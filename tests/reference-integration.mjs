// Reference-input integration QA with independent DOM, storage, graph and PCM doubles.
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
    querySelectorAll(tag) {return descendants(this).filter(child => child.tagName === tag.toUpperCase());}
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
  const api = new Function('document', 'window', 'navigator', 'RhythmDetector', 'performance', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'Blob', 'URL', 'setTimeout', 'location', 'Date', 'AudioWorkletNode', scripts[1] + `;return {state,pattern,start,stop,schedule,addHit,handleDSP,updateStats,clearResults,normalizeLatency,measureLatency,applyLatencyCorrection,summarizeBars,applySettings,captureSettings,saveSettings,flushSettings,exportSettings,renderGrid,setControls,getContext:()=>context,getProcessor:()=>processor,getSource:()=>source,getSilent:()=>silent,getFallback:()=>fallback,getTrackGains:()=>trackGains,getClickGain:()=>clickGain,getMaster:()=>master,getBuffers:()=>buffers,getClickBuffers:()=>clickBuffers};`)(doc, win, {mediaDevices: {getUserMedia: async requested => {micRequests.push(requested);if (options.getUserMedia) return await options.getUserMedia(requested, fakeStream);return fakeStream(requested);}}}, Detector, fakePerformance, class {observe() {}}, callback => {const id = nextId++;frames.set(id, callback);return id;}, id => frames.delete(id), callback => {const id = nextId++;intervals.set(id, callback);return id;}, id => intervals.delete(id), Blob, urls, timeout, location, {now: () => clockEpoch + now}, FakeWorkletNode);
  return {api, el, doc, win, storage, cookies, scheduled, contexts, nodes, micRequests, streams, worklets, timers, intervals, frames, downloads, revoked,
    async advance(milliseconds) {const end = now + milliseconds;while (true) {const due = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];if (!due) break;now = due[1].due;timers.delete(due[0]);await due[1].callback();}now = end;},
    async pagehide() {for (const callback of windowListeners.pagehide ?? []) await callback();},
    trackEnabled(row) {return doc.querySelectorAll('[data-track-enabled]').find(element => Number(element.dataset.trackEnabled) === row);},
    trackVolume(row) {return doc.querySelectorAll('[data-track-volume]').find(element => Number(element.dataset.trackVolume) === row);},
    cell(row, step) {return doc.querySelectorAll('.step').find(element => Number(element.dataset.row) === row && Number(element.dataset.step) === step);},
  };
}

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

await check('Reference synchronization is enabled by default and included in the settings snapshot', () => {
  const app = createApp();
  return {ok: app.el('reference-sync')?.checked === true && app.api.captureSettings().referenceSync === true, selected: app.api.captureSettings().referenceSync};
});

await check('Disabling the reference path persists and restores independently of auto normalization', async () => {
  const storage = storageDouble(), first = createApp(storage);
  first.el('reference-sync').checked = false;await first.el('reference-sync').fire('change');first.api.flushSettings();
  const second = createApp(storage), snapshot = second.api.captureSettings();
  return {ok: snapshot.referenceSync === false && second.el('reference-sync').checked === false && snapshot.autoNormalize === true, referenceSync: snapshot.referenceSync, autoNormalize: snapshot.autoNormalize};
});

await check('An older settings snapshot without a reference flag safely enables the new default', () => {
  const app = createApp(storageDouble({[settingsKey]: JSON.stringify({version: 1, bpm: 137, click: false, pattern: []})}));
  return {ok: app.api.captureSettings().referenceSync === true && app.api.state.bpm === 137 && app.api.pattern.every(row => row.every(value => !value)), bpm: app.api.state.bpm};
});

await check('JSON settings export and direct restoration preserve an explicit disabled reference choice', async () => {
  const first = createApp();first.api.applySettings({referenceSync: false});first.api.exportSettings();
  const exported = JSON.parse(await first.downloads[0].blob.text()), second = createApp();second.api.applySettings(exported);
  return {ok: exported.referenceSync === false && second.api.captureSettings().referenceSync === false && !second.el('reference-sync').checked, referenceSync: exported.referenceSync};
});

