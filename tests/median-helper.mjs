// Independent mathematical regressions for median centering and linear error.
// No browser or physical audio I/O; read the helper from the saved HTML.
const target = Deno.args[0] ?? 'index.html';
const html = await Deno.readTextFile(target);
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const results = [];
const record = (name, ok, evidence = {}) => results.push({name, status: ok ? 'PASS' : 'FAIL', evidence});
const close = (a, b, epsilon = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= epsilon;
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const wrap = (error, period) => error - period * Math.floor(error / period + .5);
const mae = (errors, period, previous, next) => {
  const finite = errors.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, error) => sum + Math.abs(wrap(error - (next - previous), period)), 0) / finite.length : 0;
};
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function extractFunction(source, name) {
  const start = source?.search(new RegExp('function\\s+' + name + '\\s*\\(')) ?? -1;
  if (start < 0) throw new Error(`Missing function ${name} in the second HTML script`);
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
  throw new Error(`Unclosed function ${name}`);
}

let fit;
try {
  fit = new Function('clamp', extractFunction(scripts[1], 'fitLatencyMedian') + '; return fitLatencyMedian;')(clamp);
} catch (error) {
  record('Circular median helper is available', false, {error: error.message});
}

function checkFit(name, errors, period, previous, check = () => true) {
  try {
    const before = [...errors], result = fit(errors, period, previous), actualMae = mae(errors, period, previous, result?.delayMs);
    const valid = Number.isFinite(result?.delayMs) && result.delayMs >= -300 - 1e-9 && result.delayMs <= 500 + 1e-9 && close(result.maeMs, actualMae) && errors.every((error, i) => Object.is(error, before[i]));
    record(name, valid && check(result, actualMae), {result, computedMaeMs: actualMae, previousMs: previous, stepMs: period, attacks: errors.length});
    return result;
  } catch (error) {
    record(name, false, {error: error.message});
    return null;
  }
}

