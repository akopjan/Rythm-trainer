// Focused integration QA using independent DOM, clock, storage and audio doubles.
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
    constructor() {this.connections = [];this.disconnected = false;}
    connect(destination) {this.connections.push(destination);return destination;}
    disconnect() {this.disconnected = true;}
  }
  class FakeContext {
    constructor() {this.currentTime = 0;this.sampleRate = 48000;this.state = 'running';this.destination = {destination: true};this.baseLatency = 0;contexts.push(this);}
    async resume() {}
    async close() {this.state = 'closed';}
    createGain() {const node = new AudioNode();node.gain = {value: 0, changes: [], setTargetAtTime(value, time, constant) {this.value = value;this.changes.push({value, time, constant});}};return node;}
    createMediaStreamSource() {return new AudioNode();}
    createScriptProcessor() {return new AudioNode();}
    createBuffer(channels, length, rate) {const pcm = new Float32Array(length);return {duration: length / rate, getChannelData: () => pcm};}
    createBufferSource() {const node = new AudioNode();node.start = when => {node.when = when;scheduled.push(node);};node.stop = () => {node.stopped = true;};return node;}
  }
  const fakeStream = () => {const track = {readyState: 'live', listeners: {}, getSettings: () => ({echoCancellation: true}), addEventListener(type, callback) {this.listeners[type] = callback;}, stop() {this.readyState = 'ended';}};return {getAudioTracks: () => [track], getTracks: () => [track]};};
  const timeout = (callback, delay = 0) => {const id = nextId++;timers.set(id, {callback, due: now + delay});return id;};
  const win = {AudioContext: FakeContext, devicePixelRatio: 1, location, localStorage: storage, setTimeout: timeout, clearTimeout: id => timers.delete(id), addEventListener(type, callback) {(windowListeners[type] ??= []).push(callback);}};
  const urls = {createObjectURL(blob) {const url = 'blob:test-' + nextId++;blobs.set(url, blob);return url;}, revokeObjectURL(url) {revoked.push(url);blobs.delete(url);}};
  const fakePerformance = {now: () => now, timeOrigin: 1700000000000};
  const api = new Function('document', 'window', 'navigator', 'RhythmDetector', 'performance', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'Blob', 'URL', 'setTimeout', 'location', 'Date', scripts[1] + `;return {state,pattern,start,stop,schedule,addHit,applySettings,captureSettings,saveSettings,flushSettings,exportSettings,renderGrid,setControls,getContext:()=>context,getTrackGains:()=>trackGains,getClickGain:()=>clickGain,getMaster:()=>master,getBuffers:()=>buffers,getClickBuffers:()=>clickBuffers};`)(doc, win, {mediaDevices: {getUserMedia: async () => fakeStream()}}, Detector, fakePerformance, class {observe() {}}, callback => {const id = nextId++;frames.set(id, callback);return id;}, id => frames.delete(id), callback => {const id = nextId++;intervals.set(id, callback);return id;}, id => intervals.delete(id), Blob, urls, timeout, location, {now: () => clockEpoch + now});
  return {api, el, doc, win, storage, cookies, scheduled, contexts, timers, intervals, frames, downloads, revoked,
    async advance(milliseconds) {const end = now + milliseconds;while (true) {const due = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];if (!due) break;now = due[1].due;timers.delete(due[0]);await due[1].callback();}now = end;},
    async pagehide() {for (const callback of windowListeners.pagehide ?? []) await callback();},
    trackEnabled(row) {return doc.querySelectorAll('[data-track-enabled]').find(element => Number(element.dataset.trackEnabled) === row);},
    trackVolume(row) {return doc.querySelectorAll('[data-track-volume]').find(element => Number(element.dataset.trackVolume) === row);},
    cell(row, step) {return doc.querySelectorAll('.step').find(element => Number(element.dataset.row) === row && Number(element.dataset.step) === step);},
  };
}

async function check(name, run) {try {const evidence = await run();record(name, evidence.ok, evidence);} catch (error) {record(name, false, {error: error.message, stack: error.stack?.split('\n').slice(0, 3)});}}