await check('Raw reference mode requests AEC off and preserves automatic gain/noise controls off', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();
  const request = app.micRequests[0]?.audio, constraints = app.streams[0]?.track.constraints;
  const evidence = {ok: app.api.state.running && request.echoCancellation === false && request.noiseSuppression === false && request.autoGainControl === false && !constraints.some(value => value.echoCancellation === 'all'), request, constraintCount: constraints.length};app.api.stop();return evidence;
});

await check('AudioWorklet gets microphone input zero and the complete master reference input one', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();
  const processor = app.api.getProcessor(), source = app.api.getSource(), master = app.api.getMaster();
  const evidence = {ok: processor.config.numberOfInputs === 2 && connected(source, processor, 0) && connected(master, processor, 1) && connected(master, app.api.getContext().destination), inputs: processor.config.numberOfInputs, microphoneInputs: source.connections.map(edge => edge.input), masterInputs: master.connections.map(edge => edge.input)};app.api.stop();return evidence;
});

await check('Reference configuration is tagged with the current session and initial latency', async () => {
  const app = createApp(undefined, {worklet: true});app.api.applySettings({latency: 73});await app.api.start();
  const message = outputConfiguration(app);
  const evidence = {ok: message?.enabled === true && message.id === app.api.state.token && close(message.delayMs, 73) && close(message.stepMs, 300), message};app.api.stop();return evidence;
});

await check('ScriptProcessor fallback keeps microphone and master on separate merger channels', async () => {
  const app = createApp();await app.api.start();
  const processor = app.api.getProcessor(), merger = app.nodes.find(node => node.kind === 'merger'), source = app.api.getSource(), master = app.api.getMaster();
  const evidence = {ok: processor.kind === 'script-processor' && processor.inputChannels === 2 && merger.numberOfInputs === 2 && connected(source, merger, 0) && connected(master, merger, 1) && connected(merger, processor), inputChannels: processor.inputChannels, mergerInputs: merger.numberOfInputs};app.api.stop();return evidence;
});

await check('Fallback forwards paired PCM blocks to DSP and writes zero to the speaker output', async () => {
  const app = createApp();await app.api.start();
  const captured = [], detector = app.api.getFallback(), processor = app.api.getProcessor(), mic = Float32Array.from({length: 512}, (_, i) => .1 + i / 10000), reference = Float32Array.from({length: 512}, (_, i) => -.2 - i / 10000), output = new Float32Array(512).fill(.9);
  detector.process = (...args) => captured.push(args);
  processor.onaudioprocess({playbackTime: 1, inputBuffer: {duration: 512 / 48000, numberOfChannels: 2, getChannelData: channel => channel === 0 ? mic : reference}, outputBuffer: {numberOfChannels: 1, getChannelData: () => output}});
  const evidence = {ok: captured.length === 4 && captured.every((args, i) => args[0][0] === mic[i * 128] && args[2]?.[0] === reference[i * 128] && close(args[1], 1 - 512 / 48000 + i * 128 / 48000)) && output.every(value => value === 0), blockCount: captured.length, outputPeak: Math.max(...output.map(Math.abs))};app.api.stop();return evidence;
});

await check('Failed AudioWorklet setup falls back to the same separate reference merger', async () => {
  const app = createApp(undefined, {worklet: true, workletFailure: true});await app.api.start();
  const merger = app.nodes.find(node => node.kind === 'merger'), processor = app.api.getProcessor();
  const evidence = {ok: app.api.state.running && app.api.getFallback() !== null && processor.kind === 'script-processor' && connected(app.api.getMaster(), merger, 1) && connected(app.api.getSource(), merger, 0), fallback: !!app.api.getFallback()};app.api.stop();return evidence;
});

