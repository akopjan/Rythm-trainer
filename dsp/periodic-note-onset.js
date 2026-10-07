// A small note follower for cleaned microphone samples. It proposes starts and
// pitch changes; the caller must still audit them against its rendered backing.
class PeriodicNoteOnset {
 constructor(rate,emit){
  this.rate=rate;this.emit=emit;this.stride=Math.max(1,Math.round(rate/8000));this.sampledRate=rate/this.stride;
  this.n=512;this.hop=64;this.ring=new Float64Array(this.n);this.frame=new Float64Array(this.n);this.correlations=new Float64Array(128);
  this.window=new Float64Array(this.n);this.windowSum=0;for(let i=0;i<this.n;i++){this.window[i]=.5-.5*Math.cos(2*Math.PI*i/(this.n-1));this.windowSum+=this.window[i];}
  this.alpha=1-Math.exp(-2*Math.PI*3200/rate);this.reset();
 }
 reset(){this.ring.fill(0);this.cursor=0;this.total=0;this.nativeTotal=0;this.baseTime=null;this.low=0;this.low2=0;this.divider=0;this.pitch=null;this.pending=null;this.invalidSince=null;this.lastHit=-10;this.lastFeature=null;}
 process(samples,t,gate=.004){
  if(!samples?.length||!Number.isFinite(t))return;
  if(this.baseTime===null)this.baseTime=t;
  else if(Math.abs(t-(this.baseTime+this.nativeTotal/this.rate))>.015){this.reset();this.baseTime=t;}
  for(let i=0;i<samples.length;i++){
   const x=Number.isFinite(samples[i])?samples[i]:0;this.low+=this.alpha*(x-this.low);this.low2+=this.alpha*(this.low-this.low2);this.nativeTotal++;
   if(++this.divider<this.stride)continue;this.divider=0;this.ring[this.cursor]=this.low2;this.cursor=(this.cursor+1)%this.n;this.total++;
   if(this.total>=this.n&&this.total%this.hop===0)this.observe(this.baseTime+this.nativeTotal/this.rate,Math.max(1e-6,gate));
  }
 }
 feature(gate){
  const x=this.frame,n=this.n;let mean=0;for(let i=0;i<n;i++){x[i]=this.ring[(this.cursor+i)%n];mean+=x[i];}mean/=n;
  let energy=0,early=0,late=0;for(let i=0;i<n;i++){x[i]-=mean;const p=x[i]*x[i];energy+=p;if(i<n/2)early+=p;else late+=p;}
  const rms=Math.sqrt(energy/n);if(rms<gate*.85||late<early*.58)return null;
  const minimum=Math.max(3,Math.ceil(this.sampledRate/1400)),maximum=Math.min(this.correlations.length-2,Math.floor(this.sampledRate/80));let best=0;
  for(let lag=minimum;lag<=maximum;lag++){let dot=0,a=0,b=0;for(let i=lag;i<n;i++){dot+=x[i]*x[i-lag];a+=x[i]*x[i];b+=x[i-lag]*x[i-lag];}const c=a*b>1e-20?dot/Math.sqrt(a*b):0;this.correlations[lag]=c;if(c>best)best=c;}
  if(best<.78)return null;
  let selected=-1;for(let lag=minimum+1;lag<maximum;lag++)if(this.correlations[lag]>=Math.max(.78,best*.94)&&this.correlations[lag]>=this.correlations[lag-1]&&this.correlations[lag]>this.correlations[lag+1]){selected=lag;break;}
  if(selected<0)return null;
  const a=this.correlations[selected-1],b=this.correlations[selected],c=this.correlations[selected+1],offset=Math.abs(a-2*b+c)>1e-12?.5*(a-c)/(a-2*b+c):0;
  const frequency=this.sampledRate/(selected+Math.max(-.5,Math.min(.5,offset))),coefficient=f=>2*Math.cos(2*Math.PI*f/this.sampledRate);
  const power=f=>{let p=0,q=0;const k=coefficient(f);for(let i=0;i<n;i++){const value=x[i]*this.window[i]+k*p-q;q=p;p=value;}return Math.max(0,p*p+q*q-k*p*q)/(this.windowSum*this.windowSum);};
  const fundamental=power(frequency),harmonics=power(frequency*2)+power(frequency*3),fraction=2*fundamental/(energy/n);
  // Autocorrelation alone also follows repetitive broadband transients.
  if(fraction<.08||harmonics<fundamental*.012&&b<.96)return null;
  return {frequency,cents:1200*Math.log2(frequency),rms,correlation:b,retention:late/Math.max(1e-20,early)};
 }
 observe(end,gate){
  const f=this.feature(gate),time=end-this.n/(2*this.sampledRate);this.lastFeature=f;
  if(!f){if(this.invalidSince===null)this.invalidSince=time;if(time-this.invalidSince>.060){this.pitch=null;this.pending=null;}return;}
  this.invalidSince=null;
  const changed=this.pitch===null||Math.abs(f.cents-this.pitch)>85;
  if(!changed){this.pending=null;this.pitch+=(f.cents-this.pitch)*.015;return;}
  if(!this.pending||Math.abs(f.cents-this.pending.pitch)>38){this.pending={time,pitch:f.cents,count:1,level:f.rms};return;}
  this.pending.count++;this.pending.pitch+=(f.cents-this.pending.pitch)*.2;this.pending.level=Math.max(this.pending.level,f.rms);
  if(time-this.pending.time<.032||this.pending.count<4)return;
  // Throttle admission at the observation clock without adopting an unadmitted
  // pitch. Its stable candidate keeps the original source-center timestamp.
  if(time-this.lastHit<.090)return;
  const candidate=this.pending;this.pitch=candidate.pitch;this.pending=null;
  this.lastHit=time;this.emit({type:'onset',time:Math.max(this.baseTime,candidate.time),level:candidate.level,frequency:2**(candidate.pitch/1200),source:'periodic'});
 }
}

