// Independent regressions for the adaptive median normalizer.
// Evaluates only pure helpers from the saved HTML; no browser/audio hardware.
const target = Deno.args[0] ?? 'index.html';
const html = await Deno.readTextFile(target);
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const results = [];
const record = (name, ok, evidence = {}) => results.push({name, status: ok ? 'PASS' : 'FAIL', evidence});
const close = (a, b, epsilon = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= epsilon;
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const phase = (value, period) => value - Math.round(value / period) * period;
const meanAbs = values => values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;

function extractDeclaration(source, name, kind = 'function') {
  const start = source?.search(new RegExp(kind + '\\s+' + name + (kind === 'class' ? '\\s*\\{' : '\\s*\\('))) ?? -1;
  if (start < 0) throw new Error(`Missing ${kind} ${name} in the second HTML script`);
  const body = source.indexOf('{', start);
  let depth = 0, quote = '', comment = '';
  for (let i = body; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (comment === 'line') {if (char === '\n') comment = ''; continue;}
    if (comment === 'block') {if (char === '*' && next === '/') {comment = ''; i++;} continue;}
    if (quote) {if (char === '\\') i++; else if (char === quote) quote = ''; continue;}
    if (char === '/' && next === '/') {comment = 'line'; i++; continue;}
    if (char === '/' && next === '*') {comment = 'block'; i++; continue;}
    if (char === '"' || char === "'" || char === '`') {quote = char; continue;}
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed ${kind} ${name}`);
}

let AdaptiveNormalizer;
try {
  const declarations = extractDeclaration(scripts[1], 'fitLatencyMedian') + '\n' + extractDeclaration(scripts[1], 'AdaptiveNormalizer', 'class');
  AdaptiveNormalizer = new Function('clamp', declarations + '; return AdaptiveNormalizer;')(clamp);
  record('Adaptive normalizer is available as a pure class', typeof AdaptiveNormalizer === 'function');
} catch (error) {
  record('Adaptive normalizer is available as a pure class', false, {error: error.message});
}

function check(name, run) {
  try {
    const evidence = run();
    record(name, evidence.ok, evidence);
  } catch (error) {record(name, false, {error: error.message});}
}

function simulation({step = 250, bar = 2000, count = 240, prior = 0, allowBootstrap = true, delay = () => 80, jitter = () => 0, startIndex = 0} = {}) {
  const tracker = new AdaptiveNormalizer(allowBootstrap), history = [];
  let correction = prior;
  for (let i = 0; i < count; i++) {
    const scheduled = (i + startIndex) * step, physicalDelay = delay(i, scheduled), rawMs = scheduled + physicalDelay + jitter(i);
    const offsetAtHit = correction, error = phase(rawMs - offsetAtHit, step);
    const update = tracker.observe(rawMs, step, bar, correction);
    if (Number.isFinite(update.delayMs)) correction = update.delayMs;
    history.push({i, rawMs, physicalDelay, offsetAtHit, error, update, correction});
  }
  return {tracker, history, correction};
}

if (AdaptiveNormalizer) {
  check('Too few attacks preserve the prior and do not bootstrap', () => {
    const run = simulation({count: 8, prior: 20});
    return {ok: close(run.correction, 20) && !run.tracker.ready && run.history.every(row => row.update.status === 'warming' && !Number.isFinite(row.update.delayMs)), status: run.history.at(-1).update.status, correction: run.correction};
  });

  check('Nine coherent attacks spanning a full bar initialize the common median', () => {
    const run = simulation({count: 9});
    return {ok: run.tracker.ready && close(run.correction, 80) && run.history.at(-1).update.status === 'bootstrap', correction: run.correction, update: run.history.at(-1).update};
  });

  check('Many rapid attacks within one short bar cannot bootstrap prematurely', () => {
    const tracker = new AdaptiveNormalizer();
    let last;
    for (let i = 0; i < 20; i++) last = tracker.observe(i * 50 + 30, 50, 2000, 0);
    return {ok: !tracker.ready && last.status === 'warming' && !Number.isFinite(last.delayMs), last};
  });

  check('Initial jitter uses the median rather than following every attack', () => {
    const jitter = [-12, 8, -4, 4, 0, 12, -8, 4, -4];
    const run = simulation({count: 9, jitter: i => jitter[i]});
    return {ok: close(run.correction, 80) && run.history.at(-1).update.maeMs > 0, correction: run.correction, maeMs: run.history.at(-1).update.maeMs};
  });

  check('A constant delay stays stable after initialization', () => {
    const run = simulation();
    return {ok: close(run.correction, 80) && run.history.slice(9).every(row => close(row.correction, 80)), finalCorrection: run.correction};
  });

  check('Slow positive latency drift reduces residual error compared with a fixed correction', () => {
    const run = simulation({count: 280, delay: (_, time) => 80 + Math.max(0, time - 10000) * .0015});
    const tail = run.history.slice(-40), adapted = meanAbs(tail.map(row => row.error)), fixed = meanAbs(tail.map(row => phase(row.rawMs - 80, 250)));
    return {ok: adapted < fixed / 2 && adapted < 23 && run.correction > 140, adaptiveMeanAbsMs: adapted, fixedMeanAbsMs: fixed, finalCorrection: run.correction};
  });

  check('Slow negative latency drift also follows the common center', () => {
    const run = simulation({count: 280, delay: (_, time) => 80 - Math.max(0, time - 10000) * .001});
    const tail = run.history.slice(-40), adapted = meanAbs(tail.map(row => row.error)), fixed = meanAbs(tail.map(row => phase(row.rawMs - 80, 250)));
    return {ok: adapted < fixed / 2 && adapted < 17 && run.correction < 40, adaptiveMeanAbsMs: adapted, fixedMeanAbsMs: fixed, finalCorrection: run.correction};
  });

  check('Tracking adjustments respect the rate limit and never repeat the bootstrap jump', () => {
    const run = simulation({count: 160, delay: (_, time) => time < 10000 ? 80 : 115});
    let maxDelta = 0, prior = 0;
    const tracking = [];
    for (const row of run.history) {
      if (row.update.status === 'tracking') {const delta = Math.abs(row.correction - prior);maxDelta = Math.max(maxDelta, delta);tracking.push(row);}
      prior = row.correction;
    }
    return {ok: tracking.length > 0 && maxDelta <= 10 + 1e-6 && run.history.filter(row => row.update.status === 'bootstrap').length === 1, maximumTrackingChangeMs: maxDelta, trackingUpdates: tracking.length};
  });

  check('Alternating early and late playing remains visible instead of being fitted away', () => {
    const run = simulation({jitter: i => i % 2 ? 15 : -15});
    const tail = run.history.slice(-80), early = tail.filter(row => row.error < -5).length, late = tail.filter(row => row.error > 5).length;
    return {ok: early >= 30 && late >= 30 && meanAbs(tail.map(row => row.error)) > 12 && Math.abs(run.correction - 80) <= 15, early, late, meanAbsoluteErrorMs: meanAbs(tail.map(row => row.error)), finalCorrection: run.correction};
  });

  check('One gross late attack does not pull the rolling median', () => {
    const run = simulation({count: 140, jitter: i => i === 60 ? 100 : 0});
    const around = run.history.slice(55, 100);
    return {ok: around.every(row => close(row.correction, 80)) && run.history[60].error > 90, maximumCorrectionChangeMs: Math.max(...around.map(row => Math.abs(row.correction - 80))), retainedOutlierMs: run.history[60].error};
  });

  check('Broad phase scatter holds the previous correction rather than inventing a center', () => {
    const jitter = [-100, -70, -40, 0, 40, 70, 100];
    const run = simulation({count: 100, prior: 25, allowBootstrap: false, delay: () => 25, jitter: i => jitter[i % jitter.length]});
    return {ok: close(run.correction, 25) && run.history.some(row => row.update.status === 'uncertain'), finalCorrection: run.correction, uncertainUpdates: run.history.filter(row => row.update.status === 'uncertain').length};
  });

  check('Tracking without bootstrap changes the prior gradually when enabled during existing history', () => {
    const run = simulation({count: 100, prior: 0, allowBootstrap: false, delay: () => 40});
    const movements = run.history.filter(row => Number.isFinite(row.update.delayMs));
    return {ok: !run.history.some(row => row.update.status === 'bootstrap') && movements.length > 0 && movements.every((row, i) => Math.abs(row.correction - (i ? movements[i - 1].correction : 0)) <= 10 + 1e-6) && run.correction > 20, finalCorrection: run.correction, movements: movements.length};
  });

  check('Enabling tracking during existing history waits for two full bars', () => {
    const run = simulation({count: 9, prior: 0, allowBootstrap: false, delay: () => 40});
    return {ok: close(run.correction, 0) && run.history.every(row => !Number.isFinite(row.update.delayMs)), correction: run.correction, last: run.history.at(-1).update};
  });

  check('The correction stays inside the supported upper bound', () => {
    const run = simulation({step: 2000, bar: 8000, count: 70, prior: 495, allowBootstrap: false, startIndex: 10, delay: () => 508});
    return {ok: run.history.every(row => row.correction >= -300 && row.correction <= 500) && run.correction > 498, finalCorrection: run.correction};
  });

  check('The correction stays inside the supported lower bound', () => {
    const run = simulation({step: 2000, bar: 8000, count: 70, prior: -295, allowBootstrap: false, startIndex: 10, delay: () => -308});
    return {ok: run.history.every(row => row.correction >= -300 && row.correction <= 500) && run.correction < -298, finalCorrection: run.correction};
  });

  check('Nonfinite observations cannot contaminate the window', () => {
    const tracker = new AdaptiveNormalizer();
    tracker.observe(80, 250, 2000, 0);
    const before = JSON.stringify(tracker.samples), updates = [NaN, Infinity, -Infinity].map(raw => tracker.observe(raw, 250, 2000, 0));
    return {ok: JSON.stringify(tracker.samples) === before && updates.every(update => !Number.isFinite(update.delayMs)), updates};
  });

  check('Out-of-order and duplicate timestamps are ignored', () => {
    const run = simulation({count: 9});
    const before = JSON.stringify(run.tracker.samples), last = run.history.at(-1).rawMs;
    const updates = [run.tracker.observe(last - 100, 250, 2000, 80), run.tracker.observe(last, 250, 2000, 80)];
    return {ok: JSON.stringify(run.tracker.samples) === before && updates.every(update => !Number.isFinite(update.delayMs)), updates};
  });

  check('The recent sample buffer has a fixed 48-attack upper bound', () => {
    const run = simulation({step: 100, bar: 400, count: 500, delay: () => 20});
    return {ok: Array.isArray(run.tracker.samples) && run.tracker.samples.length <= 48 && run.tracker.samples.length >= 9, samples: run.tracker.samples.length};
  });

  check('A long silent gap clears old samples while retaining initialization', () => {
    const run = simulation({count: 9});
    const last = run.history.at(-1).rawMs, update = run.tracker.observe(last + 20000, 250, 2000, run.correction);
    return {ok: run.tracker.ready && run.tracker.samples.length === 1 && !Number.isFinite(update.delayMs) && update.status !== 'bootstrap', ready: run.tracker.ready, samples: run.tracker.samples.length, update};
  });

  check('A post-gap restarted window cannot bootstrap a second abrupt correction', () => {
    const run = simulation({count: 9});
    let correction = run.correction, maxDelta = 0;const updates = [];
    for (let i = 0; i < 24; i++) {
      const update = run.tracker.observe(25000 + i * 250 + 105, 250, 2000, correction);
      if (Number.isFinite(update.delayMs)) {maxDelta = Math.max(maxDelta, Math.abs(update.delayMs - correction));correction = update.delayMs;}
      updates.push(update);
    }
    return {ok: updates.every(update => update.status !== 'bootstrap') && maxDelta <= 10 + 1e-6 && correction > 80, maxDeltaMs: maxDelta, finalCorrection: correction};
  });

  check('Fractional sixteenth-note periods in 3/4 bootstrap without rounding the timing grid', () => {
    const step = 60000 / 137 / 4, bar = step * 12;
    const run = simulation({step, bar, count: 14, delay: () => 27.375});
    return {ok: run.tracker.ready && close(run.correction, 27.375, .002) && run.history.some(row => row.update.status === 'bootstrap'), stepMs: step, barMs: bar, correction: run.correction};
  });

  check('A circular phase near a neighboring grid line preserves the closest delay alias', () => {
    const run = simulation({step: 100, bar: 400, count: 50, prior: 149, delay: () => 151});
    return {ok: Math.abs(run.correction - 151) < 1 && run.history.every(row => Math.abs(row.correction - 149) < 10), finalCorrection: run.correction};
  });

  check('A drift run retains varying historical offsets rather than using one final correction', () => {
    const run = simulation({count: 240, delay: (_, time) => 80 + Math.max(0, time - 8000) * .0015});
    const old = run.history[40], newer = run.history.at(-1);
    return {ok: newer.offsetAtHit - old.offsetAtHit > 40 && close(old.error, phase(old.rawMs - old.offsetAtHit, 250)) && Math.abs(old.error - phase(old.rawMs - run.correction, 250)) > 40, oldOffsetMs: old.offsetAtHit, finalOffsetMs: run.correction, oldErrorMs: old.error};
  });
}

const passed = results.filter(result => result.status === 'PASS').length, failed = results.length - passed;
console.log(JSON.stringify({target, passed, failed, scope: 'Pure adaptive-median timing tests; no physical microphone, audio or browser validation.', results}, null, 2));
Deno.exitCode = failed ? 1 : 0;