for (const worklet of [false, true]) await check(`${worklet ? 'AudioWorklet' : 'Fallback'} never routes microphone audio to the drum master`, async () => {
  const app = createApp(undefined, {worklet});await app.api.start();
  const source = app.api.getSource(), silent = app.api.getSilent(), processor = app.api.getProcessor(), destination = app.api.getContext().destination;
  const evidence = {ok: noRouteTo(source, app.api.getMaster()) && !connected(source, destination) && connected(processor, silent) && close(silent.gain.value, 0) && connected(silent, destination), microphoneEdges: source.connections.length, monitorGain: silent.gain.value};app.api.stop();return evidence;
});

await check('With delay tracking off browser AEC remains requested while mandatory reference isolation stays routed', async () => {
  const app = createApp(undefined, {worklet: true});app.api.applySettings({referenceSync: false});await app.api.start();
  const request = app.micRequests[0].audio, config = outputConfiguration(app), constraints = app.streams[0].track.constraints;
  const evidence = {ok: app.api.state.running && request.echoCancellation === true && config?.enabled === true && config?.trackDelay === false && config?.routed === true && connected(app.api.getMaster(), app.api.getProcessor(), 1) && constraints.some(value => value.echoCancellation === 'all'), requestedAEC: request.echoCancellation, config};app.api.stop();return evidence;
});

await check('A browser retaining AEC cannot enable raw acoustic subtraction or overwrite the correction', async () => {
  const app = createApp(undefined, {worklet: true, reportedAEC: true});app.api.applySettings({latency: 44});await app.api.start();acoustic(app, 220);
  const config = outputConfiguration(app);
  const evidence = {ok: !app.api.state.running && config?.enabled !== true && close(Number(app.el('latency').value), 44) && app.streams[0].track.stopped && app.contexts[0].state === 'closed' && app.el('status').textContent.includes('эхоподавление'), appliedReference: config?.enabled, correction: Number(app.el('latency').value), message: app.el('status').textContent};app.api.stop();return evidence;
});

await check('Reference choice is locked during both capture preparation and active transport', async () => {
  const pending = deferred(), app = createApp(undefined, {getUserMedia: async (request, makeStream) => {await pending.promise;return makeStream(request);}});
  const starting = app.api.start();await Promise.resolve();const duringPreparation = app.el('reference-sync').disabled;
  pending.resolve();await starting;const duringPlayback = app.el('reference-sync').disabled;app.api.stop();
  return {ok: duringPreparation && duringPlayback && !app.el('reference-sync').disabled, duringPreparation, duringPlayback};
});

await check('A reliable absolute 220 ms acoustic anchor cannot be replaced by an eighth-note alias', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();primeClock(app);acoustic(app, 220);
  const correction = Number(app.el('latency').value);app.api.addHit(app.api.state.epoch + .6 + .220, 'mic');
  const hit = app.api.state.attacks.at(-1);
  const evidence = {ok: close(correction, 220, .001) && app.api.state.reference?.locked === true && close(hit.error, 0, .001) && hit.step === 2 && hit.cycle === 0, correction, reference: app.api.state.reference, hit: {...hit}};app.api.stop();return evidence;
});

await check('An acoustic microphone correction never shifts keyboard attacks or their target step', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();primeClock(app);acoustic(app, 220);
  app.api.addHit(app.api.state.epoch + .6 + .020, 'key');const hit = app.api.state.attacks.at(-1);
  const evidence = {ok: close(hit.error, 20, .001) && hit.correctionMs === 0 && hit.step === 2 && app.api.state.adaptive.samples.length === 0, hit: {...hit}, learnerSamples: app.api.state.adaptive.samples.length};app.api.stop();return evidence;
});

