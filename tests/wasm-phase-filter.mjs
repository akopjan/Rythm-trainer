// Numerical parity against Python-generated, entirely synthetic fixtures.
// Run from the project root; optional args override module and fixture paths.
const modulePath = Deno.args[0] || 'dsp/phase-filter.wasm';
const fixturePath = Deno.args[1] || 'dsp/phase-power-synthetic-fixtures.json';
const bytes = await Deno.readFile(modulePath);
const fixture = JSON.parse(await Deno.readTextFile(fixturePath));
await import('../dsp/background-stream.js');
const modelSource = await Deno.readTextFile(new URL('../dsp/adaptive-background.js', import.meta.url));
const AdaptiveModel = new Function(`${modelSource}\nreturn AdaptiveBackgroundSpectrum;`)();
const module = new WebAssembly.Module(bytes);
const dsp = new WebAssembly.Instance(module, {}).exports;
const checks = [];
const discrepancies = {};
function expect(value, name) {
  if (!value) throw new Error(name);
  checks.push(name);
}
function vector(actual, expected, tolerance, name) {
  expect(actual.length === expected.length, name + ': length');
  let error = 0;
  for (let i = 0; i < actual.length; i++) {
    if (!Number.isFinite(actual[i])) throw new Error(name + ': non-finite at ' + i);
    error = Math.max(error, Math.abs(actual[i] - expected[i]));
  }
  discrepancies[name] = error;
  expect(error <= tolerance, name + ': numerical parity');
}
const n = fixture.nfft, bins = n / 2 + 1;
expect(WebAssembly.Module.imports(module).length === 0, 'Offline module has no imports');
expect(dsp.abi_version() === 1, 'Flat ABI version');
expect(dsp.init(127, fixture.phaseRows) === 0, 'Invalid FFT dimensions rejected');
expect(dsp.init(n, 1024) === 0, 'Excess profile memory rejected');
expect(dsp.init(n, fixture.phaseRows) === n, 'Numerical core initializes');
expect(dsp.init(n, fixture.phaseRows) === 0, 'Repeated initialization cannot abandon buffers');
expect(dsp.fft_size() === n && dsp.bin_count() === bins, 'FFT dimensions exported');
const memory = dsp.memory.buffer;
const view = (name, count) => new Float64Array(memory, dsp[name + '_ptr'](), count);
const input = view('input', n), real = view('real', n), imaginary = view('imag', n);
const power = view('power', bins), gains = view('gains', bins), output = view('output', n);
const background = view('background', bins), spread = view('deviation', bins);
const window = view('window', n), windowSquared = view('window_squared', n);
view('phase_means', fixture.phaseRows * bins).set(fixture.phaseMeans.flat());
view('phase_deviations', fixture.phaseRows * bins).set(fixture.phaseSpread.flat());
vector(window, fixture.window, 1e-14, 'Hann');
vector(windowSquared, fixture.windowSquared, 1e-14, 'Hann squared');
expect(Math.abs(dsp.hann_sum() - fixture.windowSum) < 1e-10, 'PSD normalization matches Python');
const interpolation = fixture.interpolation;
expect(dsp.interpolate_profile(interpolation.row, interpolation.fraction) === bins, 'Phase profile interpolates');
vector(background, interpolation.expectedBackground, 1e-15, 'Background interpolation');
vector(spread, interpolation.expectedSpread, 1e-15, 'Deviation interpolation');

for (const sample of fixture.cases) {
  input.set(sample.input);
  dsp.forward();
  vector(real, sample.forwardExpectedReal, fixture.absoluteFftTolerance, sample.name + ': FFT real');
  vector(imaginary, sample.forwardExpectedImag, fixture.absoluteFftTolerance, sample.name + ': FFT imaginary');
  dsp.inverse();
  vector(output, sample.input, fixture.absoluteInverseTolerance, sample.name + ': round trip');
  dsp.analyze();
  vector(real, sample.analyzeExpectedReal, fixture.absoluteFftTolerance, sample.name + ': Hann FFT real');
  vector(imaginary, sample.analyzeExpectedImag, fixture.absoluteFftTolerance, sample.name + ': Hann FFT imaginary');
  vector(power, sample.expectedPower, fixture.absolutePowerTolerance, sample.name + ': PSD');
  for (const mask of sample.maskCases) {
    dsp.analyze();
    expect(dsp.apply_mask(mask.margin, mask.gain, mask.floor) === bins, sample.name + ': valid mask');
    const name = sample.name + ': mask ' + mask.margin + '/' + mask.gain + '/' + mask.floor;
    vector(gains, mask.expectedMask, fixture.absoluteMaskTolerance, name + ': gains');
    dsp.inverse();
    vector(output, mask.expectedInverse, fixture.absoluteInverseTolerance, name + ': inverse');
    expect(imaginary.every(value => Math.abs(value) < 1e-10), name + ': Hermitian real output');
    dsp.synthesize();
    vector(output, mask.expectedSynthesis, fixture.absoluteInverseTolerance, name + ': synthesis');
  }
}