const presetPattern = () => Array.from({length: 4}, (_, track) => Array.from({length: 32}, (_, position) => track === 0 ? [0, 8].includes(position % 16) : track === 1 ? [4, 12].includes(position % 16) : track === 2 ? position % 2 === 0 : false));
await check('First launch restores the complete drum groove with the metronome off', async () => {
  const app = createApp(), snapshot = app.api.captureSettings();
  return {ok: JSON.stringify(snapshot.pattern) === JSON.stringify(presetPattern()) && snapshot.click === false && snapshot.trackEnabled.every(Boolean) && app.doc.querySelectorAll('.step').length === 32, selectedDrumCells: snapshot.pattern.flat().filter(Boolean).length, metronome: snapshot.click};
});

await check('Settings and hidden 3/4 pattern positions restore in a fresh app instance', async () => {
  const storage = storageDouble(), first = createApp(storage), pattern = Array.from({length: 4}, () => Array(32).fill(false));pattern[2][15] = true;pattern[2][31] = true;pattern[0][0] = true;
  first.api.applySettings({bpm: 137, bars: 2, beats: 3, division: 16, mic: false, click: false, autoNormalize: false, volume: 0, clickVolume: 33, threshold: -60, latency: -14.125, tolerance: 19, pattern, trackEnabled: [false, true, false, true], trackVolumes: [0, 23, 47, 100]});first.api.saveSettings();first.api.flushSettings();
  const second = createApp(storage), expected = first.api.captureSettings(), restored = second.api.captureSettings();
  return {ok: JSON.stringify(expected) === JSON.stringify(restored) && second.api.pattern[2][15] && second.api.pattern[2][31] && second.doc.querySelectorAll('.step').length === 96 && second.el('settings-info').textContent.includes('восстановлены'), gridCells: second.doc.querySelectorAll('.step').length, restoredLatencyMs: restored.latency};
});

await check('Rapid edits are persisted once after the debounce with the latest value', async () => {
  const app = createApp();for (const volume of [10, 20, 30, 0]) {app.el('volume').value = volume;await app.el('volume').fire('input');}
  const before = app.storage.writes.length;await app.advance(699);const beforeDeadline = app.storage.writes.length;await app.advance(1);
  return {ok: before === 0 && beforeDeadline === 0 && app.storage.writes.length === 1 && JSON.parse(app.storage.writes[0].value).volume === 0, writes: app.storage.writes.length};
});

await check('Stop flushes pending settings immediately and cancels the debounce timer', async () => {
  const app = createApp();app.el('volume').value = 42;await app.el('volume').fire('input');app.api.stop();await app.advance(1000);
  return {ok: app.storage.writes.length === 1 && app.timers.size === 0 && JSON.parse(app.storage.writes[0].value).volume === 42, writes: app.storage.writes.length};
});

await check('Pagehide preserves the last unsaved setting', async () => {
  const app = createApp();app.el('click').checked = false;await app.el('click').fire('change');await app.pagehide();
  return {ok: app.storage.writes.length === 1 && JSON.parse(app.storage.writes[0].value).click === false, savedMetronome: JSON.parse(app.storage.writes[0].value).click};
});

await check('A blocked storage write leaves a visible JSON-backup instruction', async () => {
  const app = createApp(storageDouble({}, false, true));app.el('volume').value = 22;await app.el('volume').fire('input');await app.advance(700);
  return {ok: app.el('settings-info').textContent.includes('не разрешил') && app.el('settings-info').textContent.includes('файл') && app.api.captureSettings().volume === 22, message: app.el('settings-info').textContent};
});

await check('Corrupt saved JSON does not prevent the default groove from initializing', async () => {
  const app = createApp(storageDouble({[settingsKey]: '{bad json'}));
  return {ok: JSON.stringify(app.api.pattern) === JSON.stringify(presetPattern()) && app.doc.querySelectorAll('.step').length === 32 && app.el('settings-info').textContent.includes('недоступны'), message: app.el('settings-info').textContent};
});

await check('Blocked storage reads recover visibly without requesting audio', async () => {
  const app = createApp(storageDouble({}, true));
  return {ok: app.contexts.length === 0 && !app.api.state.running && app.el('settings-info').textContent.includes('недоступны'), contexts: app.contexts.length};
});