await check('Unproven DSP onsets stay excluded after the preparation timeout while isolated instrument notes remain scoreable', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();
  const until = app.api.state.reference.waitUntil;app.api.handleDSP({type: 'onset', id: app.api.state.token, time: app.api.state.epoch + 1, level: .2});const provisionalCount = app.api.state.count;
  app.api.getContext().currentTime = until + .3;app.api.handleDSP({type: 'onset', id: app.api.state.token, time: until + .3, level: .2});const afterTimeoutCount = app.api.state.count;
  app.api.handleDSP({type: 'analysis-state', id: app.api.state.token, time: until + .3, status: 'ready'});app.api.handleDSP({type: 'onset', id: app.api.state.token, time: until + .3, level: .2, source: 'instrument', isolated: true});
  const evidence = {ok: until > app.api.state.epoch && provisionalCount === 0 && afterTimeoutCount === 0 && app.api.state.count === 1, waitSeconds: until - app.api.state.epoch, provisionalCount, afterTimeoutCount, provenInstrumentCount: app.api.state.count};app.api.stop();return evidence;
});

for (const [label, extra] of [
  ['unavailable', {status: 'unavailable'}], ['ambiguous', {status: 'ambiguous'}], ['low confidence', {confidence: .3}], ['NaN confidence', {confidence: NaN}], ['oversized confidence', {confidence: 1.1}], ['NaN delay', {delayMs: NaN}], ['infinite delay', {delayMs: Infinity}], ['negative delay', {delayMs: -80}], ['oversized delay', {delayMs: 501}], ['invalid clock', {time: NaN}], ['wrong session', {id: -1}],
]) await check(`An ${label} acoustic result cannot force an unsupported latency guess`, async () => {
  const app = createApp(undefined, {worklet: true});app.api.applySettings({latency: 41, autoNormalize: false});await app.api.start();primeClock(app);acoustic(app, 220, extra);
  const evidence = {ok: close(Number(app.el('latency').value), 41) && app.api.state.reference?.locked !== true, correction: Number(app.el('latency').value), reference: app.api.state.reference};app.api.stop();return evidence;
});

await check('Older reference timestamps cannot overwrite a newer reliable anchor', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();primeClock(app);acoustic(app, 80, {time: 2});const correction = Number(app.el('latency').value), lastTime = app.api.state.reference.lastTime;
  acoustic(app, 220, {time: 1.9});
  const evidence = {ok: close(Number(app.el('latency').value), correction) && app.api.state.reference.lastTime === lastTime, correction, lastTime};app.api.stop();return evidence;
});

await check('A conflicting duplicate reference timestamp cannot silently change the hardware anchor', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();primeClock(app);acoustic(app, 80, {time: 2});
  const correction = Number(app.el('latency').value), delayMs = app.api.state.reference.delayMs, anchorMs = app.api.state.adaptive.anchorMs;
  acoustic(app, 220, {time: 2});
  const evidence = {ok: close(Number(app.el('latency').value), correction) && close(app.api.state.reference.delayMs, delayMs) && close(app.api.state.adaptive.anchorMs, anchorMs), correction: Number(app.el('latency').value), reportedDelay: app.api.state.reference.delayMs, trackerAnchor: app.api.state.adaptive.anchorMs};app.api.stop();return evidence;
});

await check('Stopping capture invalidates even an otherwise reliable queued acoustic result', async () => {
  const app = createApp(undefined, {worklet: true});app.api.applySettings({latency: 31});await app.api.start();const id = app.api.state.token;app.api.stop();acoustic(app, 220, {id, time: 10});
  return {ok: !app.api.state.running && close(Number(app.el('latency').value), 31) && app.streams[0].track.stopped && app.contexts[0].state === 'closed', correction: Number(app.el('latency').value)};
});

await check('A result queued by an old context cannot change a subsequent session', async () => {
  const app = createApp(undefined, {worklet: true});app.api.applySettings({latency: 31});await app.api.start();const oldId = app.api.state.token;app.api.stop();await app.api.start();primeClock(app);acoustic(app, 220, {id: oldId});
  const evidence = {ok: app.api.state.running && app.api.state.token !== oldId && close(Number(app.el('latency').value), 31), oldId, currentId: app.api.state.token};app.api.stop();return evidence;
});

await check('A manually disabled reference path ignores otherwise reliable reference results', async () => {
  const app = createApp(undefined, {worklet: true});app.api.applySettings({referenceSync: false, latency: 31});await app.api.start();primeClock(app);acoustic(app, 220);
  const evidence = {ok: close(Number(app.el('latency').value), 31), correction: Number(app.el('latency').value)};app.api.stop();return evidence;
});

