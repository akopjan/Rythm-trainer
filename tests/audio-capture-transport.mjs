// Exercise the shipped audio-thread wrapper. Heavy recognition must stay out
// of capture mode; signal ownership, source clocks and control order are part
// of the transport contract. No microphone or browser timing is simulated.
const target=Deno.args[0]??new URL('../index.html',import.meta.url);
const html=await Deno.readTextFile(target);
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0]?.[1];
if(!source)throw new Error('DSP script missing');
const results=[];
function assert(value,message){if(!value)throw new Error(message);}
function equal(a,b,message){assert(JSON.stringify(a)===JSON.stringify(b),message);}
function test(name,run){try{results.push({name,status:'PASS',evidence:run()});}catch(error){results.push({name,status:'FAIL',error:String(error)});}}
function port(){
 return {messages:[],started:0,closed:0,onmessage:null,
  postMessage(message,transfers=[]){
   const sizes=transfers.map(buffer=>buffer.byteLength);
   this.messages.push({message:structuredClone(message,{transfer:transfers}),sizes});
  },start(){this.started++;},close(){this.closed++;}};
}
function fixture(rate=48000,options={analysisWorker:true,referenceRouted:true}){
 const constructors=[],calls=[],controls=[],registered={};
 class Base {constructor(){this.port=port();}}
 const api=new Function('AudioWorkletProcessor','registerProcessor','sampleRate','currentFrame','constructors','calls','controls',source+`
  RhythmDetector=class {
   constructor(...args){constructors.push(args);this.referenceEnabled=false;this.reference={options:{routed:false}};}
   configure(message){controls.push(message);}
   process(mic,time,reference){calls.push({mic:mic.slice(),time,reference:reference?.slice()});}
  };
  return {setFrame(frame){currentFrame=frame;}};
 `)(Base,(name,processor)=>{registered[name]=processor;},rate,0,constructors,calls,controls);
 assert(registered['rhythm-detector'],'Audio processor was not registered');
 const node=new registered['rhythm-detector']({processorOptions:options});
 const worker=port();
 const send=message=>node.port.onmessage({data:message});
 const attach=()=>send({type:'analysis-port',port:worker});
 const process=(frame,mic,reference)=>{
  api.setFrame(frame);
  const output=[Float32Array.from({length:128},()=>.7),Float32Array.from({length:128},()=>-.4)];
  const returned=node.process([mic?[mic]:[],reference?[reference]:[]],[output]);
  assert(output.every(channel=>channel.every(x=>x===0)),'Raw input leaked into audible output');
  return returned;
 };
 return {node,worker,constructors,calls,controls,send,attach,process};
}
const mic=()=>Float32Array.from({length:128},(_,i)=>(i-64)/256);
const reference=()=>Float32Array.from({length:128},(_,i)=>Math.sin(i*.23)*.2);

