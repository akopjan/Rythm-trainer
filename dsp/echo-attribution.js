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
  this.sourceFamilyLifetimes=[];this.total=0;this.baseTime=null;this.filters=[0,0];this.pending=[];this.meta={enabled:false};Object.assign(this,diagnostic);this.timing=timing;this.currentTime=0;this.renderBlockLength=0;this.captureBlockLength=0;
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
  this.freezeEvidence(evidenceTime);
  // A missing, stale or unproven reference does not prove an own attack.
  if(meta.enabled!==false&&!meta.ready&&!meta.noEchoProof&&!meta.canAudit){for(const job of this.pending)this.drop(job,'reference-unavailable',{stage:'process'});this.pending=[];return;}
  if(meta.enabled===false||meta.noEchoProof&&!meta.renderRecent){for(const job of this.pending)this.accept(job);this.pending=[];return;}
  if(!this.deferredAnalysis)this.advanceReady();
 }
 freezeEvidence(evidenceTime){
  // A getter may expose an FFT frame completed after process() captured its
  // metadata. Use only already-observed source time in this capture epoch.
  if(!Number.isFinite(evidenceTime)||evidenceTime>this.currentTime)return;
  const meta=this.meta;
  const snapshot=time=>Object.freeze({time:evidenceTime,own:typeof meta.instrumentEvidence==='function'&&meta.instrumentEvidence(time),tonal:meta.renderRecent===true&&typeof meta.tonalEvidence==='function'&&meta.tonalEvidence(time),renderRecent:meta.renderRecent===true});
  for(const job of this.pending){
   const bounds=this.familyBounds(job);
   if(bounds){
    if(job.familyEvidenceSnapshots||evidenceTime<bounds.last+.13)continue;
    job.familyEvidenceSnapshots=Object.freeze(job.message.familyCandidates.map(q=>snapshot(q.time)));
    const index=job.message.familyCandidates.findIndex(q=>q.time===job.message.time&&q.frequency===job.message.frequency);job.evidenceSnapshot=job.familyEvidenceSnapshots[Math.max(0,index)];
   }else if(!job.evidenceSnapshot&&evidenceTime>=job.message.time+.13)job.evidenceSnapshot=snapshot(job.message.time);
  }
 }
 canAdvance(){
  this.freezeEvidence(typeof this.meta.getEvidenceTime==='function'?this.meta.getEvidenceTime():this.meta.evidenceTime);
  const job=this.pending[0];if(!job)return false;
  const meta=this.meta;
  if(meta.enabled===false||meta.noEchoProof&&!meta.renderRecent||!meta.ready&&!meta.noEchoProof&&!meta.canAudit)return true;
  if(!job.stage&&this.total<this.captureEnd(job))return false;
  if(this.familyBounds(job)&&!job.familyEvidenceSnapshots)return false;
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
   if(this.familyBounds(job)&&job.familyEvidenceSnapshots?.every(q=>q.own!==true)){this.reject(job,'tone-unconfirmed');this.pending.shift();return true;}
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
  const family=this.sanitizeFamilyCandidates(message);
  if(family){if(!family.length){this.drop({message},'invalid-candidate',{stage:'queue'});return;}message={...message,familyCandidates:family};}
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
  if(this.familyBounds(job)){this.beginFamilyVerification(job);return;}
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
    // This is an additional positive confirmation only while the source can
    // be audited and raw capture independently proves an instrument family.
    // Established profiles and the older stable-tone paths keep their rules.
    if(!confirmed&&ownEvidence&&this.meta.canAudit===true&&job.message.source!=='periodic'&&job.y)confirmed=this.ordinaryInstrumentTone(job);
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
 familyBounds(job){
  const candidates=job.message?.familyCandidates;if(!job.message?.familyProposal||!Array.isArray(candidates)||!candidates.length)return null;
  return {first:Math.min(...candidates.map(q=>q.time)),last:Math.max(...candidates.map(q=>q.time))};
 }
 sanitizeFamilyCandidates(message){
  if(!message?.familyProposal||!Array.isArray(message.familyCandidates))return null;
  const observed=Number.isFinite(message.observedTime)?message.observedTime:this.currentTime;
  const candidates=[];
  for(const q of message.familyCandidates.slice(0,64)){
   if(!Number.isFinite(q?.time)||q.time>observed||!Number.isFinite(q?.frequency)||q.frequency<80||q.frequency>Math.min(3300,this.rate*.45/2))continue;
   candidates.push(Object.freeze({frequency:q.frequency,time:q.time,level:Number.isFinite(q.level)&&q.level>=0?q.level:message.level,observedHarmonic:Number.isInteger(q.observedHarmonic)&&q.observedHarmonic>=1&&q.observedHarmonic<=4?q.observedHarmonic:1,partialFrequency:Number.isFinite(q.partialFrequency)?q.partialFrequency:q.frequency,parts:Object.freeze(Array.from({length:4},(_,i)=>Number.isFinite(q.parts?.[i])&&q.parts[i]>=0?q.parts[i]:0)),score:Number.isFinite(q.score)?q.score:0}));
  }
  return Object.freeze(candidates);
 }
 beginFamilyVerification(job){
  if(!job.y||!job.familyEvidenceSnapshots){this.reject(job,'tone-unconfirmed');return;}
  job.stage='families';job.familyIndex=0;job.familyResults=[];job.familyDebug=[];job.familyFrameCache=new Map();
 }
 familyNativePrefilter(view){
  if(view.evidenceSnapshot?.own!==true)return false;
  const rate=this.rate,count=Math.floor(.064*rate),requested=view.message.frequency;
  const floor=Math.max(1e-16,view.gate*view.gate*.012),radius=Math.max(6,requested*.02);
  const coprime=(a,b)=>{while(b){const r=a%b;a=b;b=r;}return a===1;};
  const before=[-.30,-.22,-.14].map(t=>this.highNativeFrame(view,view.eventIndex+Math.round(t*rate),count)).filter(Boolean);
  const after=[-.10,-.06,-.02,.012,.05].map(t=>this.highNativeFrame(view,view.eventIndex+Math.round(t*rate),count)).filter(Boolean);
  // Necessary native partial rise only. This permissive check never admits;
  // each retained hypothesis still needs the unchanged native source proof.
  // Sparse named-bin checks discard stationary held families before local
  // frequency refinement, neighboring-peak scans and body confirmation.
  for(const shift of [0,-radius,radius]){
   const frequency=requested+shift;if(frequency<80||frequency>Math.min(3300,rate*.45/2))continue;
   const energy=w=>{const parts=[1,2,3,4].map(h=>frequency*h<=rate*.45?this.highNativePower(w,frequency*h):0);return {parts,sum:parts.reduce((a,b)=>a+b,0),total:w.total};};
   const old=before.map(energy);
   for(const window of after){
    const now=energy(window);
    for(const prior of old){
     if(!(now.sum>prior.sum*1.3&&Math.sqrt(2*now.sum)-Math.sqrt(2*prior.sum)>view.gate*.05))continue;
     const grown=now.parts.map((p,i)=>p>prior.parts[i]*1.3+floor*.025&&p>now.total*.00001?i+1:0).filter(Boolean);
     if(grown.some(a=>grown.some(b=>a<b&&coprime(a,b))))return true;
    }
   }
  }
  return false;
 }
 // Supplementary only: batchFamilyProof calls this after all existing native
 // proofs fail. An existing successful proof/time must be returned verbatim.
 shortBodyFamilyProof(view){
  const own=view.evidenceSnapshot?.own===true,known=own&&(view.message?.profileReady===true||view.message?.waveformReady===true||this.meta.canAudit===true);
  if(!known||!view.message?.familyProposal||view.message.source!=='periodic'||!view.y)return {ok:false,reason:'unproven-short-source'};
  this.shortBodyVerifier??=new PhaseVerifiedShortNativeFamilyProof(this.rate,(frame,frequency)=>this.highNativePower(frame,frequency),false,(frame,frequency)=>this.highNativePhase(frame,frequency));
  this.shortBodyVerifier.useImmutableSamples(view.y);
  const proof=this.shortBodyVerifier.verify(view.y,view.eventIndex,view.message.frequency,view.gate,{owned:own,sourceTrusted:known,sourceProjected:true});
  if(!proof.ok)return proof;
  // This tier confirms an existing proposal's observed body. It neither
  // relocates a previous successful point nor uses a later tone as evidence.
  return {...proof,time:view.message.time,sourceTime:view.message.time,shortNativeBody:true};
 }

 batchFamilyProof(view){
  const f=view.message.frequency;
  let proof=this.computeShortPeriodicSourceProof(view);view.familyBatchAuditShort=proof;
  if(!proof.ok&&typeof this.weakNativeFamilyProof==='function')proof=this.weakNativeFamilyProof(view);
  if(!proof.ok)proof=this.computeLowPeriodicSourceProof(view);
  if(!proof.ok&&f>=1600){
   if(this.highStableInstrumentTone(view)&&this.highPeriodicSourceRise(view)&&Number.isFinite(view.highPeriodicSourceTime)){
    // Re-center the complete native body on the physical rise, never the
    // approximate FFT proposal or an unrelated later queue observation.
    const body={...view,message:{...view.message,time:view.highPeriodicSourceTime},eventIndex:Math.round((view.highPeriodicSourceTime-this.baseTime)*this.rate)-view.start,highNativeFrequency:undefined,highPeriodicVerified:false};
    if(this.highStableInstrumentTone(body))proof={ok:true,time:view.message.time,sourceTime:view.highPeriodicSourceTime,frequency:view.highNativeFrequency??f,highFamily:true};
   }
  }
  if(!proof.ok)proof=this.shortBodyFamilyProof(view);
  if(!proof.ok||!Number.isFinite(proof.sourceTime))return {ok:false,reason:proof.reason??'native-rise-not-located'};
  // A batch proposal is a timing hypothesis. Its verified physical start may
  // lie on either side; the original legacy proof keeps its earlier clamp.
  if(proof.sourceTime<view.message.time-.32||proof.sourceTime>view.message.time+.064)return {ok:false,reason:'native-source-outside-window'};
  return proof;
 }
 supplementalNativeLocalPeak(job,r){
  const p=r.proof,rate=this.rate,f=p?.frequency,no=(reason,extra={})=>({ok:false,reason,...extra});
  if(!p?.ok||p.earliestValidBody!==true||!Number.isFinite(p.sourceTime)||!Number.isFinite(f)||!Array.isArray(p.pair)||p.pair.length!==2||!Number.isInteger(p.pair[1])||p.pair[1]<1||p.pair[1]>3)return no('unlocated-native-peak-body');
  const harmonic=p.pair[1]+1,count=Math.floor(.064*rate),center=Math.round(((p.sourceTime-this.baseTime)*rate-job.start)*2)/2;
  const radius=Math.max(8,f*.02),steps=Math.ceil(radius/2),tolerance=Math.max(4,f*.006);
  if(f-radius<=0||(f+radius)*harmonic>rate*.45||f*.064<4)return no('native-peak-band-or-cycles');
  const frames=[this.highNativeFrame(job,center+.012*rate,count),this.highNativeFrame(job,center+.044*rate,count)];
  if(frames.some(w=>!w))return no('native-peak-body-incomplete');
  const peaks=[];
  for(let window=0;window<2;window++)for(const h of [1,harmonic]){
   const values=[];
   for(let i=-steps;i<=steps;i++){const root=f+radius*i/steps;values.push({root,power:this.highNativePower(frames[window],root*h)});}
   let at=0;for(let i=1;i<values.length;i++)if(values[i].power>values[at].power)at=i;
   const best=values[at],interior=at>0&&at+1<values.length;
   const local=interior&&best.power>values[at-1].power&&best.power>values[at+1].power;
   peaks.push({window,harmonic:h,root:best.root,power:best.power,interior,local,namedPower:values[steps].power,edgePowers:[values[0].power,values.at(-1).power]});
   if(!local)return no('native-peak-not-interior',{frequency:f,radius,tolerance,peaks});
  }
  const roots=peaks.map(p=>p.root);
  if(roots.some(root=>Math.abs(root-f)>tolerance)||Math.max(...roots)-Math.min(...roots)>tolerance)return no('native-local-peaks-disagree',{frequency:f,radius,tolerance,peaks});
  return {ok:true,reason:'native-local-peaks-confirmed',frequency:f,radius,tolerance,peaks};
 }
 supplementalNativePhase(job,r){
  const p=r.proof,rate=this.rate,f=p?.frequency,no=reason=>({ok:false,reason});
  if(!p?.ok||p.earliestValidBody!==true||!Number.isFinite(p.sourceTime)||!Number.isFinite(f)||!Array.isArray(p.pair)||p.pair.length!==2||!Number.isInteger(p.pair[1])||p.pair[1]<1||p.pair[1]>3)return no('unlocated-native-phase-body');
  const h=p.pair[1]+1,count=Math.floor(.064*rate),center=Math.round(((p.sourceTime-this.baseTime)*rate-job.start)*2)/2;
  if(f*.064<4||f*h>rate*.45)return no('native-phase-band-or-cycles');
  const first=this.highNativeFrame(job,center+.012*rate,count),second=this.highNativeFrame(job,center+.044*rate,count);
  if(!first||!second)return no('native-phase-body-incomplete');
  const actual=[first,second].map(frame=>[1,2,3,4].map(k=>k*f<=rate*.45?this.highNativePower(frame,k*f):0));
  if(!Array.isArray(p.first?.parts)||!Array.isArray(p.second?.parts)||actual[0].some((v,i)=>!Object.is(v,p.first.parts[i]))||actual[1].some((v,i)=>!Object.is(v,p.second.parts[i])))return no('native-phase-body-not-recorded-body');
  const floor=Math.max(1e-16,job.gate*job.gate*.012);
  if(actual.some(parts=>parts[0]<=floor||parts[h-1]<=Math.max(floor,parts[0]*.012)))return no('native-phase-partner-too-weak');
  const phase=(frame,f)=>this.highNativePhase(frame,f);
  const clocks=[1,h].map(k=>{const d=phase(second,f*k)-phase(first,f*k)-2*Math.PI*f*k*.032;return f+Math.atan2(Math.sin(d),Math.cos(d))/(2*Math.PI*.032*k);});
  const tolerance=Math.max(4,f*.006),ok=Math.abs(clocks[0]-clocks[1])<=tolerance&&clocks.every(q=>Math.abs(q-f)<=tolerance);
  return {ok,reason:ok?'native-supplement-phase-confirmed':'native-supplement-phase-disagreement',frequency:f,partner:h,phaseRoots:clocks,tolerance,bodyStarts:[this.baseTime+(job.start+Math.round(center+.012*rate))/rate,this.baseTime+(job.start+Math.round(center+.044*rate))/rate]};
 }
 sourceBirthIdentity(proof){
  if(!proof?.ok||proof.missingFundamental===true)return {h1:false};
  const direct=w=>w&&Array.isArray(w.parts)&&Number.isFinite(w.parts[0])&&Number.isFinite(w.total)&&w.total>0?w.parts[0]/w.total:null;
  let first=direct(proof.first),second=direct(proof.second),method='measured-native-body';
  if(first===null||second===null){
   const p=proof.physical,index=p?.pair?.indexOf(1);
   if(proof.shortNativeBody!==true||index===undefined||index<0||!Number.isFinite(p.concentration)||!Array.isArray(p.powers)||p.powers.length!==3)return {h1:false};
   // concentration=min(2*sumA/totalA,2*sumB/totalB). It yields a
   // conservative measured H1/total lower bound for each actual window.
   const bound=values=>{const sum=values.reduce((a,b)=>a+b,0);return sum>0&&values.every(Number.isFinite)?p.concentration*.5*values[index]/sum:null;};
   first=bound(p.powers[1]);second=bound(p.powers[2]);method='short-H1-measured-lower-bound';
  }
  return {h1:Number.isFinite(first)&&Number.isFinite(second)&&first>=.025&&second>=.025,first,second,method};
 }
 sourceBirthHarmonic(a,b,max=Infinity){
  if(!(Number.isFinite(a)&&Number.isFinite(b)&&a>0&&b>0))return false;
  const ratio=Math.max(a,b)/Math.min(a,b),h=Math.round(ratio);
  return h>=1&&h<=max&&Math.abs(1200*Math.log2(ratio/h))<=35;
 }
 sourceBirthSeparate(a,b,parents=[]){
  if(!(a?.native===true&&b?.identity?.h1===true&&Number.isFinite(a.birth)&&Number.isFinite(b.birth)&&Math.abs(a.birth-b.birth)>=.035))return false;
  if(this.sourceBirthHarmonic(a.frequency,b.frequency))return false;
  if(true&&parents.some(p=>p.frequency<Math.min(a.frequency,b.frequency)&&Math.abs(p.time-a.time)<.060&&Math.abs(p.time-b.time)<.060&&this.sourceBirthHarmonic(p.frequency,a.frequency,8)&&this.sourceBirthHarmonic(p.frequency,b.frequency,8)))return false;
  return true;
 }
 advanceFamilyVerification(job){
  const candidates=job.message.familyCandidates;
  if(job.familyIndex<candidates.length){
   const index=job.familyIndex++,q=candidates[index],snapshot=job.familyEvidenceSnapshots[index];
   const view={...job,message:{...job.message,...q,familyCandidates:undefined,familyProposal:true,familyBatchAudit:true,source:'periodic'},eventIndex:Math.round((q.time-this.baseTime)*this.rate)-job.start,evidenceSnapshot:snapshot,lowPeriodicProof:undefined,lowPeriodicTimeApplied:false,highPeriodicVerified:false,highPeriodicSourceTime:undefined,highNativeFrequency:undefined};
   if(snapshot?.own!==true){job.familyDebug.push({index,frequency:q.frequency,time:q.time,reason:'no-own-evidence'});return;}
   if(!this.familyNativePrefilter(view)){job.familyDebug.push({index,frequency:q.frequency,time:q.time,reason:'no-native-energy'});return;}
   const proof=this.batchFamilyProof(view);
   job.familyDebug.push({index,frequency:q.frequency,time:q.time,reason:proof.ok?'instrument':proof.reason,sourceTime:proof.sourceTime});
   if(proof.ok)job.familyResults.push({q,proof,time:proof.sourceTime,frequency:proof.frequency??q.frequency,lineage:[q]});
   return;
  }
  const groups=[];
  for(const r of job.familyResults.sort((a,b)=>a.frequency-b.frequency||a.time-b.time)){
   const previous=groups.find(p=>Math.abs(p.time-r.time)<.060&&Math.abs(1200*Math.log2(p.frequency/r.frequency))<35);
   if(previous){previous.lineage.push(...r.lineage);if(r.time<previous.time){previous.time=r.time;previous.proof=r.proof;}continue;}
   groups.push(r);
  }
  const retained=[];
  for(const r of groups){
   const ancestor=retained.find(p=>{
    const ratio=r.frequency/p.frequency,h=Math.round(ratio);if(h<2||h>4||Math.abs(1200*Math.log2(ratio/h))>35||Math.abs(p.time-r.time)>=.060)return false;
    // Only descendants of the same observed physical line and same new
    // source group merge. An unrelated interval (such as B4/E4) is retained.
    return p.lineage.some(a=>r.lineage.some(b=>Math.abs(a.time-b.time)<.035&&Math.abs(a.partialFrequency-b.partialFrequency)<=Math.max(6,a.partialFrequency*.02)));
   });
   if(ancestor){ancestor.lineage.push(...r.lineage);continue;}retained.push(r);
  }
  const birthParents=groups.filter(r=>this.sourceBirthIdentity(r.proof).h1&&this.sourceFamilyLifetimeAllowed(job,r).allow).map(r=>({time:r.time,birth:r.q.time,frequency:r.frequency,native:true,identity:this.sourceBirthIdentity(r.proof)}));
  const supplementalBlocked=[];
  const emitted=[];
  for(const r of retained.sort((a,b)=>a.time-b.time)){
   if(emitted.some(time=>Math.abs(time-r.time)<.060)){
    const lifetime=this.sourceFamilyLifetimeAllowed(job,r);
    if(lifetime.allow)supplementalBlocked.push({r,reason:'batch60-only'});
    continue;
   }
   const lifetime=this.sourceFamilyLifetimeAllowed(job,r);job.familyDebug.push({lifetime,time:r.time,frequency:r.frequency});
   if(!lifetime.allow)continue;
   this.recordSourceFamilyLifetime(r);emitted.push(r.time);
   const {familyCandidates,...message}=job.message;
   this.accepted++;this.lastDecision={time:r.time,reason:'instrument'};
   const scored=this.emit({...message,time:r.time,frequency:r.frequency,level:r.q.level,source:'periodic',familyProposal:true,sourceVerified:true,originalFamilyTime:r.q.time,nativeBirthIdentity:this.sourceBirthIdentity(r.proof)});
   if(scored===false)supplementalBlocked.push({r,reason:'global60-only'});
  }
  if(typeof this.publishNativeSupplemental==='function')for(const candidate of supplementalBlocked){
   const result=this.publishNativeSupplemental(job,candidate.r,birthParents,candidate.reason);
   job.familyDebug.push({supplemental:result,time:candidate.r.time,frequency:candidate.r.frequency});
  }
  if(!emitted.length){this.reject(job,'tone-unconfirmed');return;}
  job.done=true;this.finishTiming(job);
 }

 // A previously verified family may grow late higher partials without a
 // second articulation. Only the same native fundamental is considered;
 // added upper voices and other pitches are not folded into a lower family.
 sourceFamilyLifetimeAllowed(job,r){
  if((this.sourceFamilyLifetimes??[]).some(p=>Math.abs(p.time-r.time)<.060&&Math.abs(1200*Math.log2(p.frequency/r.frequency))<35))return {allow:false,reason:'native-family-already-emitted'};
  const previous=(this.sourceFamilyLifetimes??[]).filter(p=>p.time<r.time&&r.time-p.time<=.32&&Math.abs(1200*Math.log2(p.frequency/r.frequency))<35).sort((a,b)=>b.time-a.time)[0];
  if(!previous)return {allow:true,reason:'new-family'};
  const rate=this.rate,count=Math.floor(Math.max(.006,Math.min(.012,4/r.frequency))*rate),half=(count-1)/2,frequency=r.frequency;
  const frameAt=t=>this.highNativeFrame(job,Math.round((t-this.baseTime)*rate)-job.start-half,count);
  const prior=frameAt(previous.time+.036),next=frameAt(r.time+.036);
  if(!prior||!next)return {allow:true,reason:'continuity-history-unavailable'};
  const priorPower=this.highNativePower(prior,frequency),nextPower=this.highNativePower(next,frequency),limit=Math.min(priorPower,nextPower)*.12;
  if(!(limit>Math.max(1e-16,job.gate*job.gate*.0005)))return {allow:true,reason:'continuity-family-too-weak'};
  const step=Math.max(1,Math.round(.004*rate));let valley=0,minimum=Infinity;
  for(let t=previous.time+.016;t<=r.time+.004;t+=step/rate){
   const frame=frameAt(t);if(!frame)return {allow:true,reason:'continuity-history-unavailable'};
   const value=this.highNativePower(frame,frequency);minimum=Math.min(minimum,value);
   if(value<limit)valley+=step;else valley=0;
   if(valley>=Math.round(.008*rate))return {allow:true,reason:'native-family-rearmed',minimum,limit,previousTime:previous.time};
  }
  return {allow:false,reason:'native-family-still-active',minimum,limit,previousTime:previous.time};
 }
 recordSourceFamilyLifetime(r){
  this.sourceFamilyLifetimes??=[];this.sourceFamilyLifetimes=this.sourceFamilyLifetimes.filter(p=>r.time-p.time<2.5);
  this.sourceFamilyLifetimes.push({time:r.time,frequency:r.frequency});
 }

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
  start=Math.round(start);const cache=job.familyFrameCache,key=start+':'+count;if(cache?.has(key))return cache.get(key);
  if(start<0||start+count>job.y.length)return null;
  const values=new Float64Array(count);let norm=0,total=0;
  if(Number.isInteger(count)&&count>=2){
   this.nativeWindowCache??=new Map();let window=this.nativeWindowCache.get(count);
   if(!window){const weights=new Float64Array(count);let sum=0;for(let i=0;i<count;i++){const w=.5-.5*Math.cos(2*Math.PI*i/(count-1));weights[i]=w;sum+=w;}window={weights,norm:sum};if(this.nativeWindowCache.size>=16)this.nativeWindowCache.delete(this.nativeWindowCache.keys().next().value);this.nativeWindowCache.set(count,window);}
   norm=window.norm;for(let i=0;i<count;i++){const x=job.y[start+i];values[i]=x*window.weights[i];total+=x*x/count;}
  }else for(let i=0;i<count;i++){const x=job.y[start+i],w=.5-.5*Math.cos(2*Math.PI*i/(count-1));values[i]=x*w;norm+=w;total+=x*x/count;}
  const frame={values,norm,total};if(cache){frame.familyPowers=new Map();cache.set(key,frame);}return frame;
 }
 highNativePhase(frame,frequency){
  const omega=2*Math.PI*frequency/this.rate,c=2*Math.cos(omega),states=this.kernel?.nativeStates(frame,c);
  if(states!==null&&states!==undefined)return Math.atan2(states.b*Math.sin(omega),states.a-states.b*Math.cos(omega));
  let a=0,b=0;for(const x of frame.values){const next=x+c*a-b;b=a;a=next;}
  return Math.atan2(b*Math.sin(omega),a-b*Math.cos(omega));
 }
 highNativePower(frame,frequency){
  if(frame.familyPowers?.has(frequency))return frame.familyPowers.get(frequency);
  const c=2*Math.cos(2*Math.PI*frequency/this.rate);
  if(this.kernel?.nativeReady){const result=this.kernel.nativePower(frame,c);if(Number.isFinite(result)){frame.familyPowers?.set(frequency,result);return result;}}
  let a=0,b=0;
  for(const x of frame.values){const n=x+c*a-b;b=a;a=n;}
  const result=Math.max(0,a*a+b*b-c*a*b)/(frame.norm*frame.norm);frame.familyPowers?.set(frequency,result);return result;
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
  const onsetPower=old.sum+(now.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*this.rate)),limit=job.eventIndex+Math.round((job.message?.familyBatchAudit?.048:-.020)*this.rate);
  for(let start=early;start<=limit;start+=step){const frame=this.highNativeFrame(job,start,count),observed=energy(frame);if(observed.sum<onsetPower||observed.fundamental<observed.total*.025)continue;const sourceTime=this.baseTime+(job.start+start+(count-1)/2)/this.rate;job.highPeriodicSourceTime=sourceTime;job.message.originalPeriodicTime=job.message.time;job.message.time=Math.min(job.message.time,sourceTime);break;}
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
 computeShortPeriodicSourceProof(job){
 const frequency=job.message?.frequency,rate=this.rate,count=Math.floor(.032*rate);
 const own=job.evidenceSnapshot?.own===true,known=own&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true);
 if(!known||job.message?.source!=='periodic'||!job.y||!Number.isFinite(frequency)||frequency<80||frequency>Math.min(job.message?.familyBatchAudit?3300:1400,rate*.45/2))return {ok:false,reason:'unproven-source'};
 const early=job.eventIndex-Math.round(.140*rate),late=job.eventIndex+Math.round(.020*rate);
 const frame=start=>this.highNativeFrame(job,start,count),energy=window=>{if(!window)return null;const parts=[1,2,3,4].map(h=>frequency*h<=rate*.45?this.highNativePower(window,frequency*h):0),sum=parts.reduce((a,b)=>a+b,0);return {parts,sum,total:window.total,fraction:2*sum/Math.max(1e-20,window.total)};};
 const oldFrame=frame(early),afterFrame=frame(late),old=energy(oldFrame),after=energy(afterFrame);
 if(!old||!after)return {ok:false,reason:'source-window-incomplete'};
 const neighbour=old.parts.slice(),radius=Math.max(6,frequency*.02);
 for(let offset=-radius;offset<=radius;offset+=3)for(let h=1;h<=4;h++)if((frequency+offset)*h<=rate*.45)neighbour[h-1]=Math.max(neighbour[h-1],this.highNativePower(oldFrame,(frequency+offset)*h));
 const floor=Math.max(1e-16,job.gate*job.gate*.012),newPartial=[1,2,3].some(h=>after.parts[h]>after.parts[0]*.012&&after.parts[h]>neighbour[h]*2.5+floor);
 if(!(after.parts[0]>after.total*.025&&after.fraction>.35&&after.parts[0]>neighbour[0]*2.5+floor&&newPartial&&after.fraction>old.fraction*1.3&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3))return {ok:false,reason:'no-independent-native-rise',old,after,neighbour};
 const onsetPower=old.sum+(after.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*rate)),limit=job.eventIndex+Math.round((job.message?.familyBatchAudit?.048:-.020)*rate);let center=null;
 for(let start=early;start<=limit;start+=step){const observed=energy(frame(start));if(!observed||observed.sum<onsetPower||observed.parts[0]<observed.total*.025)continue;center=start+(count-1)/2;break;}
 if(center===null)return {ok:false,reason:'native-rise-not-located',old,after,neighbour};
 const first=energy(frame(Math.round(center+.020*rate))),second=energy(frame(Math.round(center+.052*rate)));
 if(!first||!second)return {ok:false,reason:'confirmation-incomplete'};
 let dot=0,aa=0,bb=0;for(let h=0;h<4;h++){dot+=first.parts[h]*second.parts[h];aa+=first.parts[h]**2;bb+=second.parts[h]**2;}const shape=dot/Math.sqrt(Math.max(1e-30,aa*bb));
 const stable=first.total>job.gate*job.gate*.04&&second.total>job.gate*job.gate*.04&&first.parts[0]>first.total*.025&&second.parts[0]>second.total*.025&&first.parts.slice(1).reduce((a,b)=>a+b,0)>first.parts[0]*.012&&second.parts.slice(1).reduce((a,b)=>a+b,0)>second.parts[0]*.012&&first.fraction>=.35&&second.fraction>=.35&&second.sum>=first.sum*.65*.65&&shape>=.85;
 if(!stable)return {ok:false,reason:'source-centered-tone-not-stable',old,after,neighbour,first,second,shape,centerTime:this.baseTime+(job.start+center)/rate};
 const time=Math.min(job.message.time,this.baseTime+(job.start+center)/rate);
 return {ok:true,time,sourceTime:this.baseTime+(job.start+center)/rate,frequency,old,after,neighbour,first,second,shape};
}

 computeLowPeriodicSourceProof(job){
 const preserved=job.familyBatchAuditShort??this.computeShortPeriodicSourceProof(job);if(preserved.ok)return preserved;
 const requested=job.message?.frequency,rate=this.rate,count=Math.floor(.032*rate),longCount=Math.floor(.064*rate),halfExtra=Math.round(.016*rate),limit=job.eventIndex;
 const own=job.evidenceSnapshot?.own===true,known=own&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true),maximum=Math.min(job.message?.familyBatchAudit?3300:1400,rate*.45/2);
 if(!known||job.message?.source!=='periodic'||!job.y||!Number.isFinite(requested)||requested<80||requested>maximum)return {ok:false,reason:'unproven-source'};
 const frames=new Map(),powers=new WeakMap();
 const frame=(start,n=count)=>{start=Math.round(start);const key=start+':'+n;if(!frames.has(key))frames.set(key,this.highNativeFrame(job,start,n));return frames.get(key);},nativePower=(window,frequency)=>{let values=powers.get(window);if(!values){values=new Map();powers.set(window,values);}if(!values.has(frequency))values.set(frequency,this.highNativePower(window,frequency));return values.get(frequency);},energy=(window,frequency)=>{if(!window)return null;const parts=[1,2,3,4].map(h=>frequency*h<=rate*.45?nativePower(window,frequency*h):0),sum=parts.reduce((a,b)=>a+b,0);return {parts,sum,total:window.total,fraction:2*sum/Math.max(1e-20,window.total),fundamentalFraction:parts[0]/Math.max(1e-20,window.total)};};
 const floor=Math.max(1e-16,job.gate*job.gate*.012),targets=[];
 for(const offset of (job.message?.familyBatchAudit?[-.10,-.06,-.02,.02,.05]:[-.10,-.06,-.02,.02])){
  const start=limit+Math.round(offset*rate),window=frame(start-halfExtra,longCount);if(!window)continue;
  let frequency=requested,peak=nativePower(window,frequency);const radius=Math.max(6,requested*.02);
  for(let shift=-radius;shift<=radius;shift+=2){const q=requested+shift;if(q<80||q>maximum)continue;const power=nativePower(window,q);if(power>peak){peak=power;frequency=q;}}
  const after=energy(window,frequency),short=energy(frame(start),frequency);if(!short||after.fundamentalFraction<=.025||after.fraction<=.35||short.fraction<=.35)continue;
  targets.push({start,window,frequency,after,short});
 }
 targets.sort((a,b)=>b.after.sum-a.after.sum);
 let last={ok:false,reason:'no-independent-native-rise'};
 for(const target of targets){
  const {frequency,after}=target,baseline=[];
  for(let offset=-.30;offset<=-.10+.00001;offset+=.016){const start=limit+Math.round(offset*rate);if(start+longCount>target.start)continue;const window=frame(start-halfExtra,longCount),old=energy(window,frequency);if(old)baseline.push({start,window,old});}
  baseline.sort((a,b)=>b.start-a.start);
  for(const before of baseline){
   const {old}=before;
   // Necessary named-bin checks run before expensive neighboring-peak tests.
   // Every neighbor maximum is at least the corresponding named-bin power.
   if(!(after.parts[0]>old.parts[0]*2.5+floor&&[1,2,3].some(h=>after.parts[h]>after.parts[0]*.012&&after.parts[h]>old.parts[h]*2.5+floor)&&after.fundamentalFraction>old.fundamentalFraction*1.3&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3))continue;
   const neighbour=old.parts.slice(),radius=Math.max(6,frequency*.02);
   for(let offset=-radius;offset<=radius;offset+=2)for(let h=1;h<=4;h++){const q=(frequency+offset)*h;if(q<=rate*.45)neighbour[h-1]=Math.max(neighbour[h-1],nativePower(before.window,q));}
   // A neighbouring semitone can leak into a32ms target bin. Only a
   // resolved native64ms prior peak beyond the existing85-cent pitch-change
   // criterion may replace that leaked neighbour maximum with the named bin.
   if(after.parts[0]<=neighbour[0]*2.5+floor){let priorFrequency=frequency,priorPeak=old.parts[0];const width=Math.max(25,frequency*.10);for(let shift=-width;shift<=width;shift+=2){const q=frequency+shift;if(q<80||q>maximum)continue;const value=nativePower(before.window,q);if(value>priorPeak){priorPeak=value;priorFrequency=q;}}if(Math.abs(1200*Math.log2(priorFrequency/frequency))>85)neighbour[0]=old.parts[0];}
   const newPartial=[1,2,3].some(h=>after.parts[h]>after.parts[0]*.012&&after.parts[h]>neighbour[h]*2.5+floor);
   if(!(after.parts[0]>neighbour[0]*2.5+floor&&newPartial&&after.fundamentalFraction>old.fundamentalFraction*1.3&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3)){last={ok:false,reason:'no-independent-native-rise',old,after,neighbour};continue;}
   const shortOld=energy(frame(before.start),frequency);if(!shortOld)continue;
   const onsetPower=shortOld.sum+(target.short.sum-shortOld.sum)*.06,step=Math.max(1,Math.round(.008*rate)),lastStart=Math.min(limit+Math.round((job.message?.familyBatchAudit?.048:-.020)*rate),target.start);let center=null;
   for(let start=before.start;start<=lastStart;start+=step){const observed=energy(frame(start),frequency);if(!observed||observed.sum<onsetPower||observed.parts[0]<observed.total*.025)continue;const located=energy(frame(start-halfExtra,longCount),frequency);if(!located||located.fundamentalFraction<=.025||located.fraction<.35||located.parts[0]<=neighbour[0]*2.5+floor||![1,2,3].some(h=>located.parts[h]>located.parts[0]*.012&&located.parts[h]>neighbour[h]*2.5+floor))continue;center=start+(count-1)/2;break;}
   if(center===null){last={ok:false,reason:'native-rise-not-located',old,after,neighbour};continue;}
   const first=energy(frame(center+.020*rate),frequency),second=energy(frame(center+.052*rate),frequency);if(!first||!second){last={ok:false,reason:'confirmation-incomplete'};continue;}
   let dot=0,aa=0,bb=0;for(let h=0;h<4;h++){dot+=first.parts[h]*second.parts[h];aa+=first.parts[h]**2;bb+=second.parts[h]**2;}const shape=dot/Math.sqrt(Math.max(1e-30,aa*bb));
   const stable=first.total>job.gate*job.gate*.04&&second.total>job.gate*job.gate*.04&&first.fundamentalFraction>.025&&second.fundamentalFraction>.025&&first.parts.slice(1).reduce((a,b)=>a+b,0)>first.parts[0]*.012&&second.parts.slice(1).reduce((a,b)=>a+b,0)>second.parts[0]*.012&&first.fraction>=.35&&second.fraction>=.35&&second.sum>=first.sum*.65*.65&&shape>=.85;
   if(!stable){last={ok:false,reason:'source-centered-tone-not-stable',old,after,neighbour,first,second,shape,centerTime:this.baseTime+(job.start+center)/rate};continue;}
   // A local blend between two held notes is not a new native pitch.
   // Confirm the same physical frequency independently through the grown
   // fundamental and one higher partial in two longer native windows.
   const nativeConfirm=[target.window,frame(target.start+halfExtra,longCount)],tolerance=Math.max(4,frequency*.006),pitchRadius=Math.max(6,frequency*.025);
   const nativePeak=(window,h)=>{let best=0,f=frequency;for(let shift=-pitchRadius;shift<=pitchRadius;shift+=2){const q=frequency+shift;if(q<80||q>maximum||q*h>rate*.45)continue;const p=nativePower(window,q*h);if(p>best){best=p;f=q;}}return f;};
   let stationary=false,physicalFrequencies=null;
   if(nativeConfirm.every(Boolean))for(const h of [2,3,4]){
    if(!(after.parts[h-1]>after.parts[0]*.012&&after.parts[h-1]>neighbour[h-1]*2.5+floor))continue;
    const qs=[nativePeak(nativeConfirm[0],1),nativePeak(nativeConfirm[0],h),nativePeak(nativeConfirm[1],h)];
    if(Math.max(...qs)-Math.min(...qs)<=tolerance&&qs.every(q=>Math.abs(q-frequency)<=tolerance)){stationary=true;physicalFrequencies=qs;break;}
   }
   if(!stationary){last={ok:false,reason:'native-family-pitch-not-stationary',frequency};continue;}
   return {ok:true,time:Math.min(job.message.time,this.baseTime+(job.start+center)/rate),sourceTime:this.baseTime+(job.start+center)/rate,frequency,old,after,neighbour,first,second,shape,physicalFrequencies,sourceBaselineTime:this.baseTime+(job.start+before.start)/rate,targetTime:this.baseTime+(job.start+target.start)/rate};
  }
 }
 return last;
}

 weakNativeFamilyProof(job){
function preservedBatchWeakProof(job){
 const rate=this.rate,requested=job.message?.frequency,own=job.evidenceSnapshot?.own===true;
 const known=own&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true),maximum=Math.min(job.message?.familyBatchAudit?3300:1400,rate*.45/2);
 if(!known||job.message?.source!=='periodic'||!job.message.familyProposal||!job.y||!Number.isFinite(requested)||requested<80||requested>maximum)return {ok:false,reason:'unproven-weak-family'};
 const count=Math.floor(.064*rate),shortCount=Math.floor(.032*rate),limit=job.eventIndex,floor=Math.max(1e-16,job.gate*job.gate*.012),cache=new Map();
 const frame=(start,n=count)=>{start=Math.round(start);const key=start+':'+n;if(!cache.has(key))cache.set(key,this.highNativeFrame(job,start,n));return cache.get(key);};
 const power=(window,q)=>q>0&&q<=rate*.45?this.highNativePower(window,q):0;
 const energy=(window,f)=>{if(!window)return null;const parts=[1,2,3,4].map(h=>power(window,f*h)),sum=parts.reduce((a,b)=>a+b,0);return {parts,sum,total:window.total,fraction:2*sum/Math.max(1e-20,window.total),fundamentalFraction:parts[0]/Math.max(1e-20,window.total)};};
 const peak=(window,f,h=1)=>{let frequency=f,best=power(window,f*h),radius=Math.max(6,f*.02);for(let offset=-radius;offset<=radius;offset+=2){const q=f+offset;if(q<80||q>maximum||q*h>rate*.45)continue;const p=power(window,q*h);if(p>best){frequency=q;best=p;}}return {frequency,power:best};};
 const early=limit-Math.round(.14*rate),late=limit+Math.round(.012*rate),oldFrame=frame(early),afterFrame=frame(late);if(!oldFrame||!afterFrame)return {ok:false,reason:'weak-window-incomplete'};
 const seed=energy(afterFrame,requested),anchor=seed.parts.indexOf(Math.max(...seed.parts))+1,frequency=peak(afterFrame,requested,anchor).frequency,old=energy(oldFrame,frequency),after=energy(afterFrame,frequency),neighbour=old.parts.slice(),radius=Math.max(6,frequency*.02);
 for(let offset=-radius;offset<=radius;offset+=3)for(let h=1;h<=4;h++)neighbour[h-1]=Math.max(neighbour[h-1],power(oldFrame,(frequency+offset)*h));
 const loudest=Math.max(...after.parts),grown=[0,1,2,3].filter(h=>after.parts[h]>Math.max(after.total*(after.fundamentalFraction>.01?.0002:.001),loudest*.012)&&after.parts[h]>neighbour[h]*2.5+floor);
 const coprime=(a,b)=>{while(b){const r=a%b;a=b;b=r;}return a===1;},pairs=[];for(const a of grown)for(const b of grown)if(a<b&&coprime(a+1,b+1))pairs.push([a,b]);
 const hasFundamental=after.fundamentalFraction>.01&&grown.includes(0),partners=grown.filter(h=>h>0),missingFundamental=!hasFundamental;
 // Two physical coprime higher partials prove a period even when H1 is weak.
 const eligible=pairs.filter(pair=>hasFundamental||pair[0]>0),minimumFamily=partners.length>=2?.035:.12;
 if(!(after.fraction>minimumFamily&&eligible.length&&(hasFundamental?after.fundamentalFraction>old.fundamentalFraction*1.3:after.fraction>old.fraction*1.3)&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3))return {ok:false,reason:'weak-no-independent-rise',old,after,neighbour,partners,frequency,missingFundamental,pairs};
 const pair=eligible.sort((a,b)=>(a[0]===0)-(b[0]===0)||Math.min(after.parts[b[0]],after.parts[b[1]])-Math.min(after.parts[a[0]],after.parts[a[1]]))[0];
 const physicalSupport=(e)=>pair.every(h=>e.parts[h]>Math.max(e.total*(hasFundamental?.0002:.001),Math.max(...e.parts)*.012)&&e.parts[h]>neighbour[h]*2.5+floor);
 // A continuously audible weak family can swell against a constant bass.
 // Independent growth alone cannot make its already-present physical peaks
 // a new attack. Test native pre-onset peak contrast, not mixed RMS.
 const priorFrames=[frame(early-Math.round(.016*rate)),oldFrame].filter(Boolean);
 const alreadyPresent=priorFrames.some(w=>(hasFundamental?[0]:pair).every(h=>{
  const q=frequency*(h+1),p=power(w,q),width=Math.max(32,frequency*.04),side=Math.max(power(w,q-width),power(w,q+width));
  return p>floor&&p>side*4;
 }));
 // Nearby voices can mask H1 without erasing the same native H2/H3.
 // A resolved old local peak is stronger presence evidence than a wide
 // noise-floor contrast; a neighboring semitone gives a slope, not a peak.
 const resolvedBefore=priorFrames.some(w=>{
  const present=grown.filter(h=>{const q=frequency*(h+1),p=power(w,q),side=Math.max(power(w,q-8),power(w,q+8));return p>floor*.2&&p>side*1.12;});
  return hasFundamental&&present.includes(0)||present.some(a=>present.some(b=>a<b&&coprime(a+1,b+1)));
 });
 if(resolvedBefore)return {ok:false,reason:'weak-native-family-already-resolved',frequency,pair,old,after};
 let pitchMovement=null;
 if(alreadyPresent){
  const previousPeaks=pair.map(h=>{let q=frequency,value=power(oldFrame,q*(h+1));for(let d=-frequency*.12;d<=frequency*.12;d+=2){const candidate=frequency+d;if(candidate<60||candidate*(h+1)>rate*.45)continue;const p=power(oldFrame,candidate*(h+1));if(p>value){q=candidate;value=p;}}return {frequency:q,power:value};});
  const priorFrequency=previousPeaks.reduce((sum,p)=>sum+p.frequency,0)/previousPeaks.length,spread=Math.max(...previousPeaks.map(p=>p.frequency))-Math.min(...previousPeaks.map(p=>p.frequency)),cents=1200*Math.log2(frequency/priorFrequency);
  if(Math.abs(cents)>75&&spread<=Math.max(2,frequency*.006)&&previousPeaks.every(p=>p.power>floor))pitchMovement={priorFrequency,frequency,cents,spread,pair};
  else return {ok:false,reason:'weak-family-already-present',frequency,pair,old,after};
 }

 const threshold=old.sum+(after.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*rate)),last=limit+Math.round((job.message?.familyBatchAudit?.048:-.020)*rate);let center=null;
 for(let start=early;start<=last;start+=step){const e=energy(frame(start,shortCount),frequency);if(e&&e.sum>=threshold&&(hasFundamental?e.fundamentalFraction>.01:physicalSupport(e))){center=start+(shortCount-1)/2;break;}}
 if(center===null)return {ok:false,reason:'weak-rise-not-located'};
 const firstFrame=frame(center+.012*rate),secondFrame=frame(center+.044*rate);if(!firstFrame||!secondFrame)return {ok:false,reason:'weak-confirmation-incomplete'};
 const first=energy(firstFrame,frequency),second=energy(secondFrame,frequency),firstPeaks=pair.map(h=>peak(firstFrame,frequency,h+1)),secondPeaks=pair.map(h=>peak(secondFrame,frequency,h+1));
 const frequencies=[...firstPeaks,...secondPeaks].map(p=>p.frequency),stationary=Math.max(...frequencies)-Math.min(...frequencies)<=Math.max(4,frequency*.006);
 const supports=(e)=>partners.filter(h=>e.parts[h]>e.parts[0]*.012&&e.parts[h]>neighbour[h]*2.5+floor).length;
 let dot=0,aa=0,bb=0;for(let h=0;h<4;h++){dot+=first.parts[h]*second.parts[h];aa+=first.parts[h]**2;bb+=second.parts[h]**2;}const shape=dot/Math.sqrt(Math.max(1e-30,aa*bb));
 const stable=stationary&&(!hasFundamental||first.fundamentalFraction>.01&&second.fundamentalFraction>.01)&&physicalSupport(first)&&physicalSupport(second)&&first.fraction>=minimumFamily&&second.fraction>=minimumFamily&&supports(first)>=(minimumFamily===.035?2:1)&&supports(second)>=(minimumFamily===.035?2:1)&&second.sum>=first.sum*.65*.65&&shape>=.85;
 if(!stable)return {ok:false,reason:'weak-source-tone-not-stable',frequency,old,after,first,second,shape,stationary,partners,minimumFamily,centerTime:this.baseTime+(job.start+center)/rate};
 return {ok:true,time:Math.min(job.message.time,this.baseTime+(job.start+center)/rate),sourceTime:this.baseTime+(job.start+center)/rate,frequency,weakFamily:true,old,after,first,second,shape,partners,minimumFamily,missingFundamental,pair,pitchMovement};
}
function supplementalShapeReleaseProof(job){
function sealedShapeWeakProof(job){
 const rate=this.rate,requested=job.message?.frequency,own=job.evidenceSnapshot?.own===true;
 const known=own&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true),maximum=Math.min(job.message?.familyBatchAudit?3300:1400,rate*.45/2);
 if(!known||job.message?.source!=='periodic'||!job.message.familyProposal||!job.y||!Number.isFinite(requested)||requested<80||requested>maximum)return {ok:false,reason:'unproven-weak-family'};
 const count=Math.floor(.064*rate),shortCount=Math.floor(.032*rate),limit=job.eventIndex,floor=Math.max(1e-16,job.gate*job.gate*.012),cache=new Map();
 const frame=(start,n=count)=>{start=Math.round(start);const key=start+':'+n;if(!cache.has(key))cache.set(key,this.highNativeFrame(job,start,n));return cache.get(key);};
 const power=(window,q)=>q>0&&q<=rate*.45?this.highNativePower(window,q):0;
 const energy=(window,f)=>{if(!window)return null;const parts=[1,2,3,4].map(h=>power(window,f*h)),sum=parts.reduce((a,b)=>a+b,0);return {parts,sum,total:window.total,fraction:2*sum/Math.max(1e-20,window.total),fundamentalFraction:parts[0]/Math.max(1e-20,window.total)};};
 const peak=(window,f,h=1)=>{let frequency=f,best=power(window,f*h),radius=Math.max(6,f*.02);for(let offset=-radius;offset<=radius;offset+=2){const q=f+offset;if(q<80||q>maximum||q*h>rate*.45)continue;const p=power(window,q*h);if(p>best){frequency=q;best=p;}}return {frequency,power:best};};
 const early=limit-Math.round(.14*rate),late=limit+Math.round(.012*rate),oldFrame=frame(early),afterFrame=frame(late);if(!oldFrame||!afterFrame)return {ok:false,reason:'weak-window-incomplete'};
 const seed=energy(afterFrame,requested),anchor=seed.parts.indexOf(Math.max(...seed.parts))+1,frequency=peak(afterFrame,requested,anchor).frequency,old=energy(oldFrame,frequency),after=energy(afterFrame,frequency),neighbour=old.parts.slice(),radius=Math.max(6,frequency*.02);
 for(let offset=-radius;offset<=radius;offset+=3)for(let h=1;h<=4;h++)neighbour[h-1]=Math.max(neighbour[h-1],power(oldFrame,(frequency+offset)*h));
 const loudest=Math.max(...after.parts),grown=[0,1,2,3].filter(h=>after.parts[h]>Math.max(after.total*(after.fundamentalFraction>.01?.0002:.001),loudest*.012)&&after.parts[h]>neighbour[h]*2.5+floor);
 const coprime=(a,b)=>{while(b){const r=a%b;a=b;b=r;}return a===1;},pairs=[];for(const a of grown)for(const b of grown)if(a<b&&coprime(a+1,b+1))pairs.push([a,b]);
 const hasFundamental=after.fundamentalFraction>.01&&grown.includes(0),partners=grown.filter(h=>h>0),missingFundamental=!hasFundamental;
 // Two physical coprime higher partials prove a period even when H1 is weak.
 const eligible=pairs.filter(pair=>hasFundamental||pair[0]>0),minimumFamily=partners.length>=2?.035:.12;
 if(!(after.fraction>minimumFamily&&eligible.length&&(hasFundamental?after.fundamentalFraction>old.fundamentalFraction*1.3:after.fraction>old.fraction*1.3)&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3))return {ok:false,reason:'weak-no-independent-rise',old,after,neighbour,partners,frequency,missingFundamental,pairs};
 const pair=eligible.sort((a,b)=>(a[0]===0)-(b[0]===0)||Math.min(after.parts[b[0]],after.parts[b[1]])-Math.min(after.parts[a[0]],after.parts[a[1]]))[0];
 const physicalSupport=(e)=>pair.every(h=>e.parts[h]>Math.max(e.total*(hasFundamental?.0002:.001),Math.max(...e.parts)*.012)&&e.parts[h]>neighbour[h]*2.5+floor);
 // A new articulation can replace the partial balance at the same root.
 // Require measured old higher partials; absent old power is not a shape.
 const oldHigher=old.parts.slice(1),newHigher=after.parts.slice(1),oldMeasured=oldHigher.filter(p=>p>floor).length,newMeasured=newHigher.filter(p=>p>floor).length;
 let shapeDot=0,shapeOld=0,shapeNew=0;for(let h=0;h<3;h++){shapeDot+=oldHigher[h]*newHigher[h];shapeOld+=oldHigher[h]**2;shapeNew+=newHigher[h]**2;}
 const beforeAfterShape=shapeDot/Math.sqrt(Math.max(1e-30,shapeOld*shapeNew)),shapeWitness=oldMeasured>=2&&newMeasured>=2&&beforeAfterShape<.90;
 // A continuously audible weak family can swell against a constant bass.
 // Independent growth alone cannot make its already-present physical peaks
 // a new attack. Test native pre-onset peak contrast, not mixed RMS.
 const priorFrames=[frame(early-Math.round(.016*rate)),oldFrame].filter(Boolean);
 const alreadyPresent=priorFrames.some(w=>(hasFundamental?[0]:pair).every(h=>{
  const q=frequency*(h+1),p=power(w,q),width=Math.max(32,frequency*.04),side=Math.max(power(w,q-width),power(w,q+width));
  return p>floor&&p>side*4;
 }));
 // Nearby voices can mask H1 without erasing the same native H2/H3.
 // A resolved old local peak is stronger presence evidence than a wide
 // noise-floor contrast; a neighboring semitone gives a slope, not a peak.
 const resolvedBefore=priorFrames.some(w=>{
  const present=grown.filter(h=>{const q=frequency*(h+1),p=power(w,q),side=Math.max(power(w,q-8),power(w,q+8));return p>floor*.2&&p>side*1.12;});
  return hasFundamental&&present.includes(0)||present.some(a=>present.some(b=>a<b&&coprime(a+1,b+1)));
 });
 if(resolvedBefore&&!shapeWitness)return {ok:false,reason:'weak-native-family-already-resolved',frequency,pair,old,after};
 let pitchMovement=null;
 if(alreadyPresent&&!shapeWitness){
  const previousPeaks=pair.map(h=>{let q=frequency,value=power(oldFrame,q*(h+1));for(let d=-frequency*.12;d<=frequency*.12;d+=2){const candidate=frequency+d;if(candidate<60||candidate*(h+1)>rate*.45)continue;const p=power(oldFrame,candidate*(h+1));if(p>value){q=candidate;value=p;}}return {frequency:q,power:value};});
  const priorFrequency=previousPeaks.reduce((sum,p)=>sum+p.frequency,0)/previousPeaks.length,spread=Math.max(...previousPeaks.map(p=>p.frequency))-Math.min(...previousPeaks.map(p=>p.frequency)),cents=1200*Math.log2(frequency/priorFrequency);
  if(Math.abs(cents)>75&&spread<=Math.max(2,frequency*.006)&&previousPeaks.every(p=>p.power>floor))pitchMovement={priorFrequency,frequency,cents,spread,pair};
  else return {ok:false,reason:'weak-family-already-present',frequency,pair,old,after};
 }

 const threshold=old.sum+(after.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*rate)),last=limit-Math.round(.020*rate);let center=null;
 for(let start=early;start<=last;start+=step){const e=energy(frame(start,shortCount),frequency);if(e&&e.sum>=threshold&&(hasFundamental?e.fundamentalFraction>.01:physicalSupport(e))){center=start+(shortCount-1)/2;break;}}
 if(center===null)return {ok:false,reason:'weak-rise-not-located'};
 const firstFrame=frame(center+.012*rate),secondFrame=frame(center+.044*rate);if(!firstFrame||!secondFrame)return {ok:false,reason:'weak-confirmation-incomplete'};
 const first=energy(firstFrame,frequency),second=energy(secondFrame,frequency),firstPeaks=pair.map(h=>peak(firstFrame,frequency,h+1)),secondPeaks=pair.map(h=>peak(secondFrame,frequency,h+1));
 const frequencies=[...firstPeaks,...secondPeaks].map(p=>p.frequency),stationary=Math.max(...frequencies)-Math.min(...frequencies)<=Math.max(4,frequency*.006);
 const supports=(e)=>partners.filter(h=>e.parts[h]>e.parts[0]*.012&&e.parts[h]>neighbour[h]*2.5+floor).length;
 let dot=0,aa=0,bb=0;for(let h=0;h<4;h++){dot+=first.parts[h]*second.parts[h];aa+=first.parts[h]**2;bb+=second.parts[h]**2;}const shape=dot/Math.sqrt(Math.max(1e-30,aa*bb));
 const stable=stationary&&(!hasFundamental||first.fundamentalFraction>.01&&second.fundamentalFraction>.01)&&physicalSupport(first)&&physicalSupport(second)&&first.fraction>=minimumFamily&&second.fraction>=minimumFamily&&supports(first)>=(minimumFamily===.035?2:1)&&supports(second)>=(minimumFamily===.035?2:1)&&second.sum>=first.sum*.65*.65&&shape>=.85;
 if(!stable)return {ok:false,reason:'weak-source-tone-not-stable',frequency,old,after,first,second,shape,stationary,partners,minimumFamily,centerTime:this.baseTime+(job.start+center)/rate};
 return {ok:true,time:Math.min(job.message.time,this.baseTime+(job.start+center)/rate),sourceTime:this.baseTime+(job.start+center)/rate,frequency,weakFamily:true,old,after,first,second,shape,partners,minimumFamily,missingFundamental,pair,pitchMovement,shapeWitness,beforeAfterShape};
}