await check('Later acoustic drift adjusts future notes while preserving every scored past bar', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();primeClock(app);acoustic(app, 80);
  for (let i = 0;i < 20;i++) {const time = app.api.state.epoch + (2 + i) * .3 + .080;app.api.getContext().currentTime = time;app.api.addHit(time, 'mic');}
  const old = app.api.state.attacks.map(hit => ({...hit})), before = Number(app.el('latency').value), time = app.api.getContext().currentTime;
  acoustic(app, 100, {time});const after = Number(app.el('latency').value);
  const preserved = old.every((hit, i) => Object.keys(hit).every(key => hit[key] === app.api.state.attacks[i][key]));
  const evidence = {ok: after > before && after < 100 && preserved && app.api.state.count === old.length, before, after, preserved};app.api.stop();return evidence;
});

const learnPlayerPhase = app => {
  primeClock(app);acoustic(app, 60);
  for (let i = 0;i < 9;i++) {const time = app.api.state.epoch + (2 + i) * .3 + .080;app.api.getContext().currentTime = time;app.api.addHit(time, 'mic');}
};

await check('Toggling auto normalization preserves a learned player phase beside a known hardware anchor', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();learnPlayerPhase(app);
  const learned = Number(app.el('latency').value), archive = app.api.state.attacks.map(hit => ({...hit}));
  const corrections = [];
  for (const enabled of [false, true]) {
    app.el('auto-normalize').checked = enabled;await app.el('auto-normalize').fire('change');app.api.getContext().currentTime += .75;acoustic(app, 60);
    corrections.push({enabled, correction: Number(app.el('latency').value), phase: app.api.state.adaptive.phaseOffset, lastReferenceTime: app.api.state.reference.lastTime, expectedReferenceTime: app.api.getContext().currentTime});
  }
  const preserved = archive.every((hit, i) => Object.keys(hit).every(key => hit[key] === app.api.state.attacks[i][key]));
  const evidence = {ok: close(learned, 80, .001) && corrections.every(row => close(row.correction, 80, .001) && close(row.phase, 20, .001) && row.lastReferenceTime === row.expectedReferenceTime) && preserved, learned, corrections, preserved};app.api.stop();return evidence;
});

await check('Reset clears the score without losing the phase learned relative to the hardware reference', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();learnPlayerPhase(app);
  const learned = Number(app.el('latency').value);await app.el('reset').fire('click');app.api.getContext().currentTime += .75;acoustic(app, 60);
  const evidence = {ok: close(learned, 80, .001) && close(Number(app.el('latency').value), 80, .001) && close(app.api.state.adaptive.phaseOffset, 20, .001) && app.api.state.count === 0 && app.api.state.attacks.length === 0 && app.el('median-abs').innerHTML.includes('—') && app.api.state.reference.lastTime === app.api.getContext().currentTime, learned, afterReset: Number(app.el('latency').value), phase: app.api.state.adaptive.phaseOffset, count: app.api.state.count};app.api.stop();return evidence;
});

await check('Manual normalization retains its bounded player phase when the same hardware delay is reported again', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.start();learnPlayerPhase(app);
  app.el('auto-normalize').checked = false;await app.el('auto-normalize').fire('change');
  for (let i = 9;i < 29;i++) {const time = app.api.state.epoch + (2 + i) * .3 + .090;app.api.getContext().currentTime = time;app.api.addHit(time, 'mic');}
  await app.el('normalize').fire('click');const normalized = Number(app.el('latency').value), phase = app.api.state.adaptive.phaseOffset;
  app.api.getContext().currentTime += .75;acoustic(app, 60);
  const evidence = {ok: close(normalized, 90, .001) && close(phase, 30, .001) && close(Number(app.el('latency').value), 90, .001) && close(app.api.state.adaptive.phaseOffset, 30, .001) && close(numericStat(app.el('bias')), 0) && app.api.state.reference.lastTime === app.api.getContext().currentTime, normalized, phase, afterReference: Number(app.el('latency').value), signedMedian: numericStat(app.el('bias'))};app.api.stop();return evidence;
});