// Upper notes use a parallel follower; the lower follower and its admission
// clock remain unchanged. Every proposal still requires native source proof.
class HighPeriodicNoteOnset extends PeriodicNoteOnset {
 constructor(rate,emit){
  super(rate,emit);
  this.rate=rate;this.emit=emit;this.stride=Math.max(1,Math.round(rate/16000));this.sampledRate=rate/this.stride;
  this.n=1024;this.hop=128;this.ring=new Float64Array(this.n);this.frame=new Float64Array(this.n);this.correlations=new Float64Array(256);
  this.window=new Float64Array(this.n);this.windowSum=0;for(let i=0;i<this.n;i++){this.window[i]=.5-.5*Math.cos(2*Math.PI*i/(this.n-1));this.windowSum+=this.window[i];}
  this.alpha=1-Math.exp(-2*Math.PI*6000/rate);this.reset();
 }
 feature(gate){
  const x=this.frame,n=this.n;let mean=0;for(let i=0;i<n;i++){x[i]=this.ring[(this.cursor+i)%n];mean+=x[i];}mean/=n;
  let energy=0,early=0,late=0;for(let i=0;i<n;i++){x[i]-=mean;const p=x[i]*x[i];energy+=p;if(i<n/2)early+=p;else late+=p;}
  const rms=Math.sqrt(energy/n);if(rms<gate*.85||late<early*.58)return null;
  const highest=Math.min(3300,this.sampledRate*.45/2),minimum=Math.max(2,Math.floor(this.sampledRate/highest)-1),maximum=Math.min(this.correlations.length-2,Math.ceil(this.sampledRate/1600)+1);let best=0;
  for(let lag=minimum;lag<=maximum;lag++){let dot=0,a=0,b=0;for(let i=lag;i<n;i++){dot+=x[i]*x[i-lag];a+=x[i]*x[i];b+=x[i-lag]*x[i-lag];}const c=a*b>1e-20?dot/Math.sqrt(a*b):0;this.correlations[lag]=c;if(c>best)best=c;}
  if(best<.78)return null;
  let selected=-1;for(let lag=minimum+1;lag<maximum;lag++)if(this.correlations[lag]>=Math.max(.78,best*.94)&&this.correlations[lag]>=this.correlations[lag-1]&&this.correlations[lag]>this.correlations[lag+1]){selected=lag;break;}
  if(selected<0)return null;
  const a=this.correlations[selected-1],b=this.correlations[selected],c=this.correlations[selected+1],offset=Math.abs(a-2*b+c)>1e-12?.5*(a-c)/(a-2*b+c):0;
  let frequency=this.sampledRate/(selected+Math.max(-.5,Math.min(.5,offset)));const coefficient=f=>2*Math.cos(2*Math.PI*f/this.sampledRate);
  const power=f=>{let p=0,q=0;const k=coefficient(f);for(let i=0;i<n;i++){const value=x[i]*this.window[i]+k*p-q;q=p;p=value;}return Math.max(0,p*p+q*q-k*p*q)/(this.windowSum*this.windowSum);};
  const coarse=frequency,radius=coarse*.02;let strongest=power(frequency);for(let offset=-radius;offset<=radius;offset+=5){const f=coarse+offset;if(f<1600||f>highest)continue;const observed=power(f);if(observed>strongest){strongest=observed;frequency=f;}}
  if(frequency<1600||frequency>highest)return null;
  const fundamental=power(frequency),second=power(frequency*2),harmonics=second+(frequency*3<=this.sampledRate*.45?power(frequency*3):0),fraction=2*fundamental/(energy/n);
  // Autocorrelation alone also follows repetitive broadband transients.
  if(fraction<.08||harmonics<fundamental*.012&&b<.96)return null;
  return {frequency,cents:1200*Math.log2(frequency),rms,correlation:b,retention:late/Math.max(1e-20,early)};
 }
}

