// The spectral front-end preserves the original microphone clock. Automatic
// background updates never set the UI calibration flag or clear score history.
class RhythmDetector extends LegacyRhythmDetector {

 finishObservedCapture(){
  const a=this.attribution;
  if(!a.observedEOFLifecycleInstalled){installObservedEOFDrain(a);a.observedEOFLifecycleInstalled=true;}
  // Only already-completed line births are flushed. No FFT frame is padded.
  this.familyOnset.flush();
  const stream=this.spectral,size=stream?.mic?.n,center=Number.isFinite(this.background?.lastTime)?this.background.lastTime:null;
  const completedFrame=stream&&Number.isFinite(center)&&Number.isInteger(size)&&stream.nextCenter>=256?{center:stream.baseTime+(stream.nextCenter-256)/this.rate,end:stream.baseTime+(stream.nextCenter-256+size/2)/this.rate,size}:null;
  return a.prepareObservedEndOfCapture(a.baseTime+a.total/this.rate,completedFrame);
 }

 static compileWasm(){return RhythmWasmCore.compile();}
 constructor(rate,emit,module=null){
  super(rate,emit);installNativeTimbreLifetime(this.attribution);installStrongNativeTimbreLifetime(this.attribution);this.wasmModule=module;this.background=null;this.spectral=null;this.auditEnabled=false;this.auditTime=null;this.backgroundCalibration=null;this.ownEvidence=[];
  this.confirmedAnchor=null;this.provenMatchFloor=0;this.lastCaptureEnd=null;this.lastReferenceAvailable=false;this.delayJumpEvidence=null;
  const referenceFail=this.reference.fail.bind(this.reference);
  this.reference.fail=(status,time,reason,hold)=>{this.observeDelayJump(time,reason);return referenceFail(status,time,reason,hold);};
  this.periodic=new PeriodicNoteOnset(rate,m=>this.onset(m));this.highPeriodic=new HighPeriodicNoteOnset(rate,m=>this.onset(m));this.familyOnset=new MultiHarmonicFamilyOnset(rate,2048,m=>this.onset(m));this.lastFamilyFrameTime=-Infinity;this.acceptedTimes=[];this.acceptedSourceBirths=[];this.supplementalBirths=[];this.candidateCount=0;this.scoredCount=0;this.rejectedCount=0;this.lastDetectionEmit=-Infinity;
  const reject=this.attribution.reject.bind(this.attribution);
  this.attribution.reject=(job,reason)=>{this.rejectedCount++;reject(job,reason);};
  this.attribution.emit=m=>{
   if(this.mode==='sustained'&&!m.familyProposal)return false;
   if(this.mode==='sustained'&&this.acceptedTimes.some(time=>Math.abs(time-m.time)<.060))return false;
   this.acceptedTimes.push(m.time);while(this.acceptedTimes.length>32)this.acceptedTimes.shift();
   this.acceptedSourceBirths.push({time:m.time,birth:m.originalFamilyTime??null,frequency:m.frequency??null,native:m.sourceVerified===true&&m.familyProposal===true&&m.source==='periodic',identity:m.nativeBirthIdentity??null});while(this.acceptedSourceBirths.length>32)this.acceptedSourceBirths.shift();
   this.scoredCount++;
   this.emit({...m,id:this.referenceId,isolated:true,source:'instrument'});return true;
  };
  this.attribution.publishNativeSupplemental=(job,r,parents,blockedBy)=>{
   const a=this.attribution,identity=a.sourceBirthIdentity(r.proof),current={time:r.time,birth:r.q.time,frequency:r.frequency,native:true,identity};
   const no=reason=>({accepted:false,reason,blockedBy});
   if(!identity.h1)return no('new-body-h1-unmeasured');
   const nativePhase=a.supplementalNativePhase(job,r);if(!nativePhase.ok)return {...no(nativePhase.reason),nativePhase};
   const nativePeaks=a.supplementalNativeLocalPeak(job,r);if(!nativePeaks.ok)return {...no(nativePeaks.reason),nativePhase,nativePeaks};
   const primary=this.acceptedSourceBirths.filter(p=>Math.abs(p.time-r.time)<.060);
   if(primary.some(p=>Math.abs(p.time-r.time)<.020))return no('primary-coincidence20');
   if(primary.some(p=>!a.sourceBirthSeparate(p,current,parents)))return no('primary-family-not-independent');
   if(this.supplementalBirths.some(p=>Math.abs(p.time-r.time)<.060&&!a.sourceBirthSeparate(p,current,parents)))return no('supplemental-family-not-independent');
   if(this.supplementalBirths.some(p=>Math.abs(p.time-r.time)<.020))return no('supplemental-coincidence20');
   // Supplemental state never enters the baseline's acceptedTimes or lifetime
   // stream. Read-only rearm proof sees only earlier supplemental families.
   const saved=a.sourceFamilyLifetimes;let lifetime;
   try{a.sourceFamilyLifetimes=this.supplementalBirths;lifetime=a.sourceFamilyLifetimeAllowed(job,r);}finally{a.sourceFamilyLifetimes=saved;}
   if(!lifetime.allow)return no('supplemental-'+lifetime.reason);
   const {familyCandidates,...message}=job.message;
   this.supplementalBirths.push(current);while(this.supplementalBirths.length>64)this.supplementalBirths.shift();
   this.scoredCount++;
   this.emit({...message,time:r.time,frequency:r.frequency,level:r.q.level,source:'instrument',familyProposal:true,sourceVerified:true,originalFamilyTime:r.q.time,nativeBirthIdentity:identity,supplemental:true,blockedBy,id:this.referenceId,isolated:true});
   return {accepted:true,blockedBy,nativePhase,nativePeaks};
  };
 }
 ensureBackground(){
  if(!this.background){
   this.background=new AdaptiveBackgroundSpectrum(this.rate,m=>this.emit({...m,type:'background-state',id:this.referenceId}));
   this.background.configure({epoch:this.start||0,duration:this.duration||2.4,backing:this.reference.options.backing,oversubtraction:4});
   this.spectral=new BackgroundSpectralStream(this.rate,this.background,{module:this.wasmModule},m=>this.emit({...m,id:this.referenceId}));
  }
 }
 clearConfirmedAnchor(revokeProfile=false){
  if(revokeProfile){this.familyOnset?.reset();this.lastFamilyFrameTime=-Infinity;}
  this.confirmedAnchor=null;this.provenMatchFloor=this.reference.matches||0;this.delayJumpEvidence=null;
  if(revokeProfile&&this.background)this.background.beginCalibration({epoch:this.start||0,duration:this.duration||2.4,backing:this.reference.options.backing,oversubtraction:4});
 }
 observeDelayJump(time,reason){
  const r=this.reference,s=r.scan;
  if(reason!=='delay-jump'||!s||s.stage!=='full'||s.ambiguous||!(s.confidence>=.65)||!Number.isFinite(s.bestLag))return;
  const candidate=s.bestLag/this.rate*1000,previous=this.delayJumpEvidence;
  if(!previous||time-previous.time>3||Math.abs(candidate-previous.delayMs)>4){this.delayJumpEvidence={time,delayMs:candidate};return;}
  if(time-previous.time<.3)return;
  // Two agreeing completed waveform fits indicate a changed acoustic path.
  // A single coarse-envelope failure while playing never revokes the bank.
  this.clearConfirmedAnchor(true);r.locked=false;r.cancelReady=false;r.h.fill(0);r.pending=null;
 }
 updateConfirmedAnchor(){
  const r=this.reference,a=this.confirmedAnchor;
  if(a&&(a.reference!==r||a.baseTime!==r.baseTime||a.id!==this.referenceId||a.epoch!==this.start||a.duration!==this.duration||!r.options.routed||!r.options.backing||!r.referencePresent))this.clearConfirmedAnchor(true);
  if(r.matches<this.provenMatchFloor){this.clearConfirmedAnchor(true);this.provenMatchFloor=r.matches||0;}
  const proven=r.locked&&r.referencePresent&&r.options.routed&&r.options.backing&&!r.noEchoProof&&(r.anchorMethod==='waveform'||r.anchorMethod==='envelope')&&r.matches>this.provenMatchFloor&&Number.isFinite(r.baseTime)&&Number.isFinite(r.delayMs)&&r.delayMs>=0&&r.delayMs<=500;
  if(proven){
   if(this.confirmedAnchor&&Math.abs(r.delayMs-this.confirmedAnchor.delayMs)>12)this.clearConfirmedAnchor(true);
   this.confirmedAnchor={reference:r,baseTime:r.baseTime,id:this.referenceId,epoch:this.start,duration:this.duration,delayMs:r.delayMs};this.provenMatchFloor=r.matches;this.delayJumpEvidence=null;
  }
  return this.confirmedAnchor;
 }
 onset(message,gate=this.currentGate||this.threshold){
  if(this.mode==='sustained'&&(this.auditEnabled||this.referenceEnabled)&&this.reference.options.backing&&!this.reference.noEchoProof&&this.attribution.meta.canAudit===true&&message.familyProposal!==true)return;
  this.candidateCount++;
  if(this.auditEnabled||this.referenceEnabled){
   const r=this.reference,linearTrusted=r.cancelReady&&r.modelCeiling<=.03;
   // A filtered block arrives later than its source samples. Source attribution
   // audits those source samples, while the score keeps its onset timestamp.
   this.attribution.queue({...message,spectralCheck:Boolean(r.options.backing&&!r.noEchoProof&&(!linearTrusted||this.mode==='sustained'||this.background?.ready)),toneCheck:Boolean(r.options.backing&&!r.noEchoProof&&(this.mode==='sustained'||!linearTrusted&&!this.background?.ready)),profileReady:this.background?.ready===true,waveformReady:linearTrusted,captureTime:Number.isFinite(this.auditTime)?this.auditTime:undefined},gate);
  }else this.emit(message);
 }
 configure(m){
  if(m.type==='background-capture-start'){
   if(this.referenceEnabled&&m.id===this.referenceId&&m.kind==='without'&&typeof m.captureId==='string'&&Number.isFinite(m.start)&&Number.isFinite(m.end)&&m.end>m.start){
    this.ensureBackground();this.background.beginDeclaredCalibration({captureId:m.captureId,start:m.start,end:m.end,minAge:.45});
   }
   return;
  }
  if(m.type==='background-capture-end'){
   if(this.background&&m.id===this.referenceId&&typeof m.captureId==='string'){
    if(m.complete===true){
     const info=this.background.finishDeclaredCalibration(m.captureId,{end:m.end});
     this.emit({type:'background-capture-result',id:this.referenceId,captureId:m.captureId,ready:info.declaredReady===true,reason:info.declaredReason||info.reason});
    }else this.background.cancelDeclaredCalibration(m.captureId);
   }
   return;
  }
  if(m.type==='calibrate'&&this.referenceEnabled){
   this.periodic.reset();this.highPeriodic.reset();this.familyOnset.reset();this.lastFamilyFrameTime=-Infinity;
   this.clearConfirmedAnchor();
   this.ensureBackground();this.backgroundCalibration={requestedStart:m.start,duration:m.duration,deadline:null,watchdog:m.start+Math.max(30,m.duration*5)};
   this.background.beginCalibration({epoch:this.start,duration:this.duration,backing:this.reference.options.backing,oversubtraction:4});
   this.backgroundCalibration.captureId='manual:'+this.referenceId+':'+m.start;
   this.background.beginDeclaredCalibration({captureId:this.backgroundCalibration.captureId,start:m.start,end:this.backgroundCalibration.watchdog,minAge:.45});
   return;
  }
  super.configure(m);
  if(m.type==='arm'){
   this.clearConfirmedAnchor();this.lastCaptureEnd=null;this.lastReferenceAvailable=false;
   this.background=null;this.spectral=null;this.backgroundCalibration=null;this.auditTime=null;this.ownEvidence=[];this.periodic.reset();this.highPeriodic.reset();this.familyOnset.reset();this.lastFamilyFrameTime=-Infinity;this.acceptedTimes=[];this.acceptedSourceBirths=[];this.supplementalBirths=[];this.candidateCount=0;this.scoredCount=0;this.rejectedCount=0;this.lastDetectionEmit=-Infinity;
  }
  if(m.type==='reference-sync')this.clearConfirmedAnchor();
  if(m.type==='reference-sync'&&this.referenceEnabled){
   this.ensureBackground();this.background.configure({epoch:this.start,duration:this.duration,backing:m.backing,reset:true,oversubtraction:4});
   // A first profile is admitted only through the background-only guard. This
   // mode cannot learn a persistent independent tone or an unexplained tap.
   this.background.beginCalibration({epoch:this.start,duration:this.duration,backing:m.backing,oversubtraction:4});
  }
  if(m.type==='backing-state'&&this.background){if(m.backing!==this.background.backing)this.clearConfirmedAnchor(true);this.background.configure({backing:m.backing});}
  if(m.type==='mode'||m.type==='calibrate'||m.type==='invalidate'){this.periodic.reset();this.highPeriodic.reset();this.familyOnset.reset();this.lastFamilyFrameTime=-Infinity;}
  if(m.type==='invalidate'){this.clearConfirmedAnchor();if(this.background){this.background.invalidate();this.background.beginCalibration({epoch:this.start,duration:this.duration,backing:this.reference.options.backing,oversubtraction:4});}}
 }
 independentHarmonics(frame){
  const p=frame?.rawPower,persistence=this.background?.persistence;if(!p||!persistence)return false;
  const peak=bin=>{
   if(persistence[bin]<Math.max(2,Math.ceil(.026*this.rate/256)))return false;
   const nearby=[];for(let j=Math.max(0,bin-6);j<=Math.min(p.length-1,bin+6);j++)nearby.push(p[j]);nearby.sort((a,b)=>a-b);
   return p[bin]>Math.max(1e-16,nearby[Math.floor(nearby.length/2)]*8);
  };
  for(let bin=Math.ceil(80*this.background.n/this.rate);bin<=Math.floor(Math.min(4000,this.rate*.45/2)*this.background.n/this.rate);bin++){
   if(!peak(bin))continue;
   for(const harmonic of [2,3]){const center=bin*harmonic;for(let j=center-1;j<=center+1&&j<p.length;j++)if(j>=0&&j*this.rate/this.background.n>=180&&peak(j))return true;}
  }
  return false;
 }
 process(samples,t,render){
  if(!this.referenceEnabled||this.probe)return super.process(samples,t,render);
  if(!samples?.length)return;
  if(this.lastCaptureEnd!==null&&Math.abs(t-this.lastCaptureEnd)>.03)this.clearConfirmedAnchor(true);
  this.lastCaptureEnd=t+samples.length/this.rate;
  const captured=samples,linear=this.reference.process(captured,render,t),isolation=this.reference.analysisInfo();
  const referenceAvailable=this.reference.referencePresent&&this.reference.options.routed;
  if(!referenceAvailable&&(this.lastReferenceAvailable||this.confirmedAnchor))this.clearConfirmedAnchor(true);
  this.lastReferenceAvailable=referenceAvailable;
  const confirmedAnchor=this.updateConfirmedAnchor();
  this.attribution.process(render,captured,linear,t,{enabled:true,...isolation,verifiedSourceDelayMs:confirmedAnchor?.delayMs??null,predictedBlock:this.reference.predictedBlock,evidenceTime:this.background?.lastTime??-Infinity,getEvidenceTime:()=>this.background?.lastTime??-Infinity,
   instrumentEvidence:time=>this.ownEvidence.some(e=>e.time>=time-.025&&e.time<=time+.13&&(e.harmonic||this.background?.ready&&this.mode==='percussive'&&e.reason==='unmatched-transient')),
   tonalEvidence:time=>this.ownEvidence.some(e=>e.time>=time-.025&&e.time<=time+.13&&e.status==='instrument'&&e.reason==='persistent-tonal-energy')});
  this.ensureBackground();
  const r=this.reference,backing=r.options.backing&&!r.noEchoProof;
  if(r.locked||confirmedAnchor)this.background.configure({delayMs:r.locked?r.delayMs:confirmedAnchor.delayMs});
  this.background.configure({backing});
  const renderPresent=r.referencePresent&&backing&&t-r.lastRenderActive<=this.duration+.5;
  const phaseTrusted=r.locked&&Boolean(confirmedAnchor);
  const result=this.spectral.process(captured,t,{referenceEcho:r,referenceTrusted:r.referencePresent&&(phaseTrusted||r.noEchoProof),phaseTrusted,backing,renderPresent,explicitCalibration:this.background.calibrating,applyConfirmedProfile:Boolean(confirmedAnchor&&this.background.ready&&backing&&referenceAvailable),hardwareDelayMs:confirmedAnchor&&!r.locked?confirmedAnchor.delayMs:undefined});
  if(this.background.lastTime!==this.ownEvidence.at(-1)?.time)this.ownEvidence.push({time:this.background.lastTime,status:this.background.status,reason:this.background.reason,harmonic:this.independentHarmonics(result.result)});
  while(this.ownEvidence.length&&t-this.ownEvidence[0].time>.6)this.ownEvidence.shift();
  const level=Math.sqrt(captured.reduce((sum,x)=>sum+x*x,0)/captured.length);
  const useLinear=r.cancelReady&&r.modelCeiling<=.03,analysisSamples=useLinear?linear:result.samples;
  if(t-this.lastMeter>.045){
   this.emit({type:'level',value:level});
   this.emit({type:'filtered-level',value:Math.sqrt(analysisSamples.reduce((sum,x)=>sum+x*x,0)/analysisSamples.length),active:useLinear||result.filterActive===true,id:this.referenceId,time:t});
   this.lastMeter=t;
  }
  const cal=this.backgroundCalibration;
  if(t-this.lastDetectionEmit>=.20){
   const pausedReason=cal?'calibration':!isolation.ready&&!isolation.canAudit?'reference':!r.cancelReady&&!this.background.ready&&this.background.status==='learning'?'learning':null;
   this.emit({type:'detection-state',id:this.referenceId,time:t,mode:this.mode,level:Math.sqrt(analysisSamples.reduce((sum,x)=>sum+x*x,0)/analysisSamples.length),gate:this.currentGate||this.threshold,pausedReason,candidates:this.candidateCount,accepted:this.scoredCount,rejected:this.rejectedCount,pending:this.attribution.pending.length,lastDecision:this.attribution.lastDecision,attributionDrops:{...this.attribution.dropCounts},lastAttributionDrop:this.attribution.lastDrop??null,queueTiming:this.attribution.schedulingInfo()});
   this.lastDetectionEmit=t;
  }
  if(cal){
   if((r.cancelReady&&r.modelCeiling<=.03||this.background.ready)&&cal.deadline!==null&&cal.deadline>Math.max(t,cal.requestedStart+3*cal.duration)){
    cal.deadline=Math.max(t,cal.requestedStart+3*cal.duration);
    this.emit({type:'calibration-progress',id:this.referenceId,time:t,end:cal.deadline});
   }
   if(cal.deadline===null&&t>=cal.requestedStart&&(r.locked||!backing)){
    cal.deadline=r.cancelReady&&r.modelCeiling<=.03||this.background.ready?Math.max(t,cal.requestedStart+3*cal.duration):t+3*cal.duration;
    this.emit({type:'calibration-progress',id:this.referenceId,time:t,end:cal.deadline});
   }
   if(t>=(cal.deadline??cal.watchdog)){
    this.background.finishDeclaredCalibration(cal.captureId,{end:t});
    const info=this.background.endCalibration();this.backgroundCalibration=null;
    this.emit({type:'calibrated',id:this.referenceId,time:t,ready:info.ready||r.cancelReady&&r.modelCeiling<=.03||!backing,reason:r.cancelReady&&r.modelCeiling<=.03?'waveform-profile':!backing?'no-audible-echo':info.reason});
   }
   return;
  }
  if((this.background.ready||!backing&&this.background.noiseCount>=2)&&this.background.calibrating)this.background.endCalibration();
  if(!isolation.ready&&!isolation.canAudit)return;
  // During a confirmed background-only frame there can be no instrument onset.
  // This suppresses warm-up backing candidates without blocking music frames.
  if(!r.cancelReady&&!this.background.ready&&this.background.status==='learning')return;
  // A proven waveform path subtracts only the actual correlated computer
  // waveform. Keep that path for quiet simultaneous attacks; the spectral
  // path handles the room response that cannot be verified by waveform fit.
  if(this.mode==='sustained'&&this.active&&this.background.lastTime>=this.start&&this.background.lastTime!==this.lastFamilyFrameTime){this.lastFamilyFrameTime=this.background.lastTime;this.familyOnset.observe(result.result?.rawPower,this.background.lastTime,this.currentGate||this.threshold);}
  const sourceTime=useLinear?t:t-result.delaySamples/this.rate;
  const wasEnabled=this.referenceEnabled;
  const oldProfile=this.profile;this.profile=null;
  this.referenceEnabled=false;this.auditEnabled=true;this.auditTime=sourceTime+captured.length/this.rate;
  try{
   super.process(analysisSamples,sourceTime,undefined);
   if(this.mode==='sustained'&&this.active&&sourceTime>=this.start){this.periodic.process(analysisSamples,sourceTime,this.currentGate||this.threshold);this.highPeriodic.process(analysisSamples,sourceTime,this.currentGate||this.threshold);}
  }
  finally{this.referenceEnabled=wasEnabled;this.auditEnabled=false;this.profile=oldProfile;}
 }
}