for (const worklet of [false, true]) await check(`Stop releases every ${worklet ? 'worklet' : 'merger'} reference route and capture resource`, async () => {
  const app = createApp(undefined, {worklet});await app.api.start();
  const source = app.api.getSource(), processor = app.api.getProcessor(), silent = app.api.getSilent(), master = app.api.getMaster(), merger = app.nodes.find(node => node.kind === 'merger');
  app.api.stop();
  return {ok: source.disconnected && processor.disconnected && silent.disconnected && master.disconnected && (!merger || merger.disconnected) && app.streams[0].track.stopped && app.contexts[0].state === 'closed' && app.intervals.size === 0 && app.frames.size === 0, mergerDisconnected: merger?.disconnected, contextState: app.contexts[0].state};
});

await check('Stopping during worklet module loading cannot create a late reference route', async () => {
  const waiting = deferred(), app = createApp(undefined, {worklet: true, workletSetup: () => waiting.promise});
  const starting = app.api.start();await Promise.resolve();await Promise.resolve();app.api.stop();waiting.resolve();await starting;
  return {ok: !app.api.state.running && !app.api.state.pending && app.worklets.length === 0 && app.streams[0].track.stopped && app.contexts[0].state === 'closed' && app.api.getContext() === null, workletCount: app.worklets.length, stopped: app.streams[0].track.stopped};
});

await check('The fallback paired input supports the isolated eight-click latency measurement', async () => {
  const app = createApp();await app.api.measureLatency();
  const evidence = {ok: app.api.state.measuring && !app.api.state.pending && app.scheduled.length === 8 && app.micRequests[0].audio.echoCancellation === false && app.api.getFallback()?.probe !== null, measuring: app.api.state.measuring, clickCount: app.scheduled.length};app.api.stop();return evidence;
});

await check('The worklet paired input supports isolated measurement without enabling reference cancellation', async () => {
  const app = createApp(undefined, {worklet: true});await app.api.measureLatency();
  const node = app.worklets.at(-1), config = outputConfiguration(app);
  const evidence = {ok: app.api.state.measuring && app.scheduled.length === 8 && node.messages.some(message => message.type === 'measure-latency') && config?.enabled !== true, measuring: app.api.state.measuring, clickCount: app.scheduled.length, config};app.api.stop();return evidence;
});

await check('Median absolute error differs correctly from MAE and from absolute signed median', async () => {
  const app = createApp();app.api.applySettings({mic: false, autoNormalize: false, referenceSync: false});await app.api.start();
  for (const [i, error] of [-5, 10, -100, 20].entries()) app.api.addHit(app.api.state.epoch + (2 + i) * .3 + error / 1000, 'key');
  const medianAbsolute = numericStat(app.el('median-abs')), mae = numericStat(app.el('mae')), signed = numericStat(app.el('bias'));
  const evidence = {ok: close(medianAbsolute, 15) && close(mae, 33.8) && close(signed, 2.5), medianAbsolute, mae, signed};app.api.stop();return evidence;
});

await check('Odd-sample median absolute error uses the middle magnitude and reset restores missing data', async () => {
  const app = createApp();app.api.applySettings({mic: false, autoNormalize: false, referenceSync: false});await app.api.start();
  for (const [i, error] of [-7, 40, -12].entries()) app.api.addHit(app.api.state.epoch + (2 + i) * .3 + error / 1000, 'key');
  const value = numericStat(app.el('median-abs'));app.api.clearResults();
  const evidence = {ok: close(value, 12) && app.el('median-abs').innerHTML.includes('—'), value, afterReset: app.el('median-abs').innerHTML};app.api.stop();return evidence;
});