await check('JSON export contains the current pattern, independent gains and no audio or session history', async () => {
  const app = createApp();app.api.applySettings({pattern: []});await app.cell(2, 1).fire('click');app.api.state.attacks.push({rawMs: 1234, error: 55});app.api.exportSettings();
  const download = app.downloads[0], data = JSON.parse(await download.blob.text());
  return {ok: download.filename === 'rhythm-settings.json' && data.pattern[2][2] && data.trackVolumes.length === 4 && !('attacks' in data) && !('events' in data) && !('audio' in data) && app.doc.body.children.length === 0, filename: download.filename, savedAttackCount: 'attacks' in data ? data.attacks.length : null};
});

await check('Export blob URLs are revoked after the browser download is initiated', async () => {
  const app = createApp();app.api.exportSettings();const url = app.downloads[0].href;await app.advance(1000);
  return {ok: app.revoked.includes(url), revokedUrls: app.revoked.length};
});

await check('Direct settings restoration updates controls and persists the accepted snapshot', async () => {
  const app = createApp();app.api.applySettings({version: 1, bpm: 145, beats: 3, bars: 2, division: 8, click: false, clickVolume: 18, pattern: [[true]], trackEnabled: [false, true], trackVolumes: [0, 35]});app.api.saveSettings();const persisted = app.api.flushSettings();
  const saved = JSON.parse(app.storage.values.get(settingsKey));
  return {ok: persisted && app.api.state.bpm === 145 && app.api.state.beats === 3 && app.api.pattern[0][0] && app.api.state.trackEnabled[0] === false && saved.clickVolume === 18 && app.el('settings-info').textContent.includes('сохранены'), savedBpm: saved.bpm};
});

await check('Restored settings remain active with visible backup guidance when autosave is blocked', async () => {
  const app = createApp(storageDouble({}, false, true));app.api.applySettings({bpm: 145});app.api.saveSettings();const persisted = app.api.flushSettings();
  return {ok: persisted === false && app.api.state.bpm === 145 && !app.storage.values.has(settingsKey) && app.el('settings-info').textContent.includes('не разрешил') && app.el('settings-info').textContent.includes('файл'), message: app.el('settings-info').textContent};
});

for (const [label, value] of [['null', 'null'], ['array', '[]'], ['unrelated object', '{"document":"hello"}'], ['constructor-only object', '{"constructor":{}}'], ['toString-only object', '{"toString":"settings"}'], ['parsed prototype-only object', '{"__proto__":{"bpm":250}}'], ['invalid JSON', '{broken'], ['future version', '{"version":99,"bpm":250}']]) {
  await check(`Saved settings reject ${label} and preserve safe default controls and pattern`, async () => {
    const app = createApp(storageDouble({[settingsKey]: value}));
    return {ok: app.api.state.bpm === 100 && JSON.stringify(app.api.pattern) === JSON.stringify(presetPattern()) && app.doc.querySelectorAll('.step').length === 32 && app.contexts.length === 0 && app.el('settings-info').textContent.includes('недоступны'), message: app.el('settings-info').textContent};
  });
}

await check('A blank pattern schedules quarter-note metronome clicks without default eighth-note drums', async () => {
  const app = createApp();app.api.applySettings({mic: false, click: true, pattern: []});await app.api.start();const ctx = app.api.getContext(), epoch = app.api.state.epoch;
  for (let time = epoch;time < epoch + 2.4;time += .025) {ctx.currentTime = time;app.api.schedule();}
  const beatSources = app.scheduled.filter(source => source.when >= epoch && source.when < epoch + 2.4 - 1e-6);
  const evidence = {ok: beatSources.length === 4 && beatSources.every(source => app.api.getClickBuffers().includes(source.buffer) && source.connections[0] === app.api.getClickGain()), scheduledClicks: beatSources.length};app.api.stop();return evidence;
});