function releasePairsWeakProof(job){
 const rate=this.rate,requested=job.message?.frequency,own=job.evidenceSnapshot?.own===true;
 const known=own&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true),maximum=Math.min(job.message?.familyBatchAudit?3300:1400,rate*.45/2);
 if(!known||job.message?.source!=='periodic'||!job.message.familyProposal||!job.y||!Number.isFinite(requested)||requested<80||requested>maximum)return {ok:false,reason:'unproven-weak-family'};
 const count=Math.floor(.064*rate),shortCount=Math.floor(.032*rate),limit=job.eventIndex,floor=Math.max(1e-16,job.gate*job.gate*.012),cache=new Map();
 const frame=(start,n=count)=>{start=Math.round(start);const key=start+':'+n;if(!cache.has(key))cache.set(key,this.highNativeFrame(job,start,n));return cache.get(key);};
 const power=(window,q)=>q>0&&q<=rate*.45?this.highNativePower(window,q):0;
 const energy=(window,f)=>{if(!window)return null;const parts=[1,2,3,4].map(h=>power(window,f*h)),sum=parts.reduce((a,b)=>a+b,0);return {parts,sum,total:window.total,fraction:2*sum/Math.max(1e-20,window.total),fundamentalFraction:parts[0]/Math.max(1e-20,window.total)};};
 const peak=(window,f,h=1)=>{let frequency=f,best=power(window,f*h),radius=Math.max(6,f*.02);for(let offset=-radius;offset<=radius;offset+=2){const q=f+offset;if(q<80||q>maximum||q*h>rate*.45)continue;const p=power(window,q*h);if(p>best){frequency=q;best=p;}}return {frequency,power:best};};
 const early=limit-Math.round(.14*rate),late=limit+Math.round(.012*rate),oldFrame=frame(early),afterFrame=frame(late);if(!oldFrame||!afterFrame)return {ok:false,reason:'weak-window-incomplete'};
 const seed=energy(afterFrame,requested),anchor=seed.parts.indexOf(Math.max(...seed.parts))+1,frequency=peak(afterFrame,requested,anchor).frequency,old=energy(oldFrame,frequency),after=energy(afterFrame,frequency),neighbour=old.parts.slice(),radius=Math.max(6,frequency*.02);
 for(let offset=-radius;offset<=radius;offset+=3)for(let h=1;h<=4;h++)neighbour[h-1]=Math.max(neighbour[h-1],power(oldFrame,(frequency+offset)*h));
 const loudest=Math.max(...after.parts),grown=[0,1,2,3].filter(h=>after.parts[h]>Math.max(after.total*(after.fundamentalFraction>.01?.0002:.001),loudest*.012)&&after.parts[h]>neighbour[h]*2.5+floor);
 const coprime=(a,b)=>{while(b){const r=a%b;a=b;b=r;}return a===1;},pairs=[];for(const a of grown)for(const b of grown)if(a<b&&coprime(a+1,b+1))pairs.push([a,b]);
 const hasFundamental=after.fundamentalFraction>.01&&grown.includes(0),partners=grown.filter(h=>h>0),missingFundamental=!hasFundamental;
 // Two physical coprime higher partials prove a period even when H1 is weak.
 const eligible=pairs.filter(pair=>hasFundamental||pair[0]>0),minimumFamily=partners.length>=2?.035:.12;
 if(!(after.fraction>minimumFamily&&eligible.length&&(hasFundamental?after.fundamentalFraction>old.fundamentalFraction*1.3:after.fraction>old.fraction*1.3)&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3))return {ok:false,reason:'weak-no-independent-rise',old,after,neighbour,partners,frequency,missingFundamental,pairs};
 let pair=eligible.sort((a,b)=>(a[0]===0)-(b[0]===0)||Math.min(after.parts[b[0]],after.parts[b[1]])-Math.min(after.parts[a[0]],after.parts[a[1]]))[0];
 const physicalSupport=(e)=>pair.every(h=>e.parts[h]>Math.max(e.total*(hasFundamental?.0002:.001),Math.max(...e.parts)*.012)&&e.parts[h]>neighbour[h]*2.5+floor);
 // A new articulation can replace the partial balance at the same root.
 // Require measured old higher partials; absent old power is not a shape.
 const oldHigher=old.parts.slice(1),newHigher=after.parts.slice(1),oldMeasured=oldHigher.filter(p=>p>floor).length,newMeasured=newHigher.filter(p=>p>floor).length;
 let shapeDot=0,shapeOld=0,shapeNew=0;for(let h=0;h<3;h++){shapeDot+=oldHigher[h]*newHigher[h];shapeOld+=oldHigher[h]**2;shapeNew+=newHigher[h]**2;}
 const beforeAfterShape=shapeDot/Math.sqrt(Math.max(1e-30,shapeOld*shapeNew)),shapeWitness=oldMeasured>=2&&newMeasured>=2&&beforeAfterShape<.90;
 // A continuously audible weak family can swell against a constant bass.
 // Independent growth alone cannot make its already-present physical peaks
 // a new attack. Test native pre-onset peak contrast, not mixed RMS.
 const priorFrames=[frame(early-Math.round(.016*rate)),oldFrame].filter(Boolean);
 const alreadyPresent=priorFrames.some(w=>(hasFundamental?[0]:pair).every(h=>{
  const q=frequency*(h+1),p=power(w,q),width=Math.max(32,frequency*.04),side=Math.max(power(w,q-width),power(w,q+width));
  return p>Math.max(floor,after.parts[h]*.001)&&p>side*4;
 }));
 // Nearby voices can mask H1 without erasing the same native H2/H3.
 // A resolved old local peak is stronger presence evidence than a wide
 // noise-floor contrast; a neighboring semitone gives a slope, not a peak.
 const resolvedBefore=priorFrames.some(w=>{
  const present=grown.filter(h=>{const q=frequency*(h+1),p=power(w,q),side=Math.max(power(w,q-8),power(w,q+8));return p>Math.max(floor*.2,after.parts[h]*.001)&&p>side*1.12;});
  return hasFundamental&&present.includes(0)||present.some(a=>present.some(b=>a<b&&coprime(a+1,b+1)));
 });
 if(resolvedBefore&&!shapeWitness)return {ok:false,reason:'weak-native-family-already-resolved',frequency,pair,old,after};
 let pitchMovement=null;
 if(alreadyPresent&&!shapeWitness){
  const previousPeaks=pair.map(h=>{let q=frequency,value=power(oldFrame,q*(h+1));for(let d=-frequency*.12;d<=frequency*.12;d+=2){const candidate=frequency+d;if(candidate<60||candidate*(h+1)>rate*.45)continue;const p=power(oldFrame,candidate*(h+1));if(p>value){q=candidate;value=p;}}return {frequency:q,power:value};});
  const priorFrequency=previousPeaks.reduce((sum,p)=>sum+p.frequency,0)/previousPeaks.length,spread=Math.max(...previousPeaks.map(p=>p.frequency))-Math.min(...previousPeaks.map(p=>p.frequency)),cents=1200*Math.log2(frequency/priorFrequency);
  if(Math.abs(cents)>75&&spread<=Math.max(2,frequency*.006)&&previousPeaks.every(p=>p.power>floor))pitchMovement={priorFrequency,frequency,cents,spread,pair};
  else return {ok:false,reason:'weak-family-already-present',frequency,pair,old,after};
 }

 const threshold=old.sum+(after.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*rate)),last=limit-Math.round(.020*rate);let center=null;
 for(let start=early;start<=last;start+=step){const e=energy(frame(start,shortCount),frequency);if(e&&e.sum>=threshold&&(hasFundamental?e.fundamentalFraction>.01:physicalSupport(e))){center=start+(shortCount-1)/2;break;}}
 if(center===null)return {ok:false,reason:'weak-rise-not-located'};
 const firstFrame=frame(center+.012*rate),secondFrame=frame(center+.044*rate);if(!firstFrame||!secondFrame)return {ok:false,reason:'weak-confirmation-incomplete'};
 const first=energy(firstFrame,frequency),second=energy(secondFrame,frequency);
 let stationary=false,physicalFrequencies=null;
 for(const candidatePair of eligible){
  const peaks=[...candidatePair.map(h=>peak(firstFrame,frequency,h+1)),...candidatePair.map(h=>peak(secondFrame,frequency,h+1))],frequencies=peaks.map(p=>p.frequency);
  if(Math.max(...frequencies)-Math.min(...frequencies)<=Math.max(4,frequency*.006)&&frequencies.every(q=>Math.abs(q-frequency)<=Math.max(4,frequency*.006))){
   pair=candidatePair;if(physicalSupport(first)&&physicalSupport(second)){stationary=true;physicalFrequencies=frequencies;break;}
  }
 }
 const supports=(e)=>partners.filter(h=>e.parts[h]>e.parts[0]*.012&&e.parts[h]>neighbour[h]*2.5+floor).length;
 let dot=0,aa=0,bb=0;for(let h=0;h<4;h++){dot+=first.parts[h]*second.parts[h];aa+=first.parts[h]**2;bb+=second.parts[h]**2;}const shape=dot/Math.sqrt(Math.max(1e-30,aa*bb));
 const stable=stationary&&(!hasFundamental||first.fundamentalFraction>.01&&second.fundamentalFraction>.01)&&physicalSupport(first)&&physicalSupport(second)&&first.fraction>=minimumFamily&&second.fraction>=minimumFamily&&supports(first)>=(minimumFamily===.035?2:1)&&supports(second)>=(minimumFamily===.035?2:1)&&second.sum>=first.sum*.65*.65&&shape>=.85;
 if(!stable)return {ok:false,reason:'weak-source-tone-not-stable',frequency,old,after,first,second,shape,stationary,partners,minimumFamily,centerTime:this.baseTime+(job.start+center)/rate};
 return {ok:true,time:Math.min(job.message.time,this.baseTime+(job.start+center)/rate),sourceTime:this.baseTime+(job.start+center)/rate,frequency,weakFamily:true,old,after,first,second,shape,partners,minimumFamily,missingFundamental,pair,pitchMovement,shapeWitness,beforeAfterShape,physicalFrequencies};
}

 const preserved=sealedShapeWeakProof.call(this,job);
 return preserved.ok?preserved:releasePairsWeakProof.call(this,job);
}

