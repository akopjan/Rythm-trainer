// Application of a confirmed frozen phase bank is distinct from fresh learning.
const html=await Deno.readTextFile(Deno.args[0]||'index.html');
let dsp=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0][1];
for(const [marker,path] of [['STREAM','background-stream.js'],['BACKGROUND','adaptive-background.js'],['DETECTOR','background-detector.js']]){
 const source=await Deno.readTextFile(new URL('../dsp/'+path,import.meta.url));
 const first=dsp.indexOf('// GENERATED_'+marker+'_BEGIN'),last=dsp.indexOf('// GENERATED_'+marker+'_END',first);
 if(first<0||last<first)throw Error('Missing DSP marker '+marker);
 dsp=dsp.slice(0,first)+'// GENERATED_'+marker+'_BEGIN\n'+source+dsp.slice(last);
}
const {Detector,Stream,Model}=new Function(dsp+';return {Detector:RhythmDetector,Stream:BackgroundSpectralStream,Model:AdaptiveBackgroundSpectrum};')();
const module=await Detector.compileWasm();
let passed=0;const check=(name,ok)=>{if(!ok)throw Error(name);passed++;};
const rate=48000,hop=128,input=new Float32Array(hop).fill(.05),render=new Float32Array(hop).fill(.02);
function detector(){
 const messages=[],d=new Detector(rate,m=>messages.push(m),module);
 d.configure({type:'arm',start:0,duration:2.4});d.configure({type:'reference-sync',enabled:true,id:7,backing:true,routed:true});d.ensureBackground();
 const b=d.background;
 b.seed({mean:Array.from({length:b.rows},()=>new Float64Array(b.bins).fill(.01)),counts:new Uint32Array(b.rows).fill(2),anchorDelayMs:80});
 // The proof state below is a completed acoustic fit, rather than a UI latency.
 d.reference.process=(capture,reference,t)=>{
  const r=d.reference;r.baseTime??=t;r.currentTime=t+capture.length/rate;r.total+=capture.length;
  r.referencePresent=r.options.routed&&reference?.length>=capture.length;if(r.referencePresent)r.lastRenderActive=r.currentTime;
  return capture;
 };
 return {d,messages};
}
function proof(d,method='waveform') {Object.assign(d.reference,{locked:true,anchorMethod:method,matches:d.reference.matches+1,delayMs:80,cancelReady:false,noEchoProof:false});}
const held=detector();proof(held.d);held.d.process(input,0,render);
check('An acoustic waveform fit records a capture-scoped anchor',held.d.confirmedAnchor?.delayMs===80);
const version=held.d.background.version,learned=held.d.background.learnedFrames;
held.d.reference.locked=false;held.d.reference.delayMs=0;
for(let at=hop;at<8192;at+=hop)held.d.process(input,at/rate,render);
check('A ready bank stays applied after fresh acoustic lock is masked',held.d.spectral.lastFilterActive===true);
check('Retained mask uses proven 80ms phase and reference alignment',held.d.background.delayMs===80&&held.d.spectral._delay({hardwareDelayMs:80,referenceEcho:held.d.reference})===3840);
check('Applying a held bank never changes its learned version or frames',held.d.background.version===version&&held.d.background.learnedFrames===learned);
check('Retention does not claim a fresh acoustic lock',held.d.reference.locked===false);
check('The filtered meter reports actual retained WASM filtering',held.messages.some(m=>m.type==='filtered-level'&&m.active&&m.time>.045));
const unproven=detector();Object.assign(unproven.d.reference,{delayMs:80,cancelDelayMs:80,noEchoProof:true});
for(let at=0;at<4096;at+=hop)unproven.d.process(input,at/rate,render);
check('UI delay or no-echo proof cannot establish a retained acoustic anchor',unproven.d.confirmedAnchor===null);
check('No unproven retained phase mask is applied',unproven.d.spectral.lastFilterActive===false);
const amb=detector();proof(amb.d,'unknown');amb.d.process(input,0,render);amb.d.reference.locked=false;
for(let at=hop;at<4096;at+=hop)amb.d.process(input,at/rate,render);
check('An unknown/ambiguous method is not a retained acoustic proof',amb.d.confirmedAnchor===null&&!amb.d.spectral.lastFilterActive);
const missing=detector();proof(missing.d);missing.d.process(input,0,render);missing.d.process(input,hop/rate,undefined);
check('A missing paired reference revokes anchor and bank',missing.d.confirmedAnchor===null&&!missing.d.background.ready);
const clock=detector();proof(clock.d);clock.d.process(input,0,render);clock.d.reference.locked=false;clock.d.process(input,2*hop/rate,render);clock.d.process(input,2*hop/rate,render);
check('Paired 128-frame timestamp catch-up retains the continuous capture anchor',clock.d.confirmedAnchor?.delayMs===80&&clock.d.background.ready);
clock.d.process(input,.2,render);
check('A genuine source-clock jump revokes a retained bank',clock.d.confirmedAnchor===null&&!clock.d.background.ready);
for(const configuration of [{type:'invalidate'},{type:'arm',start:2,duration:2.4},{type:'reference-sync',enabled:true,id:8,backing:true,routed:true},{type:'backing-state',backing:false}]){
 const item=detector();proof(item.d);item.d.process(input,0,render);item.d.configure(configuration);
 check(configuration.type+' revokes the retained anchor',item.d.confirmedAnchor===null);
}
const changed=detector();proof(changed.d);changed.d.process(input,0,render);
const jump=(time,delay)=>{changed.d.reference.scan={stage:'full',ambiguous:false,confidence:.95,bestLag:delay*rate/1000};changed.d.reference.fail('ambiguous',time,'delay-jump',true);};
jump(1,120);check('One completed delay-jump fit does not discard the bank',changed.d.confirmedAnchor!==null&&changed.d.background.ready);
jump(1.6,122);check('Two consistent changed waveform delays revoke profile and cancellation',changed.d.confirmedAnchor===null&&!changed.d.background.ready&&!changed.d.reference.locked&&!changed.d.reference.cancelReady);
const resetModel={process(magnitudes,time,info){return {ready:true,gain:1,background:Float64Array.from(magnitudes,x=>x*x),spread:new Float64Array(magnitudes.length)};}};
const stream=new Stream(rate,resetModel,{module});
for(let at=0;at<4096;at+=hop)stream.process(input,at/rate,{referenceTrusted:true,phaseTrusted:true,backing:true});
for(let at=4096;at<8192;at+=hop)stream.process(input,at/rate,{applyConfirmedProfile:true,referenceTrusted:false,phaseTrusted:false,backing:true});
check('Application-only stream permission works after a proven clock',stream.lastFilterActive);
stream.process(input,1,{applyConfirmedProfile:true,backing:true});
for(let at=hop;at<4096;at+=hop)stream.process(input,1+at/rate,{applyConfirmedProfile:true,backing:true});
check('A stream reset requires new current proof before reuse',stream.lastFilterActive===false);
let declared=[];const capture=detector();capture.d.background.beginDeclaredCalibration=x=>declared.push(['start',x]);capture.d.background.finishDeclaredCalibration=(id,options)=>{declared.push(['end',id,options]);return {declaredReady:true,declaredReason:'test'};};capture.d.background.cancelDeclaredCalibration=id=>declared.push(['cancel',id]);
capture.d.configure({type:'background-capture-start',id:6,captureId:'bad',kind:'without',start:0,end:8});
capture.d.configure({type:'background-capture-start',id:7,captureId:'with',kind:'with',start:0,end:8});
check('Capture training rejects other sessions and instrument-labelled takes',declared.length===0);
capture.d.configure({type:'background-capture-start',id:7,captureId:'sample:7:1',kind:'without',start:0,end:8});
capture.d.configure({type:'background-capture-end',id:7,captureId:'sample:7:1',complete:true});
capture.d.configure({type:'background-capture-end',id:7,captureId:'sample:7:2',complete:false});
check('A complete declared clean capture finishes and partial capture cancels',declared[0][0]==='start'&&declared[0][1].captureId==='sample:7:1'&&declared[1][0]==='end'&&declared[2][0]==='cancel');
check('Declared-capture completion emits only a tagged model result',capture.messages.some(m=>m.type==='background-capture-result'&&m.id===7&&m.captureId==='sample:7:1'&&m.ready));
console.log(JSON.stringify({passed,total:passed,scope:'Real WASM/learning classes with controlled completed-anchor states; no physical microphone verification.'}));