await check('Each drum routes through its own saved gain while the metronome uses a separate gain', async () => {
  const app = createApp(), pattern = Array.from({length: 4}, () => Array(32).fill(false));pattern.forEach(row => row[0] = true);app.api.applySettings({mic: false, click: true, pattern, trackVolumes: [20, 40, 60, 80], clickVolume: 35});await app.api.start();app.api.getContext().currentTime = app.api.state.epoch;app.api.schedule();
  const tracks = app.api.getTrackGains(), clicks = app.api.getClickGain(), drums = app.scheduled.filter(source => app.api.getBuffers().includes(source.buffer)), clickSources = app.scheduled.filter(source => app.api.getClickBuffers().includes(source.buffer));
  const evidence = {ok: drums.length === 4 && drums.every(source => source.connections[0] === tracks[app.api.getBuffers().indexOf(source.buffer)]) && tracks.every((gain, i) => close(gain.gain.value, [0.2, 0.4, 0.6, 0.8][i])) && close(clicks.gain.value, .35) && clickSources.length === 1 && clickSources[0].connections[0] === clicks && clicks !== tracks[0], drumSources: drums.length, clickSources: clickSources.length};app.api.stop();return evidence;
});

await check('Muting one drum stops its scheduled hits without deleting its pattern or changing other gains', async () => {
  const app = createApp(), pattern = Array.from({length: 4}, () => Array(32).fill(false));pattern.forEach(row => row[0] = true);app.api.applySettings({mic: false, click: false, pattern, trackEnabled: [true, false, true, true], trackVolumes: [20, 40, 60, 80]});await app.api.start();app.api.getContext().currentTime = app.api.state.epoch;app.api.schedule();
  const buffers = app.api.getBuffers(), played = app.scheduled.map(source => buffers.indexOf(source.buffer));
  const evidence = {ok: JSON.stringify(played) === '[0,2,3]' && app.api.pattern[1][0] && close(app.api.getTrackGains()[1].gain.value, 0) && app.api.state.trackVolumes[1] === 40, scheduledDrumIndices: played, retainedVolume: app.api.state.trackVolumes[1]};app.api.stop();return evidence;
});

await check('Live drum volume changes affect only the selected gain and persist independently', async () => {
  const app = createApp();app.api.applySettings({mic: false, trackVolumes: [20, 40, 60, 80]});await app.api.start();const gains = app.api.getTrackGains();const volume = app.trackVolume(2);volume.value = 15;await volume.fire('input');await app.advance(700);
  const saved = JSON.parse(app.storage.values.get(settingsKey)), evidence = {ok: close(gains[2].gain.value, .15) && close(gains[0].gain.value, .2) && close(gains[1].gain.value, .4) && close(gains[3].gain.value, .8) && saved.trackVolumes[2] === 15, liveGain: gains[2].gain.value, storedVolume: saved.trackVolumes[2]};app.api.stop();return evidence;
});

await check('Live mute and unmute retain the drum volume and leave the metronome untouched', async () => {
  const app = createApp();app.api.applySettings({mic: false, trackVolumes: [37, 100, 100, 100], clickVolume: 28});await app.api.start();const gain = app.api.getTrackGains()[0], control = app.trackEnabled(0), clickGain = app.api.getClickGain();control.checked = false;await control.fire('change');const muted = gain.gain.value;control.checked = true;await control.fire('change');
  const evidence = {ok: muted === 0 && close(gain.gain.value, .37) && close(clickGain.gain.value, .28) && app.api.state.trackVolumes[0] === 37, mutedGain: muted, unmutedGain: gain.gain.value, metronomeGain: clickGain.gain.value};app.api.stop();return evidence;
});

await check('Metronome checkbox and volume remain independent of the selected drums', async () => {
  const app = createApp(), pattern = Array.from({length: 4}, () => Array(32).fill(false));pattern[2][0] = true;app.api.applySettings({mic: false, click: false, pattern, trackVolumes: [100, 100, 55, 100]});await app.api.start();app.el('click-volume').value = 0;await app.el('click-volume').fire('input');app.api.getContext().currentTime = app.api.state.epoch;app.api.schedule();
  const evidence = {ok: close(app.api.getClickGain().gain.value, 0) && close(app.api.getTrackGains()[2].gain.value, .55) && app.scheduled.length === 1 && app.scheduled[0].buffer === app.api.getBuffers()[2], scheduledSources: app.scheduled.length};app.api.stop();return evidence;
});

