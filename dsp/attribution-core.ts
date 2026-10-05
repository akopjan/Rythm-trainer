// Numerical kernels for the existing source-attribution search. The host owns
// source clocks, frozen waveform windows, lag searches, and admission tests.
// Float32 inputs are promoted before arithmetic so interpolation, products,
// and ordered sums match JavaScript Number operations. Exported searches do
// not allocate or change input buffers.
let capacity: i32 = 0;
let inputLength: i32 = 0;
let lowLength: i32 = 0;
let renderLength: i32 = 0;
let input = new Float32Array(0);
let lowInput = new Float32Array(0);
let render = new Float32Array(0);
let lowRender = new Float32Array(0);
let result = new Float64Array(0);

export function abi_version(): i32 { return 1; }
export function input_ptr(): usize { return input.dataStart; }
export function low_ptr(): usize { return lowInput.dataStart; }
export function render_ptr(): usize { return render.dataStart; }
export function low_render_ptr(): usize { return lowRender.dataStart; }
export function result_ptr(): usize { return result.dataStart; }

// Each detector session owns a fresh instance. Stub-runtime allocations are
// permanent, so an already initialized instance cannot allocate again.
export function init(size: i32): i32 {
  if (capacity != 0 || size < 128 || size > 1048576) return 0;
  capacity = size;
  input = new Float32Array(size);
  lowInput = new Float32Array(size);
  render = new Float32Array(size + 4);
  lowRender = new Float32Array(size + 4);
  result = new Float64Array(8);
  return 1;
}

// A failed bounds check changes neither the active lengths nor the result.
export function set_lengths(yLength: i32, lowCaptureLength: i32, referenceLength: i32): i32 {
  if (capacity == 0 || yLength < 0 || yLength > capacity
      || lowCaptureLength < 0 || lowCaptureLength > capacity
      || referenceLength < 0 || referenceLength > capacity + 4) return 0;
  inputLength = yLength;
  lowLength = lowCaptureLength;
  renderLength = referenceLength;
  return 1;
}

@inline
function basis(array: Float32Array, relative: f64): f64 {
  if (relative < 0 || relative >= <f64>(renderLength - 1)) return 0;
  const at = <i32>Math.floor(relative);
  const fraction = relative - <f64>at;
  // The active reference bound above proves both unchecked indices valid.
  const first = <f64>unchecked(array[at]);
  const second = <f64>unchecked(array[at + 1]);
  return first * (1 - fraction) + second * fraction;
}

@inline
function valid_window(start: f64, historyStart: f64, length: i32, lag: f64): bool {
  return capacity != 0 && length > 0 && length <= inputLength
    && renderLength >= 2 && isFinite(start) && isFinite(historyStart) && isFinite(lag);
}

// result[0..3] = low dot, low power, raw dot, raw power. Energy normalizers
// and gain/coherence thresholds remain in the JavaScript attribution host.
export function coarse(start: f64, historyStart: f64, length: i32, stride: i32, lag: f64): i32 {
  if (!valid_window(start, historyStart, length, lag) || stride <= 0 || stride > capacity
      || (length - 1) / stride + 1 > lowLength) return 0;
  let dot: f64 = 0, power: f64 = 0, rawDot: f64 = 0, rawPower: f64 = 0;
  for (let i = 0, k = 0; i < length; i += stride, k++) {
    // Preserve the original basis() arithmetic order, including cancellation
    // of large source sample positions and sub-sample acoustic delay.
    const relative = (start + <f64>i - lag) - historyStart;
    const x = basis(lowRender, relative);
    const y = <f64>unchecked(lowInput[k]);
    const raw = basis(render, relative);
    dot += x * y;
    power += x * x;
    rawDot += raw * <f64>unchecked(input[i]);
    rawPower += raw * raw;
  }
  unchecked(result[0] = dot);
  unchecked(result[1] = power);
  unchecked(result[2] = rawDot);
  unchecked(result[3] = rawPower);
  return 1;
}

// result[0..1] = raw dot, raw power. No atom subtraction or classification is
// performed here; the host uses these sums in its unchanged fine search.
export function full(start: f64, historyStart: f64, length: i32, lag: f64): i32 {
  if (!valid_window(start, historyStart, length, lag)) return 0;
  let dot: f64 = 0, power: f64 = 0;
  for (let i = 0; i < length; i++) {
    const relative = (start + <f64>i - lag) - historyStart;
    const x = basis(render, relative);
    dot += x * <f64>unchecked(input[i]);
    power += x * x;
  }
  unchecked(result[0] = dot);
  unchecked(result[1] = power);
  return 1;
}
