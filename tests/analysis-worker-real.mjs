// Execute the real transport boot in a native Deno Worker and MessageChannel.
// This tests structured cloning/FIFO/source clocks, not browser audio deadlines.
const html=await Deno.readTextFile(new URL('../index.html',import.meta.url));
const dspSource=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0][1];
const helper=await Deno.readTextFile(new URL('../js/analysis-worker.js',import.meta.url));
const boot=new Function(helper+';return analysisWorkerBoot;')();
const Detector=new Function(dspSource+';return RhythmDetector;')();
const module=await Detector.compileWasm(),rate=48000,frame=1923328,base=frame/rate,token=31;
if(!(module instanceof WebAssembly.Module))throw Error('The fixture requires a real compiled WASM module');
// A test-only FIFO fence acknowledges completion after the unchanged boot has
// processed every earlier port message. It changes no detector operation.
const fence=`
const receiveBoot=self.onmessage;
self.onmessage=event=>{
 receiveBoot(event);
 if(event.data&&event.data.type==='analysis-init'){
  const port=event.data.port,receivePort=port.onmessage;
  port.onmessage=message=>{
   if(message.data&&message.data.type==='test-fence')self.postMessage({type:'test-fence',tag:message.data.tag});
   else receivePort(message);
  };
 }
};
`;
const worker=new Worker('data:application/javascript,'+encodeURIComponent(dspSource+'\n'+boot+'\n'+fence),{type:'module'}),channel=new MessageChannel(),messages=[];
let resolveReady,rejectReady,resolveFence,rejectFence;
const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;}),done=new Promise((resolve,reject)=>{resolveFence=resolve;rejectFence=reject;});
const timeout=setTimeout(()=>{const error=Error('Native analysis Worker did not complete its handshake and FIFO fence');rejectReady(error);rejectFence(error);},10000);
worker.onmessage=event=>{const m=event.data;messages.push(m);if(m.type==='analysis-ready')resolveReady(m);if(m.type==='test-fence')resolveFence(m);if(m.type==='analysis-error'){const error=Error(m.message);rejectReady(error);rejectFence(error);}};
worker.onerror=event=>{event.preventDefault();const error=Error(event.message);rejectReady(error);rejectFence(error);};
let transferredBuffers=0,receivedNoteParity=false,clockParity=false;
try{
 worker.postMessage({type:'analysis-init',sampleRate:rate,token,wasmModule:module,port:channel.port1},[channel.port1]);
 const started=await ready;if(started.token!==token)throw Error('Worker token changed');
 const directMessages=[],direct=new Detector(rate,m=>directMessages.push(m),module),configs=[{type:'mode',value:'sustained'},{type:'threshold',value:10**(-48/20)},{type:'arm',start:base,duration:3.6},{type:'reference-sync',enabled:true,routed:true,backing:false,id:token}];
 for(const message of configs){channel.port2.postMessage({type:'configure',message});direct.configure(message);}
 const count=rate*2.1;
 for(let at=0;at<count;at+=512){
  const size=Math.min(512,count-at),mic=Float32Array.from({length:size},(_,i)=>{const age=(at+i)/rate-.9;if(age<0||age>=.75)return 0;const envelope=Math.min(1,age/.18,(.75-age)/.055);return .03*envelope*(Math.sin(2*Math.PI*220*age)+.36*Math.sin(2*Math.PI*440*age)+.19*Math.sin(2*Math.PI*660*age));}),reference=new Float32Array(size);
  for(let i=0;i<size;i+=128)direct.process(mic.subarray(i,i+128),(frame+at+i)/rate,reference.subarray(i,i+128));
  const micBuffer=mic.buffer,referenceBuffer=reference.buffer;
  channel.port2.postMessage({type:'capture',sampleRate:rate,frame:frame+at,mic,reference},[micBuffer,referenceBuffer]);
  if(micBuffer.byteLength!==0||referenceBuffer.byteLength!==0)throw Error('Native PCM buffers were copied rather than transferred');
  transferredBuffers+=2;
 }
 channel.port2.postMessage({type:'test-fence',tag:'all-paired-blocks'});await done;
 const notes=list=>list.filter(m=>m.type==='onset').map(m=>({time:m.time,id:m.id,source:m.source,isolated:m.isolated}));
 const expected=notes(directMessages),actual=notes(messages);
 receivedNoteParity=expected.length===1&&JSON.stringify(actual)===JSON.stringify(expected);
 const clocks=list=>list.filter(m=>m.type==='detection-state').map(m=>m.time);
 clockParity=JSON.stringify(clocks(messages))===JSON.stringify(clocks(directMessages));
 if(!receivedNoteParity||!clockParity)throw Error('Native Worker changed source timestamps or admission decisions');
 console.log(JSON.stringify({passed:4,failed:0,scope:'Native Deno Worker with actual compiled WebAssembly.Module, transferred MessagePort and paired PCM. Exact source clock and detector parity are verified; browser audio underruns are not measured.',evidence:{moduleCloned:true,sourceBase:base,transferredBuffers,portFIFOCompleted:true,clockParity,directNotes:expected,workerNotes:actual}},null,2));
}finally{clearTimeout(timeout);channel.port1.close();channel.port2.close();worker.terminate();}