// PRIVATE candidate experiment. A resolved partial is not proof of a note.
// Every frequency hypothesis must pass native source/family admission.
class PartialLineOnset {
 constructor(rate,n,emit){this.rate=rate;this.n=n;this.emit=emit;this.reset();}
 reset(){this.nodes=[];this.lastTime=-Infinity;}
 observe(power,time,gate){
  if(!power||!Number.isFinite(time)||time<=this.lastTime)return;
  if(time-this.lastTime>.12)this.reset();this.lastTime=time;
  const binHz=this.rate/this.n,high=Math.min(13200,this.rate*.45),floor=Math.max(1e-16,gate*gate*.002);
  let total=0;for(const p of power)total+=Math.max(0,p);if(total<floor)return;
  const median=bin=>{const a=[];for(let j=Math.max(1,bin-6);j<=Math.min(power.length-2,bin+6);j++)a.push(power[j]);a.sort((a,b)=>a-b);return a[a.length>>1]||0;};
  const peaks=[];
  for(let bin=Math.ceil(80/binHz);bin<power.length-1&&bin*binHz<=high;bin++){
   const p=power[bin];if(!(p>power[bin-1]&&p>=power[bin+1]&&p>Math.max(floor,total*.001,median(bin)*8)))continue;
   const a=Math.log(Math.max(1e-30,power[bin-1])),b=Math.log(Math.max(1e-30,p)),c=Math.log(Math.max(1e-30,power[bin+1])),d=a-2*b+c;
   const shift=Math.abs(d)>1e-12?Math.max(-.5,Math.min(.5,.5*(a-c)/d)):0;
   peaks.push({f:(bin+shift)*binHz,p});
  }
  const used=new Set(),ready=[];
  for(const q of peaks.sort((a,b)=>b.p-a.p).slice(0,56)){
   let best=-1,distance=Infinity;
   for(let i=0;i<this.nodes.length;i++){
    if(used.has(i))continue;const node=this.nodes[i],d=Math.abs(q.f-node.anchorF)/Math.max(binHz*.3,node.anchorF*.04);
    if(d<distance){distance=d;best=i;}
   }
   if(best<0||distance>1){this.nodes.push({anchorF:q.f,f:q.f,first:time,last:time,count:1,peak:q.p,valley:q.p,armed:true,rising:true,ever:false,lastProposal:-Infinity});used.add(this.nodes.length-1);continue;}
   const node=this.nodes[best];used.add(best);
   if(time-node.last>.055){node.first=time;node.count=0;node.armed=true;node.rising=true;node.peak=q.p;node.valley=q.p*.25;}
   node.last=time;node.count++;node.f=node.f*.6+q.f*.4;node.peak=Math.max(node.peak*.994,q.p);node.valley=Math.min(node.valley,q.p);
   if(q.p<node.peak*.18&&!node.armed){node.armed=true;node.rising=false;node.first=null;node.count=0;node.valley=q.p;}
   if(node.armed&&!node.rising){
    node.valley=Math.min(node.valley,q.p);
    if(q.p>Math.max(floor*2,node.valley*2.5)){node.rising=true;node.first=time;node.count=1;}
    else node.count=0;
   }
   if(node.armed&&node.rising&&node.count>=5&&time-node.first>=.026&&time-node.lastProposal>.12&&(!node.ever||q.p>node.valley*2.5)){
    const alternatives=[];
    for(let observedHarmonic=1;observedHarmonic<=4;observedHarmonic++){
     const f=node.f/observedHarmonic;if(f<80||f>3300)continue;
     const parts=[];let score=0;
     for(let h=1;h<=4;h++){
      const center=f*h/binHz;let p=0,at=-1;for(let j=Math.max(1,Math.floor(center)-1);j<=Math.min(power.length-2,Math.ceil(center)+1);j++)if(power[j]>p){p=power[j];at=j;}
      if(at<0||p<Math.max(floor,median(at)*6))p=0;parts.push(p);score+=Math.sqrt(p)/Math.sqrt(h);
     }
     alternatives.push({frequency:f,time:node.first,observedHarmonic,partialFrequency:node.f,parts,score});
    }
    alternatives.sort((a,b)=>b.score-a.score);
    if(alternatives.length)ready.push({node,alternatives,energy:q.p});
    node.armed=false;node.ever=true;node.lastProposal=time;node.valley=q.p;node.peak=q.p;
   }
  }
  this.nodes=this.nodes.filter(node=>time-node.last<.30).slice(-128);
  for(const q of ready.sort((a,b)=>b.energy-a.energy).slice(0,6)){
   const chosen=q.alternatives[0];
   this.emit({type:'onset',source:'periodic',familyProposal:true,partialProposal:true,
    time:chosen.time,frequency:chosen.frequency,observedTime:time,level:Math.sqrt(q.energy),
    partialFrequency:q.node.f,proposalKind:'resolved-partial-rise',familyCandidates:q.alternatives});
  }
 }
}
// Batch adjacent stable line births into a single source-audit job. Each
// alternative keeps its own source timestamp; the validator must use it.
class MultiHarmonicFamilyOnset {
 constructor(rate,n,emit){this.emit=emit;this.line=new PartialLineOnset(rate,n,m=>this.collect(m));this.pending=[];this.pendingSince=null;this.lastTime=-Infinity;}
 reset(){this.line.reset();this.pending=[];this.pendingSince=null;this.lastTime=-Infinity;}
 collect(message){if(this.pendingSince===null)this.pendingSince=message.observedTime;this.pending.push(message);}
 flush(){
  if(!this.pending.length)return;
  const candidates=[];
  for(const message of this.pending)for(const q of message.familyCandidates){
   const old=candidates.find(p=>Math.abs(p.time-q.time)<.035&&Math.abs(1200*Math.log2(p.frequency/q.frequency))<35);
   if(!old)candidates.push({...q,level:message.level});else if(q.score>old.score)Object.assign(old,q,{level:message.level});
  }
  candidates.sort((a,b)=>b.score-a.score);const kept=candidates.slice(0,64),chosen=kept[0];
  if(chosen)this.emit({type:'onset',source:'periodic',familyProposal:true,partialProposal:true,time:chosen.time,frequency:chosen.frequency,level:chosen.level,observedTime:this.pending.at(-1).observedTime,proposalKind:'batched-partial-rise',familyCandidates:kept,lineProposals:this.pending.length});
  this.pending=[];this.pendingSince=null;
 }
 observe(power,time,gate){
  if(!Number.isFinite(time)||time<=this.lastTime)return;
  if(time-this.lastTime>.12)this.reset();this.lastTime=time;
  this.line.observe(power,time,gate);if(this.pendingSince!==null&&time-this.pendingSince>=.080)this.flush();
 }
}

