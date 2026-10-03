// Streaming host for the approved phase-conditioned background filter.
// The FFT, power estimate, mask, inverse FFT, and synthesis all run in WASM.
// This file only owns fixed-size streaming and overlap-add buffers.
(function (root) {
  'use strict';

  const FFT_SIZE = 2048;
  const HOP_SIZE = 256;
  const DELAY_SAMPLES = FFT_SIZE;
  const DEFAULT_FLOOR = 0.03;
  const DEFAULT_MARGIN = 3;
  const DEFAULT_OVERSUBTRACTION = 4;

  function createModule(module) {
    if (module instanceof WebAssembly.Module) return module;
    const bytes = module || root.RHYTHM_WASM_BYTES;
    if (!bytes) throw new Error('RHYTHM_WASM_BYTES or a compiled WebAssembly.Module is required');
    return new WebAssembly.Module(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  class RhythmWasmCore {
    constructor(module) {
      this.module = createModule(module);
      if (WebAssembly.Module.imports(this.module).length) throw new Error('WASM core must have no imports');
      this.exports = new WebAssembly.Instance(this.module, {}).exports;
      const e = this.exports;
      if (e.abi_version() !== 1) throw new Error('Unsupported rhythm WASM ABI');
      if (e.init(FFT_SIZE, 1) !== FFT_SIZE) throw new Error('WASM core initialization failed');
      this.n = FFT_SIZE;
      this.bins = e.bin_count();
      this.memory = e.memory.buffer;
      this.input = this.view('input', this.n);
      this.real = this.view('real', this.n);
      this.imag = this.view('imag', this.n);
      this.window = this.view('window', this.n);
      this.windowSquared = this.view('window_squared', this.n);
      this.power = this.view('power', this.bins);
      this.gains = this.view('gains', this.bins);
      this.background = this.view('background', this.bins);
      this.spread = this.view('deviation', this.bins);
      this.means = this.view('phase_means', this.bins);
      this.deviations = this.view('phase_deviations', this.bins);
      this.output = this.view('output', this.n);
      this.windowSum = e.hann_sum();
    }

    view(name, count) {
      const pointer = this.exports[name + '_ptr']();
      return new Float64Array(this.exports.memory.buffer, pointer, count);
    }

    analyze(samples) {
      this.input.set(samples);
      return this.exports.analyze() === this.bins;
    }

    applyProfile(background, spread, gain) {
      if (!background || !spread || background.length !== this.bins || spread.length !== this.bins) return false;
      for (let k = 0; k < this.bins; k++) {
        const b = Number(background[k]), s = Number(spread[k]);
        if (!Number.isFinite(b) || b < 0 || !Number.isFinite(s) || s < 0) return false;
        this.means[k] = b;
        this.deviations[k] = s;
      }
      return this.exports.interpolate_profile(0, 0) === this.bins
        && this.exports.apply_mask(DEFAULT_MARGIN, gain * DEFAULT_OVERSUBTRACTION, DEFAULT_FLOOR) === this.bins;
    }

    inverseAndWindow() {
      return this.exports.inverse() === this.n && this.exports.synthesize() === this.n;
    }
  }

  class BackgroundSpectralStream {
    constructor(rate, model, options, emit) {
      if (!Number.isFinite(rate) || rate < 8000) throw new RangeError('Sample rate must be at least 8000 Hz');
      if (!model || typeof model.process !== 'function') throw new TypeError('A background model with process() is required');
      options = options || {};
      this.rate = rate;
      this.model = model;
      this.module = options.module || null;
      this.emit = typeof emit === 'function' ? emit : function () {};
      this.mic = new RhythmWasmCore(this.module);
      this.render = new RhythmWasmCore(this.module);
      this.ringSize = 16384;
      this.ringMask = this.ringSize - 1;
      this.inputRing = new Float32Array(this.ringSize);
      this.renderRing = new Float32Array(this.ringSize);
      this.ola = new Float64Array(this.ringSize);
      this.norm = new Float64Array(this.ringSize);
      this.frameInput = new Float64Array(FFT_SIZE);
      this.frameRender = new Float64Array(FFT_SIZE);
      this.magnitudes = new Float64Array(this.mic.bins);
      this.renderMagnitudes = new Float64Array(this.mic.bins);
      this.frameContext = {
        renderMagnitudes: this.renderMagnitudes,
        referenceTrusted: false,
        phaseTrusted: false,
        backing: false,
        explicitCalibration: false,
      };
      this.lastResult = null;
      this.reset(null);
    }

    reset(baseTime) {
      this.inputRing.fill(0);
      this.renderRing.fill(0);
      this.ola.fill(0);
      this.norm.fill(0);
      this.received = 0;
      this.emitted = 0;
      this.nextCenter = 0;
      this.baseTime = Number.isFinite(baseTime) ? baseTime : null;
      this.lastResult = null;
      this.lastFilterActive = false;
      if (typeof this.model.resetStream === 'function') this.model.resetStream();
    }

    _referenceSample(context, position, at) {
      const echo = context.referenceEcho || context.echo || null;
      const coordinateOffset = echo && Number.isFinite(echo.baseTime) && Number.isFinite(this.baseTime)
        ? (this.baseTime - echo.baseTime) * this.rate : 0;
      const alignedPosition = position + coordinateOffset;
      if (typeof context.referenceSample === 'function') return context.referenceSample(alignedPosition, at);
      if (echo && typeof echo.referenceSample === 'function') return echo.referenceSample(alignedPosition, at);
      return 0;
    }

    _delay(context) {
      if (Number.isFinite(context.hardwareDelaySamples) && context.hardwareDelaySamples >= 0) return context.hardwareDelaySamples;
      const echo = context.referenceEcho || context.echo || null;
      if (echo && echo.locked && Number.isFinite(echo.delayMs)) return echo.delayMs * this.rate / 1000;
      if (echo && echo.cancelReady && Number.isFinite(echo.cancelDelayMs)) return echo.cancelDelayMs * this.rate / 1000;
      if (Number.isFinite(context.hardwareDelayMs) && context.hardwareDelayMs >= 0) return context.hardwareDelayMs * this.rate / 1000;
      return 0;
    }

    _loadFrames(center, context) {
      const start = center - FFT_SIZE / 2;
      for (let i = 0; i < FFT_SIZE; i++) {
        const position = start + i;
        this.frameInput[i] = position < 0 ? 0 : this.inputRing[position & this.ringMask];
      }
      this.mic.input.set(this.frameInput);

      const delay = this._delay(context);
      const echo = context.referenceEcho || context.echo || null;
      const referenceAt = echo && Number.isFinite(echo.total) ? echo.total - 1 : this.received - 1;
      for (let i = 0; i < FFT_SIZE; i++) {
        const position = start + i - delay;
        this.frameRender[i] = position < 0 ? 0 : this._referenceSample(context, position, referenceAt) || 0;
      }
      this.render.input.set(this.frameRender);
    }

    _addFrame(core, center) {
      if (core.exports.inverse() !== FFT_SIZE || core.exports.synthesize() !== FFT_SIZE) throw new Error('WASM synthesis failed');
      const start = center - FFT_SIZE / 2;
      for (let i = 0; i < FFT_SIZE; i++) {
        const at = start + i;
        if (at < 0) continue;
        const slot = at & this.ringMask;
        this.ola[slot] += core.output[i];
        this.norm[slot] += core.windowSquared[i];
      }
    }

    _processFrame(center, context) {
      this._loadFrames(center, context);
      if (!this.mic.analyze(this.frameInput) || !this.render.analyze(this.frameRender)) throw new Error('WASM analysis failed');
      const bins = this.mic.bins;
      for (let k = 0; k < bins; k++) {
        this.magnitudes[k] = Math.sqrt(Math.max(0, this.mic.power[k]));
        this.renderMagnitudes[k] = Math.sqrt(Math.max(0, this.render.power[k]));
      }
      const frameTime = this.baseTime + center / this.rate;
      const info = this.frameContext;
      info.referenceTrusted = context.referenceTrusted === true;
      info.phaseTrusted = context.phaseTrusted === true;
      info.backing = context.backing === true;
      info.explicitCalibration = context.explicitCalibration === true;
      info.renderPresent = context.renderPresent === true;
      const result = this.model.process(this.magnitudes, frameTime, info) || null;
      this.lastResult = result;
      const trusted = info.phaseTrusted && info.referenceTrusted;
      const ambientReady = info.backing === false && Number.isFinite(result && result.ambientFrames) && result.ambientFrames >= 2;
      this.lastFilterActive = false;
      if (result && (result.ready === true && trusted || ambientReady) && Number.isFinite(result.gain) && result.gain >= 0) {
        this.lastFilterActive = this.mic.applyProfile(result.background, result.spread, result.gain);
        if (!this.lastFilterActive) {
          this.emit({ type: 'background-filter-error', reason: 'invalid-profile', time: frameTime });
        }
      }
      this._addFrame(this.mic, center);
    }

    process(input, time, context) {
      context = context || {};
      const samples = input || new Float32Array(0);
      const length = samples.length >>> 0;
      if (length > this.ringSize / 4) throw new RangeError('Input callback exceeds the 4096 sample stream limit');
      const output = new Float32Array(length);
      if (!length) return { samples: output, delaySamples: DELAY_SAMPLES, delay: DELAY_SAMPLES, reset: false };
      let didReset = false;
      if (!Number.isFinite(time)) throw new TypeError('A finite first-sample time is required');
      if (this.baseTime === null) this.baseTime = time;
      else if (Math.abs(time - (this.baseTime + this.received / this.rate)) > 0.03) {
        this.reset(time);
        didReset = true;
      }
      for (let i = 0; i < length; i++) this.inputRing[(this.received + i) & this.ringMask] = Number.isFinite(samples[i]) ? samples[i] : 0;
      this.received += length;

      const centerLimit = Number.isFinite(context.frameCenterLimit) ? context.frameCenterLimit : Infinity;
      while (this.nextCenter + FFT_SIZE / 2 <= this.received && this.nextCenter < centerLimit) {
        this._processFrame(this.nextCenter, context);
        this.nextCenter += HOP_SIZE;
      }

      for (let i = 0; i < length; i++) {
        const emittedAt = this.emitted++;
        const sourceAt = emittedAt - DELAY_SAMPLES;
        if (sourceAt < 0) {
          output[i] = 0;
          continue;
        }
        const slot = sourceAt & this.ringMask;
        const weight = this.norm[slot];
        output[i] = weight > 1e-12 ? this.ola[slot] / weight : 0;
        this.ola[slot] = 0;
        this.norm[slot] = 0;
      }
      return { samples: output, delaySamples: DELAY_SAMPLES, delay: DELAY_SAMPLES, reset: didReset, result: this.lastResult, filterActive: this.lastFilterActive === true };
    }
  }

  BackgroundSpectralStream.FFT_SIZE = FFT_SIZE;
  BackgroundSpectralStream.HOP_SIZE = HOP_SIZE;
  BackgroundSpectralStream.DELAY_SAMPLES = DELAY_SAMPLES;
  BackgroundSpectralStream.compileModule = function (bytes) {
    return createModule(bytes);
  };
  RhythmWasmCore.compile = function (bytes) {
    return createModule(bytes);
  };

  root.RhythmWasmCore = RhythmWasmCore;
  root.BackgroundSpectralStream = BackgroundSpectralStream;
  if (typeof module === 'object' && module.exports) module.exports = { RhythmWasmCore, BackgroundSpectralStream };
})(typeof globalThis !== 'undefined' ? globalThis : self);
