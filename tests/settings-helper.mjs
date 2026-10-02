// Standalone validation regressions for portable rhythm-trainer settings.
// Tests only the pure sanitizer extracted from the final HTML.
const target = Deno.args[0] ?? 'index.html';
const html = await Deno.readTextFile(target);
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const results = [];
const compactEvidence = value => {
  if (Array.isArray(value)) {
    if (value.length > 16 && value.every(item => typeof item === 'boolean')) return {length: value.length, enabledPositions: value.flatMap((enabled, position) => enabled ? [position] : [])};
    return value.map(compactEvidence);
  }
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactEvidence(item)])) : value;
};
const record = (name, ok, evidence = {}) => results.push({name, status: ok ? 'PASS' : 'FAIL', evidence: compactEvidence(evidence)});
const close = (a, b, epsilon = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= epsilon;
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));

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

let sanitize;
try {
  sanitize = new Function('clamp', extractFunction(scripts[1], 'sanitizeSettings') + '; return sanitizeSettings;')(clamp);
  record('Portable settings sanitizer is available independently of DOM and audio', typeof sanitize === 'function');
} catch (error) {record('Portable settings sanitizer is available independently of DOM and audio', false, {error: error.message});}

const defaultFields = {version: 1, bpm: 100, bars: 1, beats: 4, division: 8, mic: true, click: false, autoNormalize: true, inputMode: 'sustained', volume: 55, clickVolume: 100, threshold: -48, latency: 0, tolerance: 30};
const permittedKeys = [...Object.keys(defaultFields), 'pattern', 'trackEnabled', 'trackVolumes'].sort();
const presetPattern = () => Array.from({length: 4}, (_, track) => Array.from({length: 32}, (_, position) => track === 0 ? [0, 8].includes(position % 16) : track === 1 ? [4, 12].includes(position % 16) : track === 2 ? position % 2 === 0 : false));
function defaultsOk(value) {
  return value && Object.entries(defaultFields).every(([key, expected]) => Object.is(value[key], expected)) && JSON.stringify(value.pattern) === JSON.stringify(presetPattern()) && value.trackEnabled?.length === 4 && value.trackEnabled.every(enabled => enabled === true) && value.trackVolumes?.length === 4 && value.trackVolumes.every(volume => volume === 100);
}
function check(name, run) {
  try {const evidence = run();record(name, evidence.ok, evidence);} catch (error) {record(name, false, {error: error.message});}
}

