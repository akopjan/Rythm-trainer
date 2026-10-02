// Real detector reproductions for preparation gates that never opened.
// The digital reference is always the exact master backing sent to speakers;
// captured echo may have attenuation, room noise, or a causal speaker EQ.
const target = Deno.args[0] ?? 'index.html';
const utilitySource = await Deno.readTextFile(new URL('./echo-leakage.mjs', import.meta.url));
let prefix = utilitySource.slice(0, utilitySource.indexOf("echoOnly('Dry"));
prefix = prefix.replace(/const workerSource =[^\n]+/, 'const workerSource = scripts[0];');
const { backing, bayan, sample, RhythmDetector } = await eval('(async()=>{' + prefix + ';return {backing,bayan,sample,RhythmDetector};})()');
const diagnosticOpen = Deno.args.includes('--diagnostic-open');
const results = [];
const lateTimes = [6.33, 7.53, 8.73, 9.93];
const earlyTimes = [.93, 2.13, 3.33, 4.53, 5.73, 6.93];

function run({ kind = 'mixed', times = lateTimes, gain = 0, noise = true, cutoff = null, missingReference = false, amplitude = .08 } = {}) {
  const rate = 48000, duration = 12;
  const render = backing(rate, duration, kind, 100);
  const own = bayan(rate, duration, times, amplitude);
  const capture = new Float32Array(render.length);
  let filtered = 0, seed = 1987;
  const alpha = cutoff ? 1 - Math.exp(-2 * Math.PI * cutoff / rate) : 1;
  for (let i = 0; i < capture.length; i++) {
    const delayed = sample(render, i - .08 * rate);
    filtered += alpha * (delayed - filtered);
    seed = (1664525 * seed + 1013904223) >>> 0;
    const ambient = noise ? .004 * Math.sin(2 * Math.PI * 120 * i / rate) + .002 * (seed / 2147483648 - 1) : 0;
    capture[i] = gain * filtered + own[i] + ambient;
  }
  const messages = [], detector = new RhythmDetector(rate, message => messages.push(message));
  detector.configure({ type: 'mode', value: 'sustained' });
  detector.configure({ type: 'threshold', value: 10 ** (-48 / 20) });
  detector.configure({ type: 'arm', start: .25, duration: 2.4 });
  detector.configure({ type: 'reference-sync', enabled: true, id: 1, backing: true, routed: true });
  if (diagnosticOpen) {
    // This counterfactual still uses EchoAttribution for every emitted attack.
    // It changes only the all-or-nothing prerequisite for source audition.
    const original = detector.reference.analysisInfo.bind(detector.reference);
    detector.reference.analysisInfo = () => {
      const info = original();
      return { ...info, ready: info.ready || info.referencePresent && detector.reference.total / rate >= .6 };
    };
  }
  for (let i = 0; i < capture.length; i += 128) detector.process(capture.subarray(i, i + 128), i / rate, missingReference ? undefined : render.subarray(i, i + 128));
  const onsets = messages.filter(message => message.type === 'onset' && message.time >= .6);
  const analysis = messages.filter(message => message.type === 'analysis-state');
  const acoustic = messages.filter(message => message.type === 'acoustic-sync');
  return { onsets, analysis, acoustic, info: detector.reference.analysisInfo(), rejected: detector.attribution.rejected, accepted: detector.attribution.accepted };
}

function ownCase(name, config) {
  const expected = config.times ?? lateTimes, audio = run(config);
  const missing = expected.filter(time => !audio.onsets.some(hit => Math.abs(hit.time - time) < .12));
  const unexpected = audio.onsets.filter(hit => !expected.some(time => Math.abs(hit.time - time) < .12));
  results.push({ name, status: !missing.length && !unexpected.length && audio.onsets.length === expected.length ? 'PASS' : 'FAIL', evidence: {
    expected, detected: audio.onsets.map(hit => Number(hit.time.toFixed(4))), missing,
    unexpected: unexpected.map(hit => Number(hit.time.toFixed(4))), ...audio.info,
    absoluteLockCount: audio.acoustic.filter(message => message.status === 'locked').length,
    lastAnalysis: audio.analysis.at(-1) ?? null,
  }});
}

function backingCase(name, config) {
  const audio = run({ ...config, times: [] });
  results.push({ name, status: !audio.onsets.length ? 'PASS' : 'FAIL', evidence: {
    detected: audio.onsets.map(hit => Number(hit.time.toFixed(4))), ...audio.info,
    rejected: audio.rejected, accepted: audio.accepted,
  }});
}

ownCase('Headphones with ordinary fan and microphone noise still recognize four notes', {});
ownCase('Playing before silent-room preparation completes recognizes all six attacks', { times: earlyTimes, noise: false });
ownCase('Playing immediately over weak speaker leakage and room noise recognizes six attacks', { times: earlyTimes, gain: .09 });
ownCase('Muffled speaker hats preserve four independent instrument attacks', { kind: 'hats', gain: .9, cutoff: 500 });
ownCase('Very quiet instrument over room noise remains detectable', { amplitude: .025 });
backingCase('Ambient noise and weak actual backing never produce player points', { gain: .09 });
backingCase('Causal lowpass speaker EQ of the actual hats master never produces player points', { kind: 'hats', gain: .9, cutoff: 500 });
backingCase('Quiet headphones do not manufacture player points', { gain: 0 });
backingCase('Missing reference input blocks microphone scoring', { missingReference: true, gain: .55 });

const missing = run({ missingReference: true });
results.push({ name: 'Missing reference blocks even genuine notes until source audition is possible', status: !missing.onsets.length && !missing.info.canAudit && !missing.info.referencePresent ? 'PASS' : 'FAIL', evidence: { detected: missing.onsets.length, ...missing.info } });
const passed = results.filter(result => result.status === 'PASS').length;
console.log(JSON.stringify({ target, diagnosticOpen, passed, failed: results.length - passed, scope: 'Synthetic PCM through the real detector; no physical microphone verification.', results }, null, 2));
Deno.exitCode = passed === results.length ? 0 : 1;
