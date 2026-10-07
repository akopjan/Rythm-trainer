// Private QA copy of the attribution kernel with an exact native Goertzel
// power helper. The host still owns candidate selection and all decisions.
let capacity: i32 = 0;
let inputLength: i32 = 0;
let lowLength: i32 = 0;
let renderLength: i32 = 0;
let input = new Float32Array(0);
let lowInput = new Float32Array(0);
let render = new Float32Array(0);
let lowRender = new Float32Array(0);
let result = new Float64Array(0);
let nativeWindow = new Float64Array(0);
let nativeStateA: f64 = NaN;
let nativeStateB: f64 = NaN;

export function abi_version(): i32 { return 1; }
export function input_ptr(): usize { return input.dataStart; }
export function low_ptr(): usize { return lowInput.dataStart; }
export function render_ptr(): usize { return render.dataStart; }
export function low_render_ptr(): usize { return lowRender.dataStart; }
export function result_ptr(): usize { return result.dataStart; }
export function native_window_ptr(): usize { return nativeWindow.dataStart; }

export function init(size: i32): i32 {
  if (capacity != 0 || size < 128 || size > 1048576) return 0;
  capacity = size;
  input = new Float32Array(size);
  lowInput = new Float32Array(size);
  render = new Float32Array(size + 4);
  lowRender = new Float32Array(size + 4);
  result = new Float64Array(8);
  nativeWindow = new Float64Array(size);
  return 1;
}

export function set_lengths(yLength: i32, lowCaptureLength: i32, referenceLength: i32): i32 {
  if (capacity == 0 || yLength < 0 || yLength > capacity
      || lowCaptureLength < 0 || lowCaptureLength > capacity
      || referenceLength < 0 || referenceLength > capacity + 4) return 0;
  inputLength = yLength;
  lowLength = lowCaptureLength;
  renderLength = referenceLength;
  return 1;
}

// Numerical-only Goertzel recurrence over a caller-uploaded f64 window.
// Invalid bounds return NaN without reading outside nativeWindow.
export function native_power(length: i32, coefficient: f64, norm: f64): f64 {
  if (capacity == 0 || length <= 0 || length > capacity || !isFinite(coefficient)
      || !isFinite(norm) || norm <= 0) return NaN;
  let a: f64 = 0, b: f64 = 0;
  for (let i = 0; i < length; i++) {
    const n = unchecked(nativeWindow[i]) + coefficient * a - b;
    b = a;
    a = n;
  }
  const power = a * a + b * b - coefficient * a * b;
  return (power > 0 ? power : 0) / (norm * norm);
}

// Optional ABI extension: expose the two recurrence endpoints, keeping phase
// trigonometry in the host. Arithmetic order matches native_power and JS.
// Clear both endpoints on invalid input, so callers cannot reuse stale states.
export function native_goertzel_states(length: i32, coefficient: f64): i32 {
  nativeStateA = NaN;
  nativeStateB = NaN;
  if (capacity == 0 || length <= 0 || length > capacity || !isFinite(coefficient)) return 0;
  let a: f64 = 0, b: f64 = 0;
  for (let i = 0; i < length; i++) {
    const n = unchecked(nativeWindow[i]) + coefficient * a - b;
    b = a;
    a = n;
  }
  nativeStateA = a;
  nativeStateB = b;
  return 1;
}

export function native_state_a(): f64 { return nativeStateA; }
export function native_state_b(): f64 { return nativeStateB; }

@inline
function basis(array: Float32Array, relative: f64): f64 {
  if (relative < 0 || relative >= <f64>(renderLength - 1)) return 0;
  const at = <i32>Math.floor(relative);
  const fraction = relative - <f64>at;
  const first = <f64>unchecked(array[at]);
  const second = <f64>unchecked(array[at + 1]);
  return first * (1 - fraction) + second * fraction;
}

@inline
function valid_window(start: f64, historyStart: f64, length: i32, lag: f64): bool {
  return capacity != 0 && length > 0 && length <= inputLength
    && renderLength >= 2 && isFinite(start) && isFinite(historyStart) && isFinite(lag);
}