if (sanitize) {
  check('Missing settings restore the drum groove and leave the metronome off', () => {
    const settings = sanitize({});
    return {ok: defaultsOk(settings), settings};
  });

  check('Absent or malformed pattern roots restore the complete two-bar preset', () => {
    const snapshots = [undefined, null, false, 'pattern', {0: [true]}].map(pattern => sanitize({pattern}));
    return {ok: snapshots.every(settings => JSON.stringify(settings.pattern) === JSON.stringify(presetPattern())), repairedInputs: snapshots.length};
  });

  check('Explicit empty pattern arrays stay silent instead of restoring the preset', () => {
    const snapshots = [[], Array.from({length: 4}, () => Array(32).fill(false))].map(pattern => sanitize({pattern}));
    return {ok: snapshots.every(settings => settings.pattern.length === 4 && settings.pattern.every(row => row.length === 32 && row.every(cell => cell === false))), explicitBlankVariants: snapshots.length};
  });

  for (const input of [null, undefined, [], false, 'not settings', 42]) {
    check(`Malformed root ${String(input)} is safely rejected or becomes defaults`, () => {
      try {const settings = sanitize(input);return {ok: defaultsOk(settings), outcome: 'defaults'};}
      catch (error) {return {ok: error instanceof Error && Boolean(error.message), outcome: 'rejected', error: error.message};}
    });
  }

  check('Every supported user setting survives a complete portable snapshot', () => {
    const pattern = Array.from({length: 4}, (_, track) => Array.from({length: 32}, (_, position) => (position + track) % 5 === 0));
    const input = {version: 1, bpm: 137.5, bars: 2, beats: 3, division: 16, mic: false, click: false, autoNormalize: false, inputMode: 'percussive', volume: 0, clickVolume: 37, threshold: -60, latency: -27.375, tolerance: 18, pattern, trackEnabled: [true, false, true, false], trackVolumes: [0, 25, 70, 100]};
    const settings = sanitize(input);
    return {ok: Object.keys(input).every(key => JSON.stringify(settings[key]) === JSON.stringify(input[key])), settings};
  });

  check('Explicit false flags and zero controls are preserved instead of using truthy defaults', () => {
    const settings = sanitize({mic: false, click: false, autoNormalize: false, volume: 0, clickVolume: 0, latency: 0, trackEnabled: [false, false, false, false], trackVolumes: [0, 0, 0, 0]});
    return {ok: settings.mic === false && settings.click === false && settings.autoNormalize === false && settings.volume === 0 && settings.clickVolume === 0 && settings.latency === 0 && settings.trackEnabled.every(value => value === false) && settings.trackVolumes.every(value => value === 0), settings};
  });

  check('Finite numeric settings are clamped to their supported ranges', () => {
    const low = sanitize({bpm: -5, volume: -1, clickVolume: -1, threshold: -100, latency: -900, tolerance: 0, trackVolumes: [-10, 0, 1, 101]});
    const high = sanitize({bpm: 999, volume: 500, clickVolume: 500, threshold: 0, latency: 900, tolerance: 999});
    return {ok: low.bpm === 30 && low.volume === 0 && low.clickVolume === 0 && low.threshold === -65 && low.latency === -300 && low.tolerance === 1 && JSON.stringify(low.trackVolumes) === '[0,0,1,100]' && high.bpm === 280 && high.volume === 100 && high.clickVolume === 100 && high.threshold === -15 && high.latency === 500 && high.tolerance === 100, low, high};
  });

  for (const invalid of [NaN, Infinity, -Infinity, '80', true, null]) {
    check(`Non-numeric control ${String(invalid)} uses defaults without coercion`, () => {
      const settings = sanitize({bpm: invalid, volume: invalid, clickVolume: invalid, threshold: invalid, latency: invalid, tolerance: invalid, trackVolumes: [invalid, invalid, invalid, invalid]});
      return {ok: settings.bpm === 100 && settings.volume === 55 && settings.clickVolume === 100 && settings.threshold === -48 && settings.latency === 0 && settings.tolerance === 30 && settings.trackVolumes.every(value => value === 100), settings};
    });
  }

  check('Unknown bar lengths, signatures, divisions and input modes use valid defaults', () => {
    const settings = sanitize({bars: 3, beats: 7, division: 32, inputMode: 'voice'});
    return {ok: settings.bars === 1 && settings.beats === 4 && settings.division === 8 && settings.inputMode === 'sustained', settings};
  });

  check('Resolution selectors do not coerce string values from malformed JSON', () => {
    const settings = sanitize({bars: '2', beats: '3', division: '16'});
    return {ok: settings.bars === 1 && settings.beats === 4 && settings.division === 8, bars: settings.bars, beats: settings.beats, division: settings.division};
  });

  check('Allowed resolution values are preserved independently of time signature', () => {
    const snapshots = [];
    for (const bars of [1, 2]) for (const beats of [3, 4]) for (const division of [4, 8, 16]) snapshots.push(sanitize({bars, beats, division}));
    return {ok: snapshots.length === 12 && snapshots.every((settings, i) => settings.bars === (i < 6 ? 1 : 2) && [3, 4].includes(settings.beats) && [4, 8, 16].includes(settings.division)), combinations: snapshots.map(({bars, beats, division}) => ({bars, beats, division}))};
  });

  check('Boolean fields accept only actual booleans', () => {
    const settings = sanitize({mic: 'false', click: 0, autoNormalize: null, trackEnabled: ['false', 0, null, {}]});
    return {ok: settings.mic === true && settings.click === false && settings.autoNormalize === true && settings.trackEnabled.every(value => value === true), settings};
  });

  check('Sparse and short patterns become four complete 32-position boolean tracks', () => {
    const row = [];row[0] = true;row[31] = true;
    const settings = sanitize({pattern: [row, [false, true], null]});
    return {ok: settings.pattern.length === 4 && settings.pattern.every(track => track.length === 32 && track.every(value => typeof value === 'boolean')) && settings.pattern[0][0] === true && settings.pattern[0][31] === true && settings.pattern[1][1] === true && settings.pattern[2].every(value => value === false) && settings.pattern[3].every(value => value === false), enabledCounts: settings.pattern.map(track => track.filter(Boolean).length)};
  });

  check('Oversized imported patterns cannot exceed fixed backing storage', () => {
    const settings = sanitize({pattern: Array.from({length: 6}, () => Array(100).fill(true)), trackEnabled: Array(10).fill(false), trackVolumes: Array(10).fill(75)});
    return {ok: settings.pattern.length === 4 && settings.pattern.every(row => row.length === 32 && row.every(value => value === true)) && settings.trackEnabled.length === 4 && settings.trackVolumes.length === 4, dimensions: settings.pattern.map(row => row.length)};
  });

  check('Malformed pattern cell values do not create unintended drum hits', () => {
    const settings = sanitize({pattern: [[true, false, 1, 'true', {}, [], null, undefined, NaN]]});
    return {ok: settings.pattern[0][0] === true && settings.pattern[0].slice(1).every(value => value === false) && settings.pattern.slice(1).every(row => row.every(value => value === false)), firstTrack: settings.pattern[0]};
  });

  check('3/4 imports preserve hidden sixteenth positions in both 16-cell bar blocks', () => {
    const pattern = Array.from({length: 4}, () => Array(32).fill(false));
    for (const position of [11, 12, 15, 16, 27, 28, 31]) pattern[2][position] = true;
    const settings = sanitize({beats: 3, bars: 2, division: 4, pattern});
    return {ok: settings.beats === 3 && settings.division === 4 && JSON.stringify(settings.pattern) === JSON.stringify(pattern), enabledPositions: settings.pattern[2].map((enabled, i) => enabled ? i : null).filter(value => value !== null)};
  });

  check('Partial track controls preserve supplied values and fill missing tracks with defaults', () => {
    const settings = sanitize({trackEnabled: [false, true], trackVolumes: [0, 40]});
    return {ok: JSON.stringify(settings.trackEnabled) === '[false,true,true,true]' && JSON.stringify(settings.trackVolumes) === '[0,40,100,100]', enabled: settings.trackEnabled, volumes: settings.trackVolumes};
  });

  check('Sanitization does not mutate or share pattern arrays with the input', () => {
    const input = {pattern: [Array(32).fill(false)], trackEnabled: [false], trackVolumes: [25]};input.pattern[0][7] = true;
    const before = JSON.stringify(input), settings = sanitize(input);
    settings.pattern[0][7] = false;settings.trackEnabled[0] = true;settings.trackVolumes[0] = 100;
    return {ok: JSON.stringify(input) === before && settings.pattern[0] !== input.pattern[0] && settings.trackEnabled !== input.trackEnabled && settings.trackVolumes !== input.trackVolumes, inputUnchanged: JSON.stringify(input) === before};
  });

  check('Default snapshots have independent track arrays and do not share subsequent defaults', () => {
    const first = sanitize({}), second = sanitize({});first.pattern[0][3] = true;first.trackEnabled[0] = false;first.trackVolumes[0] = 0;
    return {ok: first.pattern[1][3] === false && JSON.stringify(second.pattern) === JSON.stringify(presetPattern()) && second.trackEnabled.every(value => value === true) && second.trackVolumes.every(value => value === 100), independentDefaults: true};
  });

  check('Legacy settings without a version preserve known controls and gain version 1', () => {
    const settings = sanitize({bpm: 123, click: false, volume: 22});
    return {ok: settings.version === 1 && settings.bpm === 123 && settings.click === false && settings.volume === 22, version: settings.version};
  });

  check('An unsupported future settings version is rejected or replaced with defaults', () => {
    try {const settings = sanitize({version: 99, bpm: 250, click: false});return {ok: defaultsOk(settings), outcome: 'defaults'};}
    catch (error) {return {ok: error instanceof Error && Boolean(error.message), outcome: 'rejected', error: error.message};}
  });

  check('Only settings fields are retained; audio, microphone and playing history are excluded', () => {
    const input = {version: 1, bpm: 130, audio: 'sensitive audio', stream: {deviceId: 'private'}, events: [{error: 22}], attacks: [{rawMs: 80}], errors: [22], running: true, epoch: 30, token: 123, adaptive: {samples: [80]}, permission: 'granted', custom: 'unexpected'};
    const settings = sanitize(input), keys = Object.keys(settings).sort();
    return {ok: JSON.stringify(keys) === JSON.stringify(permittedKeys) && !JSON.stringify(settings).includes('sensitive') && settings.bpm === 130, keys};
  });

  check('JSON export/import round trips to an identical sanitized snapshot', () => {
    const input = {version: 1, bpm: 119, bars: 2, beats: 3, division: 16, mic: false, click: true, autoNormalize: false, inputMode: 'sustained', volume: 77, threshold: -39, latency: 27.125, tolerance: 21, pattern: [[true, false, true]], trackEnabled: [true, false, false, true], trackVolumes: [15, 0, 68, 99]};
    const original = sanitize(input), restored = sanitize(JSON.parse(JSON.stringify(original)));
    return {ok: JSON.stringify(original) === JSON.stringify(restored), jsonBytes: JSON.stringify(original).length};
  });

  check('Sanitization is idempotent after repairing malformed controls', () => {
    const first = sanitize({bpm: 999, bars: 8, volume: -5, pattern: [[true, 1, 'true']], trackVolumes: [999, -1, null]}), second = sanitize(first);
    return {ok: JSON.stringify(first) === JSON.stringify(second), second};
  });
}

const passed = results.filter(result => result.status === 'PASS').length, failed = results.length - passed;
console.log(JSON.stringify({target, passed, failed, scope: 'Pure settings schema, repair and portable JSON tests; no real localStorage/browser/file-import validation.', results}, null, 2));
Deno.exitCode = failed ? 1 : 0;
