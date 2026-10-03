// Meaningful learning-safety and Python mask parity regressions.
// Optional private descriptor is never shipped with the web application.
const source=await Deno.readTextFile(new URL('../dsp/adaptive-background.js',import.meta.url));
const Model=new Function(`${source}\nreturn AdaptiveBackgroundSpectrum;`)();
const Bootstrap=new Function(`${source}\nreturn ProvisionalPhaseBootstrap;`)();
const rate=48000,hop=256,bins=1025,dt=hop/rate;
const flat=new Float64Array(bins).fill(1e-10),zero=new Float64Array(bins);
const tone=flat.slice();tone[43]=1e-8;
let passed=0,failed=0;
function check(name,ok,evidence={}){if(ok)passed++;else failed++;console.log(JSON.stringify({name,passed:!!ok,...evidence}));}
function seeded(){const model=new Model(rate);model.configure({duration:1.2});model.seed({mean:Array.from({length:model.rows},()=>flat),spread:Array.from({length:model.rows},()=>zero)});return model;}
function frame(model,p,index,options={}){return model.processPower(p,index*dt,{renderPower:flat,referenceTrusted:true,explicitCalibration:true,...options});}
{
 const bank=new Bootstrap(225,rate);
 for(let i=0;i<450;i++)bank.stage(flat,i*dt,i%225,Math.floor(i/225),{explicit:true,renderPresent:true});
 const noTrust=bank.confirm(2.6,{sourceTrusted:false,force:true});
 check('Provisional repeated phases never commit before independent source trust',!noTrust.ready&&noTrust.committedFrames===0);
 const early=bank.confirm(2,{sourceTrusted:true,force:true});
 check('Bootstrap retains at least150ms of later observation before commitment',!early.ready&&early.committedFrames===0);
 const ready=bank.confirm(2.6,{sourceTrusted:true,force:true});
 check('Trusted repeated background phases form an independently vetted initial model',ready.ready&&ready.coverage===1&&ready.committedFrames===450);
}
for(const kind of ['held','legato']){
 const bank=new Bootstrap(225,rate);
 for(let i=0;i<450;i++){
  const p=flat.slice(),phase=i%225;p[kind==='held'?43:phase<113?43:49]=1e-8;
  bank.stage(p,i*dt,phase,Math.floor(i/225),{explicit:true,renderPresent:true});
 }
 const out=bank.confirm(2.6,{sourceTrusted:true,force:true});
 check(`Quiet ${kind} instrument cannot enter provisional calibration despite repeated phases`,!out.ready&&out.committedFrames===0&&out.reason==='persistent-novel-tonal-cycle',{tonalDuty:out.tonalDuty});
}
{
 const bank=new Bootstrap(225,rate);
 for(let i=0;i<450;i++)bank.stage(flat,i*dt,i%225,Math.floor(i/225),{explicit:true,renderPresent:false});
 const out=bank.confirm(2.6,{sourceTrusted:true,force:true});
 check('Pre-render keyboard or microphone noise never enters the cold phase bank',!out.ready&&out.provisionalFrames===0&&out.committedFrames===0);
}
{
 const model=seeded(),before=model.version;let out;
 for(let i=0;i<300;i++)out=frame(model,flat,i,{referenceTrusted:false});
 check('Untrusted backing cannot train even during explicit calibration',model.version===before&&out.status==='unknown',{commits:model.version-before});
}
{
 const model=seeded(),before=model.version;let out;
 for(let i=0;i<300;i++)out=frame(model,tone,i);
 check('Quiet coherent held tone is frozen below onset threshold',model.version===before&&out.status==='instrument'&&out.rawRms<.004,{rawRms:out.rawRms,coherence:out.coherence,commits:model.version-before});
}
{
 const model=seeded(),before=model.version;
 for(let i=0;i<25;i++)frame(model,flat,i);
 const burst=Float64Array.from(flat,x=>x*10000),out=frame(model,burst,25,{renderPower:zero});
 check('Keyboard-like transient discards the provisional 150ms batch',model.version===before&&model.pending.length===0&&out.status==='unknown',{reason:out.reason});
}
{
 const model=new Model(rate);model.beginCalibration({duration:1.2});const before=model.version;let out;
 for(let i=0;i<700;i++)out=frame(model,flat,i,{renderPower:zero});
 check('Trusted noise-flat quiet loop tails achieve repeated phase coverage',model.version>before&&out.status==='learning'&&model.ready&&model.coverage>=.85,{coverage:model.coverage,commits:model.version-before});
}
{
 const model=seeded();for(let i=0;i<25;i++)frame(model,flat,i);
 for(let i=25;i<40;i++)frame(model,tone,i);
 const before=model.version;
 for(let i=40;i<200;i++)frame(model,flat,i,{explicitCalibration:false});
 const frozen=model.version===before;let out;
 for(let i=200;i<350;i++)out=frame(model,flat,i,{explicitCalibration:false});
 check('Music freezes writes and one-second clean rest permits recovery',frozen&&model.version>before&&out.status==='learning',{restCommits:model.version-before});
}
{
 const model=new Model(rate);model.configure({backing:false,duration:1.2});let out;
 for(let i=0;i<500;i++)out=frame(model,flat,i,{backing:false,referenceTrusted:false,explicitCalibration:false,renderPower:zero});
 const count=model.noiseCount,noise=model.noise.slice();model.invalidate();
 check('Safe ambient learning survives linked-reference invalidation',count>2&&model.noiseCount===count&&noise.every((x,i)=>x===model.noise[i])&&!model.ready,{ambientFrames:count});
}
{
 const model=seeded(),before=model.version,mean=model.mean;model.configure({delayMs:2});
 check('Small anchor drift does not erase the learned phase model',model.ready&&model.version===before&&model.mean===mean);
 model.resetStream();check('Stream reset preserves profiles but clears all provisional context',model.ready&&model.version===before&&model.mean===mean&&model.pending.length===0&&model.lastTime===-Infinity);
}
{
 const model=new Model(rate);model.configure({duration:1.2});model.seed({mean:Array.from({length:model.rows},()=>flat),counts:new Uint32Array(model.rows).fill(1)});
 check('Seeded single-observation rows do not falsely certify readiness',!model.ready&&model.coverage===0);
}
{
 const model=seeded();model.configure({oversubtraction:100});
 check('Approved oversubtraction is default four and capped at four',model.oversubtraction===4&&new Model(rate).oversubtraction===4);
 const before=model.version,out=model.process(Float64Array.from(flat,x=>Math.sqrt(x)*model.windowSum),1,{normalized:false,referenceTrusted:false});
 check('Raw FFT magnitudes normalize to sqrtPSD without model writes',out.rawPower.every((x,i)=>Math.abs(x-flat[i])<1e-22)&&model.version===before);
}
const privatePath=Deno.args[0];
if(privatePath){
 const fixture=JSON.parse(await Deno.readTextFile(privatePath));
 async function matrix(name){const entry=fixture.files[name],bytes=await Deno.readFile(entry.path),values=new Float64Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/8);return Array.from({length:entry.shape[0]},(_,i)=>values.subarray(i*bins,(i+1)*bins));}
 const mean=await matrix('mean'),spread=await matrix('spread'),power=await matrix('mixedPower');
 const model=new Model(fixture.rate);model.configure({epoch:fixture.epoch,duration:fixture.duration});model.seed({duration:fixture.duration,mean,spread,counts:fixture.counts,gain:fixture.gain});
 const initial=model.version;
 for(const test of fixture.maskCases){
  const out=model.processPower(power[test.frame],test.time,{referenceTrusted:false});
  const max=(actual,expected)=>Math.max(...actual.map((x,i)=>Math.abs(x-expected[i])));
  const maskError=max(out.mask,test.expectedMask),bgError=max(out.background,test.expectedBackground),sdError=max(out.spread,test.expectedSpread);
  check(`Private Python-approved factor4 mask parity at ${test.time}s`,maskError<1e-9&&bgError<1e-12&&sdError<1e-12,{maskError,bgError,sdError});
 }
 check('Private masks never fit bayan data',model.version===initial&&model.gain===fixture.gain,{version:model.version,gain:model.gain});
 // Ready profile comes exclusively from the independently captured baseline.
 const baseline=await matrix('baselinePower');
 if(fixture.bootstrap){
  const expectedMean=await matrix('bootstrapMean'),expectedSpread=await matrix('bootstrapSpread'),bank=new Bootstrap(fixture.rows,fixture.rate);
  for(let i=0;i<baseline.length;i++){
   const time=i*dt;if(time<fixture.bootstrap.trainingSeconds[0]||time>=fixture.bootstrap.trainingSeconds[1])continue;
   bank.stage(baseline[i],time,i%fixture.rows,Math.floor(i/fixture.rows),{explicit:true,renderPresent:true});
  }
  bank.confirm(fixture.bootstrap.confirmTime,{sourceTrusted:true,force:true});let meanError=0,spreadError=0;
  for(let row=0;row<fixture.rows;row++)for(let bin=0;bin<bins;bin++){meanError=Math.max(meanError,Math.abs(bank.mean[row][bin]-expectedMean[row][bin]));spreadError=Math.max(spreadError,Math.abs(bank.spread[row][bin]-expectedSpread[row][bin]));}
  check('All private repeated-phase bootstrap means andSDs match Python reference',bank.ready&&bank.coverage===fixture.bootstrap.coverage&&bank.counts.every((x,i)=>x===fixture.bootstrap.counts[i])&&meanError<1e-12&&spreadError<1e-12,{coverage:bank.coverage,meanError,spreadError});
 }
 const baseModel=new Model(fixture.rate);baseModel.configure({epoch:0,duration:fixture.duration});baseModel.seed({duration:fixture.duration,mean,spread,counts:fixture.counts});
 let originalEnergy=0,residualEnergy=0,heldFrames=0;
 for(let i=0;i<baseline.length;i++){
  const time=i*dt;if(time<4||time>=8||Math.abs(time-4.34)<.12||Math.abs(time-6.33)<.12)continue;
  const out=baseModel.processPower(baseline[i],time,{referenceTrusted:false});
  for(let k=1;k<bins-1;k++){originalEnergy+=baseline[i][k];residualEnergy+=out.power[k];}heldFrames++;
 }
 const attenuationDb=10*Math.log10(originalEnergy/residualEnergy);
 check('Frozen baseline-only seed suppresses genuinely held-out backing',heldFrames>500&&attenuationDb>18,{heldFrames,attenuationDb});
 const digital=await matrix('digital'),cal=new Model(fixture.rate);cal.beginCalibration({epoch:0,duration:fixture.duration});
 function renderAt(model,time){const position=model.phase(time),row=Math.floor(position),fraction=position-row;return Float64Array.from(digital[row],(value,k)=>value+(digital[(row+1)%digital.length][k]-value)*fraction);}
 const auto=new Model(fixture.rate);auto.configure({epoch:0,duration:fixture.duration});auto.seed({duration:fixture.duration,mean,spread,counts:fixture.counts});const autoBefore=auto.version,autoStates={};let unknownWrites=0;
 for(let i=0;i<baseline.length;i++){
  const time=i*dt;if(time<4||time>=8)continue;const before=auto.version;
  const out=auto.processPower(baseline[i],time,{renderPower:renderAt(auto,time),referenceTrusted:true});
  autoStates[out.status]=(autoStates[out.status]||0)+1;if(out.status!=='learning'&&auto.version!==before)unknownWrites++;
 }
 check('Recorded held-out known backing permits slow guarded automatic learning',auto.version>autoBefore&&unknownWrites===0,{commits:auto.version-autoBefore,states:autoStates});
 const musical=new Model(fixture.rate);musical.configure({epoch:fixture.epoch,duration:fixture.duration});musical.seed({duration:fixture.duration,mean,spread,counts:fixture.counts,gain:fixture.gain});const musicalBefore=musical.version,musicStates={};
 for(let i=0;i<power.length;i++){
  const time=i*dt;if(time<13||time>=25)continue;
  const out=musical.processPower(power[i],time,{renderPower:renderAt(musical,time),referenceTrusted:true});musicStates[out.status]=(musicStates[out.status]||0)+1;
 }
 check('Recorded bayan interval never changes the frozen learned model',musical.version===musicalBefore,{commits:musical.version-musicalBefore,states:musicStates});
 const bootstrapStates={};
 for(let i=0;i<baseline.length;i++){
  const time=i*dt;if(time<.05||time>=3.5)continue;
  const out=cal.processPower(baseline[i],time,{renderPower:digital[i%digital.length],referenceTrusted:true});
  bootstrapStates[out.status]=(bootstrapStates[out.status]||0)+1;
 }
 check('Recorded speaker-only calibration bootstraps from repeated phases',cal.ready&&cal.coverage>=.85,{coverage:cal.coverage,vettedObservations:cal.learnedFrames,states:bootstrapStates});
 for(const duration of [1.2,2.4]){
  const cold=new Model(fixture.rate);cold.beginCalibration({epoch:0,duration});
  const stop=duration===1.2?3.5:4.59;
  for(let i=0;i<baseline.length;i++){
   const time=i*dt;if(time<.05||time>=stop)continue;
   cold.processPower(baseline[i],time,{renderPresent:true,referenceTrusted:false,phaseTrusted:false});
  }
  const before=cold.version,uncommitted=!cold.ready&&cold.learnedFrames===0;cold.configure({delayMs:100});
  let index=Math.round(4.690666666666666/dt),time=index*dt;
  cold.processPower(baseline[index],time,{renderPresent:true,referenceTrusted:true,phaseTrusted:true});
  while(!cold.ready&&index+1<baseline.length&&time<7.5){index++;time=index*dt;cold.processPower(baseline[index],time,{renderPresent:true,referenceTrusted:true,phaseTrusted:true});}
  check(`Cold ${duration}s capture bank waits for trusted source and anchors100ms jump`,uncommitted&&cold.ready&&cold.profileAnchorDelayMs===100&&cold.version>before,{coverage:cold.coverage,vettedObservations:cold.learnedFrames,anchor:cold.profileAnchorDelayMs,readyTime:time});
  cold.endCalibration();let raw=0,residual=0;
  for(let i=index+1;i<baseline.length;i++){
   const t=i*dt;if(t>=8||Math.abs(t-6.33)<.12)continue;
   const result=cold.processPower(baseline[i],t,{referenceTrusted:false});
   for(let bin=1;bin<bins-1;bin++){raw+=baseline[i][bin];residual+=result.power[bin];}
  }
  const db=10*Math.log10(raw/residual);
  check(`Cold ${duration}s profile remains aligned on recorded held-out backing`,db>18,{attenuationDb:db});
  const expected=cold.prediction(7-.004),identity=cold.mean,version=cold.version;cold.configure({delayMs:102});cold.configure({delayMs:104});const changed=cold.prediction(7);
  check(`Two2ms hardware drift updates preserve ${duration}s profile and shift its phase`,cold.mean===identity&&cold.version===version&&changed.background.every((x,i)=>Math.abs(x-expected.background[i])<1e-12));
 }
}
console.log(JSON.stringify({passed,failed,privateFixtures:!!privatePath}));
if(failed)Deno.exit(1);
