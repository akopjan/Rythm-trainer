// Focused acoustic-loopback regressions. This fixture deliberately tests room
// paths longer than the existing three-millisecond echo filter.
const target = Deno.args[0] ?? 'index.html';
const html = await Deno.readTextFile(target);
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);

function declaration(source, name, kind = 'class') {
  const start = source.search(new RegExp(kind + '\\s+' + name + (kind === 'class' ? '\\s*\\{' : '\\s*\\(')));
  if (start < 0) throw new Error('Missing ' + name);
  let depth = 0, quote = '', comment = '';
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const character = source[i], next = source[i + 1];
    if (comment === 'line') { if (character === '\n') comment = ''; continue; }
    if (comment === 'block') { if (character === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) { if (character === '\\') i++; else if (character === quote) quote = ''; continue; }
    if (character === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (character === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed ' + name);
}

const RhythmDetector = new Function(scripts[0] + ';return RhythmDetector;')();
const soundSource = declaration(scripts[1], 'makeSound', 'function');
const results = [];
const rms = (array, start = 0) => {
  let power = 0;
  for (let i = start; i < array.length; i++) power += array[i] ** 2;
  return Math.sqrt(power / Math.max(1, array.length - start));
};
const sample = (array, position) => {
  if (position < 0 || position >= array.length - 1) return 0;
  const index = Math.floor(position), fraction = position - index;
  return array[index] * (1 - fraction) + array[index + 1] * fraction;
};

function backing(rate, duration, kind, bpm) {
  const context = { sampleRate: rate, createBuffer(channels, count, frequency) {
    const pcm = new Float32Array(count);
    return { duration: count / frequency, getChannelData: () => pcm };
  }};
  const makeSound = new Function('context', soundSource + ';return makeSound;')(context);
  const sounds = [0, 1, 2, 3, 4].map(type => makeSound(type).getChannelData(0));
  const accent = makeSound(4, true).getChannelData(0);
  const output = new Float32Array(Math.round(rate * duration));
  const add = (buffer, time, gain) => {
    const offset = Math.round(time * rate);
    for (let i = 0; i < buffer.length && offset + i < output.length; i++) output[offset + i] += buffer[i] * gain;
  };
  const halfBeat = 30 / bpm;
  for (let step = 0; .25 + step * halfBeat < duration; step++) {
    const time = .25 + step * halfBeat;
    if (kind === 'mixed' || kind === 'hats') add(sounds[2], time, .36);
    if (kind === 'mixed') {
      if (step % 4 === 0) add(sounds[0], time, .45);
      if (step % 4 === 2) add(sounds[1], time, .40);
      if (step % 16 === 15) add(sounds[3], time, .12);
    }
    if ((kind === 'clicks' || kind === 'mixed-clicks') && step % 2 === 0) add(step % 8 === 0 ? accent : sounds[4], time, .8);
  }
  return output;
}

function bayan(rate, duration, times, amplitude) {
  const output = new Float32Array(Math.round(rate * duration));
  for (let i = 0; i < output.length; i++) {
    const time = i / rate;
    for (let note = 0; note < times.length; note++) {
      const since = time - times[note];
      if (since < 0 || since > .44) continue;
      const frequency = [220, 293.66, 329.63, 246.94][note % 4];
      const envelope = Math.min(1, since / .018) * Math.min(1, (.44 - since) / .035);
      output[i] += amplitude * envelope * (Math.sin(2 * Math.PI * frequency * time) + .32 * Math.sin(4 * Math.PI * frequency * time) + .19 * Math.sin(6 * Math.PI * frequency * time));
    }
  }
  return output;
}

function run({ rate = 8000, duration = 13, bpm = 100, kind = 'mixed', paths = () => [[0, .55]], delay = () => .08, times = [], amplitude = .14, mode = 'sustained' } = {}) {
  const reference = backing(rate, duration, kind, bpm);
  const own = bayan(rate, duration, times, amplitude);
  const capture = new Float32Array(reference.length), cleaned = new Float32Array(reference.length), messages = [];
  for (let i = 0; i < capture.length; i++) {
    const time = i / rate;
    let echo = 0;
    for (const [offset, gain] of paths(time)) echo += gain * sample(reference, i - rate * (delay(time) + offset));
    capture[i] = echo + own[i];
  }
  const detector = new RhythmDetector(rate, message => messages.push(message));
  detector.configure({ type: 'mode', value: mode });
  detector.configure({ type: 'threshold', value: 10 ** (-48 / 20) });
  detector.configure({ type: 'arm', start: .25, duration: 240 / bpm });
  detector.configure({ type: 'reference-sync', enabled: true, id: 1 });
  const originalProcess = detector.reference.process.bind(detector.reference);
  detector.reference.process = (cap, ref, time) => {
    const output = originalProcess(cap, ref, time);
    cleaned.set(output, Math.round(time * rate));
    return output;
  };
  for (let i = 0; i < capture.length; i += 128) detector.process(capture.subarray(i, i + 128), i / rate, reference.subarray(i, i + 128));
  const onsets = messages.filter(message => message.type === 'onset' && message.time >= 5.5);
  const locks = messages.filter(message => message.type === 'acoustic-sync' && message.status === 'locked');
  const statuses = messages.filter(message => message.type === 'acoustic-sync').map(message => ({ time: message.time, status: message.status, reason: message.reason }));
  return { rate, own, reference, capture, cleaned, onsets, locks, statuses, detector };
}

function echoOnly(name, config) {
  const audio = run(config);
  results.push({ name, status: audio.onsets.length === 0 ? 'PASS' : 'FAIL', evidence: {
    playerOnsets: audio.onsets.length, onsetTimes: audio.onsets.map(hit => Number(hit.time.toFixed(4))),
    absoluteLockCount: audio.locks.length, lastDelayMs: audio.locks.at(-1)?.delayMs ?? null,
    cancellationReady: audio.detector.reference.cancelReady,
    residualRmsRatio: rms(audio.cleaned, Math.round(5.5 * audio.rate)) / Math.max(1e-12, rms(audio.capture, Math.round(5.5 * audio.rate))),
    statuses: audio.statuses,
  }});
}

echoOnly('Dry speaker loopback remains excluded from player scoring', {});
echoOnly('Inverted speaker polarity remains excluded from player scoring', { paths: () => [[0, -.55]] });
for (const tailMs of [20, 60, 120]) echoOnly(`A ${tailMs} ms speaker reflection never becomes a player point`, { paths: () => [[0, .55], [tailMs / 1000, .25]] });
const room = () => [[0, .55], [.020, .23], [.037, -.11], [.060, .18], [.120, -.12]];
echoOnly('Mixed drum loopback with a 120 ms room response produces no player points', { paths: room });
echoOnly('Metronome-only room echo is used for latency and never becomes a player point', { kind: 'clicks', paths: room });
echoOnly('Ambiguous hats with room reflections produce no player points', { kind: 'hats', delay: () => .38, paths: room });
echoOnly('Speaker gain changes do not leak backing into player points', { paths: time => [[0, time < 8 ? .55 : 1.1]] });
echoOnly('A new reflection after a device-path change is excluded from player scoring', { paths: time => time < 8 ? [[0, .55]] : room() });
echoOnly('A 40 ms latency change does not score raw fallback backing', { delay: time => time < 8 ? .08 : .12 });
echoOnly('Real-rate 48 kHz room reflection is excluded from player scoring', { rate: 48000, paths: room });

const ownTimes = [6.33, 7.53, 8.73, 9.93];
for (const [name, config] of [
  ['Coincident bayan attacks remain scored with room reflections', { paths: room }],
  ['48 kHz room echo is excluded while all four bayan attacks remain scored', { paths: room, rate: 48000 }],
  ['Coincident bayan attacks survive ambiguous hats and room reflections', { paths: room, kind: 'hats', delay: () => .38 }],
  ['Coincident bayan attacks survive metronome and room reflections', { paths: room, kind: 'clicks' }],
  ['Headphones preserve bayan scoring without requiring an acoustic lock', { paths: () => [] }],
]) {
  const audio = run({ ...config, times: ownTimes });
  const missing = ownTimes.filter(time => !audio.onsets.some(hit => Math.abs(hit.time - time) < .12));
  const unexpected = audio.onsets.filter(hit => !ownTimes.some(time => Math.abs(hit.time - time) < .12));
  results.push({ name, status: missing.length === 0 && unexpected.length === 0 && audio.onsets.length === ownTimes.length ? 'PASS' : 'FAIL', evidence: {
    expectedTimes: ownTimes, onsetTimes: audio.onsets.map(hit => Number(hit.time.toFixed(4))), missingTimes: missing,
    unexpectedTimes: unexpected.map(hit => Number(hit.time.toFixed(4))), absoluteLockCount: audio.locks.length,
    retainedRmsRatio: rms(audio.cleaned, Math.round(5.5 * audio.rate)) / rms(audio.own, Math.round(5.5 * audio.rate)),
  }});
}

for (const [bpm, times, duration] of [
  [100, [6.49, 7.71, 8.87, 10.09, 11.27], 13],
  [30, [10.33, 12.33, 14.33, 16.33, 18.33], 22],
]) {
  const audio = run({ bpm, duration, kind: 'clicks', times });
  const missing = times.filter(time => !audio.onsets.some(hit => Math.abs(hit.time - time) < .12));
  const unexpected = audio.onsets.filter(hit => !times.some(time => Math.abs(hit.time - time) < .12));
  const latest = audio.locks.at(-1);
  results.push({ name: `A ${bpm} BPM metronome learns actual latency and preserves five bayan attacks`, status: missing.length === 0 && unexpected.length === 0 && audio.onsets.length === times.length && latest && Math.abs(latest.delayMs - 80) < 2 ? 'PASS' : 'FAIL', evidence: {
    expectedTimes: times, onsetTimes: audio.onsets.map(hit => Number(hit.time.toFixed(4))), missingTimes: missing,
    unexpectedTimes: unexpected.map(hit => Number(hit.time.toFixed(4))), absoluteLockCount: audio.locks.length,
    lastDelayMs: latest?.delayMs ?? null,
  }});
}

const passed = results.filter(result => result.status === 'PASS').length;
const failed = results.length - passed;
console.log(JSON.stringify({ target, passed, failed, scope: 'Synthetic room loopback through the actual RhythmDetector. No microphone or physical speaker measurements.', results }, null, 2));
Deno.exitCode = failed ? 1 : 0;