await check('Stop disconnects all independent gains and closes its audio context', async () => {
  const app = createApp();app.el('mic').checked = false;await app.api.start();const gains = [...app.api.getTrackGains(), app.api.getClickGain(), app.api.getMaster()], context = app.api.getContext();app.api.stop();
  return {ok: gains.every(gain => gain.disconnected) && context.state === 'closed' && !app.api.getContext() && app.intervals.size === 0 && app.frames.size === 0, disconnectedGains: gains.filter(gain => gain.disconnected).length};
});

await check('Basic rhythm restores the preset and turns off the metronome without resetting other settings', async () => {
  const app = createApp();app.api.applySettings({bpm: 137, beats: 3, bars: 2, mic: false, click: true, latency: 27.125, pattern: [], trackEnabled: [false, true, true, false], trackVolumes: [17, 35, 60, 80]});
  await app.el('basic-pattern').fire('click');await app.advance(700);const settings = app.api.captureSettings(), saved = JSON.parse(app.storage.values.get(settingsKey));
  return {ok: JSON.stringify(settings.pattern) === JSON.stringify(presetPattern()) && settings.click === false && settings.bpm === 137 && settings.beats === 3 && settings.bars === 2 && settings.latency === 27.125 && JSON.stringify(settings.trackVolumes) === '[17,35,60,80]' && settings.trackEnabled[0] === false && JSON.stringify(saved.pattern) === JSON.stringify(presetPattern()), savedPatternHits: saved.pattern.flat().filter(Boolean).length};
});

await check('Basic rhythm is locked and ignores direct activation during calibration and measurement', async () => {
  const app = createApp();app.api.applySettings({pattern: [], click: true});const before = JSON.stringify(app.api.captureSettings());
  app.api.state.calibrating = true;app.api.setControls();const calibrationDisabled = app.el('basic-pattern').disabled;await app.el('basic-pattern').fire('click');const calibrationUnchanged = JSON.stringify(app.api.captureSettings()) === before;
  app.api.state.calibrating = false;app.api.state.measuring = true;app.api.setControls();const measurementDisabled = app.el('basic-pattern').disabled;await app.el('basic-pattern').fire('click');
  return {ok: calibrationDisabled && measurementDisabled && calibrationUnchanged && JSON.stringify(app.api.captureSettings()) === before, calibrationDisabled, measurementDisabled};
});

