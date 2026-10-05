// The audio thread forwards paired samples; expensive analysis runs in a Worker.
// Capture/configuration messages from a producer must use the same FIFO port.
const analysisWorkerBoot = `
(() => {
 let detector=null,inputPort=null,rate=0,token=null,closed=false;
 const fail=error=>self.postMessage({type:'analysis-error',token,message:String(error&&error.message||error).slice(0,240)});
 const receive=event=>{
  if(closed)return;
  try{
   const message=event.data;
   if(!message||typeof message!=='object')throw new Error('Invalid analysis message');
   if(message.type==='analysis-init'){
    if(detector)throw new Error('Analysis is already initialized');
    rate=message.sampleRate;token=message.token;
    if(!Number.isFinite(rate)||rate<8000)throw new Error('Invalid analysis sample rate');
    detector=new RhythmDetector(rate,value=>self.postMessage(value),message.wasmModule||null);
    inputPort=message.port;
    if(!inputPort||typeof inputPort.postMessage!=='function')throw new Error('Analysis input port is missing');
    inputPort.onmessage=receive;inputPort.onmessageerror=()=>fail(new Error('Analysis input could not be decoded'));inputPort.start();
    self.postMessage({type:'analysis-ready',token});return;
   }
   if(!detector)throw new Error('Analysis is not initialized');
   if(message.type==='analysis-close'){closed=true;inputPort.close();self.close();return;}
   if(message.type==='configure'){detector.configure(message.message);return;}
   if(message.type!=='capture')throw new Error('Unknown analysis message');
   const mic=message.mic,reference=message.reference;
   if(!(mic instanceof Float32Array)||!Number.isFinite(message.frame)||message.frame<0)throw new Error('Invalid captured audio block');
   if(message.sampleRate!==undefined&&message.sampleRate!==rate)throw new Error('Captured audio sample rate changed');
   if(reference!==null&&reference!==undefined&&(!(reference instanceof Float32Array)||reference.length!==mic.length))throw new Error('Unpaired rendered audio block');
   let rendered=reference;
   if(!rendered&&detector.referenceEnabled&&detector.reference.options.routed)rendered=new Float32Array(mic.length);
   for(let i=0;i<mic.length;i+=128)detector.process(mic.subarray(i,i+128),(message.frame+i)/rate,rendered&&rendered.subarray(i,i+128));
  }catch(error){closed=true;fail(error);if(inputPort)inputPort.close();}
 };
 self.onmessage=receive;
})();
`;

async function createAnalysisWorker(ctx,token,wasmModule,handleDSP,dspSource,onFailure){
 if(!ctx||!Number.isFinite(ctx.sampleRate)||ctx.sampleRate<8000)throw new Error('Invalid audio context');
 if(ctx.state==='closed')throw new Error('Audio context is closed');
 if(typeof Worker!=='function'||typeof MessageChannel!=='function')throw new Error('Background audio analysis is unavailable');
 let worker=null,channel=null,url=null,timer=null,closed=false,settled=false,resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const removeListener=()=>{if(typeof ctx.removeEventListener==='function')ctx.removeEventListener('statechange',contextChanged);};
 const release=()=>{
  if(timer!==null){clearTimeout(timer);timer=null;}
  removeListener();
  if(url!==null){URL.revokeObjectURL(url);url=null;}
 };
 const close=()=>{
  if(closed)return;closed=true;release();
  if(channel){channel.port1.close();channel.port2.close();}
  if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
 };
 const fail=(error,notify=true)=>{
  if(closed)return;
  const value=error instanceof Error?error:new Error(String(error));
  close();if(!settled){settled=true;rejectReady(value);}
  if(notify&&typeof onFailure==='function'){try{onFailure(value);}catch{/* Transport is already closed. */}}
 };
 function contextChanged(){if(ctx.state==='closed')fail(new Error('Audio context closed during analysis initialization'),false);}
 try{
  channel=new MessageChannel();url=URL.createObjectURL(new Blob([String(dspSource), '\n',analysisWorkerBoot],{type:'application/javascript'}));
  worker=new Worker(url);
  worker.onmessage=event=>{
   if(closed)return;const message=event.data;
   if(message&&message.type==='analysis-ready'){
    if(message.token!==token)return;
    if(ctx.state==='closed'){contextChanged();return;}
    release();settled=true;resolveReady();return;
   }
   if(message&&message.type==='analysis-error'){fail(new Error(message.message||'Background audio analysis failed'));return;}
   try{if(typeof handleDSP==='function')handleDSP(message);}catch(error){fail(error);}
  };
  worker.onerror=event=>{if(typeof event.preventDefault==='function')event.preventDefault();fail(new Error(event.message||'Background audio analysis could not start'));};
  worker.onmessageerror=()=>fail(new Error('Background analysis response could not be decoded'));
  if(typeof ctx.addEventListener==='function')ctx.addEventListener('statechange',contextChanged);
  timer=setTimeout(()=>fail(new Error('Background audio analysis initialization timed out')),5000);
  worker.postMessage({type:'analysis-init',sampleRate:ctx.sampleRate,token,wasmModule,port:channel.port1},[channel.port1]);
 }catch(error){fail(error);}
 await ready;
 return {worker,port:channel.port2,
  postMessage(message,transfer){
   if(closed)return false;
   const envelope=message&&message.type==='capture'||message&&message.type==='configure'?message:{type:'configure',message};
   const buffers=transfer|| (envelope.type==='capture'?[envelope.mic?.buffer,envelope.reference?.buffer].filter((value,index,list)=>value instanceof ArrayBuffer&&list.indexOf(value)===index):[]);
   try{worker.postMessage(envelope,buffers);return true;}catch(error){fail(error);return false;}
  },close};
}
