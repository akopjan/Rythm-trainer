// Observe the real detector's chosen PCM with fixed inputs. Acoustic estimation
// is stubbed here; this test verifies signal routing, meter values, and tags.
const html=await Deno.readTextFile(Deno.args[0]||'index.html');
const dsp=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0]?.[1];
if(!dsp)throw Error('App DSP is missing');
const {RhythmDetector,LegacyRhythmDetector,BackgroundSpectralStream}=new Function(dsp+';return {RhythmDetector,LegacyRhythmDetector,BackgroundSpectralStream};')();
let passed=0;const check=(name,condition)=>{if(!condition)throw Error(name);passed++;};
const rms=samples=>Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);
const near=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<1e-10;
const raw=Float32Array.from({length:128},(_,i)=>i%2?.21:-.17);
const linear=Float32Array.from({length:128},(_,i)=>i%2?.008:-.004);
const spectral=Float32Array.from({length:128},(_,i)=>i%2?.03:-.018);
const oldProcess=LegacyRhythmDetector.prototype.process;
const observed=[];
const periodicObserved=[];
LegacyRhythmDetector.prototype.process=function(samples,time){observed.push({detector:this,samples,time});};
function detector({cancelReady=false,ceiling=.01,filterActive=false,noEchoProof=false,calibrating=false,isolationReady=true}={}){
 const messages=[];const d=new RhythmDetector(48000,message=>messages.push(message));
 d.referenceEnabled=true;d.referenceId=29;d.duration=2.4;d.start=0;d.lastMeter=-10;
 d.reference={options:{backing:true},referencePresent:true,locked:true,delayMs:100,lastRenderActive:0,cancelReady,modelCeiling:ceiling,noEchoProof,
  process:()=>linear,analysisInfo:()=>({ready:isolationReady,canAudit:isolationReady})};
 d.attribution={process(){},queue(){},pending:[],rejected:0,lastDecision:null};
 d.background={lastTime:1,ready:true,status:'unknown',reason:'test',noiseCount:2,calibrating:false,configure(){},endCalibration(){return {ready:true};}};
 d.spectral={process:()=>({samples:spectral,delaySamples:2048,filterActive,result:null})};
 d.mode='sustained';d.active=true;
 d.periodic={process(samples,time,gate){periodicObserved.push({detector:d,samples,time,gate});},reset(){}};
 d.ensureBackground=()=>{};
 if(calibrating)d.backgroundCalibration={requestedStart:0,duration:2.4,deadline:20,watchdog:30};
 return {d,messages};
}
try{
 for(const [name,options,expected,active]of[
  ['Proven waveform cancellation',{cancelReady:true,filterActive:true},linear,true],
  ['Unverified waveform uses spectral cancellation',{cancelReady:true,ceiling:.09,filterActive:true},spectral,true],
  ['Spectral profile cancellation',{filterActive:true},spectral,true],
  ['Preparation without cancellation',{filterActive:false},spectral,false],
  ['Ambient spectral cancellation without audible echo',{filterActive:true,noEchoProof:true},spectral,true],
 ]){
  const {d,messages}=detector(options);d.process(raw,1,new Float32Array(128));
  const rawMessages=messages.filter(m=>m.type==='level'),filtered=messages.filter(m=>m.type==='filtered-level');
  check(name+': raw meter is actual capture',rawMessages.length===1&&near(rawMessages[0].value,rms(raw)));
  check(name+': one filtered meter message',filtered.length===1);
  check(name+': filtered meter is actual chosen PCM',near(filtered[0].value,rms(expected))&&observed.at(-1)?.samples===expected);
  check(name+': cancellation state is honest',filtered[0].active===active);
  check(name+': capture clock and session are retained',filtered[0].time===1&&filtered[0].id===29);
  check(name+': diagnostic messages leave periodic note detection running',periodicObserved.at(-1)?.detector===d&&periodicObserved.at(-1)?.samples===expected);
 }
 const {d,messages}=detector({filterActive:true});
 d.process(raw,1,new Float32Array(128));d.process(raw,1.01,new Float32Array(128));d.process(raw,1.06,new Float32Array(128));
 check('Raw and filtered meters use the same bounded cadence',messages.filter(m=>m.type==='level').length===2&&messages.filter(m=>m.type==='filtered-level').length===2);
 const diagnostic=messages.find(m=>m.type==='detection-state');
 check('Live diagnostic is tagged with capture clock and current session',diagnostic?.id===29&&diagnostic.time===1&&diagnostic.mode==='sustained');
 check('Live diagnostic describes actual filtered level and actual queue',near(diagnostic.level,rms(spectral))&&diagnostic.pausedReason===null&&diagnostic.candidates===0&&diagnostic.accepted===0&&diagnostic.rejected===0&&diagnostic.pending===0);
 check('Diagnostic cadence is bounded independently of audio and meters',messages.filter(m=>m.type==='detection-state').length===1);
 const cal=detector({filterActive:true,calibrating:true});cal.d.process(raw,1,new Float32Array(128));
 check('Calibration still displays filtered sound',cal.messages.some(m=>m.type==='filtered-level'&&m.active===true&&near(m.value,rms(spectral))));
 check('Calibration is reported independently of filter readiness',cal.messages.some(m=>m.type==='detection-state'&&m.pausedReason==='calibration'));
 check('Calibration pause still prevents note processing',!periodicObserved.some(m=>m.detector===cal.d));
 const blocked=detector({filterActive:true,isolationReady:false});blocked.d.process(raw,1,new Float32Array(128));
 check('Missing reference is exposed even when filtering is active',blocked.messages.some(m=>m.type==='detection-state'&&m.pausedReason==='reference')&&blocked.messages.some(m=>m.type==='filtered-level'&&m.active));
 check('Reference pause prevents scoring but keeps both live levels',!periodicObserved.some(m=>m.detector===blocked.d)&&blocked.messages.some(m=>m.type==='level')&&blocked.messages.some(m=>m.type==='filtered-level'));
}finally{LegacyRhythmDetector.prototype.process=oldProcess;}
// Readiness reflects successful WASM mask application, not just model.ready.
const wasmModule=await RhythmDetector.compileWasm();
let profileKind='valid';
const streamErrors=[];
const model={process(magnitudes){return {ready:true,gain:profileKind==='bad-gain'?NaN:1,
 background:profileKind==='bad-profile'?new Float64Array(1):Float64Array.from(magnitudes,x=>x*x),
 spread:new Float64Array(magnitudes.length)};}};
const stream=new BackgroundSpectralStream(48000,model,{module:wasmModule},m=>streamErrors.push(m));
let sampleOffset=0;
const context={referenceTrusted:true,phaseTrusted:true,backing:true};
function block(length,ctx=context){const result=stream.process(new Float32Array(length).fill(.02),sampleOffset/48000,ctx);sampleOffset+=length;return result;}
check('FFT preparation never announces an active filter',block(512).filterActive===false);
check('Successful WASM mask application announces active filtering',block(512).filterActive===true);
check('Untrusted phase cannot announce an active filter',block(256,{...context,phaseTrusted:false}).filterActive===false);
profileKind='bad-profile';check('Malformed profile cannot announce active filtering',block(256).filterActive===false&&streamErrors.some(m=>m.type==='background-filter-error'));
profileKind='bad-gain';check('Invalid gain cannot announce active filtering',block(256).filterActive===false);
profileKind='valid';check('A later verified frame restores active filtering',block(256).filterActive===true);
sampleOffset+=48000;check('A capture-clock discontinuity clears readiness',block(128).filterActive===false);
console.log(JSON.stringify({passed,total:passed}));