await check('HTTP settings writes use a verified cookie and keep a matching localStorage mirror', async () => {
  const app = createApp(storageDouble(), {protocol: 'http:'});app.el('volume').value = 24;await app.el('volume').fire('input');await app.advance(700);
  const encoded = app.cookies.values.get(settingsKey), decoded = JSON.parse(decodeURIComponent(encoded)), assignment = app.cookies.writes.at(-1);
  return {ok: decoded.volume === 24 && decoded.savedAt === clockEpoch + 700 && app.storage.values.get(settingsKey) === decodeURIComponent(encoded) && /Max-Age=31536000/i.test(assignment) && /Path=\//i.test(assignment) && /SameSite=Lax/i.test(assignment) && !/;\s*Secure(?:;|$)/i.test(assignment) && app.el('settings-info').textContent.includes('в cookies'), encodedCharacters: encoded.length, message: app.el('settings-info').textContent};
});

await check('HTTPS cookie persistence adds the Secure attribute', async () => {
  const app = createApp(storageDouble(), {protocol: 'https:'});app.api.saveSettings();app.api.flushSettings();
  return {ok: /;\s*Secure(?:;|$)/i.test(app.cookies.writes.at(-1)) && app.cookies.values.has(settingsKey), assignmentHasSecure: /Secure/i.test(app.cookies.writes.at(-1))};
});

await check('Cookie-only reload restores settings when all localStorage access is blocked', async () => {
  const cookies = cookieDouble(), first = createApp(storageDouble({}, true, true), {protocol: 'https:', cookies});first.api.applySettings({bpm: 139, click: true, pattern: [], latency: -37.125});first.api.saveSettings();first.api.flushSettings();
  const second = createApp(storageDouble({}, true, true), {protocol: 'https:', cookies});
  return {ok: second.api.state.bpm === 139 && second.el('click').checked && second.api.pattern.every(row => row.every(cell => !cell)) && Number(second.el('latency').value) === -37.125 && second.el('settings-info').textContent.includes('в cookies'), restoredBpm: second.api.state.bpm, message: second.el('settings-info').textContent};
});

await check('Blocked cookie writes fall back to localStorage and report the actual source', async () => {
  const cookies = cookieDouble({}, false, true), storage = storageDouble(), app = createApp(storage, {protocol: 'https:', cookies});app.el('volume').value = 31;await app.el('volume').fire('input');await app.advance(700);
  const second = createApp(storage, {protocol: 'https:', cookies});
  return {ok: !cookies.values.has(settingsKey) && JSON.parse(storage.values.get(settingsKey)).volume === 31 && second.api.captureSettings().volume === 31 && app.el('settings-info').textContent.includes('localStorage') && second.el('settings-info').textContent.includes('localStorage'), message: second.el('settings-info').textContent};
});

await check('Local HTML avoids cookie writes and keeps working settings in localStorage', async () => {
  const app = createApp();app.api.saveSettings();app.api.flushSettings();
  return {ok: app.cookies.writes.length === 0 && app.storage.values.has(settingsKey) && app.el('settings-info').textContent.includes('Cookies недоступны') && app.el('settings-info').textContent.includes('localStorage'), cookieWrites: app.cookies.writes.length};
});

for (const [label, encoded] of [['invalid URI encoding', '%malformed'], ['invalid JSON', encodeURIComponent('{broken')], ['unsupported version', encodeURIComponent('{"version":99,"bpm":250}')], ['constructor-only payload', encodeURIComponent('{"constructor":{}}')], ['toString-only payload', encodeURIComponent('{"toString":"settings"}')], ['parsed prototype-only payload', encodeURIComponent('{"__proto__":{"bpm":250}}')]]) {
  await check(`A cookie with ${label} falls back to valid saved controls`, async () => {
    const storage = storageDouble({[settingsKey]: JSON.stringify({version: 1, bpm: 126, click: true, pattern: []})}), cookies = cookieDouble({[settingsKey]: encoded});
    const app = createApp(storage, {protocol: 'https:', cookies});
    return {ok: app.api.state.bpm === 126 && app.el('click').checked && app.api.pattern.every(row => row.every(cell => !cell)) && JSON.parse(decodeURIComponent(cookies.values.get(settingsKey))).bpm === 126 && app.el('settings-info').textContent.includes('в cookies'), restoredBpm: app.api.state.bpm};
  });
}

await check('Legacy localStorage snapshots migrate into cookies without losing explicit blank patterns', async () => {
  const storage = storageDouble({[settingsKey]: JSON.stringify({bpm: 142, pattern: [], trackEnabled: [false, true, false, true], trackVolumes: [0, 22, 33, 44]})}), cookies = cookieDouble();
  const app = createApp(storage, {protocol: 'https:', cookies}), migrated = JSON.parse(decodeURIComponent(cookies.values.get(settingsKey)));
  return {ok: migrated.version === 1 && migrated.bpm === 142 && migrated.savedAt === 0 && migrated.pattern.every(row => row.every(cell => !cell)) && migrated.trackEnabled[0] === false && migrated.trackVolumes[0] === 0 && app.el('settings-info').textContent.includes('в cookies'), migratedBpm: migrated.bpm};
});

await check('All 128 pattern positions and user controls fit in the verified settings cookie', async () => {
  const app = createApp(storageDouble({}, true, true), {protocol: 'https:'}), pattern = Array.from({length: 4}, (_, track) => Array.from({length: 32}, (_, position) => (position + track) % 3 === 0));
  app.api.applySettings({bpm: 137.5, beats: 3, bars: 2, division: 16, mic: false, click: true, autoNormalize: false, inputMode: 'percussive', threshold: -53, volume: 17, clickVolume: 83, latency: -127.375, tolerance: 23, pattern, trackEnabled: [false, true, true, false], trackVolumes: [0, 19, 83, 100]});app.api.saveSettings();app.api.flushSettings();
  const encoded = app.cookies.values.get(settingsKey), saved = JSON.parse(decodeURIComponent(encoded));const second = createApp(storageDouble({}, true, true), {protocol: 'https:', cookies: app.cookies});
  return {ok: encoded.length < 3800 && JSON.stringify(saved.pattern) === JSON.stringify(pattern) && JSON.stringify(second.api.captureSettings()) === JSON.stringify(app.api.captureSettings()), encodedCharacters: encoded.length, savedPatternCells: saved.pattern.flat().length};
});

await check('Cookie snapshots exclude microphone audio, permissions and measured history', async () => {
  const app = createApp(storageDouble(), {protocol: 'https:'});app.api.state.attacks.push({rawMs: 731, error: -27});app.api.state.events.push({error: -27});app.api.state.errors.push(-27);app.api.state.running = true;app.api.saveSettings();app.api.flushSettings();
  const stored = JSON.parse(decodeURIComponent(app.cookies.values.get(settingsKey)));
  return {ok: ['audio', 'stream', 'permission', 'attacks', 'events', 'errors', 'running', 'epoch', 'adaptive'].every(key => !(key in stored)) && Number.isFinite(stored.savedAt), savedKeys: Object.keys(stored)};
});

await check('Cookie verification failure uses localStorage rather than claiming cookies were saved', async () => {
  const app = createApp(storageDouble(), {protocol: 'https:', cookies: cookieDouble({}, true)});app.el('volume').value = 47;await app.el('volume').fire('input');await app.advance(700);
  return {ok: JSON.parse(app.storage.values.get(settingsKey)).volume === 47 && app.el('settings-info').textContent.includes('localStorage'), message: app.el('settings-info').textContent};
});

await check('When both cookie and localStorage writes fail, settings backup guidance remains visible', async () => {
  const app = createApp(storageDouble({}, true, true), {protocol: 'https:', cookies: cookieDouble({}, false, true)});app.api.saveSettings();const saved = app.api.flushSettings();
  return {ok: saved === false && app.el('settings-info').textContent.includes('не разрешил') && app.el('settings-info').textContent.includes('файл'), message: app.el('settings-info').textContent};
});

await check('A newer local mirror beats a stale readable cookie after its overwrite was blocked', async () => {
  const old = {version: 1, bpm: 120, savedAt: clockEpoch}, cookies = cookieDouble({[settingsKey]: encodeURIComponent(JSON.stringify(old))}, false, true), storage = storageDouble({[settingsKey]: JSON.stringify(old)});
  const first = createApp(storage, {protocol: 'https:', cookies});first.el('bpm').value = 166;await first.el('bpm').fire('change');first.api.flushSettings();
  const local = JSON.parse(storage.values.get(settingsKey)), second = createApp(storage, {protocol: 'https:', cookies});
  return {ok: local.savedAt > clockEpoch && second.api.state.bpm === 166 && JSON.parse(decodeURIComponent(cookies.values.get(settingsKey))).bpm === 120 && second.el('settings-info').textContent.includes('localStorage'), savedAt: local.savedAt, staleCookieSavedAt: clockEpoch, restoredBpm: second.api.state.bpm};
});

await check('Equal saved timestamps prefer the cookie snapshot', async () => {
  const cookies = cookieDouble({[settingsKey]: encodeURIComponent(JSON.stringify({bpm: 156, savedAt: 123}))}), storage = storageDouble({[settingsKey]: JSON.stringify({bpm: 140, savedAt: 123})}), app = createApp(storage, {protocol: 'https:', cookies});
  return {ok: app.api.state.bpm === 156 && app.el('settings-info').textContent.includes('в cookies'), selectedBpm: app.api.state.bpm};
});

await check('An unrelated cookie with a similar name cannot become the trainer settings', async () => {
  const cookies = cookieDouble({[settingsKey + '0']: encodeURIComponent(JSON.stringify({bpm: 250}))}), app = createApp(storageDouble(), {protocol: 'https:', cookies});
  return {ok: app.api.state.bpm === 100 && JSON.stringify(app.api.pattern) === JSON.stringify(presetPattern()), bpm: app.api.state.bpm};
});

const passed = results.filter(result => result.status === 'PASS').length, failed = results.length - passed;
console.log(JSON.stringify({target, passed, failed, scope: 'DOM/audio/cookie/storage/clock integration doubles; no physical device or real browser verification.', results}, null, 2));
Deno.exitCode = failed ? 1 : 0;
