// Learning/control wrapper for the Python-referenced spectral power model.
// It emits no onset and never blanks microphone samples. A caller may apply
// the returned background/spread in the separately verified WASM mask core.
class ProvisionalPhaseBootstrap {
 constructor(rows,rate,n=2048){this.rows=rows;this.rate=rate;this.n=n;this.bins=n/2+1;this.frames=Array.from({length:rows},()=>[]);this.commits=0;this.coverage=0;this.ready=false;this.reason='awaiting-explicit-calibration';this.lastCheck=-Infinity;}
 stage(power,time,phase,cycle,{explicit=false,renderPresent=false}={}){
  if(!explicit||!renderPresent){this.reason='unknown-reference-or-calibration-closed';return false;}
  const row=Math.round(phase)%this.rows,list=this.frames[row];
  // Keep at most one nearest-center sample per cycle and a bounded five-cycle
  // provisional bank. No observation here is a learned background model.
  const error=Math.abs(phase-Math.round(phase)),existing=list.findIndex(frame=>frame.cycle===cycle);
  if(existing<0)list.push({cycle,time,power:Float64Array.from(power),error});else if(error<list[existing].error)list[existing]={cycle,time,power:Float64Array.from(power),error};
  if(list.length>5)list.shift();this.reason='provisional-phase-bank';return true;
 }
 similarity(a,b,width){let dot=0,pa=0,pb=0;for(let first=0;first<this.bins;first+=width){let x=0,y=0;for(let k=first;k<Math.min(first+width,this.bins);k++){x+=a[k];y+=b[k];}x=Math.sqrt(x);y=Math.sqrt(y);dot+=x*y;pa+=x*x;pb+=y*y;}return dot/Math.max(1e-24,Math.sqrt(pa)*Math.sqrt(pb));}
 confirm(time,{sourceTrusted=false,force=false}={}){
  if(!sourceTrusted){this.reason='source-clock-unconfirmed';return this.info();}
  if(!force&&time-this.lastCheck<.10)return this.info();this.lastCheck=time;
  const mean=Array.from({length:this.rows},()=>new Float64Array(this.bins)),spread=mean.map(()=>new Float64Array(this.bins)),counts=new Uint32Array(this.rows);let selected=0;
  for(let row=0;row<this.rows;row++){
   const observations=this.frames[row];let best=null;
   for(let i=0;i<observations.length;i++)for(let j=i+1;j<observations.length;j++){
    const a=observations[i],b=observations[j];if(a.cycle===b.cycle||time-Math.max(a.time,b.time)<.15)continue;
    let pa=0,pb=0;for(let k=0;k<this.bins;k++){pa+=a.power[k];pb+=b.power[k];}const ratio=pa/Math.max(1e-24,pb);
    if(ratio<.25||ratio>4)continue;const coarse=this.similarity(a.power,b.power,16),fine=this.similarity(a.power,b.power,4);
    if(coarse>=.96&&fine>=.90&&(!best||fine>best.fine))best={a,b,fine};
   }
   if(best){selected++;counts[row]=2;for(let k=0;k<this.bins;k++){const a=best.a.power[k],b=best.b.power[k];mean[row][k]=(a+b)/2;spread[row][k]=Math.abs(a-b)/2;}}
  }
  if(selected<this.rows*.85){this.reason='insufficient-repeated-phase-evidence';return this.info();}
  let tonalRows=0;
  for(let row=0;row<this.rows;row++){
   for(let bin=Math.ceil(80*this.n/this.rate);bin<=Math.floor(3500*this.n/this.rate);bin++){
    const values=[];for(let shift=-6;shift<=6;shift++)values.push(mean[row][Math.max(0,Math.min(this.bins-1,bin+shift))]);values.sort((a,b)=>a-b);
    if(mean[row][bin]>Math.max(1e-16,values[6]*8)){tonalRows++;break;}
   }
  }
  this.tonalDuty=tonalRows/this.rows;
  if(this.tonalDuty>=.65){this.reason='persistent-novel-tonal-cycle';return this.info();}
  this.mean=mean;this.spread=spread;this.counts=counts;this.commits=selected*2;this.coverage=selected/this.rows;this.ready=true;this.reason='repeated-source-locked-background';return this.info();
 }
 info(){return {ready:this.ready,coverage:this.coverage,committedFrames:this.commits,provisionalFrames:this.frames.reduce((sum,row)=>sum+row.length,0),reason:this.reason,tonalDuty:this.tonalDuty};}
}
class AdaptiveBackgroundSpectrum {
 constructor(rate,emit=()=>{}){
  this.rate=rate;this.emit=emit;this.n=2048;this.hop=256;this.bins=this.n/2+1;this.windowSum=(this.n-1)/2;
  this.noise=new Float64Array(this.bins);this.noiseM2=new Float64Array(this.bins);this.noiseCount=0;this.version=0;this.learnedFrames=0;
  this.epoch=0;this.duration=2.4;this.delayMs=0;this.backing=true;this.margin=3;this.oversubtraction=4;this.floor=.03;this.lastEmit=-Infinity;
  this.configure({epoch:0,duration:2.4,delayMs:0});
 }
 configure(options={}){
  if(Number.isFinite(options.epoch))this.epoch=options.epoch;
  if(Number.isFinite(options.duration)&&options.duration>0)this.duration=options.duration;
  if(Number.isFinite(options.delayMs))this.delayMs=options.delayMs;
  if(typeof options.backing==='boolean')this.backing=options.backing;
  if(Number.isFinite(options.margin))this.margin=Math.max(0,Math.min(8,options.margin));
  if(Number.isFinite(options.oversubtraction))this.oversubtraction=Math.max(1,Math.min(4,options.oversubtraction));
  const rows=Math.max(32,Math.min(1024,Math.round(this.duration*this.rate/this.hop)));
  if(rows!==this.rows||options.reset===true){this.rows=rows;this.resetLinked();}
  return this.info();
 }
 resetLinked(){
  this.mean=Array.from({length:this.rows},()=>new Float64Array(this.bins));this.m2=this.mean.map(()=>new Float64Array(this.bins));this.upper=this.mean.map(()=>new Float64Array(this.bins));this.counts=new Uint32Array(this.rows);
  this.pending=[];this.cleanWindow=[];this.unknownSince=null;this.calibrating=false;this.ready=false;this.bootstrap=new ProvisionalPhaseBootstrap(this.rows,this.rate,this.n);this.profileAnchorDelayMs=0;this.cleanSince=null;this.lastVeto=-Infinity;this.lastTime=-Infinity;this.lastPower=0;this.lastMagnitude=new Float64Array(this.bins);this.persistence=new Uint16Array(this.bins);this.status='unknown';this.reason='profile-needed';this.gain=1;this.coverage=0;this.version++;
 }
 invalidate(){this.resetLinked();return this.info();}
 resetStream(){this.pending=[];this.cleanWindow=[];this.unknownSince=null;this.cleanSince=null;this.lastVeto=-Infinity;this.lastTime=-Infinity;this.lastPower=0;this.lastMagnitude.fill(0);this.persistence.fill(0);this.status='unknown';this.reason='stream-reset';this.lastEmit=-Infinity;return this.info();}
 beginCalibration(options={}){this.configure(options);this.resetLinked();this.calibrating=true;this.reason='explicit-calibration';return this.info();}
 endCalibration(){this.calibrating=false;this.updateReadiness();return this.info();}
 seed(model={}){
  if(Number.isFinite(model.duration))this.configure({duration:model.duration});
  if(!Array.isArray(model.mean)||model.mean.length!==this.rows)throw new Error('Background profile row count differs');
  for(let row=0;row<this.rows;row++){
   if(model.mean[row].length!==this.bins)throw new Error('Background profile bin count differs');
   const count=model.counts?Math.max(0,Math.floor(Number(model.counts[row])||0)):2;this.counts[row]=count;
   for(let bin=0;bin<this.bins;bin++){const value=Number(model.mean[row][bin]);if(!Number.isFinite(value)||value<0)throw new Error('Invalid background power');this.mean[row][bin]=value;const sd=Number(model.spread?.[row]?.[bin])||0;this.m2[row][bin]=Math.max(0,sd)**2*count;this.upper[row][bin]=Math.max(value,Number(model.upper?.[row]?.[bin])||value);}
  }
  if(model.noise){if(model.noise.length!==this.bins)throw new Error('Ambient bin count differs');for(let bin=0;bin<this.bins;bin++)this.noise[bin]=Math.max(0,Number(model.noise[bin])||0);this.noiseCount=2;}
  if(Number.isFinite(model.gain)&&model.gain>0)this.gain=model.gain;
  this.profileAnchorDelayMs=Number.isFinite(model.anchorDelayMs)?model.anchorDelayMs:0;
  this.pending=[];this.cleanWindow=[];this.unknownSince=null;this.cleanSince=null;this.version++;this.updateReadiness();return this.info();
 }
 updateReadiness(){let covered=0;for(const count of this.counts)if(count>=2)covered++;this.coverage=covered/this.rows;this.ready=this.coverage>=.85;}
 capturePhase(time){const value=(time-this.epoch)/this.duration,phase=((value%1)+1)%1*this.rows,nearest=Math.round(phase);return Math.abs(phase-nearest)<1e-7?nearest%this.rows:phase;}
 phase(time){return this.capturePhase(time-(this.delayMs-this.profileAnchorDelayMs)/1000);}
 prediction(time){
  const phase=this.phase(time),row=Math.floor(phase),fraction=phase-row,pool=Math.min(2,Math.floor(.011/(this.duration/this.rows))),background=new Float64Array(this.bins),spread=new Float64Array(this.bins);
  for(let bin=0;bin<this.bins;bin++){
   let a=0,b=0,sa=0,sb=0;
   for(let shift=-pool;shift<=pool;shift++){
    const first=(row+shift+this.rows)%this.rows,second=(first+1)%this.rows;
    if(this.counts[first]){a=Math.max(a,this.mean[first][bin]);sa=Math.max(sa,Math.sqrt(this.m2[first][bin]/this.counts[first]));}
    if(this.counts[second]){b=Math.max(b,this.mean[second][bin]);sb=Math.max(sb,Math.sqrt(this.m2[second][bin]/this.counts[second]));}
   }
   background[bin]=this.noise[bin]+a+(b-a)*fraction;spread[bin]=sa+(sb-sa)*fraction;
  }
  return {background,spread,row};
 }
 features(power,predicted,render){
  let total=0,expected=0,excess=0,log=0,flatSum=0,flatN=0,flux=0,magnitudeSum=0;const peaks=new Uint8Array(this.bins),nextPersistence=new Uint16Array(this.bins);
  for(let bin=0;bin<this.bins;bin++){
   const p=power[bin],m=Math.sqrt(p),weight=bin===0||bin===this.bins-1?1:2;total+=p*weight;expected+=predicted.background[bin]*this.gain*weight;excess+=Math.max(0,p-(predicted.background[bin]+3*predicted.spread[bin])*this.gain)*weight;flux+=Math.max(0,m-this.lastMagnitude[bin]);magnitudeSum+=m;this.lastMagnitude[bin]=m;
   const hz=bin*this.rate/this.n;if(hz>=600&&hz<=9000){log+=Math.log(Math.max(1e-20,p));flatSum+=p;flatN++;}
   if(hz>=80&&hz<=3500){const nearby=[];for(let k=Math.max(0,bin-6);k<=Math.min(this.bins-1,bin+6);k++)nearby.push(power[k]);nearby.sort((a,b)=>a-b);const local=nearby[Math.floor(nearby.length/2)],known=(predicted.background[bin]+4*predicted.spread[bin])*this.gain;
    if(p>Math.max(1e-16,known*3,this.noise[bin]*6)&&p>local*8){peaks[bin]=1;nextPersistence[bin]=Math.min(65535,1+Math.max(this.persistence[Math.max(0,bin-1)],this.persistence[bin],this.persistence[Math.min(this.bins-1,bin+1)]));}
   }
  }
  this.persistence=nextPersistence;let persistent=0,novelPeaks=0,tonalPower=0;for(let bin=0;bin<this.bins;bin++){if(peaks[bin])novelPeaks++;if(nextPersistence[bin]>=6){persistent++;tonalPower+=power[bin]*2;}}
  let dot=0,pa=0,pb=0,renderTotal=0;
  for(let first=1;first<this.bins;first+=16){let a=0,b=0;for(let bin=first;bin<Math.min(first+16,this.bins);bin++){a+=power[bin];b+=this.ready?predicted.background[bin]:render?.[bin]||0;renderTotal+=render?.[bin]||0;}a=Math.sqrt(a);b=Math.sqrt(b);dot+=a*b;pa+=a*a;pb+=b*b;}
  const coherence=pa*pb>1e-24?dot/Math.sqrt(pa*pb):0,flatness=flatN&&flatSum>0?Math.exp(log/flatN)/(flatSum/flatN):0,rms=Math.sqrt(total*2/3),rise=total>Math.max(1e-14,this.lastPower*2.5);this.lastPower=total;
  return {total,expected,excessRatio:total>1e-24?excess/total:0,flatness,flux:magnitudeSum>1e-20?flux/magnitudeSum:0,rms,rise,peaks,persistent,novelPeaks,tonalFraction:total>0?tonalPower/total:0,coherence,renderTotal};
 }
 veto(time,status,reason){this.pending=[];this.cleanWindow=[];this.unknownSince=null;this.cleanSince=null;this.lastVeto=time;this.status=status;this.reason=reason;}
 commit(frame){
  const targets=frame.ambient?[[this.noise,this.noiseM2,this.noiseCount]]:[[this.mean[frame.row],this.m2[frame.row],this.counts[frame.row]]];
  const [mean,m2,count]=targets[0],next=count+1;
  for(let bin=0;bin<this.bins;bin++){
   const value=frame.ambient?frame.power[bin]:Math.max(0,frame.power[bin]/this.gain-this.noise[bin]),delta=value-mean[bin];
   if(frame.calibration||count<3){mean[bin]+=delta/next;m2[bin]+=delta*(value-mean[bin]);}
   else{const alpha=.01;mean[bin]+=alpha*delta;m2[bin]=(1-alpha)*(m2[bin]/count+alpha*delta*delta)*next;}
   if(!frame.ambient)this.upper[frame.row][bin]=frame.calibration?Math.max(this.upper[frame.row][bin],value):Math.max(mean[bin],this.upper[frame.row][bin]*.999+value*.001);
  }
  if(frame.ambient)this.noiseCount=next;else this.counts[frame.row]=next;this.learnedFrames++;this.version++;this.updateReadiness();
 }
 info(){return {status:this.status,reason:this.reason,ready:this.ready,calibrating:this.calibrating,coverage:this.coverage,version:this.version,learnedFrames:this.learnedFrames,ambientFrames:this.noiseCount,pendingFrames:this.pending?.length||0,provisionalFrames:this.bootstrap?.info().provisionalFrames||0,bootstrapReason:this.bootstrap?.reason,profileAnchorDelayMs:this.profileAnchorDelayMs,rows:this.rows,gain:this.gain};}
 process(magnitudes,time,context={}){
  if(!Number.isFinite(time)||magnitudes?.length!==this.bins)throw new Error('Expected finite FFT-center time and1025 magnitudes');
  const scale=context.normalized===false?1/this.windowSum:1,power=Float64Array.from(magnitudes,x=>Number.isFinite(x)?Math.max(0,x*scale)**2:0),render=context.renderMagnitudes?Float64Array.from(context.renderMagnitudes,x=>Number.isFinite(x)?Math.max(0,x*scale)**2:0):null;
  return this.processPower(power,time,{...context,renderPower:render});
 }
 processPower(power,time,context={}){
  if(power?.length!==this.bins||!Number.isFinite(time))throw new Error('Expected1025 power bins and finite center time');
  if(time<=this.lastTime){this.pending=[];this.cleanWindow=[];this.unknownSince=null;this.cleanSince=null;return {...this.info(),reason:'non-monotonic-time',power,magnitudes:Float64Array.from(power,x=>Math.sqrt(Math.max(0,x)))};}
  this.lastTime=time;const backing=typeof context.backing==='boolean'?context.backing:this.backing,trusted=context.referenceTrusted===true&&context.phaseTrusted!==false,calibration=this.calibrating||context.explicitCalibration===true;
  if(!this.ready&&calibration&&backing&&this.bootstrap){
   const phase=this.capturePhase(time),cycle=Math.floor((time-this.epoch)/this.duration),renderPresent=context.renderPresent===true||trusted;
   this.bootstrap.stage(power,time,phase,cycle,{explicit:true,renderPresent});
   const boot=this.bootstrap.confirm(time,{sourceTrusted:trusted});
   if(boot.ready){const bank=this.bootstrap;this.seed({mean:bank.mean,spread:bank.spread,counts:bank.counts,gain:1,anchorDelayMs:this.delayMs});this.learnedFrames+=bank.commits;this.bootstrap=null;}
  }
  const predicted=this.prediction(time),features=this.features(power,predicted,context.renderPower);
  // Persistent excess tonal energy is evidence even below the onset threshold.
  // Unknown transients freeze learning rather than being relabeled as rest.
  const own=features.persistent>=1,offTemplate=features.rise&&features.flux>.30&&(!backing||(this.ready?features.excessRatio>.60:features.renderTotal<1e-12)),unexplained=this.ready&&features.excessRatio>.60&&features.coherence<.85;
  if(own)this.veto(time,'instrument','persistent-tonal-energy');
  else if(offTemplate||unexplained||backing&&!trusted)this.veto(time,'unknown',offTemplate?'unmatched-transient':unexplained?'unexplained-energy':'reference-unconfirmed');
  else{
   const quietNoise=!backing&&features.flatness>.55&&features.rms<.002&&!features.persistent;
   const quietTail=calibration&&backing&&trusted&&features.renderTotal<1e-12&&features.flatness>.55&&features.rms<.002&&!features.novelPeaks;
   const knownQuiet=this.ready&&features.rms<.002&&!features.novelPeaks&&features.coherence>.75&&features.excessRatio<.45;
   const matched=backing&&trusted&&!features.novelPeaks&&(this.ready?features.coherence>.85&&features.excessRatio<.30||knownQuiet:calibration&&features.coherence>.75&&features.renderTotal>1e-12),confirmed=quietNoise||quietTail||matched;
   this.cleanWindow.push({time,confirmed});while(this.cleanWindow.length&&time-this.cleanWindow[0].time>1.05)this.cleanWindow.shift();
   if(confirmed)this.unknownSince=null;else if(this.unknownSince===null)this.unknownSince=time;
   if(this.unknownSince!==null&&time-this.unknownSince>.12){this.pending=[];this.cleanWindow=[];this.lastVeto=time;}
   const fraction=this.cleanWindow.length?this.cleanWindow.reduce((sum,frame)=>sum+(frame.confirmed?1:0),0)/this.cleanWindow.length:0;
   const rested=confirmed&&(calibration||this.cleanWindow.length&&time-this.cleanWindow[0].time>=1&&time-this.lastVeto>=1&&fraction>=.80);
   this.status=rested?'learning':'unknown';this.reason=rested?(quietNoise?'stationary-noise':quietTail?'trusted-quiet-tail':'matched-backing'):confirmed?'waiting-for-clean-rest':'background-unconfirmed';
   if(rested)this.pending.push({time,row:predicted.row,power:Float64Array.from(power),ambient:quietNoise,calibration});
   // Unknown frames neither enter the bank nor release earlier frames. A
   // confirmed tone/transient veto discards the preceding150ms candidate bank.
   if(rested)while(this.pending.length&&time-this.pending[0].time>=.15)this.commit(this.pending.shift());
  }
  const residual=new Float64Array(this.bins),mask=new Float64Array(this.bins),filtered=new Float64Array(this.bins);
  for(let bin=0;bin<this.bins;bin++){
   const p=Math.max(0,power[bin]),known=this.ready||this.noiseCount>=2?(predicted.background[bin]+this.margin*predicted.spread[bin])*this.gain*this.oversubtraction:0;
   const ratio=p>1e-30?Math.max(this.floor,Math.sqrt(Math.max(0,p-known)/p)):this.floor;
   mask[bin]=ratio;residual[bin]=p*ratio*ratio;filtered[bin]=Math.sqrt(residual[bin]);
  }
  let residualTotal=0;for(let bin=0;bin<this.bins;bin++)residualTotal+=residual[bin]*(bin===0||bin===this.bins-1?1:2);
  const info=this.info();if(time-this.lastEmit>=.5){this.lastEmit=time;this.emit({type:'background-learning',time,...info,coherence:features.coherence});}
  return {...info,power:residual,rawPower:power,magnitudes:filtered,mask,background:predicted.background,spread:predicted.spread,rms:Math.sqrt(residualTotal*2/3),rawRms:features.rms,coherence:features.coherence,excessRatio:features.excessRatio};
 }
}
