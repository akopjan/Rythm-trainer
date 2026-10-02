// Echo separation scoring contract QA using actual app DSP and independent DOM/audio doubles.
// No microphone, physical sound, browser download or real localStorage access.
const target = Deno.args[0] ?? 'index.html';
const html = await Deno.readTextFile(target);
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const results = [];
const record = (name, ok, evidence = {}) => results.push({name, status: ok ? 'PASS' : 'FAIL', evidence});
const close = (a, b, epsilon = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= epsilon;
const settingsKey = 'rhythm-trainer.settings.v1';
const Detector = new Function(scripts[0] + ';return RhythmDetector;')();

function storageDouble(initial = {}, blockedRead = false, blockedWrite = false) {
  const values = new Map(Object.entries(initial)), writes = [];
  return {values, writes, getItem(key) {if (blockedRead) throw new Error('Storage disabled');return values.get(key) ?? null;}, setItem(key, value) {if (blockedWrite) throw new Error('Quota/security failure');writes.push({key, value});values.set(key, value);}};
}

function cookieDouble(initial = {}, blockedRead = false, blockedWrite = false) {
  const values = new Map(Object.entries(initial)), writes = [];
  return {values, writes, read() {if (blockedRead) throw new Error('Cookie reads blocked');return [...values].map(([name, value]) => name + '=' + value).join('; ');}, write(assignment) {writes.push(assignment);if (blockedWrite) return;const pair = assignment.split(';', 1)[0], separator = pair.indexOf('='), name = pair.slice(0, separator), value = pair.slice(separator + 1);if (/max-age=0(?:;|$)/i.test(assignment)) values.delete(name);else values.set(name, value);}};
}

const clockEpoch = 1700000000000;
function createApp(storage = storageDouble(), options = {}) {
  let nextId = 1, now = 0;
  const protocol = options.protocol ?? 'file:', cookies = options.cookies ?? cookieDouble();
  const location = {protocol, href: protocol === 'file:' ? 'file:///index.html' : protocol + '//trainer.example/index.html'};
  const micRequests = [], streams = [], nodes = [], worklets = [];
  const elements = new Map(), timers = new Map(), intervals = new Map(), frames = new Map(), scheduled = [], contexts = [], blobs = new Map(), revoked = [], downloads = [], windowListeners = {};
  class Element {
    constructor(tagName = 'DIV') {
      this.tagName = tagName;this.value = '';this.checked = false;this.disabled = false;this.children = [];this.listeners = {};this.dataset = {};this.attributes = {};this.className = '';this.textContent = '';this.innerHTML = '';this.files = [];
      this.style = {setProperty(name, value) {this[name] = value;}};
      this.classList = {contains: name => this.className.split(' ').includes(name), toggle: (name, force) => {const names = new Set(this.className.split(' ').filter(Boolean)), enabled = force ?? !names.has(name);if (enabled) names.add(name);else names.delete(name);this.className = [...names].join(' ');return enabled;}, remove: name => this.classList.toggle(name, false)};
    }
    append(...children) {for (const child of children) {this.children.push(child);if (child && typeof child === 'object') child.parentElement = this;}}
    replaceChildren(...children) {this.children = [];this.append(...children);}
    setAttribute(key, value) {this.attributes[key] = String(value);}
    addEventListener(type, callback) {(this.listeners[type] ??= []).push(callback);}
    async fire(type, event = {}) {for (const callback of this.listeners[type] ?? []) await callback({target: this, ...event});}
    querySelector(tag) {return descendants(this).find(child => child.tagName === tag.toUpperCase());}
    getBoundingClientRect() {return {width: 850, height: 290};}
    focus() {doc.activeElement = this;}
    click() {if (this.tagName === 'A') downloads.push({href: this.href, filename: this.download, blob: blobs.get(this.href)});return this.fire('click');}
    remove() {if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);this.removed = true;}
  }
  const descendants = root => root.children.flatMap(child => child && typeof child === 'object' ? [child, ...descendants(child.children ? child : {children: []})] : []);
  const el = id => elements.get(id);
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1].toUpperCase()), attributes = match[2];element.id = match[3];element.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '';element.checked = /\bchecked\b/.test(attributes);elements.set(element.id, element);
  }
  for (const [id, value] of [['bars', '1'], ['division', '8'], ['signature', '4'], ['input-mode', 'sustained']]) el(id).value = value;
  el('rhythm-dsp').textContent = scripts[0];el('start').append(new Element('SPAN'), new Element('PATH'));el('chart').parentElement = new Element();el('meter').parentElement = new Element();
  const painter = Object.fromEntries(['scale', 'fillRect', 'beginPath', 'setLineDash', 'moveTo', 'lineTo', 'stroke', 'fillText', 'arc', 'fill'].map(name => [name, () => {}]));el('chart').getContext = () => painter;
  const doc = {
    hidden: false, activeElement: null, location, body: new Element('BODY'), listeners: {}, getElementById: el, createElement: tag => new Element(tag.toUpperCase()), createTextNode: text => ({textContent: text}),
    querySelectorAll(selector) {
      const all = [...elements.values(), ...descendants(el('sequencer')), ...descendants(this.body)];
      return [...new Set(all)].filter(element => selector.split(',').some(part => {
        if (part.startsWith('.')) return element.classList?.contains(part.slice(1));
        const attribute = part.match(/^\[data-(.+)\]$/)?.[1];
        return attribute ? attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in (element.dataset ?? {}) : false;
      }));
    },
    addEventListener(type, callback) {(this.listeners[type] ??= []).push(callback);},
    fire(type, event = {}) {for (const callback of this.listeners[type] ?? []) callback(event);},
  };
  Object.defineProperty(doc, 'cookie', {get: () => cookies.read(), set: assignment => {if (protocol === 'http:' || protocol === 'https:') cookies.write(assignment);}});
  class AudioNode {
    constructor(kind = 'node') {this.kind = kind;this.connections = [];this.disconnected = false;nodes.push(this);}
    connect(destination, output = 0, input = 0) {this.connections.push({destination, output, input});return destination;}
    disconnect() {this.disconnected = true;}
  }
  class FakeContext {
    constructor() {this.currentTime = 0;this.sampleRate = options.rate ?? 48000;this.state = 'running';this.destination = {kind: 'destination'};this.baseLatency = 0;if (options.worklet) this.audioWorklet = {addModule: async () => {if (options.workletSetup) await options.workletSetup();if (options.workletFailure) throw new Error('Worklet unavailable');}};contexts.push(this);}
    async resume() {}
    async close() {this.state = 'closed';}
    createGain() {const node = new AudioNode('gain');node.gain = {value: 0, changes: [], setTargetAtTime(value, time, constant) {this.value = value;this.changes.push({value, time, constant});}};return node;}
    createMediaStreamSource() {return new AudioNode('microphone');}
    createScriptProcessor(bufferSize, inputChannels, outputChannels) {return Object.assign(new AudioNode('script-processor'), {bufferSize, inputChannels, outputChannels});}
    createChannelMerger(inputs = 6) {return Object.assign(new AudioNode('merger'), {numberOfInputs: inputs});}
    createBuffer(channels, length, rate) {const pcm = new Float32Array(length);return {duration: length / rate, getChannelData: () => pcm};}
    createBufferSource() {const node = new AudioNode('buffer-source');node.start = when => {node.when = when;scheduled.push(node);};node.stop = () => {node.stopped = true;};return node;}
  }
  const fakeStream = requested => {
    const track = {readyState: 'live', stopped: false, listeners: {}, constraints: [], getSettings: () => ({echoCancellation: options.reportedAEC ?? requested.audio.echoCancellation}), getCapabilities: () => ({echoCancellation: [true, false, 'all']}), async applyConstraints(value) {this.constraints.push(value);}, addEventListener(type, callback) {this.listeners[type] = callback;}, stop() {this.readyState = 'ended';this.stopped = true;}};
    const stream = {track, getAudioTracks: () => [track], getTracks: () => [track]};streams.push(stream);return stream;
  };
  class FakeWorkletNode extends AudioNode {
    constructor(ctx, name, config) {super('worklet');this.context = ctx;this.processorName = name;this.config = config;this.messages = [];this.port = {onmessage: null, postMessage: message => this.messages.push(message)};worklets.push(this);}
  }
  const timeout = (callback, delay = 0) => {const id = nextId++;timers.set(id, {callback, due: now + delay});return id;};
  const win = {AudioWorkletNode: options.worklet ? FakeWorkletNode : undefined, AudioContext: FakeContext, devicePixelRatio: 1, location, localStorage: storage, setTimeout: timeout, clearTimeout: id => timers.delete(id), addEventListener(type, callback) {(windowListeners[type] ??= []).push(callback);}};
  const urls = {createObjectURL(blob) {const url = 'blob:test-' + nextId++;blobs.set(url, blob);return url;}, revokeObjectURL(url) {revoked.push(url);blobs.delete(url);}};
  const fakePerformance = {now: () => now, timeOrigin: 1700000000000};
  const api = new Function('document', 'window', 'navigator', 'RhythmDetector', 'performance', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'Blob', 'URL', 'setTimeout', 'location', 'Date', 'AudioWorkletNode', scripts[1] + `;return {state,pattern,start,stop,schedule,addHit,handleDSP,updateStats,clearResults,normalizeLatency,measureLatency,applyLatencyCorrection,summarizeBars,applySettings,captureSettings,saveSettings,flushSettings,importSettings,exportSettings,renderGrid,setControls,getContext:()=>context,getProcessor:()=>processor,getSource:()=>source,getSilent:()=>silent,getFallback:()=>fallback,getTrackGains:()=>trackGains,getClickGain:()=>clickGain,getMaster:()=>master,getBuffers:()=>buffers,getClickBuffers:()=>clickBuffers};`)(doc, win, {mediaDevices: {getUserMedia: async requested => {micRequests.push(requested);if (options.getUserMedia) return await options.getUserMedia(requested, fakeStream);return fakeStream(requested);}}}, Detector, fakePerformance, class {observe() {}}, callback => {const id = nextId++;frames.set(id, callback);return id;}, id => frames.delete(id), callback => {const id = nextId++;intervals.set(id, callback);return id;}, id => intervals.delete(id), Blob, urls, timeout, location, {now: () => clockEpoch + now}, FakeWorkletNode);
  return {api, el, doc, win, storage, cookies, scheduled, contexts, nodes, micRequests, streams, worklets, timers, intervals, frames, downloads, revoked,
    async advance(milliseconds) {const end = now + milliseconds;while (true) {const due = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];if (!due) break;now = due[1].due;timers.delete(due[0]);await due[1].callback();}now = end;},
    async pagehide() {for (const callback of windowListeners.pagehide ?? []) await callback();},
    trackEnabled(row) {return doc.querySelectorAll('[data-track-enabled]').find(element => Number(element.dataset.trackEnabled) === row);},
    trackVolume(row) {return doc.querySelectorAll('[data-track-volume]').find(element => Number(element.dataset.trackVolume) === row);},
    cell(row, step) {return doc.querySelectorAll('.step').find(element => Number(element.dataset.row) === row && Number(element.dataset.step) === step);},
  };
}