test('Capture construction and configuration never instantiate heavy recognition',()=>{
 const f=fixture();f.send({type:'threshold',value:.004});f.attach();f.process(1923328,mic(),reference());
 assert(f.constructors.length===0&&f.calls.length===0&&f.controls.length===0,'Capture mode ran the detector');
 return {detectorConstructions:0,detectorCalls:0};
});
test('Unattached audio writes zeros and sends no capture or input through the control port',()=>{
 const f=fixture();assert(f.process(640,mic(),reference())===true,'Capture processor stopped while waiting for its worker');
 assert(f.worker.messages.length===0&&f.node.port.messages.length===0,'Audio was sent before attachment');
 assert(f.constructors.length===0&&f.calls.length===0,'Unattached capture ran recognition');
 return {framesDiscardedBeforeAttachment:128};
});
for(const rate of [8000,44100,48000])test(`Paired 128-frame signals retain their source clock at ${rate} Hz`,()=>{
 const f=fixture(rate),input=mic(),render=reference(),expectedMic=[...input],expectedRender=[...render],frame=rate*40+128;
 f.attach();assert(f.process(frame,input,render)===true,'Live capture processor stopped');
 assert(f.worker.messages.length===1,'One source quantum did not produce one paired packet');
 const {message,sizes}=f.worker.messages[0];
 assert(message.type==='capture'&&message.frame===frame,'Absolute source-frame clock was changed');
 assert(message.mic instanceof Float32Array&&message.reference instanceof Float32Array,'Paired signals are not Float32 PCM');
 equal([...message.mic],expectedMic,'Microphone samples changed');equal([...message.reference],expectedRender,'Render samples changed');
 equal(sizes,[512,512],'Paired PCM buffers were not transferred together');
 assert(input.byteLength===512&&render.byteLength===512,'Browser input buffers were detached');
 equal([...input],expectedMic,'Capture mutated browser microphone input');equal([...render],expectedRender,'Capture mutated browser reference input');
 assert(f.constructors.length===0&&f.calls.length===0,'Capture ran heavy recognition');
 return {frame,microphoneSamples:128,referenceSamples:128,transferredBytes:1024};
});
test('A silent routed master input remains a paired zero waveform',()=>{
 const f=fixture();f.attach();f.process(1024,mic(),undefined);
 const {message,sizes}=f.worker.messages[0];
 assert(message.reference instanceof Float32Array&&message.reference.length===128&&message.reference.every(x=>x===0),'Routed silence was mistaken for missing reference');
 equal(sizes,[512,512],'Routed silence was not transferred with capture');
 return {referenceSamples:128,referenceIsZero:true};
});
test('An intentionally unrouted reference remains absent',()=>{
 const f=fixture(48000,{analysisWorker:true,referenceRouted:false});f.attach();f.process(1024,mic(),undefined);
 const {message,sizes}=f.worker.messages[0];
 assert(message.reference===null,'Unrouted input fabricated a reference source');equal(sizes,[512],'Unrouted capture transferred a reference buffer');
 return {reference:null,transferredBytes:512};
});
test('A missing microphone block does not fabricate a capture packet',()=>{
 const f=fixture();f.attach();assert(f.process(1024,undefined,reference())===true,'Missing input terminated live capture');
 assert(f.worker.messages.length===0,'An absent microphone input became player audio');
 return {capturedPackets:0};
});
test('Source clock gaps remain visible and paired packet order is preserved',()=>{
 const f=fixture();f.attach();f.process(2048,mic(),reference());f.process(2176,undefined,reference());f.process(2304,mic(),reference());f.process(2432,mic(),reference());
 equal(f.worker.messages.map(x=>x.message.frame),[2048,2304,2432],'A clock gap was compressed or packets reordered');
 assert(f.worker.messages.every(x=>x.message.type==='capture'&&x.message.mic.length===128&&x.message.reference.length===128),'A gap broke paired quantum sizes');
 return {sourceFrames:[2048,2304,2432],gapFrames:128};
});
test('Configuration queued before attachment flushes in FIFO order before capture',()=>{
 const f=fixture(),commands=[{type:'mode',value:'sustained'},{type:'threshold',value:.004},{type:'arm',start:40.25,duration:3.6}];
 f.send(commands[0]);f.send(commands[1]);assert(f.worker.messages.length===0,'Configuration was sent without a transport');
 f.attach();f.send(commands[2]);f.process(1920000,mic(),reference());
 equal(f.worker.messages.map(x=>x.message.type),['configure','configure','configure','capture'],'Configuration/capture transfer order changed');
 equal(f.worker.messages.slice(0,3).map(x=>x.message.message),commands,'Configuration payload or FIFO order changed');
 assert(f.controls.length===0&&f.constructors.length===0,'Forwarded control also configured an audio-thread detector');
 return {controlTypes:commands.map(x=>x.type),captureFollowsControls:true};
});
test('The ordinary processor branch retains configuration, time and zero output',()=>{
 const f=fixture(48000,{analysisWorker:false}),command={type:'threshold',value:.004},input=mic(),render=reference();
 f.send(command);assert(f.process(1920000,input,render)===true,'Ordinary processor stopped');
 assert(f.constructors.length===1&&f.calls.length===1,'Ordinary detector lifecycle changed');
 equal(f.controls,[command],'Ordinary configuration was not delivered');assert(f.calls[0].time===40,'Ordinary source timestamp changed');
 equal([...f.calls[0].mic],[...input],'Ordinary microphone samples changed');equal([...f.calls[0].reference],[...render],'Ordinary reference samples changed');
 return {detectorConstructions:1,detectorCalls:1,sourceTime:40};
});
const failed=results.filter(x=>x.status==='FAIL').length;
console.log(JSON.stringify({target:String(target),passed:results.length-failed,failed,scope:'Actual shipped audio capture wrapper with paired transferable PCM, exact source frames, silence routing and FIFO control handoff. No browser deadline or physical-device claims.',results},null,2));
Deno.exitCode=failed?1:0;