if (fit) {
  checkFit('An outlier cannot pull the center away from the ordinary median', [10, 11, 12, 100], 300, 0, result => close(result.delayMs, 11.5) && close(result.maeMs, 22.75));
  checkFit('Odd samples center on the middle observation', [10, 11, 12, 13, 100], 300, 0, result => close(result.delayMs, 12));
  checkFit('Even samples use the midpoint of the two central observations', [20, 30, 40, 100], 300, 80, result => close(result.delayMs, 115) && close(result.maeMs, 22.5));
  checkFit('A flat median interval crossing phase zero uses its combined midpoint', [-10, 40], 300, 0, result => close(result.delayMs, 15) && close(result.maeMs, 25));
  checkFit('Half-grid seam samples are centered with both early and late residuals', [-49, 49], 100, 0, result => {
    const residuals = [-49, 49].map(error => wrap(error - result.delayMs, 100));
    return close(Math.abs(result.delayMs), 50) && close(result.maeMs, 1) && residuals.some(error => error < 0) && residuals.some(error => error > 0);
  });
  checkFit('Seam wrapping does not put every nonzero residual on the early side', [-149, -90, 145], 300, 0, result => {
    const residuals = [-149, -90, 145].map(error => wrap(error - result.delayMs, 300));
    return close(result.delayMs, -149) && close(result.maeMs, 65 / 3) && residuals.some(error => error < 0) && residuals.some(error => error > 0) && close(median(residuals), 0);
  });
  checkFit('Antipodal observations with no identifiable center retain the prior', [-25, 25], 100, 20, result => close(result.delayMs, 20) && close(result.maeMs, 25));
  checkFit('Several antipodal pairs still retain the prior', [-25, 25, 0, 50], 100, 237, result => close(result.delayMs, 237) && close(result.maeMs, 25));
  checkFit('Antipodal fractional phases preserve the prior despite modulo roundoff', [-1000 / 28, 1000 / 28], 1000 / 7, 237, result => close(result.delayMs, 237) && close(result.maeMs, 1000 / 28));
  checkFit('The nearest periodic alias is selected', [40, 40], 100, 140, result => close(result.delayMs, 180) && close(result.maeMs, 0));
  checkFit('An allowed alias replaces an inaccessible positive correction', [40, 40], 100, 490, result => close(result.delayMs, 430) && close(result.maeMs, 0));
  checkFit('An allowed alias replaces an inaccessible negative correction', [-40, -40], 100, -290, result => close(result.delayMs, -230) && close(result.maeMs, 0));
  checkFit('An upper bound is used when no equivalent minimum is accessible', [250, 350], 2000, 400, result => close(result.delayMs, 500) && close(result.maeMs, 200));
  checkFit('A lower bound is used when no equivalent minimum is accessible', [-250, -350], 2000, -200, result => close(result.delayMs, -300) && close(result.maeMs, 200));
  checkFit('A zero residual keeps the existing nonzero correction', [0, 0, 0], 100, 237, result => close(result.delayMs, 237) && close(result.maeMs, 0));
  checkFit('Empty observations preserve the current correction', [], 100, 123, result => close(result.delayMs, 123) && close(result.maeMs, 0));
  checkFit('Nonfinite observations cannot contaminate the result', [NaN, Infinity, 10, 30, -Infinity], 300, 0, result => close(result.delayMs, 20) && close(result.maeMs, 10));
  checkFit('Fractional periods retain sub-millisecond precision', [1000 / 14 - .2, -1000 / 14 + .3], 1000 / 7, 0, result => close(result.delayMs, -1000 / 14 + .05) && close(result.maeMs, .25));
  checkFit('More than 3000 observations all contribute to the linear score', [80, ...Array(3000).fill(10)], 1000, 0, result => close(result.delayMs, 10) && close(result.maeMs, 70 / 3001));

  const base = [-20, 5, 15, 25], original = checkFit('Base dataset uses its median', base, 120, 42, result => close(result.delayMs, 52));
  checkFit('Equivalent prior and residual translation preserve absolute correction', base.map(error => wrap(error + 17, 120)), 120, 25, result => close(result.delayMs, original?.delayMs) && close(result.maeMs, original?.maeMs));
  checkFit('Shifting physical timing shifts the correction equally', base, 120, 59, result => close(result.delayMs, original?.delayMs + 17) && close(result.maeMs, original?.maeMs));
  checkFit('Observation order has no effect', [...base].reverse(), 120, 42, result => close(result.delayMs, original?.delayMs) && close(result.maeMs, original?.maeMs));

  for (const [errors, period, previous] of [[base, 120, 42], [[-149, -90, 145], 300, 0], [[-49, 49], 100, 0], [[250, 350], 2000, 400], [[-10, 40], 300, 0]]) {
    const first = fit(errors, period, previous), residuals = errors.map(error => wrap(error - (first.delayMs - previous), period));
    checkFit(`Repeated median normalization is stable for ${JSON.stringify(errors)}`, residuals, period, first.delayMs, result => close(result.delayMs, first.delayMs) && close(result.maeMs, first.maeMs));
  }

  // Dense independent evaluation verifies the objective without reimplementing
  // the production sweep or deriving candidates from its branch locations.
  let seed = 18803;
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296;};
  for (let test = 0; test < 12; test++) {
    const period = [75, 100, 153, 300, 2000][test % 5], previous = -280 + random() * 760;
    const errors = Array.from({length: 5 + test}, () => (random() - .5) * period), spacing = .1;
    let bruteMae = Infinity, bruteDelay;
    for (let i = 0; i <= 8000; i++) {
      const delay = -300 + i * spacing, candidate = mae(errors, period, previous, delay);
      if (candidate < bruteMae) {bruteMae = candidate; bruteDelay = delay;}
    }
    const result = checkFit(`Arbitrary dataset ${test + 1} minimizes absolute error in an independent search`, errors, period, previous, (result, actualMae) => actualMae <= bruteMae + 1e-6 && bruteMae - actualMae <= spacing / 2 + 1e-6);
    results.at(-1).evidence = {...results.at(-1).evidence, bruteDelayMs: bruteDelay, bruteMaeMs: bruteMae};
    if (result) {
      const residuals = errors.map(error => wrap(error - (result.delayMs - previous), period));
      checkFit(`Arbitrary dataset ${test + 1} remains stable when normalized again`, residuals, period, result.delayMs, next => close(next.delayMs, result.delayMs) && close(next.maeMs, result.maeMs));
    }
  }
}