// The public hosts must apply the approved parameters to the same independently
// calculated Python bins, preserving excess tonal energy instead of blanking it.
const approvedCore = new globalThis.RhythmWasmCore(module);
const approvedModel = new AdaptiveModel(48000);
approvedModel.seed({
  mean: Array.from({ length: approvedModel.rows }, () => interpolation.expectedBackground),
  spread: Array.from({ length: approvedModel.rows }, () => interpolation.expectedSpread),
});
const frozenVersion = approvedModel.version;
for (let index = 0; index < fixture.cases.length; index++) {
  const sample = fixture.cases[index];
  const approved = sample.maskCases.find(mask => mask.margin === 3 && mask.gain === 4 && mask.floor === .003);
  expect(!!approved, sample.name + ': Python fixture covers approved parameters');
  expect(approvedCore.analyze(sample.input) && approvedCore.applyProfile(
    interpolation.expectedBackground, interpolation.expectedSpread, 1), sample.name + ': host applies approved profile');
  vector(approvedCore.gains, approved.expectedMask, fixture.absoluteMaskTolerance, sample.name + ': WASM host approved mask');
  expect(approvedCore.inverseAndWindow(), sample.name + ': host synthesizes approved mask');
  vector(approvedCore.output, approved.expectedSynthesis, fixture.absoluteInverseTolerance, sample.name + ': WASM host approved synthesis');
  const result = approvedModel.processPower(Float64Array.from(sample.expectedPower), 1 + index, { referenceTrusted: false });
  vector(result.mask, approved.expectedMask, fixture.absoluteMaskTolerance, sample.name + ': adaptive host approved mask');
  if (sample.name === 'multitone-plus-seeded-noise') {
    expect(approved.expectedMask.some(value => value > .99) && approved.expectedMask.some(value => value === .003),
      'Approved mask preserves strong tonal bins while attenuating backing-dominated bins');
  }
}
expect(approvedModel.version === frozenVersion, 'Approved mask test never trains on mixed synthetic signal');

// Invalid metadata must not apply a partly updated attenuation mask.
input.set(fixture.cases.at(-1).input);
dsp.analyze();
const coefficients = Array.from(real);
expect(dsp.apply_mask(NaN, 1, .03) === 0, 'Invalid gain metadata rejected');
vector(real, coefficients, 0, 'Invalid gain does not modify coefficients');
background[41] = NaN;
expect(dsp.apply_mask(2, 1, .03) === 0, 'Invalid profile rejected atomically');
vector(real, coefficients, 0, 'Invalid profile does not modify coefficients');
dsp.interpolate_profile(interpolation.row, interpolation.fraction);

// Endpoints, exact hop alignment, and WOLA normalization are independently
// exercised on arbitrary seeded samples, with no background attenuation.
const duration = 4097, hop = fixture.hop;
let seed = 2903;
const signal = Float64Array.from({ length: duration }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed / 2147483648 - 1) * .1;
});
const accumulated = new Float64Array(duration), weight = new Float64Array(duration);
for (let center = 0; center <= duration + n / 2; center += hop) {
  const start = center - n / 2;
  for (let i = 0; i < n; i++) input[i] = signal[start + i] || 0;
  dsp.analyze();
  dsp.inverse();
  dsp.synthesize();
  for (let i = 0; i < n; i++) {
    const index = start + i;
    if (index < 0 || index >= duration) continue;
    accumulated[index] += output[i];
    weight[index] += windowSquared[i];
  }
}
expect(weight.every(value => value > .1), 'WOLA covers every endpoint');
const reconstructed = accumulated.map((value, i) => value / weight[i]);
vector(reconstructed, signal, 1e-12, 'WOLA unfiltered identity');
const length = memory.byteLength;
input.fill(0);
for (let i = 0; i < 500; i++) {
  dsp.analyze();
  dsp.interpolate_profile(i % fixture.phaseRows, .125);
  dsp.apply_mask(2, .5, .03);
  dsp.inverse();
  dsp.synthesize();
}
expect(dsp.memory.buffer === memory && dsp.memory.buffer.byteLength === length, 'Frame processing never grows or replaces memory');
console.log(JSON.stringify({ passed: checks.length, total: checks.length, moduleBytes: bytes.length, memoryBytes: length, maximumErrors: discrepancies }));
