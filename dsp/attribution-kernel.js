// Private QA copy of the project adapter with optional native-power support.
class RhythmAttributionCore {
 constructor(capacity,module=null){
  const bytes=module||globalThis.RHYTHM_ATTRIBUTION_WASM_BYTES;
  if(!bytes)throw Error('Source attribution WASM is missing');
  const compiled=bytes instanceof WebAssembly.Module?bytes:new WebAssembly.Module(bytes instanceof Uint8Array?bytes:Uint8Array.from(bytes));
  if(WebAssembly.Module.imports(compiled).length)throw Error('Source attribution WASM must have no imports');
  this.exports=new WebAssembly.Instance(compiled,{}).exports;
  const e=this.exports;if(e.abi_version()!==1||e.init(capacity)!==1)throw Error('Source attribution WASM initialization failed');
  this.capacity=capacity;const memory=e.memory.buffer;
  this.y=new Float32Array(memory,e.input_ptr(),capacity);this.low=new Float32Array(memory,e.low_ptr(),capacity);
  this.render=new Float32Array(memory,e.render_ptr(),capacity+4);this.lowRender=new Float32Array(memory,e.low_render_ptr(),capacity+4);
  this.result=new Float64Array(memory,e.result_ptr(),8);
  this.nativeWindow=typeof e.native_window_ptr==='function'?new Float64Array(memory,e.native_window_ptr(),capacity):null;
  this.nativeReady=!!this.nativeWindow&&typeof e.native_power==='function';
  this.nativeStatesReady=!!this.nativeWindow&&typeof e.native_goertzel_states==='function'
   &&typeof e.native_state_a==='function'&&typeof e.native_state_b==='function';
  this.nativeFrame=null;
  this.sourcePowers=null;
 }
 load(job){
  if(job.y.length>this.capacity||job.low.length>this.capacity||job.render.length>this.capacity+4||job.lowRender.length!==job.render.length)throw Error('Source attribution snapshot exceeds WASM capacity');
  this.y.set(job.y);this.low.set(job.low);this.render.set(job.render);this.lowRender.set(job.lowRender);
  if(this.exports.set_lengths(job.y.length,job.low.length,job.render.length)!==1)throw Error('Source attribution WASM lengths are invalid');
  // prepare() snapshots both reference arrays; updateResidual() changes only
  // the microphone arrays. Opt-in callers may reuse immutable source powers.
  this.sourcePowers=job.immutableReference===true?{full:new Map(),coarse:new Map()}:null;
 }
 updateResidual(job){this.y.set(job.y);this.low.set(job.low);}
 coarse(job,lag,stride){
  const cache=this.sourcePowers?.coarse,key=lag+':'+stride,known=cache?.get(key);
  if(known&&typeof this.exports.coarse_dot==='function'){
   if(this.exports.coarse_dot(job.start,job.historyStart,job.length,stride,lag)!==1)throw Error('Invalid coarse source projection');
   this.result[1]=known[0];this.result[3]=known[1];
  }else{
   if(this.exports.coarse(job.start,job.historyStart,job.length,stride,lag)!==1)throw Error('Invalid coarse source projection');
   cache?.set(key,[this.result[1],this.result[3]]);
  }
  return this.result;
 }
 full(job,lag){
  const cache=this.sourcePowers?.full;
  if(cache?.has(lag)&&typeof this.exports.full_dot==='function'){
   if(this.exports.full_dot(job.start,job.historyStart,job.length,lag)!==1)throw Error('Invalid full-rate source projection');
   this.result[1]=cache.get(lag);
  }else{
   if(this.exports.full(job.start,job.historyStart,job.length,lag)!==1)throw Error('Invalid full-rate source projection');
   cache?.set(lag,this.result[1]);
  }
  return this.result;
 }
 nativePower(frame,coefficient){
  if(!this.nativeReady)return null;
  const values=frame?.values;
  if(!values||values.length<=0||values.length>this.capacity)return NaN;
  if(this.nativeFrame!==frame){this.nativeWindow.set(values);this.nativeFrame=frame;}
  return this.exports.native_power(values.length,coefficient,frame.norm);
 }
 nativeStates(frame,coefficient){
  if(!this.nativeStatesReady)return null;
  const values=frame?.values;
  if(!values||values.length<=0||values.length>this.capacity)return {a:NaN,b:NaN};
  // Shares the existing immutable-frame upload cache with nativePower.
  if(this.nativeFrame!==frame){this.nativeWindow.set(values);this.nativeFrame=frame;}
  if(this.exports.native_goertzel_states(values.length,coefficient)!==1)return {a:NaN,b:NaN};
  return {a:this.exports.native_state_a(),b:this.exports.native_state_b()};
 }
}
if(typeof module!=='undefined')module.exports=RhythmAttributionCore;