function supplementalValidBodyProof(job){
function earliestValidBodyCore(job){
 const rate=this.rate,requested=job.message?.frequency,own=job.evidenceSnapshot?.own===true;
 const known=own&&(job.message?.profileReady===true||job.message?.waveformReady===true||this.meta.canAudit===true),maximum=Math.min(job.message?.familyBatchAudit?3300:1400,rate*.45/2);
 if(!known||job.message?.source!=='periodic'||!job.message.familyProposal||!job.y||!Number.isFinite(requested)||requested<80||requested>maximum)return {ok:false,reason:'unproven-weak-family'};
 const count=Math.floor(.064*rate),shortCount=Math.floor(.032*rate),limit=job.eventIndex,floor=Math.max(1e-16,job.gate*job.gate*.012),cache=new Map();
 const frame=(start,n=count)=>{start=Math.round(start);const key=start+':'+n;if(!cache.has(key))cache.set(key,this.highNativeFrame(job,start,n));return cache.get(key);};
 const power=(window,q)=>q>0&&q<=rate*.45?this.highNativePower(window,q):0;
 const energy=(window,f)=>{if(!window)return null;const parts=[1,2,3,4].map(h=>power(window,f*h)),sum=parts.reduce((a,b)=>a+b,0);return {parts,sum,total:window.total,fraction:2*sum/Math.max(1e-20,window.total),fundamentalFraction:parts[0]/Math.max(1e-20,window.total)};};
 const peak=(window,f,h=1)=>{let frequency=f,best=power(window,f*h),radius=Math.max(6,f*.02);for(let offset=-radius;offset<=radius;offset+=2){const q=f+offset;if(q<80||q>maximum||q*h>rate*.45)continue;const p=power(window,q*h);if(p>best){frequency=q;best=p;}}return {frequency,power:best};};
 const early=limit-Math.round(.14*rate),late=limit+Math.round(.012*rate),oldFrame=frame(early),afterFrame=frame(late);if(!oldFrame||!afterFrame)return {ok:false,reason:'weak-window-incomplete'};
 const seed=energy(afterFrame,requested),anchor=seed.parts.indexOf(Math.max(...seed.parts))+1,frequency=peak(afterFrame,requested,anchor).frequency,old=energy(oldFrame,frequency),after=energy(afterFrame,frequency),neighbour=old.parts.slice(),radius=Math.max(6,frequency*.02);
 for(let offset=-radius;offset<=radius;offset+=3)for(let h=1;h<=4;h++)neighbour[h-1]=Math.max(neighbour[h-1],power(oldFrame,(frequency+offset)*h));
 const loudest=Math.max(...after.parts),grown=[0,1,2,3].filter(h=>after.parts[h]>Math.max(after.total*(after.fundamentalFraction>.01?.0002:.001),loudest*.012)&&after.parts[h]>neighbour[h]*2.5+floor);
 const coprime=(a,b)=>{while(b){const r=a%b;a=b;b=r;}return a===1;},pairs=[];for(const a of grown)for(const b of grown)if(a<b&&coprime(a+1,b+1))pairs.push([a,b]);
 const hasFundamental=after.fundamentalFraction>.01&&grown.includes(0),partners=grown.filter(h=>h>0),missingFundamental=!hasFundamental;
 // Two physical coprime higher partials prove a period even when H1 is weak.
 const eligible=pairs.filter(pair=>hasFundamental||pair[0]>0),minimumFamily=partners.length>=2?.035:.12;
 if(!(after.fraction>minimumFamily&&eligible.length&&(hasFundamental?after.fundamentalFraction>old.fundamentalFraction*1.3:after.fraction>old.fraction*1.3)&&Math.sqrt(2*after.sum)-Math.sqrt(2*old.sum)>job.gate*.3))return {ok:false,reason:'weak-no-independent-rise',old,after,neighbour,partners,frequency,missingFundamental,pairs};
 let pair=eligible.sort((a,b)=>(a[0]===0)-(b[0]===0)||Math.min(after.parts[b[0]],after.parts[b[1]])-Math.min(after.parts[a[0]],after.parts[a[1]]))[0];
 const physicalSupport=(e)=>pair.every(h=>e.parts[h]>Math.max(e.total*(hasFundamental?.0002:.001),Math.max(...e.parts)*.012)&&e.parts[h]>neighbour[h]*2.5+floor);
 // A new articulation can replace the partial balance at the same root.
 // Require measured old higher partials; absent old power is not a shape.
 const oldHigher=old.parts.slice(1),newHigher=after.parts.slice(1),oldMeasured=oldHigher.filter(p=>p>floor).length,newMeasured=newHigher.filter(p=>p>floor).length;
 let shapeDot=0,shapeOld=0,shapeNew=0;for(let h=0;h<3;h++){shapeDot+=oldHigher[h]*newHigher[h];shapeOld+=oldHigher[h]**2;shapeNew+=newHigher[h]**2;}
 const beforeAfterShape=shapeDot/Math.sqrt(Math.max(1e-30,shapeOld*shapeNew)),shapeWitness=oldMeasured>=2&&newMeasured>=2&&beforeAfterShape<.90;
 // A continuously audible weak family can swell against a constant bass.
 // Independent growth alone cannot make its already-present physical peaks
 // a new attack. Test native pre-onset peak contrast, not mixed RMS.
 const priorFrames=[frame(early-Math.round(.016*rate)),oldFrame].filter(Boolean);
 const alreadyPresent=priorFrames.some(w=>(hasFundamental?[0]:pair).every(h=>{
  const q=frequency*(h+1),p=power(w,q),width=Math.max(32,frequency*.04),side=Math.max(power(w,q-width),power(w,q+width));
  return p>Math.max(floor,after.parts[h]*.001)&&p>side*4;
 }));
 // Nearby voices can mask H1 without erasing the same native H2/H3.
 // A resolved old local peak is stronger presence evidence than a wide
 // noise-floor contrast; a neighboring semitone gives a slope, not a peak.
 const resolvedBefore=priorFrames.some(w=>{
  const present=grown.filter(h=>{const q=frequency*(h+1),p=power(w,q),side=Math.max(power(w,q-8),power(w,q+8));return p>Math.max(floor*.2,after.parts[h]*.001)&&p>side*1.12;});
  return hasFundamental&&present.includes(0)||present.some(a=>present.some(b=>a<b&&coprime(a+1,b+1)));
 });
 if(resolvedBefore&&!shapeWitness)return {ok:false,reason:'weak-native-family-already-resolved',frequency,pair,old,after};
 let pitchMovement=null;
 if(alreadyPresent&&!shapeWitness){
  const previousPeaks=pair.map(h=>{let q=frequency,value=power(oldFrame,q*(h+1));for(let d=-frequency*.12;d<=frequency*.12;d+=2){const candidate=frequency+d;if(candidate<60||candidate*(h+1)>rate*.45)continue;const p=power(oldFrame,candidate*(h+1));if(p>value){q=candidate;value=p;}}return {frequency:q,power:value};});
  const priorFrequency=previousPeaks.reduce((sum,p)=>sum+p.frequency,0)/previousPeaks.length,spread=Math.max(...previousPeaks.map(p=>p.frequency))-Math.min(...previousPeaks.map(p=>p.frequency)),cents=1200*Math.log2(frequency/priorFrequency);
  if(Math.abs(cents)>75&&spread<=Math.max(2,frequency*.006)&&previousPeaks.every(p=>p.power>floor))pitchMovement={priorFrequency,frequency,cents,spread,pair};
  else return {ok:false,reason:'weak-family-already-present',frequency,pair,old,after};
 }

 const confirm=(center)=>{
 const firstFrame=frame(center+.012*rate),secondFrame=frame(center+.044*rate);if(!firstFrame||!secondFrame)return {ok:false,reason:'weak-confirmation-incomplete'};
 const first=energy(firstFrame,frequency),second=energy(secondFrame,frequency);
 const supports=(e)=>partners.filter(h=>e.parts[h]>e.parts[0]*.012&&e.parts[h]>neighbour[h]*2.5+floor).length;
 let dot=0,aa=0,bb=0;for(let h=0;h<4;h++){dot+=first.parts[h]*second.parts[h];aa+=first.parts[h]**2;bb+=second.parts[h]**2;}const shape=dot/Math.sqrt(Math.max(1e-30,aa*bb));
 const bodyPossible=(!hasFundamental||first.fundamentalFraction>.01&&second.fundamentalFraction>.01)&&first.fraction>=minimumFamily&&second.fraction>=minimumFamily&&supports(first)>=(minimumFamily===.035?2:1)&&supports(second)>=(minimumFamily===.035?2:1)&&second.sum>=first.sum*.65*.65&&shape>=.85;
 if(!bodyPossible)return {ok:false,reason:'weak-source-tone-not-stable',frequency,old,after,first,second,shape,stationary:false,partners,minimumFamily,centerTime:this.baseTime+(job.start+center)/rate};
 let stationary=false,physicalFrequencies=null;
 for(const candidatePair of eligible){
  if(!candidatePair.every(h=>[first,second].every(e=>e.parts[h]>Math.max(e.total*(hasFundamental?.0002:.001),Math.max(...e.parts)*.012)&&e.parts[h]>neighbour[h]*2.5+floor)))continue;
  const peaks=[...candidatePair.map(h=>peak(firstFrame,frequency,h+1)),...candidatePair.map(h=>peak(secondFrame,frequency,h+1))],frequencies=peaks.map(p=>p.frequency);
  if(Math.max(...frequencies)-Math.min(...frequencies)<=Math.max(4,frequency*.006)&&frequencies.every(q=>Math.abs(q-frequency)<=Math.max(4,frequency*.006))){
   pair=candidatePair;if(physicalSupport(first)&&physicalSupport(second)){stationary=true;physicalFrequencies=frequencies;break;}
  }
 }

 const stable=stationary&&(!hasFundamental||first.fundamentalFraction>.01&&second.fundamentalFraction>.01)&&physicalSupport(first)&&physicalSupport(second)&&first.fraction>=minimumFamily&&second.fraction>=minimumFamily&&supports(first)>=(minimumFamily===.035?2:1)&&supports(second)>=(minimumFamily===.035?2:1)&&second.sum>=first.sum*.65*.65&&shape>=.85;
 if(!stable)return {ok:false,reason:'weak-source-tone-not-stable',frequency,old,after,first,second,shape,stationary,partners,minimumFamily,centerTime:this.baseTime+(job.start+center)/rate};
 // A blend can bias H1 refinement between two held voices. Check whether the
 // physically confirmed coprime pair was already resolved at its actual root,
 // rather than only at the approximate H1 hint used before confirmation.
 const resolvedConfirmedPair=priorFrames.some(w=>pair.every((h,k)=>{
  const physicalFrequency=(physicalFrequencies[k]+physicalFrequencies[k+2])*.5*(h+1),p=power(w,physicalFrequency);
  return p>Math.max(floor*.2,after.parts[h]*.001)&&p>Math.max(power(w,physicalFrequency-8),power(w,physicalFrequency+8))*1.12;
 }));
 if(resolvedConfirmedPair&&!shapeWitness&&!pitchMovement)return {ok:false,reason:'confirmed-native-pair-already-resolved',frequency,pair,physicalFrequencies};
 return {ok:true,sourceTime:this.baseTime+(job.start+center)/rate,earliestValidBody:true,time:Math.min(job.message.time,this.baseTime+(job.start+center)/rate),frequency,weakFamily:true,old,after,first,second,shape,partners,minimumFamily,missingFundamental,pair,pitchMovement,shapeWitness,beforeAfterShape,physicalFrequencies};
 };

 const threshold=old.sum+(after.sum-old.sum)*.06,step=Math.max(1,Math.round(.008*rate)),last=limit-Math.round(.020*rate);let failure={ok:false,reason:'weak-rise-not-located'};
 for(let start=early;start<=last;start+=step){
  const e=energy(frame(start,shortCount),frequency);if(!e||e.sum<threshold||!(hasFundamental?e.fundamentalFraction>.01:physicalSupport(e)))continue;
  const proof=confirm(start+(shortCount-1)/2);if(proof.ok)return proof;failure=proof;
 }
 return failure;
}

 const proof=earliestValidBodyCore.call(this,job);
 if(!proof.ok||!proof.missingFundamental)return proof;
 const rate=this.rate,maximum=Math.min(job.message?.familyBatchAudit?3300:1400,rate*.45/2),frequency=proof.frequency;
 const center=Math.round(((proof.sourceTime-this.baseTime)*rate-job.start)*2)/2,count=Math.floor(.064*rate);
 const first=this.highNativeFrame(job,center+.012*rate,count),second=this.highNativeFrame(job,center+.044*rate,count);
 if(!first||!second)return {ok:false,reason:'missing-root-window-incomplete'};
 const fineRoot=(window,h,seed)=>{let q=seed,best=this.highNativePower(window,seed*h);for(let shift=-2;shift<=2;shift+=.25){const candidate=seed+shift;if(candidate<80||candidate>maximum||candidate*h>rate*.45)continue;const p=this.highNativePower(window,candidate*h);if(p>best){best=p;q=candidate;}}return q;};
 const pair=proof.pair,seeds=proof.physicalFrequencies,refined=[...pair.map((h,k)=>fineRoot(first,h+1,seeds[k])),...pair.map((h,k)=>fineRoot(second,h+1,seeds[k+2]))];
 if(Math.max(...refined)-Math.min(...refined)>Math.max(.5,frequency*.006))return {ok:false,reason:'missing-root-incoherent',frequency,pair,physicalFrequencies:seeds,refined};
 return proof;
}

