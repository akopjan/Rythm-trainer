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

function createApp(storage = storageDouble()) {
  let nextId = 1, now = 0;
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
    hidden: false, activeElement: null, body: new Element('BODY'), listeners: {}, getElementById: el, createElement: tag => new Element(tag.toUpperCase()), createTextNode: text => ({textContent: text}),
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
  const win = {AudioContext: FakeContext, devicePixelRatio: 1, localStorage: storage, setTimeout: timeout, clearTimeout: id => timers.delete(id), addEventListener(type, callback) {(windowListeners[type] ??= []).push(callback);}};
  const urls = {createObjectURL(blob) {const url = 'blob:test-' + nextId++;blobs.set(url, blob);return url;}, revokeObjectURL(url) {revoked.push(url);blobs.delete(url);}};
  const fakePerformance = {now: () => now, timeOrigin: 1700000000000};
  const api = new Function('document', 'window', 'navigator', 'RhythmDetector', 'performance', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'Blob', 'URL', 'setTimeout', scripts[1] + `;return {state,pattern,start,stop,schedule,addHit,applySettings,captureSettings,saveSettings,flushSettings,importSettings,exportSettings,renderGrid,setControls,getContext:()=>context,getTrackGains:()=>trackGains,getClickGain:()=>clickGain,getMaster:()=>master,getBuffers:()=>buffers,getClickBuffers:()=>clickBuffers};`)(doc, win, {mediaDevices: {getUserMedia: async () => fakeStream()}}, Detector, fakePerformance, class {observe() {}}, callback => {const id = nextId++;frames.set(id, callback);return id;}, id => frames.delete(id), callback => {const id = nextId++;intervals.set(id, callback);return id;}, id => intervals.delete(id), Blob, urls, timeout);
  return {api, el, doc, win, storage, scheduled, contexts, timers, intervals, frames, downloads, revoked,
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

await check('First launch has a blank drum pattern and only the explicit metronome selected', async () => {
  const app = createApp(), snapshot = app.api.captureSettings();
  return {ok: snapshot.pattern.every(row => row.every(cell => !cell)) && snapshot.click && snapshot.trackEnabled.every(Boolean) && app.doc.querySelectorAll('.step').length === 32, selectedDrumCells: snapshot.pattern.flat().filter(Boolean).length, metronome: snapshot.click};
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

await check('Corrupt saved JSON does not prevent a fresh blank app from initializing', async () => {
  const app = createApp(storageDouble({[settingsKey]: '{bad json'}));
  return {ok: app.api.pattern.every(row => row.every(cell => !cell)) && app.doc.querySelectorAll('.step').length === 32 && app.el('settings-info').textContent.includes('недоступны'), message: app.el('settings-info').textContent};
});

await check('Blocked storage reads recover visibly without requesting audio', async () => {
  const app = createApp(storageDouble({}, true));
  return {ok: app.contexts.length === 0 && !app.api.state.running && app.el('settings-info').textContent.includes('недоступны'), contexts: app.contexts.length};
});

await check('JSON export contains the current pattern, independent gains and no audio or session history', async () => {
  const app = createApp();await app.cell(2, 1).fire('click');app.api.state.attacks.push({rawMs: 1234, error: 55});app.api.exportSettings();
  const download = app.downloads[0], data = JSON.parse(await download.blob.text());
  return {ok: download.filename === 'rhythm-settings.json' && data.pattern[2][2] && data.trackVolumes.length === 4 && !('attacks' in data) && !('events' in data) && !('audio' in data) && app.doc.body.children.length === 0, filename: download.filename, savedAttackCount: 'attacks' in data ? data.attacks.length : null};
});

await check('Export blob URLs are revoked after the browser download is initiated', async () => {
  const app = createApp();app.api.exportSettings();const url = app.downloads[0].href;await app.advance(1000);
  return {ok: app.revoked.includes(url), revokedUrls: app.revoked.length};
});

await check('A valid JSON import restores controls and persists the accepted snapshot', async () => {
  const app = createApp();await chooseFile(app, fileFor({version: 1, bpm: 145, beats: 3, bars: 2, division: 8, click: false, clickVolume: 18, pattern: [[true]], trackEnabled: [false, true], trackVolumes: [0, 35]}));
  const saved = JSON.parse(app.storage.values.get(settingsKey));
  return {ok: app.api.state.bpm === 145 && app.api.state.beats === 3 && app.api.pattern[0][0] && app.api.state.trackEnabled[0] === false && saved.clickVolume === 18 && app.el('settings-info').textContent.includes('загружены'), savedBpm: saved.bpm};
});

await check('Valid import reports unavailable autosave when storage is blocked', async () => {
  const app = createApp(storageDouble({}, false, true));await chooseFile(app, fileFor({bpm: 145}));
  return {ok: app.api.state.bpm === 145 && app.el('settings-info').textContent.includes('автосохранение недоступно') && app.el('settings-info').textContent.includes('следующего запуска'), message: app.el('settings-info').textContent};
});

for (const [label, value] of [['null', 'null'], ['array', '[]'], ['unrelated object', '{"document":"hello"}'], ['invalid JSON', '{broken'], ['future version', '{"version":99,"bpm":250}']]) {
  await check(`Import rejects ${label} while preserving current controls and pattern`, async () => {
    const app = createApp();await app.cell(0, 0).fire('click');app.el('bpm').value = 123;await app.el('bpm').fire('change');const before = JSON.stringify(app.api.captureSettings());
    await chooseFile(app, fileFor(value));
    return {ok: JSON.stringify(app.api.captureSettings()) === before && app.el('settings-info').textContent.includes('не изменены'), message: app.el('settings-info').textContent};
  });
}

await check('Oversized imports are rejected before reading their contents', async () => {
  const app = createApp();let reads = 0;await chooseFile(app, {size: 65537, async text() {reads++;return '{"bpm":250}';}});
  return {ok: reads === 0 && app.api.state.bpm === 100 && app.el('settings-info').textContent.includes('слишком большой'), reads};
});

await check('The newest concurrent import wins even when an earlier read finishes last', async () => {
  const app = createApp(), slow = deferred();const first = chooseFile(app, {size: 20, text: () => slow.promise});
  await chooseFile(app, fileFor({bpm: 180}));slow.resolve('{"bpm":120}');await first;
  return {ok: app.api.state.bpm === 180 && JSON.parse(app.storage.values.get(settingsKey)).bpm === 180, finalBpm: app.api.state.bpm};
});

await check('An obsolete failed import cannot overwrite a newer successful notice', async () => {
  const app = createApp(), slow = deferred();const first = chooseFile(app, {size: 20, text: () => slow.promise});
  await chooseFile(app, fileFor({bpm: 180}));const message = app.el('settings-info').textContent;slow.reject(new Error('Old file failed'));await first;
  return {ok: app.api.state.bpm === 180 && app.el('settings-info').textContent === message, message: app.el('settings-info').textContent};
});

await check('Starting playback during an asynchronous import cancels that import', async () => {
  const app = createApp(), slow = deferred();app.el('mic').checked = false;const importing = chooseFile(app, {size: 20, text: () => slow.promise});
  await app.api.start();slow.resolve('{"bpm":250}');await importing;
  const evidence = {ok: app.api.state.running && app.api.state.bpm === 100 && app.el('settings-info').textContent.includes('отменена'), message: app.el('settings-info').textContent};app.api.stop();return evidence;
});

await check('A start-and-stop race still invalidates a previously opened settings file', async () => {
  const app = createApp(), slow = deferred();app.el('mic').checked = false;const importing = chooseFile(app, {size: 20, text: () => slow.promise});
  await app.api.start();app.api.stop();slow.resolve('{"bpm":250}');await importing;
  return {ok: !app.api.state.running && app.api.state.bpm === 100 && app.el('settings-info').textContent.includes('отменена'), bpm: app.api.state.bpm};
});

await check('Opening import during playback is refused and its UI control is disabled', async () => {
  const app = createApp();app.el('mic').checked = false;await app.api.start();let reads = 0;await chooseFile(app, {size: 20, async text() {reads++;return '{"bpm":250}';}});
  const evidence = {ok: app.el('import-settings').disabled && reads === 0 && app.api.state.bpm === 100 && app.el('settings-info').textContent.includes('Остановите'), reads};app.api.stop();return evidence;
});

await check('A blank pattern schedules quarter-note metronome clicks without default eighth-note drums', async () => {
  const app = createApp();app.el('mic').checked = false;await app.api.start();const ctx = app.api.getContext(), epoch = app.api.state.epoch;
  for (let time = epoch;time < epoch + 2.4;time += .025) {ctx.currentTime = time;app.api.schedule();}
  const beatSources = app.scheduled.filter(source => source.when >= epoch && source.when < epoch + 2.4 - 1e-6);
  const evidence = {ok: beatSources.length === 4 && beatSources.every(source => app.api.getClickBuffers().includes(source.buffer) && source.connections[0] === app.api.getClickGain()), scheduledClicks: beatSources.length};app.api.stop();return evidence;
});

await check('Each drum routes through its own saved gain while the metronome uses a separate gain', async () => {
  const app = createApp(), pattern = Array.from({length: 4}, () => Array(32).fill(false));pattern.forEach(row => row[0] = true);app.api.applySettings({mic: false, pattern, trackVolumes: [20, 40, 60, 80], clickVolume: 35});await app.api.start();app.api.getContext().currentTime = app.api.state.epoch;app.api.schedule();
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

const passed = results.filter(result => result.status === 'PASS').length, failed = results.length - passed;
console.log(JSON.stringify({target, passed, failed, scope: 'DOM/audio/storage/clock integration doubles; no physical device or real browser verification.', results}, null, 2));
Deno.exitCode = failed ? 1 : 0;
