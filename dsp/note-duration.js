// Visual duration estimates for already accepted notes. This observer never
// creates an onset or changes the attribution, filtering, or scoring state.
// Input is an existing, complete residual FFT frame on the microphone clock.
class NoteDurationTracker {
 constructor(rate,emit=()=>{},options={}){
  if(!(Number.isFinite(rate)&&rate>0))throw new TypeError('Expected a sample rate');
  this.rate=rate;this.n=options.fftSize??2048;this.bins=this.n/2+1;
  this.maxNotes=Math.max(1,Math.min(32,options.maxNotes??16));
  this.maxHistory=Math.max(8,Math.min(256,options.maxHistory??128));
  this.emit=emit;this.sequence=0;this.reset(null);
 }
 reset(token,reason='reset'){
  // A stop/toggle/clock reset interrupts observation; it is not an acoustic
  // release. Keep the last actually observed duration and old token attached.
  for(const note of this.notes??[])this.event(note,'note-state','unavailable',Math.max(note.time,Number.isFinite(this.lastTime)?this.lastTime:note.time),{reason,interrupted:true,observedDuration:Number.isFinite(note.lastFrame)?Math.max(0,note.lastFrame-note.time):0});
  this.token=token;this.history=[];this.notes=[];this.lastTime=-Infinity;
 }
 event(note,type,state,time,extra={}){
  this.emit({type,id:this.token,durationId:note.id,onsetTime:note.time,
   frequency:note.frequency,time,state,confidence:state==='sounding'||state==='released'?'estimated':state==='divided'?'accepted-boundary':'unavailable',...extra});
 }
 band(power,frequency){
  const center=Math.round(frequency*this.n/this.rate),radius=Math.max(1,Math.ceil(frequency*.015*this.n/this.rate));
  if(center-radius<1||center+radius>=power.length-1)return {power:0,floor:1e-16};
  let peak=0;for(let k=center-radius;k<=center+radius;k++)peak=Math.max(peak,power[k]);
  const sides=[];for(let d=radius+3;d<=radius+8;d++)for(const sign of [-1,1]){
   const k=center+sign*d;if(k>=1&&k<power.length-1)sides.push(power[k]);
  }
  sides.sort((a,b)=>a-b);
  return {power:peak,floor:Math.max(1e-16,(sides[Math.floor(sides.length/2)]??0)*3)};
 }
 measure(frame,note){
  return note.harmonics.map(h=>{
   const value=this.band(frame.power,note.frequency*h),noise=frame.noise?this.band(frame.noise,note.frequency*h).power:0;
   return {power:value.power,floor:Math.max(value.floor,noise*3)};
  });
 }
 accept(message,onAccepted=null){
  const frequency=message?.frequency,time=message?.time;
  if(!Number.isFinite(time)||!Number.isFinite(frequency)||frequency<60||frequency>this.rate*.44){const unavailable={durationId:null,durationStatus:'unavailable'};if(onAccepted)onAccepted(null);return unavailable;}
  const same=p=>Math.abs(1200*Math.log2(p.frequency/frequency))<=35;
  const later=this.notes.filter(p=>p.time>time&&same(p)),boundary=later.length?Math.min(...later.map(p=>p.time)):Infinity;
  const previousFamily=this.notes.filter(p=>p.time<=time&&same(p)&&p.reference).sort((a,b)=>b.time-a.time)[0];
  const durationId=++this.sequence;
  // Emit the original accepted onset exactly once before any lifecycle event,
  // including a repeated-note division or synchronous history replay.
  if(onAccepted)onAccepted(durationId);
  // A separately accepted repeated attack divides its old visual span. It
  // does not claim that the old reed physically became silent at that instant.
  for(const previous of this.notes)if(previous.time<=time&&same(previous)){
   this.event(previous,'note-end','divided',time,{reason:'rearticulated',duration:Math.max(0,time-previous.time)});
  }
  this.notes=this.notes.filter(p=>!(p.time<=time&&same(p)));
  while(this.notes.length>=this.maxNotes){const previous=this.notes.shift();this.event(previous,'note-state','unavailable',this.lastTime,{reason:'capacity'});}
  const harmonics=[];for(let h=1;h<=6&&frequency*h<this.rate*.44;h++)harmonics.push(h);
  const note={id:durationId,time,frequency,harmonics,baseline:harmonics.map(()=>0),reference:null,learn:[],lastFrame:-Infinity,lastEmit:-Infinity,quiet:[],state:'pending'};
  const before=this.history.filter(f=>f.time<time-this.n/(2*this.rate)&&f.time>=time-.18);
  // For an accepted repeat of a currently measured family, the older note's
  // body is the note being divided, not background to subtract from the new
  // note. Keep the already measured external baseline instead.
  if(previousFamily&&previousFamily.baseline.length===note.baseline.length)note.baseline=previousFamily.baseline.slice();
  else for(const frame of before){const parts=this.measure(frame,note);for(let k=0;k<parts.length;k++)note.baseline[k]=Math.max(note.baseline[k],parts[k].power);}
  this.notes.push(note);
  this.event(note,'note-state','pending',time,{reason:'body-pending'});
  for(const frame of this.history)if(frame.time>=time+this.n/(2*this.rate)&&frame.time<boundary&&this.notes.includes(note))this.advance(note,frame);
  if(Number.isFinite(boundary)&&this.notes.includes(note)){
   if(note.reference)this.event(note,'note-end','divided',boundary,{reason:'rearticulated',duration:boundary-time});
   else{note.state='unavailable';this.event(note,'note-state','unavailable',boundary,{reason:'body-not-measurable'});}
   this.notes=this.notes.filter(p=>p!==note);
  }
  return {durationId:note.id,durationStatus:note.state};
 }
 observe(frame){
  if(frame?.complete!==true||!Number.isFinite(frame.time)||frame.time<=this.lastTime||frame.power?.length!==this.bins)return false;
  // Snapshot only the existing spectra: no additional FFT, source fitting,
  // zero padding, or future samples enter this observer.
  const power=Float32Array.from(frame.power,x=>Number.isFinite(x)&&x>0?x:0);
  const noise=frame.noisePower?.length===this.bins?Float32Array.from(frame.noisePower,x=>Number.isFinite(x)&&x>0?x:0):null;
  const observed={power,noise,time:frame.time};this.lastTime=frame.time;
  this.history.push(observed);while(this.history.length>this.maxHistory)this.history.shift();
  for(const note of [...this.notes])if(observed.time>=note.time+this.n/(2*this.rate))this.advance(note,observed);
  return true;
 }
 advance(note,frame){
  if(frame.time<=note.lastFrame)return;const previousTime=note.lastFrame;note.lastFrame=frame.time;
  const parts=this.measure(frame,note),excess=parts.map((p,k)=>Math.max(0,p.power-note.baseline[k]));
  if(!note.reference){
   const supported=parts.map((p,k)=>excess[k]>p.floor*2.5);
   if(supported[0]&&supported.filter(Boolean).length>=2){
    note.learn.push({excess,supported});if(note.learn.length>3)note.learn.shift();
    if(note.learn.length===3){
     note.reference=note.harmonics.map((_,k)=>note.learn.every(f=>f.supported[k])?Math.max(...note.learn.map(f=>f.excess[k])):0);
     if(note.reference[0]>0&&note.reference.filter(x=>x>0).length>=2){note.state='sounding';note.lastEmit=frame.time;this.event(note,'note-state','sounding',frame.time,{reason:'measured-harmonic-body',duration:frame.time-note.time,observedEnd:frame.time});}else note.reference=null;
    }
   }else note.learn=[];
   if(!note.reference&&frame.time>note.time+.4){note.state='unavailable';this.event(note,'note-state','unavailable',frame.time,{reason:'body-not-measurable'});this.notes=this.notes.filter(p=>p!==note);}
   return;
  }
  // Bellows dynamics and vibrato do not extend a span by a rhythmic timer.
  // Require the measured family to be quiet in three observed complete
  // frames. The residual floor and its learned body both set the threshold.
  // Another simultaneously held family may share a higher partial. Its
  // shared partial alone must not keep this released fundamental alive.
  const absent=note.reference.map((reference,k)=>reference>0&&excess[k]<=Math.max(parts[k].floor*2,reference*.006));
  const quiet=absent[0]&&absent.slice(1).some(Boolean);
  if(quiet)note.quiet.push({time:frame.time,gap:Number.isFinite(previousTime)?frame.time-previousTime:0});else note.quiet=[];
  if(!quiet&&frame.time-note.lastEmit>=.045){note.lastEmit=frame.time;this.event(note,'note-state','sounding',frame.time,{reason:'observed-harmonic-body',duration:frame.time-note.time,observedEnd:frame.time});}
  if(note.quiet.length>=3){
   const end=Math.max(note.time,note.quiet[0].time),uncertainty=this.n/(2*this.rate)+Math.max(...note.quiet.map(f=>f.gap));
   note.state='released';this.event(note,'note-end','released',end,{reason:'measured-family-quiet',duration:end-note.time,confirmedAt:frame.time,uncertaintySeconds:uncertainty});
   this.notes=this.notes.filter(p=>p!==note);
  }
 }
}