function fileFor(value, size) {const text = typeof value === 'string' ? value : JSON.stringify(value);return {size: size ?? new TextEncoder().encode(text).length, text: async () => text};}
function chooseFile(app, file) {app.el('settings-file').files = [file];return app.api.importSettings();}
function deferred() {let resolve, reject;const promise = new Promise((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
async function check(name, run) {try {const evidence = await run();record(name, evidence.ok, evidence);} catch (error) {record(name, false, {error: error.message, stack: error.stack?.split('\n').slice(0, 3)});}}

const connected = (from, to, input) => from?.connections.some(edge => edge.destination === to && (input === undefined || edge.input === input));
const numericStat = element => Number(element.innerHTML.replace(/<[^>]*>/g, '').replace(',', '.').replace(/[^0-9+.-]/g, ''));
const acoustic = (app, delayMs, extra = {}) => app.api.handleDSP({type: 'acoustic-sync', id: app.api.state.token, status: 'locked', delayMs, confidence: .95, time: app.api.getContext()?.currentTime ?? 0, ...extra});
const outputConfiguration = app => app.worklets.at(-1)?.messages.filter(message => message.type === 'reference-sync').at(-1);
const noRouteTo = (start, target, visited = new Set()) => {
  if (start === target) return false;
  if (!start || visited.has(start)) return true;
  visited.add(start);
  return (start.connections ?? []).every(edge => noRouteTo(edge.destination, target, visited));
};
const primeClock = app => {app.api.getContext().currentTime = app.api.state.epoch + .1;};


async function runRecognition({ambientRms = 0, gain = .5, player = false, sparse = true, routed = true, kind = 'mixed', earlyPlayer = false, delay = .315, duration = 12} = {}) {
  const rate = 8000, length = Math.ceil(rate * duration), app = createApp(undefined, {rate, worklet: true});
  if (kind === 'metronome') app.api.applySettings({pattern: [], click: true});
  await app.api.start();
  const ctx = app.api.getContext(), epoch = app.api.state.epoch, master = app.api.getMaster(), rendered = new Float32Array(length), capture = new Float32Array(length), delaySamples = Math.round(delay * rate), messages = [];
  let Processor;
  class ProcessorBase {constructor() {this.port = {postMessage: message => {messages.push({...message});app.api.handleDSP(message);}};}}
  const clockHarness = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentFrame', scripts[0] + ';return {setFrame:value=>{currentFrame=value;}};')(ProcessorBase, (name, constructor) => {if (name === 'rhythm-detector') Processor = constructor;}, rate, 0);
  const wrapper = new Processor();
  for (const message of app.worklets.at(-1).messages) wrapper.port.onmessage({data: message.type === 'reference-sync' ? {...message, routed} : message});
  const playerTimes = player ? Array.from({length: 5}, (_, i) => epoch + ((earlyPlayer ? 2 : 20) + i * 2) * .3 + delay) : [];
  let sourceIndex = 0, emptyReferenceQuanta = 0, rawPeakMeter = 0, speakerOutputPeak = 0;
  for (let first = 0;first < length;first += 128) {
    ctx.currentTime = first / rate;app.api.schedule();clockHarness.setFrame(first);
    for (;sourceIndex < app.scheduled.length;sourceIndex++) {
      const source = app.scheduled[sourceIndex], pcm = source.buffer.getChannelData(0), outputGain = source.connections[0].destination, outputLevel = outputGain === master ? master.gain.value : outputGain.gain.value * master.gain.value, offset = Math.round(source.when * rate);
      for (let i = 0;i < pcm.length && offset + i < rendered.length;i++) rendered[offset + i] += pcm[i] * outputLevel;
    }
    const end = Math.min(length, first + 128);
    for (let i = first;i < end;i++) {
      const time = i / rate;let near = 0;
      for (let note = 0;note < playerTimes.length;note++) {
        const dt = time - playerTimes[note];if (dt < 0 || dt > .44) continue;
        const frequency = [220, 293.66, 329.63, 246.94][note % 4], envelope = Math.min(1, dt / .018) * Math.min(1, (.44 - dt) / .035);
        near += .14 * envelope * (Math.sin(2 * Math.PI * frequency * time) + .32 * Math.sin(4 * Math.PI * frequency * time) + .19 * Math.sin(6 * Math.PI * frequency * time));
      }
      capture[i] = (i >= delaySamples ? rendered[i - delaySamples] * gain : 0) + near + ambientRms * Math.SQRT2 * Math.sin(2 * Math.PI * 60 * time);
    }
    const reference = rendered.subarray(first, end), empty = !routed || sparse && reference.every(value => value === 0), output = new Float32Array(end - first).fill(.91);
    if (empty) emptyReferenceQuanta++;
    wrapper.process([[capture.subarray(first, end)], empty ? [] : [reference]], [[output]]);
    speakerOutputPeak = Math.max(speakerOutputPeak, ...output.map(Math.abs));rawPeakMeter = Math.max(rawPeakMeter, Number.parseFloat(app.el('meter').style.width) || 0);
  }
  const times = app.api.state.attacks.map(hit => hit.rawMs / 1000 + epoch), matched = playerTimes.map(time => times.filter(hit => Math.abs(hit - time) < .12)), unmatched = times.filter(hit => !playerTimes.some(time => Math.abs(hit - time) < .12));
  const evidence = {count: times.length, expectedPlayerTimes: playerTimes, attackTimes: times, matchedPlayerAttacks: matched.map(matches => matches.length), unmatchedAttackTimes: unmatched, emptyReferenceQuanta, rawPeakMeter, speakerOutputPeak, routed, isolationStatus: app.api.state.isolation.status, referenceLocked: app.api.state.reference.locked, normalizationMs: Number(app.el('latency').value), status: app.el('status').textContent};
  app.api.stop();return evidence;
}

await check('The real worklet keeps playing in ideal headphones with continuous silent reference quanta', async () => {
  const evidence = await runRecognition({gain: 0, delay: 0, player: true, sparse: false});return {...evidence, ok: evidence.count === 5 && evidence.matchedPlayerAttacks.every(count => count === 1) && evidence.speakerOutputPeak === 0};
});
await check('The real worklet preserves noisy headphone playing when reference inputs are empty between sources', async () => {
  const evidence = await runRecognition({gain: 0, delay: 0, player: true, ambientRms: .002});return {...evidence, ok: evidence.count === 5 && evidence.matchedPlayerAttacks.every(count => count === 1) && evidence.emptyReferenceQuanta > 0 && evidence.speakerOutputPeak === 0 && !evidence.referenceLocked};
});
await check('The real worklet preserves early noisy headphone playing without waiting for three seconds of absolute silence', async () => {
  const evidence = await runRecognition({gain: 0, delay: 0, player: true, ambientRms: .002, earlyPlayer: true});return {...evidence, ok: evidence.count === 5 && evidence.matchedPlayerAttacks.every(count => count === 1) && evidence.unmatchedAttackTimes.length === 0};
});
await check('Empty worklet reference quanta between drums do not turn backing-only echo into player attacks', async () => {
  const evidence = await runRecognition();return {...evidence, ok: evidence.count === 0 && evidence.emptyReferenceQuanta > 0 && evidence.speakerOutputPeak === 0};
});
await check('Empty worklet reference quanta between drums preserve all five coincident instrument attacks', async () => {
  const evidence = await runRecognition({player: true});return {...evidence, ok: evidence.count === 5 && evidence.matchedPlayerAttacks.every(count => count === 1) && evidence.unmatchedAttackTimes.length === 0 && Math.abs(evidence.normalizationMs - 315) < 5};
});
await check('Empty worklet reference quanta between metronome clicks never add player points', async () => {
  const evidence = await runRecognition({kind: 'metronome'});return {...evidence, ok: evidence.count === 0 && evidence.emptyReferenceQuanta > 0};
});
await check('An explicitly unavailable worklet reference route never permits backing-only scoring', async () => {
  const evidence = await runRecognition({routed: false});return {...evidence, ok: evidence.count === 0 && evidence.isolationStatus === 'blocked' && evidence.rawPeakMeter > 10};
});
await check('An unavailable worklet reference route does not silently mark instrument events as isolated', async () => {
  const evidence = await runRecognition({routed: false, player: true, gain: 0, ambientRms: .002});return {...evidence, ok: evidence.count === 0 && evidence.isolationStatus === 'blocked' && evidence.rawPeakMeter > 10};
});

await check('The first hardware anchor does not discard an already isolated note queued earlier in the current session', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();
  const id = app.api.state.token, onsetTime = app.api.state.epoch + .9, anchorTime = app.api.state.epoch + 1.2;
  app.api.getContext().currentTime = anchorTime;
  app.api.handleDSP({type: 'acoustic-sync', id, status: 'locked', delayMs: 80, confidence: .95, time: anchorTime});
  app.api.handleDSP({type: 'onset', id, source: 'instrument', isolated: true, time: onsetTime, level: .2});
  const evidence = {ok: app.api.state.count === 1 && app.api.state.reference.locked && close(app.api.state.attacks[0]?.rawMs, (onsetTime - app.api.state.epoch) * 1000), count: app.api.state.count, onsetTime, anchorTime, rawMs: app.api.state.attacks[0]?.rawMs, correctionMs: app.api.state.attacks[0]?.correctionMs, session: id};app.api.stop();return evidence;
});

const summary = {target, passed: results.filter(result => result.status === 'PASS').length, failed: results.filter(result => result.status === 'FAIL').length, scope: 'Actual AudioWorklet wrapper, app routing messages and synthetic acoustic PCM; sparse [] reference inputs model the Web Audio inactive-input contract. No physical microphone.', results};
console.log(JSON.stringify(summary, null, 2));
Deno.exitCode = summary.failed ? 1 : 0;