await check('Explicit manual normalization centers signed history while retaining nonzero median absolute error', async () => {
  const app = createApp();app.api.applySettings({referenceSync: false, autoNormalize: false});await app.api.start();
  for (const [i, jitter] of [-12, -4, 0, 5, 25].entries()) app.api.addHit(app.api.state.epoch + (2 + i) * .3 + .080 + jitter / 1000, 'mic');
  await app.el('normalize').fire('click');
  const evidence = {ok: close(Number(app.el('latency').value), 80, .001) && close(numericStat(app.el('bias')), 0) && close(numericStat(app.el('median-abs')), 5), correction: Number(app.el('latency').value), medianAbsolute: numericStat(app.el('median-abs')), signed: numericStat(app.el('bias'))};app.api.stop();return evidence;
});

await check('Note-based adaptive updates keep completed startup observations and bar assignments frozen', async () => {
  const app = createApp();app.api.applySettings({referenceSync: false, autoNormalize: true});await app.api.start();
  for (let i = 0;i < 9;i++) app.api.addHit(app.api.state.epoch + (2 + i) * .3 + .030, 'mic');
  const archived = app.api.state.attacks.map(hit => ({...hit}));
  for (let i = 9;i < 180;i++) {const time = app.api.state.epoch + (2 + i) * .3 + (30 + Math.min(20, i * .14)) / 1000;app.api.getContext().currentTime = time;app.api.addHit(time, 'mic');}
  const correction = Number(app.el('latency').value), preserved = archived.every((hit, i) => Object.keys(hit).every(key => hit[key] === app.api.state.attacks[i][key]));
  const evidence = {ok: preserved && correction > 30 && correction < 60 && app.api.state.count === 180, correction, preserved};app.api.stop();return evidence;
});

await check('Real AudioWorklet wrapper forwards its second input to DSP and produces only silence', () => {
  let Processor;
  class BaseProcessor {constructor() {this.port = {postMessage() {}};}}
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentFrame', scripts[0])(BaseProcessor, (name, constructor) => {if (name === 'rhythm-detector') Processor = constructor;}, 48000, 48000);
  const node = new Processor(), captured = [], mic = new Float32Array(128).fill(.11), reference = new Float32Array(128).fill(.22), output = new Float32Array(128).fill(.33);
  node.detector.process = (...args) => captured.push(args);const continues = node.process([[mic], [reference]], [[output]]);
  return {ok: continues === true && captured.length === 1 && captured[0][0]?.length === mic.length && captured[0][0][0] === mic[0] && close(captured[0][1], 1) && captured[0][2]?.[0] === reference[0] && output.every(value => value === 0), blocks: captured.length, outputPeak: Math.max(...output.map(Math.abs))};
});