// Private supplementary proof. Call only after the actual rendered source was
// projected from native-rate PCM and an independent instrument snapshot exists.
// This verifies short bodies; it neither finds candidates nor replaces the
// existing long proof, source projection, or family/time deduplication.
class PhaseVerifiedShortNativeFamilyProof {
  constructor(rate, nativePower=null, collectDiagnostics=false, nativePhase=null) {
    this.rate = rate; this.nativePower=nativePower;this.nativePhase=nativePhase;
    this.collectDiagnostics=collectDiagnostics; this.hannCache=new Map();
  }

  useImmutableSamples(samples) {
    if(this.immutableSamples!==samples){this.immutableSamples=samples;this.immutableFrames=new Map();}
  }

  frame(samples, start, count) {
    start = Math.round(start);
    if (start < 0 || start + count > samples.length) return null;
    const cache=this.immutableSamples===samples?this.immutableFrames:null,key=start+':'+count;
    if(cache?.has(key))return cache.get(key);
    const values = new Float64Array(count);
    let weights=this.hannCache.get(count);
    if(!weights){weights=Float64Array.from({length:count},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(count-1)));this.hannCache.set(count,weights);}
    let norm = 0, total = 0;
    for (let i = 0; i < count; i++) {
      const x = samples[start + i], w = weights[i];
      values[i] = x * w; norm += w; total += x * x / count;
    }
    const result={ values, norm, total, familyPowers:new Map() };
    if(cache){if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(key,result);}
    return result;
  }

  power(frame, frequency) {
    if(frame.familyPowers.has(frequency))return frame.familyPowers.get(frequency);
    if(this.nativePower){const value=this.nativePower(frame,frequency);if(Number.isFinite(value)){frame.familyPowers.set(frequency,value);return value;}}
    const c = 2 * Math.cos(2 * Math.PI * frequency / this.rate);
    let a = 0, b = 0;
    for (const x of frame.values) { const n = x + c * a - b; b = a; a = n; }
    const result=Math.max(0, a * a + b * b - c * a * b) / (frame.norm * frame.norm);
    frame.familyPowers.set(frequency,result);return result;
  }

  peak(frame, requested, harmonic) {
    const radius = requested * .10, step = radius / 16;
    let frequency = requested, power = this.power(frame, requested * harmonic);
    for (let i = -16; i <= 16; i++) {
      const q = requested + i * step;
      const p = this.power(frame, q * harmonic);
      if (p > power) { frequency = q; power = p; }
    }
    const center = frequency;
    for (let i = -4; i <= 4; i++) {
      const q = center + i * step / 4, p = this.power(frame, q * harmonic);
      if (p > power) { frequency = q; power = p; }
    }
    return { frequency, power, harmonic };
  }


  phase(frame, frequency) {
    if(this.nativePhase)return this.nativePhase(frame,frequency);
    const omega=2*Math.PI*frequency/this.rate,c=2*Math.cos(omega);let a=0,b=0;
    for(const x of frame.values){const next=x+c*a-b;b=a;a=next;}
    return Math.atan2(b*Math.sin(omega),a-b*Math.cos(omega));
  }

  verify(samples, eventIndex, frequency, gate, evidence = {}) {
    const reject = (reason, detail = {}) => ({ ok: false, reason, ...detail });
    if (evidence.owned !== true || evidence.sourceTrusted !== true || evidence.sourceProjected !== true) return reject('unproven-source');
    if (!Number.isFinite(frequency) || frequency < 80 || frequency > Math.min(3300, this.rate * .45 / 4)) return reject('invalid-frequency');
    if (!Number.isFinite(gate) || gate < 0 || !Number.isFinite(eventIndex)) return reject('invalid-input');
    const n = Math.round(.016 * this.rate);
    const before = this.frame(samples, eventIndex - n, n);
    const first = this.frame(samples, eventIndex + Math.round(.008 * this.rate), n);
    const second = this.frame(samples, eventIndex + Math.round(.024 * this.rate), n);
    if (!before || !first || !second) return reject('source-window-incomplete');
    const frames=[before,first,second],peaks=[[],[],[]];
    const peakAt=(frameIndex,h)=>peaks[frameIndex][h-1]??=(this.peak(frames[frameIndex],frequency,h));
    const floor = Math.max(1e-16, gate * gate * .012);
    const pairs = [[1, 4], [2, 3], [3, 4], [1, 3], [1, 2], [5, 7], [5, 6], [6, 7], [7, 8], [3, 7], [4, 7], [3, 5], [4, 5], [1, 5], [1, 6], [1, 7], [1, 8], [2, 5], [2, 7], [3, 8], [5, 8]];
    const diagnostics = [];
    for (const pair of pairs) {
      if (pair.some(h => frequency * h * .016 < 4 || frequency * h > this.rate*.45)) continue;
      let old;
      const a = pair.map(h => peakAt(1,h));
      const b = pair.map(h => peakAt(2,h));
      const roots = [...a, ...b].map(q => q.frequency);
      const root = roots.reduce((s, f) => s + f, 0) / roots.length;
      const sumA = a.reduce((s, q) => s + q.power, 0), sumB = b.reduce((s, q) => s + q.power, 0);
      const concentration = Math.min(2 * sumA / Math.max(1e-30, first.total), 2 * sumB / Math.max(1e-30, second.total));
      const describe=()=>({ pair, root, roots, oldRoots: old.map(q => q.frequency), powers: [old, a, b].map(parts => parts.map(q => q.power)), concentration });
      let physical;
      if(this.collectDiagnostics){old=pair.map(h=>peakAt(0,h));physical=describe();diagnostics.push(physical);}
      const higherOnly = pair.every(h => h >= 3);
      if (Math.max(...roots) - Math.min(...roots) > root * .008 || Math.abs(1200 * Math.log2(root / frequency)) > 55) continue;
      if (a.some(q => q.power <= floor) || b.some(q => q.power <= floor)) continue;
      if (concentration < (higherOnly ? .012 : .12) || sumB < sumA * .35 || sumA < sumB * .25) continue;
      if ([a, b].some(parts => Math.min(...parts.map(q => q.power)) < Math.max(...parts.map(q => q.power)) * .008)) continue;
      old??=pair.map(h=>peakAt(0,h));physical??=describe();
      // Before the event an already present nearby family defeats novelty.
      // A resolved semitone at a high native partial may instead show a pitch
      // transition even when the 16ms fundamental window leaks the old note.
      const priorSame = old.map((q, i) => Math.abs(1200 * Math.log2(q.frequency / root)) < 60 && q.power >= Math.min(a[i].power, b[i].power) * .20);
      if (priorSame.every(Boolean)) continue;
      const novel = old.map((q, i) => Math.min(a[i].power, b[i].power) > q.power * 2.5 + floor || (q.power > floor && Math.abs(1200 * Math.log2(q.frequency / root)) > 85 && !priorSame[i]));
      if (!novel.every(Boolean)) continue;
      // Independent phase clocks distinguish a true native period from
      // nearby shoulders whose16ms spectral maxima happen to agree.
      const phaseRoots=pair.map(h=>{const difference=this.phase(second,root*h)-this.phase(first,root*h)-2*Math.PI*root*h*.016,error=Math.atan2(Math.sin(difference),Math.cos(difference));return root+error/(2*Math.PI*.016*h);});
      physical.phaseRoots=phaseRoots;
      if(Math.abs(phaseRoots[0]-phaseRoots[1])>Math.max(4,root*.006)||phaseRoots.some(q=>Math.abs(q-root)>Math.max(6,root*.02)))continue;
      // A smooth AM valley is not a new key attack: keep earlier resolved
      // native-family presence separate from the short immediate baseline.
      const prior=this.frame(samples,eventIndex-Math.round(.14*this.rate),Math.round(.064*this.rate));
      if(prior){
        const priorPeaks=pair.map(h=>this.peak(prior,root,h));
        const priorSameFamily=priorPeaks.every((q,i)=>Math.abs(1200*Math.log2(q.frequency/root))<=75&&q.power>Math.max(floor*.2,Math.min(a[i].power,b[i].power)*.001))&&Math.abs(priorPeaks[0].frequency-priorPeaks[1].frequency)<=root*.008;
        if(priorSameFamily){
          // A rearticulation may cross an observed silent release. Do not
          // infer this solely from a relative dip in the louder body.
          const shortN=Math.round(.008*this.rate),hop=Math.round(.004*this.rate),limits=pair.map((h,i)=>Math.max(1e-16,gate*gate*.00005,Math.min(a[i].power,b[i].power)*.001));
          let silent=0,rearmed=false;
          for(let at=Math.round(eventIndex-.10*this.rate);at<=eventIndex;at+=hop){const frame=this.frame(samples,at,shortN);if(!frame)continue;const absent=pair.every((h,i)=>this.power(frame,root*h)<limits[i]);silent=absent?silent+hop:0;if(silent>=Math.round(.008*this.rate)){rearmed=true;break;}}
          if(!rearmed){physical.priorResolved=true;continue;}
        }
      }
      return { ok: true, reason: 'phase-verified-short-native-family', frequency: root, sourceIndex: Math.round(eventIndex), physical, windowsMs: [-16, 8, 24], proofEndIndex: Math.round(eventIndex) + Math.round(.040 * this.rate) };
    }
    return reject('short-native-family-unconfirmed', { diagnostics });
  }
}
