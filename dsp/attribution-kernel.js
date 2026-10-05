// Numeric-only source projection. The host retains every admission guard,
// source timestamp, lag search and joint room-path fit.
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
 }
 load(job){
  if(job.y.length>this.capacity||job.low.length>this.capacity||job.render.length>this.capacity+4||job.lowRender.length!==job.render.length)throw Error('Source attribution snapshot exceeds WASM capacity');
  this.y.set(job.y);this.low.set(job.low);this.render.set(job.render);this.lowRender.set(job.lowRender);
  if(this.exports.set_lengths(job.y.length,job.low.length,job.render.length)!==1)throw Error('Source attribution WASM lengths are invalid');
 }
 updateResidual(job){this.y.set(job.y);this.low.set(job.low);}
 coarse(job,lag,stride){if(this.exports.coarse(job.start,job.historyStart,job.length,stride,lag)!==1)throw Error('Invalid coarse source projection');return this.result;}
 full(job,lag){if(this.exports.full(job.start,job.historyStart,job.length,lag)!==1)throw Error('Invalid full-rate source projection');return this.result;}
}