let summarize;
try {
  summarize = new Function(extractFunction(scripts[1], 'summarizeBars') + '; return summarizeBars;')();
} catch (error) {
  record('Pure chronological bar summary is available', false, {error: error.message});
}

function checkBars(name, attacks, perBar, bars, tolerance, latestBar, check) {
  try {
    const before = attacks.map(attack => ({...attack})), report = summarize(attacks, perBar, bars, tolerance, latestBar);
    const unchanged = attacks.length === before.length && attacks.every((attack, i) => Object.keys(attack).every(key => Object.is(attack[key], before[i][key])));
    record(name, unchanged && check(report), {bars: report.history.length, positionCounts: report.positions.map(row => row.count)});
    return report;
  } catch (error) {
    record(name, false, {error: error.message});
    return null;
  }
}

if (summarize) {
  checkBars('An empty session has no chronological rows and no invented zero errors', [], 8, 2, 30, -1, report => report.history.length === 0 && report.positions.length === 2 && report.positions.every(row => row.count === 0 && row.maeMs === null && row.medianMs === null && row.biasMs === null && row.inside === 0));
  checkBars('Elapsed empty bars are represented by missing scores', [], 6, 1, 30, 2, report => report.history.length === 3 && report.history.every((row, i) => row.bar === i + 1 && row.count === 0 && row.maeMs === null && row.medianMs === null && row.biasMs === null));

  const threeFour = [{cycle: 0, step: 0, error: 10}, {cycle: 0, step: 5, error: -20}, {cycle: 1, step: 0, error: 30}];
  checkBars('3/4 eighth-note bars contain six grid positions', threeFour, 6, 1, 30, -1, report => report.history.length === 2 && report.history[0].count === 2 && close(report.history[0].maeMs, 15) && close(report.history[0].medianMs, -5) && close(report.history[0].biasMs, -5) && report.history[1].count === 1 && report.history[1].bar === 2 && report.history[1].cycle === 2);

  const twoBarPattern = [{cycle: 0, step: 0, error: 5}, {cycle: 0, step: 11, error: -15}, {cycle: 0, step: 12, error: 40}, {cycle: 1, step: 0, error: -100}, {cycle: 1, step: 12, error: 30}];
  checkBars('3/4 sixteenths distinguish both bars in successive two-bar cycles', twoBarPattern, 12, 2, 30, -1, report => report.history.length === 4 && report.history.map(row => row.patternBar).join(',') === '1,2,1,2' && report.history.map(row => row.cycle).join(',') === '1,1,2,2' && report.history.map(row => row.count).join(',') === '2,1,1,1');
  checkBars('Pattern positions aggregate attacks with their actual sample weights', twoBarPattern, 12, 2, 30, -1, report => report.positions[0].bar === 1 && report.positions[0].count === 3 && close(report.positions[0].maeMs, 40) && close(report.positions[0].medianMs, -15) && close(report.positions[0].biasMs, -110 / 3) && report.positions[1].count === 2 && close(report.positions[1].maeMs, 35));
  checkBars('An early attack at the upcoming bar target belongs to that target bar', [{cycle: 1, step: 0, error: -12}], 6, 2, 30, -1, report => report.history.length === 3 && report.history[0].count === 0 && report.history[1].count === 0 && report.history[2].count === 1 && report.history[2].patternBar === 1 && report.history[2].cycle === 2 && report.positions[0].earlier === 1 && report.positions[1].count === 0);
  checkBars('A late attack at the final old-bar target stays in that old bar', [{cycle: 0, step: 5, error: 12}], 6, 2, 30, -1, report => report.history.length === 1 && report.history[0].count === 1 && report.history[0].later === 1 && report.positions[0].count === 1 && report.positions[1].count === 0);
  checkBars('4/4 sixteenths map second-bar and next-cycle targets separately', [{cycle: 0, step: 31, error: 10}, {cycle: 1, step: 0, error: -10}], 16, 2, 30, -1, report => report.history.length === 3 && report.history.map(row => row.count).join(',') === '0,1,1' && report.history[1].patternBar === 2 && report.history[2].patternBar === 1);

  const gaps = [{cycle: 3, step: 0, error: 20}];
  checkBars('Missing earlier bars are displayed without being counted as correct', gaps, 8, 1, 30, -1, report => report.history.length === 4 && report.history.slice(0, 3).every(row => row.count === 0 && row.maeMs === null && row.inside === 0) && report.history[3].count === 1 && report.positions[0].count === 1);
  checkBars('Elapsed-bar boundary extends a session beyond the last played attack', gaps, 8, 1, 30, 5, report => report.history.length === 6 && report.history[4].count === 0 && report.history[5].maeMs === null);
  checkBars('An older elapsed-bar boundary cannot truncate observed attacks', gaps, 8, 1, 30, 0, report => report.history.length === 4 && report.history[3].count === 1);

  const boundaryErrors = [-30, 30, -30 - 1e-7, 30 + 1e-7, -30.01, 30.01, 0, .01, -.01, .05, -.05, .051, -.051];
  checkBars('Bar tolerance includes exact limits and keeps timing-sign counts separate', boundaryErrors.map(error => ({cycle: 0, step: 1, error})), 8, 1, 30, -1, report => report.history[0].count === 13 && report.history[0].inside === 11 && report.history[0].earlier === 4 && report.history[0].later === 4 && close(report.history[0].medianMs, 0));
  checkBars('Tolerance changes accuracy without changing the linear error', [{cycle: 0, step: 1, error: 10}, {cycle: 0, step: 2, error: -20}], 8, 1, 15, -1, report => report.history[0].inside === 1 && close(report.history[0].maeMs, 15));
  checkBars('Errors retain the shared correction rather than refitting each bar', [{cycle: 0, step: 0, error: 60}, {cycle: 0, step: 1, error: 70}], 8, 1, 30, -1, report => close(report.history[0].maeMs, 65) && close(report.history[0].medianMs, 65) && close(report.history[0].biasMs, 65) && report.history[0].inside === 0);
  checkBars('Preparatory negative-bar assignments are omitted from ordinary bar rows', [{cycle: -1, step: 7, error: 30}, {cycle: 0, step: 0, error: 10}], 8, 1, 30, -1, report => report.history.length === 1 && report.history[0].count === 1 && close(report.history[0].maeMs, 10) && report.positions[0].count === 1);
  checkBars('Nonfinite errors cannot create scored or elapsed bars', [{cycle: 0, step: 0, error: 10}, {cycle: 7, step: 0, error: NaN}, {cycle: 8, step: 0, error: Infinity}], 8, 1, 30, -1, report => report.history.length === 1 && report.history[0].count === 1 && close(report.positions[0].maeMs, 10));
  checkBars('Keyboard and microphone attacks remain part of the same bar statistics', [{cycle: 0, step: 0, error: 10, kind: 'key'}, {cycle: 0, step: 1, error: -20, kind: 'mic'}], 8, 1, 30, -1, report => report.history[0].count === 2 && close(report.history[0].maeMs, 15));

  const longSession = Array.from({length: 3001}, (_, i) => ({cycle: Math.floor(i / 2), step: (i % 2) * 8, error: i === 0 ? 99 : 40}));
  checkBars('Chronological bar history includes the oldest attack after 3000 chart points', longSession, 8, 2, 30, -1, report => report.history.length === 3001 && report.history[0].count === 1 && close(report.history[0].maeMs, 99) && report.history.at(-1).bar === 3001 && report.history.reduce((sum, row) => sum + row.count, 0) === 3001);
  checkBars('Long-session pattern summaries retain the correct all-history weights', longSession, 8, 2, 30, -1, report => report.positions[0].count === 1501 && report.positions[1].count === 1500 && close(report.positions[0].maeMs, (99 + 40 * 1500) / 1501) && close(report.positions[1].maeMs, 40));
  checkBars('A problematic old bar remains identifiable beyond the display window', longSession, 8, 2, 30, -1, report => report.history.reduce((best, row) => !best || row.maeMs > best.maeMs ? row : best, null).bar === 1);
}

const passed = results.filter(result => result.status === 'PASS').length, failed = results.length - passed;
console.log(JSON.stringify({target, passed, failed, scope: 'Pure median/linear-error mathematics and bar aggregation; no physical microphone, audio or browser validation.', results}, null, 2));
Deno.exitCode = failed ? 1 : 0;
