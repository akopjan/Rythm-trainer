// Attribute candidate attacks to the known rendered backing after cancellation.
// Projection changes no microphone samples. Verified periodic starts may refine
// an accepted timestamp using earlier independent harmonic energy.
// Audio-thread fallback spreads searches over subsequent audio blocks. A
// dedicated Worker may drain ready search slices without awaiting more PCM.
// The raw rendered dictionary avoids treating cancellation-filter artifacts
// as a second sound source, or fitting a learned microphone filter to a player.
class EchoAttribution {
 constructor(rate,emit){
  this.rate=rate;this.emit=emit;this.stride=Math.max(1,Math.round(rate/8000));
  // Queued audits may wait about a second behind earlier source fits. Keep
  // their capture pre-roll and up to 500 ms of delayed render history too.
  // This bounded ring does not change observation time or scoring timestamps.
  this.size=2**Math.ceil(Math.log2(rate*2.5+512));this.mask=this.size-1;
  this.render=new Float32Array(this.size);this.capture=new Float32Array(this.size);
  this.lowRender=new Float32Array(this.size);this.lowCapture=new Float32Array(this.size);
  this.alpha=1-Math.exp(-2*Math.PI*900/rate);this.deferredAnalysis=false;this.kernel=null;this.reset();
 }
 reset(options={}){
  const preserve=options.preserveDiagnostics===true;
  const diagnostic={accepted:preserve?this.accepted||0:0,rejected:preserve?this.rejected||0:0,lastDecision:preserve?this.lastDecision??null:null,lastDrop:preserve?this.lastDrop??null:null,dropCounts:preserve?this.dropCounts||{}:{}};
  for(const array of [this.render,this.capture,this.lowRender,this.lowCapture])array.fill(0);
  const timing=preserve&&this.timing?this.timing:{completed:0,peak:0,waitSumMs:0,maxWaitMs:0,lastWaitMs:0,drainCalls:0,drainSteps:0,drainCpuMs:0,maxDrainCpuMs:0,maxStepCpuMs:0};
  this.total=0;this.baseTime=null;this.filters=[0,0];this.pending=[];this.meta={enabled:false};Object.assign(this,diagnostic);this.timing=timing;this.currentTime=0;this.renderBlockLength=0;this.captureBlockLength=0;
 }
 setDeferredAnalysis(enabled){
  this.deferredAnalysis=enabled===true;
  if(this.deferredAnalysis&&!this.kernel&&typeof RhythmAttributionCore!=='undefined')this.kernel=new RhythmAttributionCore(this.size);
 }
 finishTiming(job){
  if(job.timingDone||!Number.isFinite(job.queuedSourceTime))return;
  job.timingDone=true;const wait=Math.max(0,(this.baseTime+this.total/this.rate-job.queuedSourceTime)*1000);
  this.timing.completed++;this.timing.waitSumMs+=wait;this.timing.lastWaitMs=wait;this.timing.maxWaitMs=Math.max(this.timing.maxWaitMs,wait);
 }
 schedulingInfo(){const {waitSumMs,...info}=this.timing;return {...info,mode:this.deferredAnalysis?'worker':'audio-block',kernel:this.kernel?'wasm':'javascript',pending:this.pending.length,meanWaitMs:info.completed?waitSumMs/info.completed:0};}
 reject(job,reason){const current=Number.isFinite(this.currentTime)?Math.max(0,this.currentTime):0,candidate=job.message?.time;this.rejected++;this.lastDecision={time:Number.isFinite(candidate)?Math.min(current,Math.max(0,candidate)):current,reason};job.done=true;this.finishTiming(job);}
 drop(job,reason,details={}){
  if(job.done)return;
  const number=value=>Number.isFinite(value)?value:null,flag=value=>typeof value==='boolean'?value:null;
  this.lastDrop={reason,stage:details.stage||null,candidateTime:number(job.message?.time),signalTime:number(job.signalTime),currentTime:number(this.currentTime),baseTime:number(this.baseTime),total:number(this.total),size:number(this.size),start:number(job.start),length:number(job.length),historyStart:number(job.historyStart),gap:number(details.gap),referencePresent:flag(this.meta.referencePresent),ready:flag(this.meta.ready),canAudit:flag(this.meta.canAudit),enabled:flag(this.meta.enabled),noEchoProof:flag(this.meta.noEchoProof),renderBlockLength:this.renderBlockLength,captureBlockLength:this.captureBlockLength};
  this.dropCounts[reason]=(this.dropCounts[reason]||0)+1;this.reject(job,reason);
 }
 process(render,capture,cleaned,t,meta={}){
  const n=capture?.length||0;if(!n)return;
  this.currentTime=t+n/this.rate;this.renderBlockLength=render?.length||0;this.captureBlockLength=n;this.meta={...meta};
  if(this.baseTime===null)this.baseTime=t;
  else if(Math.abs(t-(this.baseTime+this.total/this.rate))>.03){const gap=t-(this.baseTime+this.total/this.rate);for(const job of this.pending)this.drop(job,'clock-reset',{stage:'process',gap});this.reset({preserveDiagnostics:true});this.baseTime=t;}
  this.currentTime=t+n/this.rate;this.renderBlockLength=render?.length||0;this.captureBlockLength=n;
  this.meta={...meta};
  for(let i=0;i<n;i++){
   const at=this.total++&this.mask,x=Number.isFinite(render?.[i])?render[i]:0;
   const audit=Number.isFinite(capture[i])?capture[i]:0;
   this.render[at]=x;this.capture[at]=audit;
   this.filters[0]+=this.alpha*(x-this.filters[0]);this.filters[1]+=this.alpha*(audit-this.filters[1]);
   this.lowRender[at]=this.filters[0];this.lowCapture[at]=this.filters[1];
  }
  if(!this.pending.length)return;
  // The harmonic classifier has a shorter rolling history than a queued
  // waveform audit. Retain each event's source-time evidence after its future
  // observation window closes, including jobs waiting behind the head.
  const evidenceTime=Number.isFinite(meta.evidenceTime)?meta.evidenceTime:t+n/this.rate;
  for(const job of this.pending)if(!job.evidenceSnapshot&&evidenceTime>=job.message.time+.13){
   job.evidenceSnapshot={time:evidenceTime,own:typeof meta.instrumentEvidence==='function'&&meta.instrumentEvidence(job.message.time),tonal:meta.renderRecent===true&&typeof meta.tonalEvidence==='function'&&meta.tonalEvidence(job.message.time),renderRecent:meta.renderRecent===true};
  }
  // A missing, stale or unproven reference does not prove an own attack.
  if(meta.enabled!==false&&!meta.ready&&!meta.noEchoProof&&!meta.canAudit){for(const job of this.pending)this.drop(job,'reference-unavailable',{stage:'process'});this.pending=[];return;}
  if(meta.enabled===false||meta.noEchoProof&&!meta.renderRecent){for(const job of this.pending)this.accept(job);this.pending=[];return;}
  if(!this.deferredAnalysis)this.advanceReady();
 }
 canAdvance(){
  const job=this.pending[0];if(!job)return false;
  const meta=this.meta;
  if(meta.enabled===false||meta.noEchoProof&&!meta.renderRecent||!meta.ready&&!meta.noEchoProof&&!meta.canAudit)return true;
  if(!job.stage&&this.total<this.captureEnd(job))return false;
  // The FFT evidence trails raw capture. Draining faster must not shorten
  // the independent harmonic observation window used to confirm an attack.
  if(this.deferredAnalysis&&typeof meta.instrumentEvidence==='function'&&(job.message.toneCheck===true||job.message.spectralCheck===true)&&!job.evidenceSnapshot)return false;
  return true;
 }
 advanceReady(){
  if(!this.canAdvance())return false;
  const meta=this.meta;
  if(meta.enabled!==false&&!meta.ready&&!meta.noEchoProof&&!meta.canAudit){for(const job of this.pending)this.drop(job,'reference-unavailable',{stage:'drain'});this.pending=[];return true;}
  if(meta.enabled===false||meta.noEchoProof&&!meta.renderRecent){for(const job of this.pending)this.accept(job);this.pending=[];return true;}
  const job=this.pending[0];
  if(!job.stage){
   // A small raw clock step is tolerated without resetting the PCM ring.
   // Its timestamp can therefore lead the samples actually received. Wait
   // for the exact same sample bound that prepare() will read, not raw time.
   if(this.total<this.captureEnd(job))return false;
   if(!this.prepare(job)){this.pending.shift();return true;}
  }
  this.advance(job);
  if(job.done)this.pending.shift();
  return true;
 }
 drain(options={}){
  const clock=()=>typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():Date.now();
  const budget=Number.isFinite(options.budgetMs)?Math.max(0,Math.min(8,options.budgetMs)):2;
  const maxSteps=Number.isFinite(options.maxSteps)?Math.max(1,Math.min(512,Math.floor(options.maxSteps))):64;
  const started=clock();let steps=0;
  // The budget is cooperative: one unchanged numerical slice is atomic.
  // Stop between slices and yield to capture/configuration messages.
  while(this.deferredAnalysis&&steps<maxSteps&&clock()-started<budget&&this.canAdvance()){
   const before=clock();if(!this.advanceReady())break;steps++;
   this.timing.maxStepCpuMs=Math.max(this.timing.maxStepCpuMs,Math.max(0,clock()-before));
  }
  const elapsedMs=Math.max(0,clock()-started),more=this.deferredAnalysis&&this.canAdvance();
  this.timing.drainCalls++;this.timing.drainSteps+=steps;this.timing.drainCpuMs+=elapsedMs;this.timing.maxDrainCpuMs=Math.max(this.timing.maxDrainCpuMs,elapsedMs);
  return {steps,pending:this.pending.length,blocked:this.pending.length>0&&!more,more,elapsedMs};
 }
 queue(message,gate=.004){
  if(message?.type!=='onset'||!Number.isFinite(message.time)){this.drop({message},'invalid-candidate',{stage:'queue'});return;}
  if(this.meta.enabled===false||this.meta.noEchoProof&&!this.meta.renderRecent){this.accept({message});return;}
  if(!this.meta.ready&&!this.meta.noEchoProof&&!this.meta.canAudit){this.drop({message},'reference-unavailable',{stage:'queue'});return;}
  if(this.pending.length>=8){this.drop({message},'queue-full',{stage:'queue'});return;}
  // Spectral detectors may backdate their timestamp. Audit the waveform being
  // observed now while preserving the original timestamp used by the score.
  this.pending.push({message:{...message},signalTime:Number.isFinite(message.captureTime)?Math.min(this.baseTime+this.total/this.rate,message.captureTime):this.baseTime+this.total/this.rate,queuedSourceTime:this.baseTime+this.total/this.rate,gate:Number.isFinite(gate)&&gate>0?gate:.004});
  this.timing.peak=Math.max(this.timing.peak,this.pending.length);
 }
 accept(job){
  const lowProof=this.lowPeriodicSourceProof(job);
  if(lowProof.ok&&!job.lowPeriodicTimeApplied){job.message.originalPeriodicTime=job.message.originalPeriodicTime??job.message.time;job.message.time=lowProof.time;job.lowPeriodicTimeApplied=true;}

  // Residual percussion after a learned spectral mask needs independent
  // instrument evidence in the original capture, observed with lookahead.
  const ownEvidence=job.evidenceSnapshot?job.evidenceSnapshot.own:typeof this.meta.instrumentEvidence==='function'&&this.meta.instrumentEvidence(job.message.time),knownInstrument=job.message?.profileReady===true&&ownEvidence;
  // Source projection can verify an independent rise before a long-term
  // profile exists. The exception below also requires a stable residual tone.
  const knownPeriodicSource=ownEvidence&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true);
  const tonalEvidence=job.evidenceSnapshot?job.evidenceSnapshot.tonal:this.meta.renderRecent===true&&typeof this.meta.tonalEvidence==='function'&&this.meta.tonalEvidence(job.message.time);
  let confirmed=true;
  if(job.message?.toneCheck===true){
   if(knownInstrument)confirmed=true;
   else{
    const stable=this.stableInstrumentTone(job);
    confirmed=stable&&(ownEvidence||tonalEvidence&&job.tonalFamilyCount>=2);
   }
  }
  else if(job.message?.spectralCheck===true&&typeof this.meta.instrumentEvidence==='function')confirmed=ownEvidence;
  if(!confirmed){
   this.reject(job,'tone-unconfirmed');return;
  }
  if(job.message.source==='periodic'&&job.message.frequency>=1600){
   if(!(knownPeriodicSource&&this.highStableInstrumentTone(job)&&this.highPeriodicSourceRise(job))){this.reject(job,'tone-unconfirmed');return;}
  }
  if(job.y){
   // Independent energy can be a held note. A backing-triggered candidate
   // needs its own amplitude rise or pitch change after source projection.
   const removed=Math.max(0,job.original-job.energy),echo=Math.sqrt(removed/job.length),limit=job.eventIndex,afterStart=Math.min(job.length-1,limit+Math.round(.012*this.rate)),afterEnd=Math.min(job.length,limit+Math.round(.052*this.rate));let before=0,after=0;
   const beforeStart=Math.max(0,limit-Math.round(.024*this.rate));
   for(let i=beforeStart;i<limit;i++)before+=job.y[i]**2;for(let i=afterStart;i<afterEnd;i++)after+=job.y[i]**2;
   before=Math.sqrt(before/Math.max(1,limit-beforeStart));after=Math.sqrt(after/Math.max(1,afterEnd-afterStart));
   if(echo>job.gate*.5&&!(after>before*1.45&&after-before>job.gate*.2)&&!this.spectralNovelty(job,afterStart,after,before)&&!(knownInstrument&&(this.harmonicFamilyRise(job)||this.highHarmonicFamilyRise(job)))&&!(job.message.source==='periodic'&&knownPeriodicSource&&this.stableInstrumentTone(job)&&this.periodicSourceRise(job))){this.reject(job,'held-tone');return;}
  }
  this.accepted++;this.lastDecision={time:job.message.time,reason:'instrument'};this.emit({...job.message});job.done=true;this.finishTiming(job);
 }

 // A new upper note over a held bass need not raise the whole signal by45%.
 // Only with a vetted background profile, frozen instrument evidence, and
 // source projection may a new family replace that global-rise requirement.
 // Cold-start waveform/periodic proof alone keeps the older held-tone veto.
 // Relative family growth rejects a uniform bellows-volume change; two
 // post-onset windows reject brief inharmonic or decaying backing transients.
 harmonicFamilyRise(job){
  const rate=this.rate,stride=this.stride,limit=job.eventIndex;
  if(!job.y||!Number.isFinite(limit))return false;
  const beforeCount=Math.floor(.024*rate/stride),afterCount=Math.floor(.032*rate/stride);
  const beforeStart=limit-beforeCount*stride,firstStart=limit+Math.round(.012*rate),secondStart=limit+Math.round(.045*rate);
  if(beforeCount<16||afterCount<16||beforeStart<0||secondStart+(afterCount-1)*stride>=job.y.length)return false;
  const make=(start,count)=>{const values=new Float64Array(count);let norm=0,energy=0;for(let i=0;i<count;i++){const x=job.y[start+i*stride],w=.5-.5*Math.cos(2*Math.PI*i/(count-1));values[i]=x*w;norm+=w;energy+=x*x/count;}return {values,norm,energy};};
  const before=make(beforeStart,beforeCount),first=make(firstStart,afterCount),second=make(secondStart,afterCount),sampledRate=rate/stride;
  const power=(frame,frequency)=>{const c=2*Math.cos(2*Math.PI*frequency/sampledRate);let a=0,b=0;for(const x of frame.values){const n=x+c*a-b;b=a;a=n;}return Math.max(0,a*a+b*b-c*a*b)/(frame.norm*frame.norm);};
  const maxFundamental=Math.min(1400,sampledRate*.45/3),floor=Math.max(1e-16,job.gate*job.gate*.012);
  for(let frequency=80;frequency<=maxFundamental;frequency+=10){
   const old=[1,2,3].map(h=>power(before,frequency*h)),a=[1,2,3].map(h=>power(first,frequency*h)),b=[1,2,3].map(h=>power(second,frequency*h));
   if(!(a[0]>old[0]*1.6+floor&&b[0]>old[0]*1.6+floor&&a[0]>first.energy*.01&&b[0]>second.energy*.01))continue;
   const newHarmonic=[1,2].some(h=>a[h]>old[h]*1.6+floor&&b[h]>old[h]*1.6+floor&&a[h]>a[0]*.012&&b[h]>b[0]*.012);
   if(!newHarmonic)continue;
   const oldSum=old.reduce((x,y)=>x+y,0),aSum=a.reduce((x,y)=>x+y,0),bSum=b.reduce((x,y)=>x+y,0);
   const oldFraction=2*oldSum/Math.max(1e-20,before.energy),aFraction=2*aSum/Math.max(1e-20,first.energy),bFraction=2*bSum/Math.max(1e-20,second.energy);
   if(aFraction<.035||bFraction<.035||aFraction<=oldFraction*1.3||bFraction<=oldFraction*1.3)continue;
   if(Math.sqrt(2*Math.min(aSum,bSum))-Math.sqrt(2*oldSum)<=job.gate*.3||bSum<aSum*.65*.65)continue;
   let dot=0,aa=0,bb=0;for(let h=0;h<3;h++){dot+=a[h]*b[h];aa+=a[h]*a[h];bb+=b[h]*b[h];}
   if(aa*bb>1e-30&&dot/Math.sqrt(aa*bb)>=.92)return true;
  }
  return false;
 }


 // Scan only with a vetted profile and frozen own-source evidence. A native
 // recheck prevents the faster scan from treating aliases as harmonic notes.
 highHarmonicFamilyRise(job){
  const rate=this.rate,stride=Math.max(1,Math.round(rate/16000)),limit=job.eventIndex,sampledRate=rate/stride;
  if(!job.y||!Number.isFinite(limit))return false;
  const beforeCount=Math.floor(.024*rate/stride),afterCount=Math.floor(.032*rate/stride);
  const beforeStart=limit-beforeCount*stride,firstStart=limit+Math.round(.012*rate),secondStart=limit+Math.round(.045*rate);
  if(beforeCount<16||afterCount<16||beforeStart<0||secondStart+(afterCount-1)*stride>=job.y.length)return false;
  const make=(start,count,step=stride)=>{const values=new Float64Array(count);let norm=0,energy=0;for(let i=0;i<count;i++){const x=job.y[start+i*step],w=.5-.5*Math.cos(2*Math.PI*i/(count-1));values[i]=x*w;norm+=w;energy+=x*x/count;}return {values,norm,energy};};
  const before=make(beforeStart,beforeCount),first=make(firstStart,afterCount),second=make(secondStart,afterCount);
  const power=(frame,frequency,analysisRate=sampledRate)=>{const c=2*Math.cos(2*Math.PI*frequency/analysisRate);let a=0,b=0;for(const x of frame.values){const n=x+c*a-b;b=a;a=n;}return Math.max(0,a*a+b*b-c*a*b)/(frame.norm*frame.norm);};
  const high=Math.min(4000,sampledRate*.45/2),floor=Math.max(1e-16,job.gate*job.gate*.012);
  let native=null;
  for(let frequency=1600;frequency<=high;frequency+=10){
   const o1=power(before,frequency),a1=power(first,frequency),b1=power(second,frequency);
   if(!(a1>o1*1.6+floor&&b1>o1*1.6+floor&&a1>first.energy*.01&&b1>second.energy*.01))continue;
   const o2=power(before,frequency*2),a2=power(first,frequency*2),b2=power(second,frequency*2);
   if(!(a2>o2*1.6+floor&&b2>o2*1.6+floor&&a2>a1*.012&&b2>b1*.012))continue;
   const third=frequency*3<=sampledRate*.45,o3=third?power(before,frequency*3):0,a3=third?power(first,frequency*3):0,b3=third?power(second,frequency*3):0;
   const oldSum=o1+o2+o3,aSum=a1+a2+a3,bSum=b1+b2+b3;
   const oldFraction=2*oldSum/Math.max(1e-20,before.energy),aFraction=2*aSum/Math.max(1e-20,first.energy),bFraction=2*bSum/Math.max(1e-20,second.energy);
   if(aFraction<.035||bFraction<.035||aFraction<=oldFraction*1.3||bFraction<=oldFraction*1.3)continue;
   if(Math.sqrt(2*Math.min(aSum,bSum))-Math.sqrt(2*oldSum)<=job.gate*.3||bSum<aSum*.65*.65)continue;
   // A narrow fixed bin can rise when vibrato moves an unchanged tone.
   // Center both post windows on a persistent local peak and compare with
   // the strongest nearby pre-existing fundamental, not only the same bin.
   let oldNeighbour=o1,firstPeak=a1,secondPeak=b1;const neighbourhood=Math.max(40,frequency*.02);
   for(let offset=-neighbourhood;offset<=neighbourhood;offset+=10){const neighbour=frequency+offset;if(neighbour<1600||neighbour>high)continue;oldNeighbour=Math.max(oldNeighbour,power(before,neighbour));firstPeak=Math.max(firstPeak,power(first,neighbour));secondPeak=Math.max(secondPeak,power(second,neighbour));}
   if(a1<firstPeak*.8||b1<secondPeak*.8||!(a1>oldNeighbour*1.6+floor&&b1>oldNeighbour*1.6+floor))continue;
   const dot=a1*b1+a2*b2+a3*b3,aa=a1*a1+a2*a2+a3*a3,bb=b1*b1+b2*b2+b3*b3;
   if(!(aa*bb>1e-30&&dot/Math.sqrt(aa*bb)>=.92))continue;
   // The fast search has no anti-alias filter. An out-of-band source can
   // fold onto a convincing family, so it cannot itself establish evidence.
   // Verify only this candidate's partials against native projected PCM;
   // never run a full native-rate frequency search.
   if(!native){
    const nativeBeforeCount=Math.floor(.024*rate),nativeAfterCount=Math.floor(.032*rate),nativeBeforeStart=limit-nativeBeforeCount;
    if(nativeBeforeStart<0||secondStart+nativeAfterCount>job.y.length)return false;
    native=[make(nativeBeforeStart,nativeBeforeCount,1),make(firstStart,nativeAfterCount,1),make(secondStart,nativeAfterCount,1)];
   }
   const nativePartials=native.map(frame=>[power(frame,frequency,rate),power(frame,frequency*2,rate),third?power(frame,frequency*3,rate):0]);
   const [oldNative,firstNative,secondNative]=nativePartials;
   if(![firstNative,secondNative].every((partial,i)=>partial[0]>oldNative[0]*1.6+floor&&partial[1]>oldNative[1]*1.6+floor&&partial[0]>native[i+1].energy*.01&&partial[1]>partial[0]*.012))continue;
   const sums=nativePartials.map(partial=>partial.reduce((sum,value)=>sum+value,0)),fractions=sums.map((sum,i)=>2*sum/Math.max(1e-20,native[i].energy));
   if(fractions[1]<.035||fractions[2]<.035||fractions[1]<=fractions[0]*1.3||fractions[2]<=fractions[0]*1.3)continue;
   if(Math.sqrt(2*Math.min(sums[1],sums[2]))-Math.sqrt(2*sums[0])<=job.gate*.3||sums[2]<sums[1]*.65*.65)continue;
   let nativeDot=0,nativeAA=0,nativeBB=0;for(let h=0;h<3;h++){nativeDot+=firstNative[h]*secondNative[h];nativeAA+=firstNative[h]**2;nativeBB+=secondNative[h]**2;}
   if(!(nativeAA*nativeBB>1e-30&&nativeDot/Math.sqrt(nativeAA*nativeBB)>=.92))continue;
   return true;
  }
  return false;
 }

 // High proposals must prove their named family in native projected
 // PCM before any amplitude/novelty shortcut. Decimated aliases cannot do so.
 highNativeFrame(job,start,count){
  if(start<0||start+count>job.y.length)return null;
  const values=new Float64Array(count);let norm=0,total=0;
  for(let i=0;i<count;i++){const x=job.y[start+i],w=.5-.5*Math.cos(2*Math.PI*i/(count-1));values[i]=x*w;norm+=w;total+=x*x/count;}
  return {values,norm,total};
 }
 highNativePower(frame,frequency){
  const c=2*Math.cos(2*Math.PI*frequency/this.rate);let a=0,b=0;
  for(const x of frame.values){const n=x+c*a-b;b=a;a=n;}
  return Math.max(0,a*a+b*b-c*a*b)/(frame.norm*frame.norm);
 }
 highStableInstrumentTone(job){
  const frequency=job.message?.frequency;
  if(!job.y||!Number.isFinite(frequency)||frequency<1600||frequency>Math.min(4000,this.rate*.45/2))return false;
  // Quiet known notes need not dominate the remaining backing energy. Cold
  // input keeps the stronger concentration and power-shape requirements.
  const knownInstrument=job.message?.profileReady===true&&job.evidenceSnapshot?.own===true;
  const count=Math.floor(.032*this.rate),starts=(knownInstrument?[.050,.080]:[.020,.050,.080]).map(t=>job.eventIndex+Math.round(t*this.rate));
  const frames=starts.map(start=>this.highNativeFrame(job,start,count));if(frames.some(f=>!f))return false;
  const radius=Math.max(30,frequency*.02),best=[];
  for(const frame of frames){let peak=0,f=frequency;for(let offset=-radius;offset<=radius;offset+=10){const q=frequency+offset,p=this.highNativePower(frame,q);if(p>peak){peak=p;f=q;}}best.push({f,fundamental:peak,second:this.highNativePower(frame,f*2),third:f*3<=this.rate*.45?this.highNativePower(frame,f*3):0,total:frame.total});}
  if(Math.max(...best.map(x=>x.f))-Math.min(...best.map(x=>x.f))>Math.max(15,frequency*.006))return false;
  if(best.some(x=>x.fundamental<x.total*(knownInstrument ? .01 : .025)||x.second+x.third<x.fundamental*.012||2*(x.fundamental+x.second+x.third)<x.total*(knownInstrument ? .12 : .35)))return false;
  const a=best[0],b=best.at(-1),left=[a.fundamental,a.second,a.third],right=[b.fundamental,b.second,b.third];
  let dot=0,aa=0,bb=0;for(let h=0;h<3;h++){const x=knownInstrument?Math.sqrt(left[h]):left[h],y=knownInstrument?Math.sqrt(right[h]):right[h];dot+=x*y;aa+=x*x;bb+=y*y;}
  if(b.fundamental+b.second+b.third<(a.fundamental+a.second+a.third)*.65*.65||aa*bb<=1e-30||dot/Math.sqrt(aa*bb)<.92)return false;
  job.highNativeFrequency=best[Math.floor(best.length/2)].f;return true;
 }
 highPeriodicSourceRise(job){
  if(job.highPeriodicVerified)return true;
  const frequency=job.highNativeFrequency??job.message?.frequency;
  if(!job.y||!Number.isFinite(frequency)||frequency<1600||frequency>Math.min(4000,this.rate*.45/2))return false;
  const knownInstrument=job.message?.profileReady===true&&job.evidenceSnapshot?.own===true;
  const count=Math.floor(.032*this.rate),early=job.eventIndex-Math.round(.14*this.rate),late=job.eventIndex+Math.round((knownInstrument ? .05 : .02)*this.rate);
  const before=this.highNativeFrame(job,early,count),after=this.highNativeFrame(job,late,count);if(!before||!after)return false;
  const energy=frame=>{const fundamental=this.highNativePower(frame,frequency),second=this.highNativePower(frame,frequency*2),third=frequency*3<=this.rate*.45?this.highNativePower(frame,frequency*3):0;return {fundamental,second,third,sum:fundamental+second+third,total:frame.total};};
  const old=energy(before),now=energy(after);let oldNeighbour=old.fundamental,oldSecond=old.second,oldThird=old.third;const radius=Math.max(60,frequency*.04);
  for(let offset=-radius;offset<=radius;offset+=10){const q=frequency+offset;oldNeighbour=Math.max(oldNeighbour,this.highNativePower(before,q));oldSecond=Math.max(oldSecond,this.highNativePower(before,q*2));if(q*3<=this.rate*.45)oldThird=Math.max(oldThird,this.highNativePower(before,q*3));}
  if(!(now.fundamental>after.total*(knownInstrument ? .01 : .025)&&now.second+now.third>now.fundamental*.012&&2*now.sum>after.total*(knownInstrument ? .12 : .35)&&now.fundamental>oldNeighbour*2.5&&((now.second>now.fundamental*.012&&now.second>oldSecond*2.5)||(now.third>now.fundamental*.012&&now.third>oldThird*2.5))&&2*now.sum/Math.max(1e-20,after.total)>2*old.sum/Math.max(1e-20,before.total)*1.3&&Math.sqrt(2*now.sum)-Math.sqrt(2*old.sum)>job.gate*.3))return false;
  const onsetPower=old.sum+(now.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*this.rate)),limit=job.eventIndex-Math.round(.020*this.rate);
  for(let start=early;start<=limit;start+=step){const frame=this.highNativeFrame(job,start,count),observed=energy(frame);if(observed.sum<onsetPower||observed.fundamental<observed.total*.025)continue;const sourceTime=this.baseTime+(job.start+start+(count-1)/2)/this.rate;job.message.originalPeriodicTime=job.message.time;job.message.time=Math.min(job.message.time,sourceTime);break;}
  job.highPeriodicVerified=true;return true;
 }

 lowPeriodicSourceProof(job){
  if(job.lowPeriodicProof)return job.lowPeriodicProof;
  return job.lowPeriodicProof=this.computeLowPeriodicSourceProof(job);
 }
 // Verify the named family at native rate, then place confirmation windows
 // after its source rise. A delayed proposal must not sample the note release.
 // Independent partial growth prevents a held tone or folded alias from
 // supplying a new attack; optional H4 supports reed timbres with weak H2/H3.
 computeLowPeriodicSourceProof(job){
 const frequency=job.message?.frequency,rate=this.rate,count=Math.floor(.032*rate);
 const own=job.evidenceSnapshot?.own===true,known=own&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true);
 if(!known||job.message?.source!=='periodic'||!job.y||!Number.isFinite(frequency)||frequency<80||frequency>Math.min(1400,rate*.45/2))return {ok:false,reason:'unproven-source'};
 const early=job.eventIndex-Math.round(.140*rate),late=job.eventIndex+Math.round(.020*rate);
 const frame=start=>this.highNativeFrame(job,start,count),energy=window=>{if(!window)return null;const parts=[1,2,3,4].map(h=>frequency*h<=rate*.45?this.highNativePower(window,frequency*h):0),sum=parts.reduce((a,b)=>a+b,0);return {parts,sum,total:window.total,fraction:2*sum/Math.max(1e-20,window.total)};};
 const oldFrame=frame(early),afterFrame=frame(late),old=energy(oldFrame),after=energy(afterFrame);
 if(!old||!after)return {ok:false,reason:'source-window-incomplete'};
 const neighbour=old.parts.slice(),radius=Math.max(6,frequency*.02);
 for(let offset=-radius;offset<=radius;offset+=3)for(let h=1;h<=4;h++)if((frequency+offset)*h<=rate*.45)neighbour[h-1]=Math.max(neighbour[h-1],this.highNativePower(oldFrame,(frequency+offset)*h));
 const floor=Math.max(1e-16,job.gate*job.gate*.012),newPartial=[1,2,3].some(h=>after.parts[h]>after.parts[0]*.012&&after.parts[h]>neighbour[h]*2.5+floor);
 if(!(after.parts[0]>after.total*.025&&after.fraction>.35&&after.parts[0]>neighbour[0]*2.5+floor&&newPartial&&after.fraction>old.fraction*1.3&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3))return {ok:false,reason:'no-independent-native-rise',old,after,neighbour};
 const onsetPower=old.sum+(after.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*rate)),limit=job.eventIndex-Math.round(.020*rate);let center=null;
 for(let start=early;start<=limit;start+=step){const observed=energy(frame(start));if(!observed||observed.sum<onsetPower||observed.parts[0]<observed.total*.025)continue;center=start+(count-1)/2;break;}
 if(center===null)return {ok:false,reason:'native-rise-not-located',old,after,neighbour};
 const first=energy(frame(Math.round(center+.020*rate))),second=energy(frame(Math.round(center+.052*rate)));
 if(!first||!second)return {ok:false,reason:'confirmation-incomplete'};
 let dot=0,aa=0,bb=0;for(let h=0;h<4;h++){dot+=first.parts[h]*second.parts[h];aa+=first.parts[h]**2;bb+=second.parts[h]**2;}const shape=dot/Math.sqrt(Math.max(1e-30,aa*bb));
 const stable=first.total>job.gate*job.gate*.04&&second.total>job.gate*job.gate*.04&&first.parts[0]>first.total*.025&&second.parts[0]>second.total*.025&&first.parts.slice(1).reduce((a,b)=>a+b,0)>first.parts[0]*.012&&second.parts.slice(1).reduce((a,b)=>a+b,0)>second.parts[0]*.012&&first.fraction>=.35&&second.fraction>=.35&&second.sum>=first.sum*.65*.65&&shape>=.85;
 if(!stable)return {ok:false,reason:'source-centered-tone-not-stable',old,after,neighbour,first,second,shape,centerTime:this.baseTime+(job.start+center)/rate};
 const time=Math.min(job.message.time,this.baseTime+(job.start+center)/rate);
 return {ok:true,time,frequency,old,after,neighbour,first,second,shape};
}

 // Verify a tracked note against an earlier projected source window. A slow
 // onset can already be sounding when its level crosses the attack threshold.
 periodicSourceRise(job){
  if(job.lowPeriodicProof?.ok)return true;

  if(job.message?.frequency>=1600)return this.highPeriodicSourceRise(job);
  const frequency=job.message?.frequency;if(!Number.isFinite(frequency)||frequency<80||frequency>1400||!job.y)return false;
  const count=Math.floor(.032*this.rate/this.stride),early=job.eventIndex-Math.round(.14*this.rate),late=job.eventIndex+Math.round(.02*this.rate);
  if(count<16||early<0||late+(count-1)*this.stride>=job.y.length)return false;
  const energy=start=>{const values=new Float64Array(count);let norm=0,total=0;for(let i=0;i<count;i++){const x=job.y[start+i*this.stride],w=.5-.5*Math.cos(2*Math.PI*i/(count-1));values[i]=x*w;norm+=w;total+=x*x/count;}let sum=0,fundamental=0;for(let h=1;h<=3;h++){const c=2*Math.cos(2*Math.PI*frequency*h/(this.rate/this.stride));let a=0,b=0;for(const x of values){const n=x+c*a-b;b=a;a=n;}const power=Math.max(0,a*a+b*b-c*a*b)/(norm*norm);if(h===1)fundamental=power;sum+=power;}return{sum,fundamental,total};};
  const before=energy(early),after=energy(late);
  if(!(after.fundamental>after.total*.025&&2*after.sum>after.total*.35&&after.sum>before.sum*2.5&&Math.sqrt(2*after.sum)-Math.sqrt(2*before.sum)>job.gate*.3))return false;
  const onsetPower=before.sum+(after.sum-before.sum)*.06,step=Math.max(this.stride,Math.round(.008*this.rate)),limit=job.eventIndex-Math.round(.020*this.rate);
  for(let start=early;start<=limit;start+=step){
   const observed=energy(start);if(observed.sum<onsetPower||observed.fundamental<observed.total*.025)continue;
   const sourceTime=this.baseTime+(job.start+start+(count-1)*this.stride/2)/this.rate;
   job.message.originalPeriodicTime=job.message.time;job.message.time=Math.min(job.message.time,sourceTime);break;
  }
  return true;
 }
 // Harmonics alone are also present in clipped speaker percussion. Before
 // a background profile exists, require a steady independent harmonic tone in
 // two short source-time windows after projection. Drum/click decays do not
 // satisfy this; only the separate periodic rise check may refine onset time.
 stableInstrumentTone(job){
  if(job.lowPeriodicProof?.ok){job.tonalFamilyCount=1;return true;}

  if(job.message?.source==='periodic'&&job.message?.frequency>=1600)return this.highStableInstrumentTone(job);
  job.tonalFamilyCount=0;
  if(!job.y||!Number.isFinite(job.eventIndex))return false;
  const count=Math.max(16,Math.floor(.032*this.rate/this.stride)),first=job.eventIndex+Math.round(.020*this.rate),second=job.eventIndex+Math.round(.080*this.rate);
  if(first<0||second+(count-1)*this.stride>=job.y.length)return false;
  const windows=[new Float64Array(count),new Float64Array(count)],energies=[0,0];let sum=0;
  for(let i=0;i<count;i++){const w=.5-.5*Math.cos(2*Math.PI*i/(count-1));sum+=w;for(let k=0;k<2;k++){const x=job.y[(k?second:first)+i*this.stride];windows[k][i]=x*w;energies[k]+=x*x/count;}}
  if(energies[1]<job.gate*job.gate*.04)return false;
  const sampledRate=this.rate/this.stride,high=Math.min(1400,sampledRate*.45/3);
  const power=(values,frequency)=>{const c=2*Math.cos(2*Math.PI*frequency/sampledRate);let a=0,b=0;for(const x of values){const next=x+c*a-b;b=a;a=next;}return Math.max(0,a*a+b*b-c*a*b)/(sum*sum);};
  const families=[];let mono=false;
  for(let frequency=80;frequency<=high;frequency+=10){
   const early=[1,2,3].map(h=>power(windows[0],frequency*h)),late=[1,2,3].map(h=>power(windows[1],frequency*h));
   const a=early.reduce((x,y)=>x+y,0),b=late.reduce((x,y)=>x+y,0);
   if(early[0]<energies[0]*.025||late[0]<energies[1]*.025||early[1]+early[2]<early[0]*.015||late[1]+late[2]<late[0]*.015)continue;
   let dot=0,aa=0,bb=0;for(let h=0;h<3;h++){dot+=early[h]*late[h];aa+=early[h]**2;bb+=late[h]**2;}
   const stableShape=aa*bb>1e-30&&dot/Math.sqrt(aa*bb)>=.85;
   if(!stableShape||b<a*.65*.65)continue;
   const concentration=Math.min(2*a/energies[0],2*b/energies[1]);
   if(concentration>=.35)mono=true;
   if(concentration>=.12)families.push({frequency,early,late,concentration});
  }
  // A chord distributes its energy across distinct fundamentals. Count the
  // union of their partials; neighbouring hypotheses and shared harmonics must
  // not count the same spectral energy twice.
  families.sort((a,b)=>b.concentration-a.concentration);
  const chosen=[],bands=[];
  for(const family of families){
   if(chosen.some(other=>Math.abs(other.frequency-family.frequency)<Math.max(25,family.frequency*.07)))continue;
   if(chosen.some(other=>{const ratio=Math.max(other.frequency,family.frequency)/Math.min(other.frequency,family.frequency);return Math.abs(ratio-Math.round(ratio))<.06;}))continue;
   chosen.push(family);
   for(let h=0;h<3;h++){
    const frequency=family.frequency*(h+1),existing=bands.find(band=>Math.abs(band.frequency-frequency)<20);
    if(existing){existing.early=Math.max(existing.early,family.early[h]);existing.late=Math.max(existing.late,family.late[h]);}
    else bands.push({frequency,early:family.early[h],late:family.late[h]});
   }
   if(chosen.length>=2){
    let a=0,b=0,dot=0,aa=0,bb=0;for(const band of bands){a+=band.early;b+=band.late;dot+=band.early*band.late;aa+=band.early**2;bb+=band.late**2;}
    if(2*a>=energies[0]*.35&&2*b>=energies[1]*.35&&b>=a*.65*.65&&dot/Math.sqrt(Math.max(1e-30,aa*bb))>=.85){job.tonalFamilyCount=chosen.length;return true;}
   }
   if(chosen.length===3)break;
  }
  if(mono){job.tonalFamilyCount=1;return true;}
  return false;
 }
 // Equal Hann windows distinguish a legato pitch change from a held tone.
 // The small bank runs near8k samples per second, only for candidate jobs.
 spectralNovelty(job,afterStart,afterRms,beforeRms){
  const count=Math.floor(.024*this.rate/this.stride),beforeStart=job.eventIndex-count*this.stride;
  if(count<16||beforeStart<0||afterStart+(count-1)*this.stride>=job.length)return false;
  const window=new Float32Array(count);for(let i=0;i<count;i++)window[i]=.5-.5*Math.cos(2*Math.PI*i/(count-1));
  const sampledRate=this.rate/this.stride,high=Math.min(3500,sampledRate*.45);let positive=0,total=0;const a=new Float64Array(32),b=new Float64Array(32);
  for(let bin=0;bin<32;bin++){
   const frequency=60*(high/60)**(bin/31),coefficient=2*Math.cos(2*Math.PI*frequency/sampledRate);let a0=0,a1=0,b0=0,b1=0;
   for(let i=0;i<count;i++){const a=job.y[beforeStart+i*this.stride]*window[i]+coefficient*a0-a1,b=job.y[afterStart+i*this.stride]*window[i]+coefficient*b0-b1;a1=a0;a0=a;b1=b0;b0=b;}
   const before=Math.sqrt(Math.max(0,a0*a0+a1*a1-coefficient*a0*a1)),after=Math.sqrt(Math.max(0,b0*b0+b1*b1-coefficient*b0*b1));positive+=Math.max(0,after-before);total+=after;a[bin]=before;b[bin]=after;
  }
  const rise=total>1e-12?positive/total:0;
  // A close legato note shifts the same harmonic shape without a large
  // energy rise. Compare normalized shapes; a held tone or random noise
  // must not become a note just because its magnitude fluctuates.
  let best=0,bestShift=0,baseline=0;
  for(let k=-24;k<=24;k++){const shift=k*.05;let dot=0,pa=0,pb=0;for(let i=1;i<31;i++){const x=i-shift,j=Math.floor(x),f=x-j,value=j>=0&&j+1<32?a[j]*(1-f)+a[j+1]*f:0;dot+=value*b[i];pa+=value*value;pb+=b[i]*b[i];}const correlation=pa*pb>1e-20?dot/Math.sqrt(pa*pb):0;if(k===0)baseline=correlation;if(correlation>best){best=correlation;bestShift=shift;}}
  return rise>.5&&rise*afterRms>job.gate*.3||(Math.abs(bestShift)>.23&&best>.95&&best-baseline>.01&&afterRms>beforeRms*.85);

 }
 at(array,position){
  if(position<0||position>=this.total||position<this.total-this.size)return 0;
  const index=Math.floor(position),fraction=position-index,a=array[index&this.mask],b=index+1<this.total?array[(index+1)&this.mask]:a;
  return a+(b-a)*fraction;
 }
 basis(job,index,lag,kind,low=false){
  const position=job.start+index-lag,array=low?job.lowRender:job.render,relative=position-job.historyStart;
  if(relative<0||relative>=array.length-1)return 0;
  const at=Math.floor(relative),fraction=relative-at;return array[at]*(1-fraction)+array[at+1]*fraction;
 }
 captureEnd(job){return Math.ceil((job.signalTime-this.baseTime+(job.message.toneCheck ? .132 : .052))*this.rate);}
 prepare(job){
  // Backdated spectral callbacks need capture history around their actual
  // scoring timestamp, rather than only the later callback observation.
  job.start=Math.max(0,Math.floor((Math.min(job.signalTime,job.message.time)-this.baseTime-(job.message.source==='periodic'?.16:.024))*this.rate));job.length=this.captureEnd(job)-job.start;job.eventIndex=Math.max(0,Math.min(job.length,Math.round((job.message.time-this.baseTime)*this.rate)-job.start));
  if(job.start+job.length>this.total){this.drop(job,'capture-window-incomplete',{stage:'prepare'});return false;}
  if(job.start<this.total-this.size){this.drop(job,'history-unavailable',{stage:'prepare'});return false;}
  job.y=new Float32Array(job.length);job.low=new Float32Array(Math.ceil(job.length/this.stride));job.original=0;
  // Audit the captured waveform, rather than the subtraction error: otherwise
  // a changing short FIR appears as an extra negative colored echo source.
  for(let i=0;i<job.length;i++){const x=this.at(this.capture,job.start+i);job.y[i]=x;job.original+=x*x;if(i%this.stride===0)job.low[i/this.stride]=this.at(this.lowCapture,job.start+i);}
  job.originalY=job.y.slice();job.atoms=[];
  if(job.original<1e-16){this.reject(job,'below-threshold');return true;}
  const anchored=this.meta.cancelReady&&Number.isFinite(this.meta.delayMs);
  job.anchor=anchored?this.meta.delayMs*this.rate/1000:0;
  job.lowLag=anchored?Math.max(0,job.anchor-this.rate*.12):0;job.highLag=anchored?Math.min(this.rate*.5,job.anchor+this.rate*.20):this.rate*.5;
  // Snapshot every template used by this job. A low-rate callback or a pending
  // queue must not let live ring overwrites change a partially completed fit.
  job.historyStart=Math.max(0,Math.floor(job.start-job.highLag-4));
  if(job.historyStart<Math.max(0,this.total-this.size)){this.drop(job,'history-unavailable',{stage:'prepare'});return false;}
  const historyLength=job.start+job.length-job.historyStart+4;
  for(const name of ['render','lowRender']){const array=new Float32Array(historyLength);for(let i=0;i<historyLength;i++)array[i]=this.at(this[name],job.historyStart+i);job[name]=array;}
  if(this.kernel)this.kernel.load(job);
  job.iteration=0;job.energy=job.original;this.beginCoarse(job);return true;
 }
 beginCoarse(job){
  job.stage='coarse';job.lag=job.lowLag;job.bestScore=0;job.bestLag=job.anchor;job.bestKind='render';job.bestRawScore=0;job.bestRawLag=job.anchor;
  job.lowEnergy=job.low.reduce((sum,x)=>sum+x*x,0);job.sampledEnergy=0;for(let i=0;i<job.length;i+=this.stride)job.sampledEnergy+=job.y[i]*job.y[i];
  job.coarseStep=Math.max(this.stride,this.rate*.001);
  // Test the verified direct delay exactly before the regular coarse lattice.
  job.direct=job.anchor>=job.lowLag&&job.anchor<=job.highLag;
 }
 coarse(job,lag,kind){
  let dot=0,power=0,rawDot=0,rawPower=0;
  if(this.kernel){const values=this.kernel.coarse(job,lag,this.stride);dot=values[0];power=values[1];rawDot=values[2];rawPower=values[3];}
  else for(let i=0,k=0;i<job.length;i+=this.stride,k++){const x=this.basis(job,i,lag,kind,true),y=job.low[k],raw=this.basis(job,i,lag,kind);dot+=x*y;power+=x*x;rawDot+=raw*job.y[i];rawPower+=raw*raw;}
  const score=Math.max(power*job.lowEnergy>1e-20&&Math.abs(dot/power)<=6?dot*dot/(power*job.lowEnergy):0,rawPower*job.sampledEnergy>1e-20&&Math.abs(rawDot/rawPower)<=6?rawDot*rawDot/(rawPower*job.sampledEnergy):0);
  if(score>job.bestScore){job.bestScore=score;job.bestLag=lag;job.bestKind=kind;}
  const rawScore=rawPower*job.sampledEnergy>1e-20&&Math.abs(rawDot/rawPower)<=6?rawDot*rawDot/(rawPower*job.sampledEnergy):0;if(rawScore>job.bestRawScore){job.bestRawScore=rawScore;job.bestRawLag=lag;}
 }
 full(job,lag,kind){
  let dot=0,power=0;
  if(this.kernel){const values=this.kernel.full(job,lag);dot=values[0];power=values[1];}
  else for(let i=0;i<job.length;i++){const x=this.basis(job,i,lag,kind);dot+=x*job.y[i];power+=x*x;}
  const score=power>1e-15?dot*dot/power:0;
  if(score>job.fullScore&&Math.abs(dot/power)<=6){job.fullScore=score;job.fullLag=lag;job.fullGain=dot/power;job.fullKind=kind;}
 }
 advance(job){
  if(job.done)return;
  if(job.stage==='coarse'){
   if(job.direct){this.coarse(job,job.anchor,'render');job.direct=false;}
   const coarseBatch=Math.max(6,Math.min(384,Math.round(48*48000/this.rate)));
   for(let batch=0;batch<coarseBatch&&job.lag<=job.highLag;batch++,job.lag+=job.coarseStep){this.coarse(job,job.lag,'render');}
   if(job.lag<=job.highLag)return;
   if(job.bestScore<1e-16){this.accept(job);return;}
   job.stage='fine';job.fineLow=Math.max(job.lowLag,Math.floor(job.bestLag-this.rate*.0015));job.fineHigh=Math.min(job.highLag,Math.ceil(job.bestLag+this.rate*.0015));
   // Refine both lowpass and raw peaks: a bass phase alias must not hide
   // the broadband copy of a snare or a room reflection.
   job.fineLag=job.fineLow;job.fullScore=0;job.fullLag=job.bestLag;job.fullGain=0;job.secondFine=job.bestRawLag>=job.fineLow&&job.bestRawLag<=job.fineHigh?null:[Math.max(job.lowLag,Math.floor(job.bestRawLag-this.rate*.0015)),Math.min(job.highLag,Math.ceil(job.bestRawLag+this.rate*.0015))];
   this.full(job,job.bestLag,'render');
   this.full(job,job.anchor,'render');
  }
  if(job.stage==='fine'){
   const fineBatch=Math.max(4,Math.min(96,Math.round(32*48000/this.rate)));
   for(let batch=0;batch<fineBatch&&job.fineLag<=job.fineHigh;batch++,job.fineLag++){this.full(job,job.fineLag,'render');}
   if(job.fineLag<=job.fineHigh)return;
   if(job.secondFine){[job.fineLag,job.fineHigh]=job.secondFine;job.secondFine=null;return;}
   if(job.fullScore<job.original*1e-8||Math.abs(job.fullGain)>6){this.accept(job);return;}
   this.subtract(job);
   const rms=Math.sqrt(job.energy/job.length),explained=1-job.energy/job.original;
   // A loud echo may accompany a quiet instrument. The veto requires both
   // coherent attribution and absence of audible independent residual energy.
   if(explained>.90&&rms<job.gate*.5){this.reject(job,'speaker');return;}
   if(++job.iteration>=6){this.accept(job);return;}
   this.beginCoarse(job);
  }
 }
 subtract(job){
  const lag=job.fullLag,kind=job.fullKind;let a=job.fullGain,b=0,best=job.fullScore;
  // A two-tap interpolation fit resolves sub-sample echo phase without a bank
  // of fractionally shifted signals or an always-running long room filter.
  for(const adjacent of [-1,1]){
   let p0=0,p1=0,cross=0,c0=0,c1=0;
   for(let i=0;i<job.length;i++){const x0=this.basis(job,i,lag,kind),x1=this.basis(job,i,lag+adjacent,kind),y=job.y[i];p0+=x0*x0;p1+=x1*x1;cross+=x0*x1;c0+=x0*y;c1+=x1*y;}
   const determinant=p0*p1-cross*cross;if(determinant<=p0*p1*1e-7)continue;
   const x=(c0*p1-c1*cross)/determinant,y=(c1*p0-c0*cross)/determinant,score=x*c0+y*c1;
   if(x*y>=-1e-7&&Math.abs(x+y)<=6&&score>best){a=x;b=y;best=score;job.adjacent=adjacent;}
  }
  const sum=a+b,fraction=Math.abs(sum)>1e-12?b/sum:0,atom=new Float32Array(job.length);
  for(let i=0;i<job.length;i++)atom[i]=(1-fraction)*this.basis(job,i,lag,kind)+fraction*this.basis(job,i,lag+(job.adjacent||1),kind);
  job.atoms.push(atom);
  // Jointly refit the tiny selected dictionary. Greedy subtraction alone leaves
  // correlated kick/click copies in the residual and creates false attacks.
  const n=job.atoms.length,matrix=Array.from({length:n},()=>new Float64Array(n+1));
  for(let row=0;row<n;row++){
   for(let column=0;column<=row;column++){let dot=0;const x=job.atoms[row],y=job.atoms[column];for(let i=0;i<job.length;i++)dot+=x[i]*y[i];matrix[row][column]=matrix[column][row]=dot;}
   let dot=0;for(let i=0;i<job.length;i++)dot+=job.atoms[row][i]*job.originalY[i];matrix[row][n]=dot;
  }
  const regularizer=Math.max(1e-12,matrix.reduce((sum,row,i)=>sum+row[i],0)*1e-8/n);
  for(let i=0;i<n;i++)matrix[i][i]+=regularizer;
  for(let column=0;column<n;column++){
   let pivot=column;for(let row=column+1;row<n;row++)if(Math.abs(matrix[row][column])>Math.abs(matrix[pivot][column]))pivot=row;
   [matrix[column],matrix[pivot]]=[matrix[pivot],matrix[column]];
   const divisor=matrix[column][column];if(Math.abs(divisor)<1e-20)continue;
   for(let k=column;k<=n;k++)matrix[column][k]/=divisor;
   for(let row=0;row<n;row++)if(row!==column){const change=matrix[row][column];for(let k=column;k<=n;k++)matrix[row][k]-=change*matrix[column][k];}
  }
  let energy=0,filtered=0;
  for(let i=0;i<job.length;i++){
   let prediction=0;for(let j=0;j<n;j++)prediction+=Math.max(-6,Math.min(6,matrix[j][n]))*job.atoms[j][i];
   job.y[i]=job.originalY[i]-prediction;energy+=job.y[i]**2;
   filtered+=this.alpha*(job.y[i]-filtered);if(i%this.stride===0)job.low[i/this.stride]=filtered;
  }
  job.energy=energy;
  if(this.kernel)this.kernel.updateResidual(job);
 }
}
