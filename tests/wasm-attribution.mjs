// Numerical equivalence of the production WASM sums and original JS formulas.
const root=new URL('../dsp/',import.meta.url),bytes=await Deno.readFile(new URL('attribution-core.wasm',root)),host=await Deno.readTextFile(new URL('attribution-kernel.js',root));
const Core=new Function(host+';return RhythmAttributionCore;')(),core=new Core(8192,bytes),results=[];
const assert=(v,m)=>{if(!v)throw Error(m);};function test(name,fn){try{results.push({name,status:'PASS',evidence:fn()});}catch(error){results.push({name,status:'FAIL',error:error.message});}}
const basis=(a,position)=>{if(position<0||position>=a.length-1)return 0;const i=Math.floor(position),f=position-i;return a[i]*(1-f)+a[i+1]*f;};
let seed=317;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return(seed/4294967296*2-1)*.3;};
let comparisons=0;
for(const stride of [1,6,12,24])for(const start of [0,2024192,2147483000])test(`Ordered coarse/full sums match JS at stride${stride}, source index${start}`,()=>{
 const length=2051,referenceLength=6000,historyStart=start-1800,job={start,historyStart,length,y:Float32Array.from({length},random),low:Float32Array.from({length:Math.ceil(length/stride)},random),render:Float32Array.from({length:referenceLength},random),lowRender:Float32Array.from({length:referenceLength},random)};
 core.load(job);
 for(const lag of [0,.125,65.333,1799,1800,1800.125,1900.75,4300,6500]){
  let dot=0,power=0,rawDot=0,rawPower=0;
  for(let i=0,k=0;i<length;i+=stride,k++){const relative=start+i-lag-historyStart,x=basis(job.lowRender,relative),raw=basis(job.render,relative);dot+=x*job.low[k];power+=x*x;rawDot+=raw*job.y[i];rawPower+=raw*raw;}
  const actual=Array.from(core.coarse(job,lag,stride).subarray(0,4)),expected=[dot,power,rawDot,rawPower];
  for(let k=0;k<4;k++){assert(Object.is(actual[k],expected[k]),'Coarse sum rounding/order changed');comparisons++;}
  dot=0;power=0;for(let i=0;i<length;i++){const x=basis(job.render,start+i-lag-historyStart);dot+=x*job.y[i];power+=x*x;}
  const full=Array.from(core.full(job,lag).subarray(0,2));assert(Object.is(full[0],dot)&&Object.is(full[1],power),'Full-rate sum rounding/order changed');comparisons+=2;
 }
 return{lagFixtures:9,exactNumericComparisons:54};
});
test('Residual updates replace the fitted player window without altering reference snapshots',()=>{
 const length=128,job={start:0,historyStart:0,length,y:new Float32Array(length).fill(.1),low:new Float32Array(length).fill(.2),render:new Float32Array(length+4).fill(.3),lowRender:new Float32Array(length+4).fill(.4)};core.load(job);
 const before=Array.from(core.full(job,0).subarray(0,2));job.y.fill(.02);job.low.fill(.04);core.updateResidual(job);const after=Array.from(core.full(job,0).subarray(0,2));
 assert(after[0]<before[0]&&after[1]===before[1]&&core.render[0]===Math.fround(.3),'Residual upload modified the known backing source');return{before,after};
});
test('Invalid windows and strides leave previous sums unchanged',()=>{
 const e=core.exports,previous=Array.from(core.result);for(const args of [[NaN,0,128,1,0],[0,0,0,1,0],[0,0,9000,1,0],[0,0,128,0,0],[0,0,128,-1,0],[0,0,128,2147483647,0],[0,0,128,1,Infinity]])assert(e.coarse(...args)===0,'Invalid coarse input was accepted');
 assert(e.full(0,0,9000,0)===0&&e.full(Infinity,0,128,0)===0,'Invalid full-rate input was accepted');assert(e.set_lengths(9000,128,132)===0&&e.set_lengths(128,128,9000)===0,'Invalid active memory lengths were accepted');assert(JSON.stringify(Array.from(core.result))===JSON.stringify(previous),'Rejected call changed results');return{guards:true};
});
test('Searching allocates no memory and does not modify inputs',()=>{
 const buffer=core.exports.memory.buffer,pointers=['input_ptr','low_ptr','render_ptr','low_render_ptr','result_ptr'].map(k=>core.exports[k]()),inputs=[Array.from(core.y.slice(0,128)),Array.from(core.render.slice(0,132))],job={start:0,historyStart:0,length:128};
 for(let i=0;i<100;i++){core.coarse(job,i*.25,1);core.full(job,i*.25);}
 assert(core.exports.memory.buffer===buffer&&pointers.every((p,i)=>p===core.exports[['input_ptr','low_ptr','render_ptr','low_render_ptr','result_ptr'][i]]()),'Search changed memory or buffer locations');assert(JSON.stringify(inputs)===JSON.stringify([Array.from(core.y.slice(0,128)),Array.from(core.render.slice(0,132))]),'Search modified captured/reference audio');assert(core.exports.init(8192)===0,'Second init leaked fixed memory');return{memoryBytes:buffer.byteLength,pointerStability:true};
});
const summary={passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,exactNumericComparisons:comparisons,scope:'Compiled production AssemblyScript WASM, exact JS arithmetic oracle, fixed-memory/ABI guards. No physical audio or browser timing claim.',results};console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