async function runBackingWithBayan(preexistingProfile = false) {
  const rate = 8000, duration = 9.7, length = Math.ceil(rate * duration), app = createApp(undefined, {rate});await app.api.start();
  const ctx = app.api.getContext(), detector = app.api.getFallback(), epoch = app.api.state.epoch, master = app.api.getMaster(), reference = new Float32Array(length), capture = new Float32Array(length), delaySamples = Math.round(.315 * rate);
  const playerTimes = Array.from({length: 5}, (_, i) => epoch + (16 + i * 2) * .3 + .315), anchorObservations = [], emissions = [], originalEmit = detector.emit;
  detector.emit = message => {emissions.push({...message});originalEmit(message);};
  if (preexistingProfile) {detector.bins = Math.ceil(detector.duration * rate / 128);detector.profile = new Float32Array(detector.bins * 3).fill(10);}
  let sourceIndex = 0;
  for (let first = 0;first < length;first += 128) {
    ctx.currentTime = first / rate;app.api.schedule();
    for (;sourceIndex < app.scheduled.length;sourceIndex++) {
      const source = app.scheduled[sourceIndex], pcm = source.buffer.getChannelData(0), outputGain = source.connections[0].destination, gain = outputGain === master ? master.gain.value : outputGain.gain.value * master.gain.value, offset = Math.round(source.when * rate);
      for (let i = 0;i < pcm.length && offset + i < reference.length;i++) reference[offset + i] += pcm[i] * gain;
    }
    const end = Math.min(length, first + 128);
    for (let i = first;i < end;i++) {
      const t = i / rate;let player = 0;
      for (let note = 0;note < playerTimes.length;note++) {
        const dt = t - playerTimes[note];if (dt < 0 || dt > .44) continue;
        const frequency = [220, 293.66, 329.63, 246.94][note % 4], envelope = Math.min(1, dt / .018) * Math.min(1, (.44 - dt) / .035);
        player += .14 * envelope * (Math.sin(2 * Math.PI * frequency * t) + .32 * Math.sin(4 * Math.PI * frequency * t) + .19 * Math.sin(6 * Math.PI * frequency * t));
      }
      capture[i] = (i >= delaySamples ? reference[i - delaySamples] * .5 : 0) + player;
    }
    detector.process(capture.subarray(first, end), first / rate, reference.subarray(first, end));
    if (app.api.state.reference?.locked && !anchorObservations.length) anchorObservations.push({time: ctx.currentTime, delay: app.api.state.reference.delayMs});
  }
  const hits = app.api.state.attacks.map(hit => ({...hit})), firstAnchor = anchorObservations[0], correction = Number(app.el('latency').value), noteMatches = playerTimes.map((time, i) => ({expectedTime: time, expectedStep: (16 + i * 2) % 8, hits: hits.filter(hit => Math.abs(hit.rawMs / 1000 + epoch - time) < .12)}));
  const backingOnlyHits = hits.filter(hit => hit.rawMs / 1000 + epoch < playerTimes[0] - .10), lateExtraHits = hits.filter(hit => hit.rawMs / 1000 + epoch >= playerTimes[0] - .10 && !playerTimes.some(time => Math.abs(hit.rawMs / 1000 + epoch - time) < .12));
  const retained = noteMatches.every(match => match.hits.some(hit => hit.step === match.expectedStep && Math.abs(hit.error) < 60));
  const evidence = {ok: app.api.state.running && !!firstAnchor && Math.abs(firstAnchor.delay - 315) < 2 && Math.abs(correction - 315) < 5 && hits.length === playerTimes.length && backingOnlyHits.length === 0 && lateExtraHits.length === 0 && retained && numericStat(app.el('median-abs')) < 60, firstAnchor, firstAnchorEventTime: emissions.find(message => message.type === 'acoustic-sync' && message.status === 'locked')?.time, correction, totalAttacks: hits.length, attackTimes: hits.map(hit => Number((hit.rawMs / 1000 + epoch).toFixed(6))), backingOnlyAttackTimes: backingOnlyHits.map(hit => Number((hit.rawMs / 1000 + epoch).toFixed(6))), lateExtraAttacks: lateExtraHits.length, noteMatches: noteMatches.map(match => ({expectedStep: match.expectedStep, errors: match.hits.map(hit => hit.error), targetSteps: match.hits.map(hit => hit.step)})), medianAbsoluteError: numericStat(app.el('median-abs')), preexistingProfile};app.api.stop();return evidence;
}

let backingBaseline;
await check('Real backing PCM produces no startup phantom, resolves 315 ms delay and retains coincident bayan attacks through DSP to the UI', async () => {
  backingBaseline = await runBackingWithBayan();return backingBaseline;
});

await check('Reference-cleaned coincident bayan attacks survive a deliberately excessive legacy background profile', async () => {
  const withProfile = await runBackingWithBayan(true), preserved = backingBaseline && JSON.stringify(withProfile.noteMatches) === JSON.stringify(backingBaseline.noteMatches);
  return {...withProfile, ok: withProfile.ok && preserved, samePlayerOnsetsAsNoProfile: preserved};
});

const summary = {target, passed: results.filter(result => result.status === 'PASS').length, failed: results.filter(result => result.status === 'FAIL').length, scope: 'Independent DOM, storage and Web Audio graph/PCM doubles; no live browser, microphone or physical acoustic path.', results};
console.log(JSON.stringify(summary, null, 2));
Deno.exitCode = summary.failed ? 1 : 0;
