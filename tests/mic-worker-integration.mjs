// Exercise the actual microphone setup and cleanup without audio hardware.
// The Worker transport is a double; its independent DSP protocol has its own tests.
const html=await Deno.readTextFile(Deno.args[0]||'index.html');
const begin=html.indexOf('async function connectMic('),end=html.indexOf('async function start(',begin);
const send=html.match(/^function sendDSP\(message\).*$/m)?.[0];
const stop=html.match(/^function stop\(\).*$/m)?.[0];
if(begin<0||end<begin||!send||!stop)throw Error('Microphone integration functions missing');
const source=html.slice(begin,end)+'\n'+send+'\n'+stop;
const results=[];
function expect(condition,message){if(!condition)throw Error(message);}
async function test(name,run){try{await run();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',error:error.message});}}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function setup(options={}){
 const events=[],nodes=[],delivered=[],workerCalls=[],transportMessages=[];
 class Node{
  constructor(kind){this.kind=kind;this.connections=[];this.disconnected=false;nodes.push(this);}
  connect(target,output=0,input=0){events.push({kind:'connect',from:this.kind,to:target.kind,input});this.connections.push({target,output,input});return target;}
  disconnect(){this.disconnected=true;this.connections=[];}
 }
 const transport={port:{kind:'worker-port'},closed:false,postMessage(message,transfers){transportMessages.push({message,transfers});},close(){this.closed=true;events.push({kind:'worker-close'});}};
 const master=new Node('master');
 const ctx={sampleRate:48000,currentTime:2,destination:{kind:'destination'},closed:false,
  createMediaStreamSource(){return new Node('microphone');},createGain(){const n=new Node('silent');n.gain={value:1};return n;},
  createScriptProcessor(size,inputChannels,outputChannels){return Object.assign(new Node('script-processor'),{size,inputChannels,outputChannels});},
  createChannelMerger(channels){return Object.assign(new Node('merger'),{channels});},async close(){this.closed=true;}};
 if(options.worklet!==false)ctx.audioWorklet={async addModule(){events.push({kind:'add-module'});if(options.moduleGate)await options.moduleGate;if(options.moduleError)throw Error('Worklet unavailable');}};
 class Worklet extends Node{
  constructor(context,name,config){super('worklet');this.context=context;this.name=name;this.config=config;this.messages=[];this.port={onmessage:null,postMessage:(message,transfers)=>{events.push({kind:'worklet-message',type:message.type});this.messages.push({message,transfers});}};}
 }
 const state={token:7,running:false,pending:true,measuring:options.measuring===true,calibrating:false,epoch:0,bpm:100,beats:4,lastBar:-1};
 const elements=new Map([['rhythm-dsp',{textContent:'known-dsp'}],['input-mode',{value:'sustained'}],['threshold',{value:'-48'}],['meter',{style:{},parentElement:{setAttribute(){}}}],['echo-info',{textContent:''}],['latency-info',{textContent:''}]]);
 let detectorConstructed=0;
 class Detector{constructor(){detectorConstructed++;throw Error('Heavy DSP constructor on main thread');}static compileWasm(){return 'compiled-wasm';}}
 const revoked=[];
 const fakeURL={createObjectURL(){return 'blob:worker-test';},revokeObjectURL(url){revoked.push(url);}};
 const workerFactory=async(...args)=>{workerCalls.push(args);events.push({kind:'worker-init'});if(options.workerGate)await options.workerGate;return transport;};
 const noOp=()=>{};
 const api=new Function('myContext','initialMaster','state','$','window','AudioWorkletNode','RhythmDetector','createAnalysisWorker','handleDSP','URL','Blob','document','noOp',`
  let context=myContext,master=initialMaster,source=null,silent=null,processor=null,fallback=null,analysisWorker=null,referenceMerger=null,referenceAvailable=false;
  let scheduler=null,raf=null,stream=null,trackGains=[],clickGain=null;const activeSources=new Set();
  const stopSampleRecording=noOp,resetFilteredMeter=noOp,resetDetection=noOp,clearInterval=noOp,cancelAnimationFrame=noOp,setControls=noOp,setStatus=noOp,drawChart=noOp,updateBarStats=noOp,flushSettings=noOp;
  const audibleTime=()=>myContext.currentTime,cycleDuration=()=>2.4;
  ${source}
  return {connectMic,sendDSP,stop,setContext:value=>{context=value;},get:()=>({context,source,silent,processor,fallback,analysisWorker,referenceMerger,referenceAvailable})};
 `)(ctx,master,state,id=>elements.get(id),{Worker:function(){},MessageChannel:function(){},AudioWorkletNode:Worklet},Worklet,Detector,workerFactory,message=>delivered.push(message),fakeURL,Blob,{querySelectorAll:()=>[]},noOp);
 return {api,ctx,state,master,transport,transportMessages,workerCalls,nodes,events,delivered,revoked,get detectorConstructed(){return detectorConstructed;}};
}

await test('Worklet connects transferred Worker port before microphone input and keeps the audio graph silent',async()=>{
 const h=setup();expect(await h.api.connectMic(h.ctx,{})===false,'Worklet should not report fallback');
 const {processor,source,silent}=h.api.get(),config=processor.config.processorOptions;
 expect(config.analysisWorker===true&&config.referenceRouted===true&&config.wasmModule===undefined,'DSP must run in Worker');
 const port=processor.messages.find(entry=>entry.message.type==='analysis-port');
 expect(port?.message.port===h.transport.port&&port.transfers?.[0]===h.transport.port,'Worker port must be transferred');
 expect(h.events.findIndex(e=>e.type==='analysis-port')<h.events.findIndex(e=>e.kind==='connect'&&e.from==='microphone'),'Worker port must precede microphone connection');
 expect(source.connections[0].target===processor&&h.master.connections[0].target===processor&&h.master.connections[0].input===1,'Microphone and render reference must be separate inputs');
 expect(silent.gain.value===0&&processor.connections[0].target===silent&&silent.connections[0].target===h.ctx.destination,'Analysis output must pass only through zero gain');
 h.api.sendDSP({type:'arm',start:1});expect(processor.messages.at(-1).message.type==='arm','Worklet must receive controls');
 expect(h.detectorConstructed===0,'Main thread must not construct detector');
});

await test('Latency measurement excludes rendered backing from the Worker route',async()=>{
 const h=setup({measuring:true});await h.api.connectMic(h.ctx,{});
 expect(h.api.get().processor.config.processorOptions.referenceRouted===false,'Measurement cannot route backing');
 expect(h.master.connections.length===0&&h.api.get().referenceAvailable===false,'Measurement must leave master render disconnected');
});

await test('ScriptProcessor fallback owns transferred PCM, reports exact capture frame, and outputs silence',async()=>{
 const h=setup({worklet:false});expect(await h.api.connectMic(h.ctx,{})===true,'Fallback should report its use');
 const {processor}=h.api.get();expect(processor.inputChannels===2,'Fallback must keep microphone and render channels');
 const mic=Float32Array.from({length:512},(_,i)=>i/1024),reference=Float32Array.from(mic,x=>-x),output=new Float32Array(512).fill(1);
 processor.onaudioprocess({playbackTime:3,inputBuffer:{duration:512/48000,getChannelData:channel=>channel?reference:mic},outputBuffer:{getChannelData:()=>output}});
 const capture=h.transportMessages.at(-1),frame=Math.round((3-512/48000)*48000);
 expect(capture.message.type==='capture'&&capture.message.frame===frame,'Worker frame must represent first captured sample');
 expect(capture.message.mic!==mic&&capture.message.reference!==reference&&capture.message.mic[250]===mic[250]&&capture.message.reference[250]===reference[250],'Transferred PCM must be owned copies');
 expect(capture.transfers[0]===capture.message.mic.buffer&&capture.transfers[1]===capture.message.reference.buffer,'Both owned buffers must be transferred');
 expect(output.every(x=>x===0),'Fallback analysis output must be silent');
 h.api.sendDSP({type:'threshold',value:.004});expect(h.transportMessages.at(-1).message.type==='configure'&&h.transportMessages.at(-1).message.message.type==='threshold','Fallback controls must go to Worker');
 expect(h.detectorConstructed===0,'Fallback must not construct heavy DSP on main thread');
});

await test('A rejected Worklet module keeps DSP in Worker through the silent fallback',async()=>{
 const h=setup({moduleError:true});expect(await h.api.connectMic(h.ctx,{})===true,'Worklet error should select fallback');
 expect(h.api.get().processor.kind==='script-processor'&&h.api.get().analysisWorker===h.transport&&h.detectorConstructed===0,'Worker must survive the fallback selection');
 expect(h.revoked.length===1,'Temporary module URL must be revoked');
});

for(const staleKind of ['context','token'])await test('Worker initialization abandons a stale '+staleKind+' before connecting audio',async()=>{
 const gate=deferred(),h=setup({workerGate:gate.promise}),pending=h.api.connectMic(h.ctx,{});
 if(staleKind==='context')h.api.setContext({});else h.state.token++;
 gate.resolve();await pending;
 expect(h.transport.closed,'Stale Worker transport must close');
 expect(h.nodes.every(n=>n.connections.length===0),'Stale setup must not connect audio nodes');
 expect(h.api.get().processor===null,'Stale setup must not construct a processor');
});

for(const staleKind of ['context','token'])await test('Worklet module initialization abandons a stale '+staleKind+' and closes Worker',async()=>{
 const gate=deferred(),h=setup({moduleGate:gate.promise}),pending=h.api.connectMic(h.ctx,{});
 // Advance through the awaited Worker creation to the module setup.
 await Promise.resolve();await Promise.resolve();
 expect(h.events.some(e=>e.kind==='add-module'),'Test must reach pending module setup');
 if(staleKind==='context')h.api.setContext({});else h.state.token++;
 gate.resolve();await pending;
 expect(h.transport.closed,'Stale module setup must close Worker');
 expect(h.api.get().processor===null,'Stale module setup must not construct a processor');
 expect(h.nodes.every(n=>n.connections.length===0),'Stale module setup must not connect audio');
 expect(h.revoked.length===1,'Stale module URL must still be revoked');
});

await test('Stop terminates Worker and disconnects microphone, reference, and silent output',async()=>{
 const h=setup();await h.api.connectMic(h.ctx,{});const current=h.api.get();h.state.running=true;h.state.pending=false;
 h.api.stop();expect(h.transport.closed&&h.api.get().analysisWorker===null,'Stop must terminate Worker');
 expect(current.source.disconnected&&current.processor.disconnected&&current.silent.disconnected&&h.master.disconnected,'Stop must disconnect owned audio nodes');
 expect(h.ctx.closed&&h.api.get().context===null&&h.api.get().processor===null,'Stop must close context and clear processor');
 expect(h.state.token===8&&!h.state.running&&!h.state.pending,'Stop must invalidate session');
 h.workerCalls[0][3]({type:'level',value:1});expect(h.delivered.length===0,'Late Worker output must be ignored after Stop');
});

const failed=results.filter(r=>r.status==='FAIL').length;
console.log(JSON.stringify({passed:results.length-failed,failed,total:results.length,results},null,2));
Deno.exitCode=failed?1:0;
