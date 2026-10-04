// The spectral front-end preserves the original microphone clock. Automatic
// background updates never set the UI calibration flag or clear score history.
class RhythmDetector extends LegacyRhythmDetector {
 static compileWasm(){return RhythmWasmCore.compile();}
 constructor(rate,emit,module=null){
  super(rate,emit);this.wasmModule=module;this.background=null;this.spectral=null;this.auditEnabled=false;this.auditTime=null;this.backgroundCalibration=null;this.ownEvidence=[];
  this.periodic=new PeriodicNoteOnset(rate,m=>this.onset(m));this.acceptedTimes=[];this.candidateCount=0;this.scoredCount=0;this.rejectedCount=0;this.lastDetectionEmit=-Infinity;
  const reject=this.attribution.reject.bind(this.attribution);
  this.attribution.reject=(job,reason)=>{this.rejectedCount++;reject(job,reason);};
  this.attribution.emit=m=>{
   if(this.mode==='sustained'&&this.acceptedTimes.some(time=>Math.abs(time-m.time)<.060))return;
   this.acceptedTimes.push(m.time);while(this.acceptedTimes.length>32)this.acceptedTimes.shift();
   this.scoredCount++;
   this.emit({...m,id:this.referenceId,isolated:true,source:'instrument'});
  };
 }
 ensureBackground(){
  if(!this.background){
   this.background=new AdaptiveBackgroundSpectrum(this.rate,m=>this.emit({...m,type:'background-state',id:this.referenceId}));
   this.background.configure({epoch:this.start||0,duration:this.duration||2.4,backing:this.reference.options.backing,oversubtraction:4});
   this.spectral=new BackgroundSpectralStream(this.rate,this.background,{module:this.wasmModule},m=>this.emit({...m,id:this.referenceId}));
  }
 }
 onset(message,gate=this.currentGate||this.threshold){
  this.candidateCount++;
  if(this.auditEnabled||this.referenceEnabled){
   const r=this.reference,linearTrusted=r.cancelReady&&r.modelCeiling<=.03;
   // A filtered block arrives later than its source samples. Source attribution
   // audits those source samples, while the score keeps its onset timestamp.
   this.attribution.queue({...message,spectralCheck:Boolean(r.options.backing&&!r.noEchoProof&&(!linearTrusted||this.mode==='sustained'||this.background?.ready)),toneCheck:Boolean(r.options.backing&&!r.noEchoProof&&(this.mode==='sustained'||!linearTrusted&&!this.background?.ready)),profileReady:this.background?.ready===true,waveformReady:linearTrusted,captureTime:Number.isFinite(this.auditTime)?this.auditTime:undefined},gate);
  }else this.emit(message);
 }
 configure(m){
  if(m.type==='calibrate'&&this.referenceEnabled){
   this.periodic.reset();
   this.ensureBackground();this.backgroundCalibration={requestedStart:m.start,duration:m.duration,deadline:null,watchdog:m.start+Math.max(30,m.duration*5)};
   this.background.beginCalibration({epoch:this.start,duration:this.duration,backing:this.reference.options.backing,oversubtraction:4});
   return;
  }
  super.configure(m);
  if(m.type==='arm'){
   this.background=null;this.spectral=null;this.backgroundCalibration=null;this.auditTime=null;this.ownEvidence=[];this.periodic.reset();this.acceptedTimes=[];this.candidateCount=0;this.scoredCount=0;this.rejectedCount=0;this.lastDetectionEmit=-Infinity;
  }
  if(m.type==='reference-sync'&&this.referenceEnabled){
   this.ensureBackground();this.background.configure({epoch:this.start,duration:this.duration,backing:m.backing,reset:true,oversubtraction:4});
   // A first profile is admitted only through the background-only guard. This
   // mode cannot learn a persistent independent tone or an unexplained tap.
   this.background.beginCalibration({epoch:this.start,duration:this.duration,backing:m.backing,oversubtraction:4});
  }
  if(m.type==='backing-state'&&this.background)this.background.configure({backing:m.backing});
  if(m.type==='mode'||m.type==='calibrate'||m.type==='invalidate')this.periodic.reset();
  if(m.type==='invalidate'&&this.background){this.background.invalidate();this.background.beginCalibration({epoch:this.start,duration:this.duration,backing:this.reference.options.backing,oversubtraction:4});}
 }
 independentHarmonics(frame){
  const p=frame?.rawPower,persistence=this.background?.persistence;if(!p||!persistence)return false;
  const peak=bin=>{
   if(persistence[bin]<Math.max(2,Math.ceil(.026*this.rate/256)))return false;
   const nearby=[];for(let j=Math.max(0,bin-6);j<=Math.min(p.length-1,bin+6);j++)nearby.push(p[j]);nearby.sort((a,b)=>a-b);
   return p[bin]>Math.max(1e-16,nearby[Math.floor(nearby.length/2)]*8);
  };
  for(let bin=Math.ceil(80*this.background.n/this.rate);bin<=Math.floor(1600*this.background.n/this.rate);bin++){
   if(!peak(bin))continue;
   for(const harmonic of [2,3]){const center=bin*harmonic;for(let j=center-1;j<=center+1&&j<p.length;j++)if(j>=0&&j*this.rate/this.background.n>=180&&peak(j))return true;}
  }
  return false;
 }
 process(samples,t,render){
  if(!this.referenceEnabled||this.probe)return super.process(samples,t,render);
  if(!samples?.length)return;
  const captured=samples,linear=this.reference.process(captured,render,t),isolation=this.reference.analysisInfo();
  this.attribution.process(render,captured,linear,t,{enabled:true,...isolation,predictedBlock:this.reference.predictedBlock,evidenceTime:this.background?.lastTime??-Infinity,
   instrumentEvidence:time=>this.ownEvidence.some(e=>e.time>=time-.025&&e.time<=time+.13&&(e.harmonic||this.background?.ready&&this.mode==='percussive'&&e.reason==='unmatched-transient')),
   tonalEvidence:time=>this.ownEvidence.some(e=>e.time>=time-.025&&e.time<=time+.13&&e.status==='instrument'&&e.reason==='persistent-tonal-energy')});
  this.ensureBackground();
  const r=this.reference,backing=r.options.backing&&!r.noEchoProof;
  if(r.locked)this.background.configure({delayMs:r.delayMs});
  this.background.configure({backing});
  const renderPresent=r.referencePresent&&backing&&t-r.lastRenderActive<=this.duration+.5;
  const result=this.spectral.process(captured,t,{referenceEcho:r,referenceTrusted:r.referencePresent&&(r.locked||r.noEchoProof),phaseTrusted:r.locked,backing,renderPresent,explicitCalibration:this.background.calibrating});
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
   this.emit({type:'detection-state',id:this.referenceId,time:t,mode:this.mode,level:Math.sqrt(analysisSamples.reduce((sum,x)=>sum+x*x,0)/analysisSamples.length),gate:this.currentGate||this.threshold,pausedReason,candidates:this.candidateCount,accepted:this.scoredCount,rejected:this.rejectedCount,pending:this.attribution.pending.length,lastDecision:this.attribution.lastDecision});
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
  const sourceTime=useLinear?t:t-result.delaySamples/this.rate;
  const wasEnabled=this.referenceEnabled;
  const oldProfile=this.profile;this.profile=null;
  this.referenceEnabled=false;this.auditEnabled=true;this.auditTime=sourceTime+captured.length/this.rate;
  try{
   super.process(analysisSamples,sourceTime,undefined);
   if(this.mode==='sustained'&&this.active&&sourceTime>=this.start)this.periodic.process(analysisSamples,sourceTime,this.currentGate||this.threshold);
  }
  finally{this.referenceEnabled=wasEnabled;this.auditEnabled=false;this.profile=oldProfile;}
 }
}
