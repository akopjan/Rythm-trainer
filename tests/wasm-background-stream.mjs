import { readFile } from 'node:fs/promises';
await import('../dsp/background-stream.js');
const { BackgroundSpectralStream } = globalThis;
const wasmBytes = await readFile(new URL('../dsp/phase-filter.wasm', import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
const checks = [];
function expect(value, message) {
  if (!value) throw new Error(message);
  checks.push(message);
}
function model() {
  return { process() { return { ready: false, gain: 1 }; } };
}
function makeSignal(length) {
  let seed = 42017;
  return Float32Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2147483648 - 1) * 0.2;
  });
}
function run(signal, pattern) {
  const stream = new BackgroundSpectralStream(48000, model(), { module: wasmModule });
  const output = new Float32Array(signal.length);
  let at = 0, call = 0;
  while (at < signal.length) {
    const count = Math.min(pattern[call++ % pattern.length], signal.length - at);
    const block = stream.process(signal.subarray(at, at + count), at / 48000, {});
    output.set(block.samples, at);
    at += count;
  }
  return { output, stream };
}

expect(WebAssembly.Module.imports(wasmModule).length === 0, 'WASM module has no imports');
const signal = makeSignal(12037);
const a = run(signal, [128]);
const b = run(signal, [512]);
const c = run(signal, [128, 512, 256, 384, 64]);
expect(a.stream.mic.exports.fft_size() === 2048 && a.stream.render.exports.fft_size() === 2048, 'Two 2048 point WASM cores initialize');
expect(a.stream.mic.exports.memory.buffer.byteLength === 6 * 1024 * 1024, 'Core uses fixed 6 MiB memory');
expect(a.stream.mic.exports.memory.buffer === a.stream.mic.memory, 'Frame processing keeps stable WASM memory');
expect(a.stream.constructor.DELAY_SAMPLES === 2048, 'Stream reports exact 2048 sample causal delay');
let maxChunkError = 0, maxIdentityError = 0;
for (let i = 0; i < signal.length; i++) {
  maxChunkError = Math.max(maxChunkError, Math.abs(a.output[i] - b.output[i]), Math.abs(a.output[i] - c.output[i]));
  if (i >= 2048) maxIdentityError = Math.max(maxIdentityError, Math.abs(a.output[i] - signal[i - 2048]));
  else expect(a.output[i] === 0, 'Startup is zero-filled');
}
expect(maxChunkError < 2e-7, 'Output is invariant to 128, 512, and mixed callback sizes');
expect(maxIdentityError < 2e-6, 'Causal Hann WOLA reconstructs identity including endpoints');

const resetStream = new BackgroundSpectralStream(48000, model(), { module: wasmModule });
resetStream.process(signal.subarray(0, 512), 1, {});
const afterGap = resetStream.process(signal.subarray(512, 1024), 2, {});
expect(afterGap.reset && afterGap.delaySamples === 2048, 'Clock gap resets stream and preserves declared delay');
expect(afterGap.samples.every(value => value === 0), 'Clock gap restarts with zero-filled latency');

let rejected = false;
try { new BackgroundSpectralStream(7000, model(), { module: wasmModule }); } catch { rejected = true; }
expect(rejected, 'Invalid sample rate is rejected');
// Room-noise learning has no drum phase table. It must still be applied when
// the host has explicitly confirmed that no backing is audible.
const ambientModel={process(magnitudes){return {ready:false,ambientFrames:2,gain:1,
 background:Float64Array.from(magnitudes,x=>x*x),spread:new Float64Array(magnitudes.length)};}};
const ambientStream=new BackgroundSpectralStream(48000,ambientModel,{module:wasmModule});
let ambientError=0;
for(let at=0;at<signal.length;at+=128){
 const block=ambientStream.process(signal.subarray(at,at+128),at/48000,{backing:false});
 for(let i=0;i<block.samples.length;i++)if(at+i>=2048)
  ambientError=Math.max(ambientError,Math.abs(block.samples[i]-.003*signal[at+i-2048]));
}
expect(ambientError<1e-7,'Vetted ambient profile works without a phase-table ready flag');
console.log(JSON.stringify({ passed: checks.length, total: checks.length, maxChunkError, maxIdentityError }));
