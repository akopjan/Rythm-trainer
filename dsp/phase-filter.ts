// Numerical reference: float64 FFT, Hann STFT, phase PSD subtraction, inverse FFT.
// Buffers are allocated once by init(). No exported frame operation allocates.
// The host owns guarded background learning and overlap-add timing.
let n: i32 = 0;
let bins: i32 = 0;
let rows: i32 = 0;
let hannSum: f64 = 0;
let input = new Float64Array(0);
let real = new Float64Array(0);
let imag = new Float64Array(0);
let window = new Float64Array(0);
let windowSquared = new Float64Array(0);
let power = new Float64Array(0);
let gains = new Float64Array(0);
let background = new Float64Array(0);
let deviation = new Float64Array(0);
let means = new Float64Array(0);
let deviations = new Float64Array(0);
let output = new Float64Array(0);
let reverse = new Int32Array(0);
let cosine = new Float64Array(0);
let sine = new Float64Array(0);

export function abi_version(): i32 { return 1; }
export function fft_size(): i32 { return n; }
export function bin_count(): i32 { return bins; }
export function phase_rows(): i32 { return rows; }
export function hann_sum(): f64 { return hannSum; }
export function input_ptr(): usize { return input.dataStart; }
export function real_ptr(): usize { return real.dataStart; }
export function imag_ptr(): usize { return imag.dataStart; }
export function window_ptr(): usize { return window.dataStart; }
export function window_squared_ptr(): usize { return windowSquared.dataStart; }
export function power_ptr(): usize { return power.dataStart; }
export function gains_ptr(): usize { return gains.dataStart; }
export function background_ptr(): usize { return background.dataStart; }
export function deviation_ptr(): usize { return deviation.dataStart; }
export function phase_means_ptr(): usize { return means.dataStart; }
export function phase_deviations_ptr(): usize { return deviations.dataStart; }
export function output_ptr(): usize { return output.dataStart; }

// A fresh AudioWorklet session instantiates a fresh module. Reinitializing a
// stub-runtime instance would abandon its buffers, so it is rejected.
export function init(size: i32, phaseRows: i32): i32 {
  if (n != 0 || size < 128 || size > 4096 || (size & (size - 1)) != 0
      || phaseRows < 1 || phaseRows > 1024
      || phaseRows * (size / 2 + 1) > 262144) return 0;
  n = size;
  bins = n / 2 + 1;
  rows = phaseRows;
  input = new Float64Array(n);
  real = new Float64Array(n);
  imag = new Float64Array(n);
  window = new Float64Array(n);
  windowSquared = new Float64Array(n);
  power = new Float64Array(bins);
  gains = new Float64Array(bins);
  background = new Float64Array(bins);
  deviation = new Float64Array(bins);
  means = new Float64Array(rows * bins);
  deviations = new Float64Array(rows * bins);
  output = new Float64Array(n);
  reverse = new Int32Array(n);
  cosine = new Float64Array(n / 2);
  sine = new Float64Array(n / 2);
  let bits = 0;
  for (let sizeBits = n; sizeBits > 1; sizeBits >>= 1) bits++;
  hannSum = 0;
  for (let i = 0; i < n; i++) {
    const value = .5 - .5 * Math.cos(2 * Math.PI * <f64>i / <f64>(n - 1));
    window[i] = value;
    windowSquared[i] = value * value;
    hannSum += value;
    let index = i, reversed = 0;
    for (let bit = 0; bit < bits; bit++) { reversed = (reversed << 1) | (index & 1); index >>= 1; }
    reverse[i] = reversed;
  }
  for (let i = 0; i < n / 2; i++) {
    const angle = -2 * Math.PI * <f64>i / <f64>n;
    cosine[i] = Math.cos(angle);
    sine[i] = Math.sin(angle);
  }
  return n;
}

// In-place radix-two complex transform. Forward is unscaled with negative
// exponential; inverse has positive exponential and divides by N.
export function transform(inverse: i32): i32 {
  if (n == 0) return 0;
  for (let i = 0; i < n; i++) {
    const j = reverse[i];
    if (j > i) {
      const re = real[i], im = imag[i];
      real[i] = real[j]; imag[i] = imag[j]; real[j] = re; imag[j] = im;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size / 2, stride = n / size;
    for (let base = 0; base < n; base += size) {
      for (let j = 0; j < half; j++) {
        const first = base + j, second = first + half, index = j * stride;
        const cos = cosine[index], sin = inverse != 0 ? -sine[index] : sine[index];
        const re = real[second] * cos - imag[second] * sin;
        const im = real[second] * sin + imag[second] * cos;
        const firstRe = real[first], firstIm = imag[first];
        real[second] = firstRe - re; imag[second] = firstIm - im;
        real[first] = firstRe + re; imag[first] = firstIm + im;
      }
    }
  }
  if (inverse != 0) for (let i = 0; i < n; i++) { real[i] /= <f64>n; imag[i] /= <f64>n; }
  return n;
}

export function forward(): i32 {
  if (n == 0) return 0;
  for (let i = 0; i < n; i++) { real[i] = input[i]; imag[i] = 0; }
  return transform(0);
}

export function analyze(): i32 {
  if (n == 0) return 0;
  for (let i = 0; i < n; i++) { real[i] = input[i] * window[i]; imag[i] = 0; }
  transform(0);
  const denominator = hannSum * hannSum;
  for (let k = 0; k < bins; k++) power[k] = (real[k] * real[k] + imag[k] * imag[k]) / denominator;
  return bins;
}

// Cyclic linear interpolation of independently vetted mean/deviation tables.
export function interpolate_profile(row: i32, fraction: f64): i32 {
  if (n == 0 || row < 0 || row >= rows || !isFinite(fraction) || fraction < 0 || fraction > 1) return 0;
  const first = row * bins, second = ((row + 1) % rows) * bins;
  for (let k = 0; k < bins; k++) {
    const mean = means[first + k], sd = deviations[first + k];
    background[k] = mean + (means[second + k] - mean) * fraction;
    deviation[k] = sd + (deviations[second + k] - sd) * fraction;
  }
  return bins;
}

// A failed argument/profile check leaves all complex coefficients unchanged.
export function apply_mask(margin: f64, frozenGain: f64, minimumGain: f64): i32 {
  if (n == 0 || !isFinite(margin) || margin < 0 || !isFinite(frozenGain) || frozenGain < 0
      || !isFinite(minimumGain) || minimumGain < 0 || minimumGain > 1) return 0;
  for (let k = 0; k < bins; k++) {
    if (!isFinite(power[k]) || power[k] < 0 || !isFinite(background[k]) || background[k] < 0
        || !isFinite(deviation[k]) || deviation[k] < 0) return 0;
  }
  for (let k = 0; k < bins; k++) {
    const value = power[k];
    gains[k] = value <= 1e-30 ? minimumGain : Math.max(minimumGain,
      Math.sqrt(Math.max(0, value - (background[k] + margin * deviation[k]) * frozenGain) / value));
  }
  for (let k = 0; k < bins; k++) {
    const gain = gains[k];
    real[k] *= gain; imag[k] *= gain;
    if (k > 0 && k < n / 2) { real[n - k] *= gain; imag[n - k] *= gain; }
  }
  return bins;
}

export function inverse(): i32 {
  if (n == 0) return 0;
  transform(1);
  for (let i = 0; i < n; i++) output[i] = real[i];
  return n;
}

// Host accumulates this numerator and window_squared into its WOLA rings.
export function synthesize(): i32 {
  if (n == 0) return 0;
  for (let i = 0; i < n; i++) output[i] = real[i] * window[i];
  return n;
}