// Integer PCM positions are the common source-fit case. Within these bounds,
// all additions/subtractions are exactly representable and interpolation has
// an exactly zero fractional part. Keep the original sum order and even the
// zero interpolation term (including NaN/Infinity semantics).
@inline
function integer_window(start: f64, historyStart: f64, length: i32, lag: f64): i32 {
  const limit: f64 = 281474976710656;
  if (start < 0 || historyStart < 0 || lag < 0 || start > limit
      || historyStart > limit || lag > limit || Math.floor(start) != start
      || Math.floor(historyStart) != historyStart || Math.floor(lag) != lag) return -1;
  const relative = (start - lag) - historyStart;
  if (relative < 0 || relative + <f64>(length - 1) >= <f64>(renderLength - 1)) return -1;
  return <i32>relative;
}

export function coarse(start: f64, historyStart: f64, length: i32, stride: i32, lag: f64): i32 {
  if (!valid_window(start, historyStart, length, lag) || stride <= 0 || stride > capacity
      || (length - 1) / stride + 1 > lowLength) return 0;
  let dot: f64 = 0, power: f64 = 0, rawDot: f64 = 0, rawPower: f64 = 0;
  const offset = integer_window(start, historyStart, length, lag);
  if (offset >= 0) for (let i = 0, k = 0; i < length; i += stride, k++) {
    const at = offset + i;
    const x = <f64>unchecked(lowRender[at]) + <f64>unchecked(lowRender[at + 1]) * 0;
    const raw = <f64>unchecked(render[at]) + <f64>unchecked(render[at + 1]) * 0;
    dot += x * <f64>unchecked(lowInput[k]);
    power += x * x;
    rawDot += raw * <f64>unchecked(input[i]);
    rawPower += raw * raw;
  } else for (let i = 0, k = 0; i < length; i += stride, k++) {
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

export function full(start: f64, historyStart: f64, length: i32, lag: f64): i32 {
  if (!valid_window(start, historyStart, length, lag)) return 0;
  let dot: f64 = 0, power: f64 = 0;
  const offset = integer_window(start, historyStart, length, lag);
  if (offset >= 0) for (let i = 0; i < length; i++) {
    const at = offset + i;
    const x = <f64>unchecked(render[at]) + <f64>unchecked(render[at + 1]) * 0;
    dot += x * <f64>unchecked(input[i]);
    power += x * x;
  } else for (let i = 0; i < length; i++) {
    const relative = (start + <f64>i - lag) - historyStart;
    const x = basis(render, relative);
    dot += x * <f64>unchecked(input[i]);
    power += x * x;
  }
  unchecked(result[0] = dot);
  unchecked(result[1] = power);
  return 1;
}

// The frozen reference has the same power across residual-fit iterations.
// The host may reuse that power; these functions only recompute its dot
// product with the updated microphone residual, in the exact original order.
export function full_dot(start: f64, historyStart: f64, length: i32, lag: f64): i32 {
  if (!valid_window(start, historyStart, length, lag)) return 0;
  let dot: f64 = 0;
  const offset = integer_window(start, historyStart, length, lag);
  if (offset >= 0) for (let i = 0; i < length; i++) {
    const at = offset + i;
    const x = <f64>unchecked(render[at]) + <f64>unchecked(render[at + 1]) * 0;
    dot += x * <f64>unchecked(input[i]);
  } else for (let i = 0; i < length; i++) {
    const x = basis(render, (start + <f64>i - lag) - historyStart);
    dot += x * <f64>unchecked(input[i]);
  }
  unchecked(result[0] = dot);
  return 1;
}

export function coarse_dot(start: f64, historyStart: f64, length: i32, stride: i32, lag: f64): i32 {
  if (!valid_window(start, historyStart, length, lag) || stride <= 0 || stride > capacity
      || (length - 1) / stride + 1 > lowLength) return 0;
  let dot: f64 = 0, rawDot: f64 = 0;
  const offset = integer_window(start, historyStart, length, lag);
  if (offset >= 0) for (let i = 0, k = 0; i < length; i += stride, k++) {
    const at = offset + i;
    const x = <f64>unchecked(lowRender[at]) + <f64>unchecked(lowRender[at + 1]) * 0;
    const raw = <f64>unchecked(render[at]) + <f64>unchecked(render[at + 1]) * 0;
    dot += x * <f64>unchecked(lowInput[k]);
    rawDot += raw * <f64>unchecked(input[i]);
  } else for (let i = 0, k = 0; i < length; i += stride, k++) {
    const relative = (start + <f64>i - lag) - historyStart;
    dot += basis(lowRender, relative) * <f64>unchecked(lowInput[k]);
    rawDot += basis(render, relative) * <f64>unchecked(input[i]);
  }
  unchecked(result[0] = dot);
  unchecked(result[2] = rawDot);
  return 1;
}
