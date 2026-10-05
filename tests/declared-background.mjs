// Explicit rhythm-only capture, population moments and safe lifecycle boundaries.
const source=await Deno.readTextFile(new URL('../dsp/adaptive-background.js',import.meta.url));
const {Model,Bank}=new Function(source+';return {Model:AdaptiveBackgroundSpectrum,Bank:DeclaredBackgroundCapture};')();
const rate=48000,dt=256/rate,bins=1025,flat=new Float64Array(bins).fill(1e-9),zero=new Float64Array(bins);
let passed=0;
const check=(name,ok)=>{if(!ok)throw Error(name);passed++;};
function run({trusted=true,end=3.1,stop=end,epoch=.003,id='take'}={}){
 const model=new Model(rate);model.configure({duration:1.2,epoch,delayMs:111});
 check('Valid explicit capture starts',model.beginDeclaredCalibration({captureId:id,start:0,end,minAge:.45}));
 const expected=Array.from({length:model.rows},()=>[]),initial=model.version;
 for(let i=0;i*dt<stop;i++){
  const time=i*dt,cycle=Math.floor((time-epoch)/1.2),p=flat.slice();p[43]=1e-6*(1+.05*cycle);p[86]=p[43]*.2;
  const phase=model.capturePhase(time);
  if(time>=.45&&time<end-.05)expected[Math.round(phase)%model.rows].push(p);
  model.processPower(p,time,{referenceTrusted:trusted,phaseTrusted:trusted,renderPresent:true,backing:true,renderPower:flat});
 }
 check('Explicit collection never writes an unfinished profile',model.version===initial&&!model.ready);
 const capture=model.declaredCapture,info=model.finishDeclaredCalibration(id);
 return {model,expected,info,capture};
}
{
 const {model,expected,info,capture}=run();
 check('Complete declared take with a genuine source lock becomes ready',info.declaredReady&&model.ready&&model.coverage===1);
 for(let row=0;row<model.rows;row++){
  const observations=expected[row],mean=observations.reduce((s,p)=>s+p[43],0)/observations.length;
  const sd=Math.sqrt(observations.reduce((s,p)=>s+(p[43]-mean)**2,0)/observations.length);
  check('Independent population moments match the captured phases',model.counts[row]===observations.length&&Math.abs(model.mean[row][43]-mean)<1e-20&&Math.abs(Math.sqrt(model.m2[row][43]/model.counts[row])-sd)<1e-20);
 }
 check('Frame-grid offset survives non-grid metronome epochs',Math.abs(model.profilePhaseOffset-capture.phaseOffset)<1e-14);
 check('Approved mask floor is used after declared capture',model.floor===.003);
}
{
 const {model,info}=run({trusted:false});check('User label alone cannot certify acoustic phase',!info.declaredReady&&!model.ready&&info.declaredReason==='declared-source-unconfirmed');
}
{
 const {model,info}=run({stop:1.5});check('Missing capture tail does not create a profile',!info.declaredReady&&!model.ready&&info.declaredReason==='declared-capture-incomplete');
}
{
 const {model,info}=run({end:1.5});check('One cycle cannot certify every phase',!info.declaredReady&&!model.ready&&info.declaredReason==='declared-needs-two-cycles');
}
{
 const model=new Model(rate);model.configure({duration:1.2});model.seed({mean:Array.from({length:model.rows},()=>flat),spread:Array.from({length:model.rows},()=>zero)});
 const before=model.mean,version=model.version;model.beginDeclaredCalibration({captureId:'new',start:0,end:3.1});
 const stale=model.finishDeclaredCalibration('old');check('Stale completion cannot replace or close a newer capture',!stale.declaredReady&&model.declaredCapture.id==='new'&&model.mean===before&&model.version===version);
 check('Partial cancellation preserves the last confirmed profile',model.cancelDeclaredCalibration('new')&&model.ready&&model.mean===before&&model.version===version);
 model.beginDeclaredCalibration({captureId:'reset',start:0,end:3.1});model.resetStream();check('Source discontinuity discards provisional explicit capture',model.declaredCapture===null&&model.mean===before);
 model.beginDeclaredCalibration({captureId:'invalidate',start:0,end:3.1});model.invalidate();check('Reference invalidation discards both linked and provisional profile',model.declaredCapture===null&&!model.ready);
}
{
 const bank=new Bank(32,rate,bins,{captureId:'manual',start:0,end:30,minAge:.45});
 for(let i=0;i<700;i++){const t=i*dt;bank.stage(flat,t,i%32,Math.floor(i/32),{renderPresent:true,referenceTrusted:true,phaseTrusted:true},80);}
 const out=bank.finalize(3.5);check('Manual calibration finalizes at its actual earlier endpoint',out.ready&&out.counts.every(n=>n>=2));
}
console.log(JSON.stringify({passed,failed:0,scope:'Synthetic explicit calibration and model moments; no physical microphone or browser.'}));