const preserved=preservedBatchWeakProof.call(this,job);if(preserved.ok)return preserved;
const release=supplementalShapeReleaseProof.call(this,job);return release.ok?release:supplementalValidBodyProof.call(this,job);
}

 periodicSourceRise(job){
  if(job.lowPeriodicProof?.ok)return true;

  if(job.message?.frequency>=1600)return this.highPeriodicSourceRise(job);
  if(job.message?.frequency<1600)return this.lowPeriodicSourceProof(job).ok;
  const frequency=job.message?.frequency;if(!Number.isFinite(frequency)||frequency<80||frequency>1400||!job.y)return false;
  const count=Math.floor(.032*this.rate/this.stride),early=job.eventIndex-Math.round(.14*this.rate),late=job.eventIndex+Math.round(.02*this.rate);
  if(count<16||early<0||late+(count-1)*this.stride>=job.y.length)return false;
  const energy=start=>{const values=new Float64Array(count);let norm=0,total=0;for(let i=0;i<count;i++){const x=job.y[start+i*this.stride],w=.5-.5*Math.cos(2*Math.PI*i/(count-1));values[i]=x*w;norm+=w;total+=x*x/count;}let sum=0,fundamental=0;for(let h=1;h<=3;h++){const c=2*Math.cos(2*Math.PI*frequency*h/(this.rate/this.stride));let a=0,b=0;for(const x of values){const n=x+c*a-b;b=a;a=n;}const power=Math.max(0,a*a+b*b-c*a*b)/(norm*norm);if(h===1)fundamental=power;sum+=power;}return{sum,fundamental,total};};
  const before=energy(early),after=energy(late);
  if(!(after.fundamental>after.total*.025&&2*after.sum>after.total*.35&&after.sum>before.sum*2.5&&Math.sqrt(2*after.sum)-Math.sqrt(2*before.sum)>job.gate*.3))return false;
  const onsetPower=before.sum+(after.sum-before.sum)*.06,step=Math.max(this.stride,Math.round(.008*this.rate)),limit=job.eventIndex+Math.round((job.message?.familyBatchAudit?.048:-.020)*this.rate);
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
 // A source-projected ordinary candidate can contain a stable instrument
 // family without dominating the full microphone energy. Physical native
 // partials confirm presence; the unchanged attack/held-tone veto still
 // determines whether this candidate is a new articulation.
ordinaryInstrumentTone(job,upper=false){
 if(!job.y||!Number.isFinite(job.eventIndex))return false;
 const rate=this.rate,step=upper?Math.max(1,Math.round(this.rate/16000)):this.stride,n=Math.floor(.032*rate/step),wideN=Math.floor(.064*rate/step),one=job.eventIndex+Math.round(.020*rate),two=job.eventIndex+Math.round(.052*rate);
 if(n<16||two+Math.floor(.032*rate)>job.y.length)return false;
 const make=(start,count,stride)=>{let norm=0,total=0;const values=new Float64Array(count);for(let i=0;i<count;i++){const x=job.y[start+i*stride],w=.5-.5*Math.cos(2*Math.PI*i/(count-1));values[i]=x*w;norm+=w;total+=x*x/count;}return{values,norm,total};};
 const power=(frame,f,sampled)=>{const c=2*Math.cos(2*Math.PI*f/sampled);let a=0,b=0;for(const x of frame.values){const y=x+c*a-b;b=a;a=y;}return Math.max(0,a*a+b*b-c*a*b)/(frame.norm*frame.norm);};
 const first=make(one,n,step),second=make(two,n,step),wide=make(one,wideN,step),sr=rate/step;
 const parts=(frame,f,sampled)=>[1,2,3,4].map(h=>f*h<=sampled*.45?power(frame,f*h,sampled):0),sum=x=>x.reduce((a,b)=>a+b,0);
 let native=null;
 const low=upper?1400:80,high=upper?Math.min(4000,sr*.45/2):Math.min(1400,sr*.45/2);
 for(let f=low;f<=high;f+=10){
  const ap=parts(first,f,sr),bp=parts(second,f,sr),wp=parts(wide,f,sr);
  if(!(bp[0]>second.total*.025&&wp[0]>wide.total*.01&&2*sum(bp)>second.total*.12&&2*sum(wp)>wide.total*.12&&sum(bp)>=sum(ap)*.4225))continue;
  if(!native)native=[make(one,Math.floor(.032*rate),1),make(two,Math.floor(.032*rate),1),make(one,Math.floor(.064*rate),1)];
  let best=0;const local=[];for(let v=f-20;v<=f+20;v+=2){if(v<low||v>high)continue;const p=power(native[2],v,rate);local.push({frequency:v,power:p});best=Math.max(best,p);}
  // The64ms fundamental can contain an overlapping neighbouring reed.
  // Verify candidate centers within its main peak instead of treating one
  // interference-shifted maximum as the exact harmonic fundamental.
  const hypotheses=local.filter(v=>v.frequency>f-18&&v.frequency<f+18&&v.power>=best*.8).sort((a,b)=>b.power-a.power);
  for(const hypothesis of hypotheses){const q=hypothesis.frequency;
  const a=parts(native[0],q,rate),b=parts(native[1],q,rate),w=parts(native[2],q,rate);
  if(!(b[0]>native[1].total*.025&&w[0]>native[2].total*.01&&2*sum(b)>native[1].total*.12&&2*sum(w)>native[2].total*.12&&sum(b.slice(1))>b[0]*.012&&sum(b)>=sum(a)*.4225))continue;
  // At least one source partial must be present early and remain centered at
  // the same physical harmonic later. A leadingH4 may precede a reed's f0.
  const stationary=[];
  for(let h=1;h<=4;h++){
   if(q*h>rate*.45||a[h-1]<native[0].total*.003||b[h-1]<b[0]*(h===1?.01:.012))continue;
   let fa=q,fb=q,pa=0,pb=0;for(let v=q-18;v<=q+18;v+=2){const x=power(native[0],v*h,rate),y=power(native[1],v*h,rate);if(x>pa){pa=x;fa=v;}if(y>pb){pb=y;fb=v;}}
   if(Math.abs(fa-q)>12||Math.abs(fb-q)>12||Math.abs(fa-fb)>10||a[h-1]<pa*.8||b[h-1]<pb*.8)continue;
   stationary.push(h);
  }
  if(!stationary.length)continue;
  // Higher partials independently center on this physical fundamental, not
  // an unrelated nearby transient or an out-of-band decimation alias.
  let partner=false;for(let h=2;h<=4;h++){
   if(q*h>rate*.45||b[h-1]<=b[0]*.012)continue;
   let ph=q,peak=0;for(let v=q-18;v<=q+18;v+=2){const p=power(native[1],v*h,rate);if(p>peak){peak=p;ph=v;}}
   if(Math.abs(ph-q)<=10&&b[h-1]>=peak*.8){partner=true;break;}
  }
  if(!partner)continue;
  return true;
  }
 }
 return !upper&&this.ordinaryInstrumentTone(job,true);
}

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
 captureEnd(job){
  const family=this.familyBounds(job);if(family)return Math.ceil((family.last-this.baseTime+.132)*this.rate);
  // Periodic proposals already identify the source time; their callback
  // observation delay adds no information to the source-centered proof.
  // Ordinary attack jobs retain their original callback capture bound.
  const sourceTime=job.message.source==='periodic'?job.message.time:job.signalTime;
  return Math.ceil((sourceTime-this.baseTime+(job.message.toneCheck ? .132 : .052))*this.rate);
 }
 prepare(job){
  // Backdated spectral callbacks need capture history around their actual
  // scoring timestamp, rather than only the later callback observation.
  const family=this.familyBounds(job);
  job.start=Math.max(0,Math.floor((family?family.first-this.baseTime-.32:Math.min(job.signalTime,job.message.time)-this.baseTime-(job.message.source==='periodic'?(job.message.frequency<=1400?.32:.16):.024))*this.rate));job.length=this.captureEnd(job)-job.start;job.eventIndex=Math.max(0,Math.min(job.length,Math.round((job.message.time-this.baseTime)*this.rate)-job.start));
  if(job.start+job.length>this.total){this.drop(job,'capture-window-incomplete',{stage:'prepare'});return false;}
  if(job.start<this.total-this.size){this.drop(job,'history-unavailable',{stage:'prepare'});return false;}
  job.y=new Float32Array(job.length);job.low=new Float32Array(Math.ceil(job.length/this.stride));job.original=0;
  // Audit the captured waveform, rather than the subtraction error: otherwise
  // a changing short FIR appears as an extra negative colored echo source.
  for(let i=0;i<job.length;i++){const x=this.at(this.capture,job.start+i);job.y[i]=x;job.original+=x*x;if(i%this.stride===0)job.low[i/this.stride]=this.at(this.lowCapture,job.start+i);}
  job.originalY=job.y.slice();job.atoms=[];
  if(job.original<1e-16){this.reject(job,'below-threshold');return true;}
  // Freeze the separately proven hardware path for this audit. A queued
  // fit must keep its selected reference window if live metadata changes.
  job.verifiedSourceDelayMs=Number.isFinite(this.meta.verifiedSourceDelayMs)&&this.meta.verifiedSourceDelayMs>=0&&this.meta.verifiedSourceDelayMs<=500?this.meta.verifiedSourceDelayMs:null;
  const verified=job.verifiedSourceDelayMs!==null,anchored=verified||this.meta.cancelReady&&Number.isFinite(this.meta.delayMs);
  job.anchor=anchored?(verified?job.verifiedSourceDelayMs:this.meta.delayMs)*this.rate/1000:0;
  job.lowLag=anchored?Math.max(0,job.anchor-this.rate*(verified?.020:.12)):0;job.highLag=anchored?Math.min(this.rate*.5,job.anchor+this.rate*(verified?.080:.20)):this.rate*.5;
  // Snapshot every template used by this job. A low-rate callback or a pending
  // queue must not let live ring overwrites change a partially completed fit.
  job.historyStart=Math.max(0,Math.floor(job.start-job.highLag-4));
  if(job.historyStart<Math.max(0,this.total-this.size)){this.drop(job,'history-unavailable',{stage:'prepare'});return false;}
  const historyLength=job.start+job.length-job.historyStart+4;
  for(const name of ['render','lowRender']){const array=new Float32Array(historyLength);for(let i=0;i<historyLength;i++)array[i]=this.at(this[name],job.historyStart+i);job[name]=array;}
  job.immutableReference=true;if(this.kernel)this.kernel.load(job);
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
  if(job.stage==='families'){this.advanceFamilyVerification(job);return;}
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
   if(job.fullScore<job.original*1e-8||Math.abs(job.fullGain)>6||this.familyBounds(job)&&job.fullScore<job.energy*0.01){this.accept(job);return;}
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
