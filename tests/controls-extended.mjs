// Read-only QA of the supplied standalone HTML. No browser or physical audio I/O.
const target = Deno.args[0] ?? 'index.html';
const html = await Deno.readTextFile(target);
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const results = [];
const record = (name, ok, evidence = {}) => results.push({name, status: ok ? 'PASS' : 'FAIL', evidence});
const close = (a,b,epsilon = 1e-6) => Math.abs(a-b) <= epsilon;

class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName; this.value = ''; this.checked = false; this.disabled = false;
    this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {};
    this.style = {setProperty(name,value) {this[name] = value;}};
    this.className = ''; this.textContent = ''; this.innerHTML = '';
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        const enabled = force ?? !names.has(name);
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(' '); return enabled;
      },
      remove: name => this.classList.toggle(name,false),
    };
  }
  append(...children) {for (const c of children) {this.children.push(c); if(typeof c === 'object') c.parentElement = this;}}
  replaceChildren(...children) {this.children = []; this.append(...children);}
  setAttribute(k,v) {this.attributes[k] = String(v);}
  addEventListener(k,fn) {(this.listeners[k] ??= []).push(fn);}
  async fire(type,event = {}) {for (const fn of this.listeners[type] ?? []) await fn({target:this,...event});}
  querySelector(tag) {return this.children.find(c => c.tagName === tag.toUpperCase());}
  getBoundingClientRect() {return {width:850,height:290};}
  focus() {doc.activeElement = this;}
}
const elements = new Map();
const el = id => elements.get(id);
for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const e = new Element(match[1].toUpperCase()), attr = match[2];
  e.id = match[3]; e.value = attr.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
  e.checked = /\bchecked\b/.test(attr); elements.set(e.id,e);
}
el('bars').value = '1'; el('division').value = '8'; el('rhythm-dsp').textContent = scripts[0];
if(el('signature'))el('signature').value='4';
if(el('input-mode'))el('input-mode').value='sustained';
record('Adaptive normalization is enabled by default in the saved UI',el('auto-normalize')?.checked===true);
// Fixed-mode regression cases still verify the explicit manual correction.
el('auto-normalize').checked=false;
// These transport/control regressions exercise the ordinary AEC route. The
// independent reference integration suite covers raw capture and its DSP link.
if(el('reference-sync'))el('reference-sync').checked=false;
el('start').append(new Element('SPAN'),new Element('PATH'));
el('chart').parentElement = new Element(); el('meter').parentElement = new Element();
const drawing = [];
const painter = {};
for(const method of ['scale','fillRect','beginPath','setLineDash','moveTo','lineTo','stroke','fillText','arc','fill']) {
  painter[method] = (...args) => drawing.push({method,args,fillStyle:painter.fillStyle});
}
el('chart').getContext = () => painter;
const descendants = e => [e,...(e.children ?? []).flatMap(c => typeof c === 'object' ? descendants(c) : [])];
const allElements = () => [...new Set([...elements.values()].flatMap(descendants))];
const doc = {
  hidden:false, activeElement:null, listeners:{}, getElementById:el,
  createElement:tag => new Element(tag.toUpperCase()), createTextNode:text => ({textContent:text}),
  querySelectorAll:selector => allElements().filter(e => selector === '.step' ? e.classList?.contains('step') : selector === '.current' ? e.classList?.contains('current') : selector === '[data-step],[data-head]' ? ('step' in (e.dataset ?? {}) || 'head' in (e.dataset ?? {})) : selector === '[data-track-enabled],[data-track-volume]' ? ('trackEnabled' in (e.dataset ?? {}) || 'trackVolume' in (e.dataset ?? {})) : false),
  addEventListener(k,fn) {(this.listeners[k] ??= []).push(fn);},
  fire(type,event = {}) {for (const fn of this.listeners[type] ?? []) fn(event);},
};
const contexts = [], scheduled = [], timerCallbacks = new Map(), animationCallbacks = new Map();
const micRequests=[];
let nextID = 1, micImpl, workletImpl = null;
const worklets = [];
class AudioNode {
  constructor() {this.connected = false; this.disconnected = false;}
  connect() {this.connected = true;}
  disconnect() {this.disconnected = true;}
}
class FakeContext {
  constructor() {this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = {}; this.baseLatency = 0; if(workletImpl) this.audioWorklet = {addModule:workletImpl}; contexts.push(this);}
  async resume() {}
  async close() {this.state = 'closed';}
  createGain() {return Object.assign(new AudioNode(),{gain:{value:0,setTargetAtTime(v) {this.value = v;}}});}
  createMediaStreamSource() {return new AudioNode();}
  createScriptProcessor() {return new AudioNode();}
  createBuffer(ch,n,rate) {const data = new Float32Array(n); return {getChannelData:() => data,duration:n/rate};}
  createBufferSource() {
    const node = new AudioNode(); node.start = when => {node.when = when; scheduled.push(node);};
    node.stop = () => {node.stopped = true;}; return node;
  }
}
function fakeStream() {
  const t = {readyState:'live',stopped:false,listeners:{},stop() {this.stopped = true;this.readyState = 'ended';},getSettings:() => ({echoCancellation:true}),addEventListener(k,fn) {this.listeners[k] = fn;}};
  return {track:t,getAudioTracks:() => [t],getTracks:() => [t]};
}
micImpl = async () => fakeStream();
const fakePerformance = {now:() => 1000,timeOrigin:1700000000000};
const win = {AudioContext:FakeContext,devicePixelRatio:1,addEventListener() {}};
class FakeWorkletNode extends AudioNode {
  constructor() {super();this.messages=[];this.port={onmessage:null,postMessage:m=>this.messages.push(m)};worklets.push(this);}
}
const Detector = new Function(scripts[0]+';return RhythmDetector;')();
const api = new Function('document','window','navigator','RhythmDetector','performance','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','setInterval','clearInterval',scripts[1]+`;return {state,pattern,addHit,start,stop,schedule,animate,clearResults,drawChart,renderGrid,handleDSP,makeSound,setControls,stepDuration,stepCount,cycleDuration,applyLatencyCorrection,measureLatency:typeof measureLatency==='function'?measureLatency:null,getContext:()=>context,getStream:()=>stream,getFallback:()=>fallback};`)(doc,win,{mediaDevices:{getUserMedia:(options) => {micRequests.push(options);return micImpl(options);}}},Detector,fakePerformance,class {observe() {}},fn => {const id=nextID++;animationCallbacks.set(id,fn);return id;},id => animationCallbacks.delete(id),(fn) => {const id=nextID++;timerCallbacks.set(id,fn);return id;},id => timerCallbacks.delete(id));
record('Full main script initializes with DOM and canvas doubles',doc.querySelectorAll('.step').length === 32 && el('start').querySelector('span').textContent === 'Start');

for (const bars of [1,2]) for (const division of [4,8,16]) {
  el('bars').value=String(bars);el('division').value=String(division);await el('division').fire('change');
  const buttons=doc.querySelectorAll('.step'), b=buttons.at(-1), p=(bars*division-1)*16/division;
  const before=api.pattern[3][p];await b.fire('click');
  record(`Grid ${bars} bars / ${division}: count, toggle, aria`,buttons.length===4*bars*division && api.pattern[3][p]===!before && b.attributes['aria-pressed']===String(!before));
}
for(const [value,expected] of [['0',30],['999',280],['',100],['145',145]]) {
  el('bpm').value=value;await el('bpm').fire('change');record(`BPM normalization ${JSON.stringify(value)}`,api.state.bpm===expected);
}
el('bpm').value='100';el('bars').value='1';el('division').value='8';await el('bpm').fire('change');
el('mic').checked=false;await el('mic').fire('change');await api.start();
record('Keyboard-only start locks settings and focuses chart',api.state.running && el('bpm').disabled && doc.activeElement===el('chart'));
api.getContext().currentTime=api.state.epoch+.6;
let prevented=false;doc.fire('keydown',{code:'Space',repeat:false,target:el('chart'),timeStamp:1000,preventDefault() {prevented=true;}});
record('Space on focused chart records a hit and prevents scroll',api.state.count===1 && prevented);
const countBefore=api.state.count;doc.fire('keydown',{code:'Space',repeat:true,target:el('chart'),timeStamp:1000,preventDefault() {}});
record('Holding Space does not create repeat hits',api.state.count===countBefore);
api.clearResults();const button=doc.querySelectorAll('.step')[0];button.focus();
let cellDefaultPrevented=false;const patternBeforeSpace=api.pattern[0][0];
doc.fire('keydown',{code:'Space',repeat:false,target:button,timeStamp:1000,preventDefault() {cellDefaultPrevented=true;}});
record('Space remains a hit after a pattern cell gets focus',api.state.count===1 && cellDefaultPrevented && api.pattern[0][0]===patternBeforeSpace,{count:api.state.count,target:button.tagName,defaultPrevented:cellDefaultPrevented,note:'Native browser button behavior requires live verification.'});
let repeatDefaultPrevented=false;doc.fire('keydown',{code:'Space',repeat:true,target:button,timeStamp:1000,preventDefault() {repeatDefaultPrevented=true;}});
record('Repeated Space on a cell cannot activate the cell or add hits',repeatDefaultPrevented && api.state.count===1);
for(const target of [el('start'),el('reset'),el('volume'),el('bpm'),el('division'),new Element('TEXTAREA'),new Element('SUMMARY')]) {
  const before=api.state.count;let prevented=false;
  doc.fire('keydown',{code:'Space',repeat:false,target,timeStamp:1000,preventDefault() {prevented=true;}});
  record(`Space preserves native behavior on ${target.id ?? target.tagName}`,api.state.count===before && !prevented);
}
el('mic').checked=true;let micModePrevented=false;const beforeMicKey=api.state.count;
doc.fire('keydown',{code:'Space',repeat:false,target:button,timeStamp:1000,preventDefault() {micModePrevented=true;}});
record('Microphone mode preserves native Space behavior on cells',api.state.count===beforeMicKey && !micModePrevented);el('mic').checked=false;
doc.hidden=true;doc.fire('visibilitychange');
record('Hiding page stops audio, clears timers, preserves existing results',!api.state.running && !timerCallbacks.size && !animationCallbacks.size && contexts.at(-1).state==='closed');doc.hidden=false;

api.state.running=true;api.state.epoch=10;api.state.readyTime=10;el('tolerance').value='30';el('latency').value='0';
for(const [offset,time] of [[-30,10.57],[30,10.63]]) {
  api.clearResults();drawing.length=0;api.addHit(time,'key');
  record(`Exact ${offset} ms boundary is inside ±30 ms`,el('accuracy').innerHTML.startsWith('100 ') && el('last-hit').textContent.endsWith('в допуске') && drawing.find(d=>d.method==='arc')?.fillStyle==='#167657',{computedError:api.state.events[0]?.error,accuracy:el('accuracy').innerHTML,lastHit:el('last-hit').textContent});
}
for(const tolerance of [1,30,100]) for(const sign of [-1,1]) {
  el('tolerance').value=String(tolerance);api.clearResults();api.addHit(10.6+sign*(tolerance+.01)/1000,'key');
  record(`A ${sign*(tolerance+.01)} ms attack is outside ±${tolerance} ms`,el('accuracy').innerHTML.startsWith('0 ') && !el('last-hit').textContent.endsWith('в допуске'));
}
api.clearResults();api.addHit(10.64,'key');
el('tolerance').value='50';await el('tolerance').fire('change');record('Changing tolerance recomputes existing results',el('accuracy').innerHTML.startsWith('100 '));
el('latency').value='80';await el('latency').fire('change');api.addHit(10.68,'mic');
record('Latency correction clears mixed measurements and corrects microphone only',api.state.count===1 && close(api.state.events[0].error,0));
api.addHit(10.68,'key');record('Latency correction leaves keyboard timing unchanged',close(api.state.events[1].error,80));
api.stop();el('latency').value='0';

await api.start();api.getContext().currentTime=api.state.epoch+.3;api.addHit(api.state.epoch+.3,'key');
api.getContext().currentTime=api.state.epoch+7*api.cycleDuration();drawing.length=0;api.drawChart();
const playingPoints=drawing.filter(d=>d.method==='arc').length;drawing.length=0;api.stop();
const stoppedPoints=drawing.filter(d=>d.method==='arc').length;
record('Stop preserves last-six-cycle chart window',playingPoints===stoppedPoints,{playingPoints,stoppedPoints});
drawing.length=0;api.stop();api.drawChart();record('Repeated Stop and redraw keep expired points hidden',drawing.every(d=>d.method!=='arc'));
await api.start();api.getContext().currentTime=api.state.epoch+.3;api.addHit(api.state.epoch+.3,'key');drawing.length=0;api.stop();
record('Stop keeps recent points visible in a fresh session',drawing.filter(d=>d.method==='arc').length===1);
api.clearResults();drawing.length=0;api.drawChart();record('Reset after Stop clears chart points',api.state.count===0 && drawing.every(d=>d.method!=='arc'));

el('mic').checked=true;await el('mic').fire('change');await api.start(true);
record('Calibration locks editable sound controls',api.state.calibrating && el('volume').disabled && doc.querySelectorAll('.step').every(e=>e.disabled));
const calCount=api.state.count;api.addHit(api.state.epoch+1);record('Calibration ignores player hits',api.state.count===calCount);
api.handleDSP({type:'calibrated'});record('Calibration completion restores controls and clears results',!api.state.calibrating && !el('volume').disabled && api.state.count===0);
const liveTrack=api.getStream().track;liveTrack.readyState='ended';liveTrack.listeners.ended();
record('Device disconnect stops active session and releases track',!api.state.running && !api.getStream() && liveTrack.stopped && el('status').textContent.includes('отключён'));
micImpl=async()=>{const err=new Error('busy');err.name='NotReadableError';throw err;};await api.start();record('Busy microphone is recoverable',!api.state.pending && !api.state.running && el('status').textContent.includes('занят'));
micImpl=async()=>{const err=new Error('missing');err.name='NotFoundError';throw err;};await api.start();record('Missing microphone is recoverable',!api.state.pending && el('status').textContent.includes('не найден'));
delete win.AudioContext;await api.start();record('Missing Web Audio produces visible error',!api.state.pending && el('status').textContent.includes('Web Audio'));win.AudioContext=FakeContext;
micImpl=async()=>fakeStream();workletImpl=async()=>{};win.AudioWorkletNode=FakeWorkletNode;globalThis.AudioWorkletNode=FakeWorkletNode;
await api.start();const worklet=worklets.at(-1);
record('AudioWorklet startup connects and receives threshold and arm messages',api.state.running && worklet.connected && worklet.messages.some(m=>m.type==='threshold') && worklet.messages.some(m=>m.type==='arm') && el('audio-info').textContent.includes('Анализ в AudioWorklet'));
api.stop();record('AudioWorklet stop disconnects processor and clears message listener',worklet.disconnected && worklet.port.onmessage===null);
workletImpl=async()=>{throw new Error('module unavailable');};await api.start();record('AudioWorklet module failure activates fallback detector',api.state.running && !!api.getFallback() && el('audio-info').textContent.includes('Резервный анализ'));api.stop();
let resolveModule;workletImpl=()=>new Promise(resolve=>resolveModule=resolve);const moduleStart=api.start();
await Promise.resolve();await Promise.resolve();const pendingStream=api.getStream();api.stop();resolveModule();await moduleStart;
record('Stop during pending AudioWorklet module releases mic and does not restart',!api.state.running && !api.state.pending && !api.getStream() && pendingStream.track.stopped);
workletImpl=null;delete win.AudioWorkletNode;delete globalThis.AudioWorkletNode;

function runDSP(detector,rate,duration,signal) {
  const block=new Float32Array(128);
  for(let i=0;i<duration*rate;i+=128) {for(let j=0;j<128;j++)block[j]=signal((i+j)/rate);detector.process(block,i/rate);}
}
for(const rate of [44100,48000,96000]) {
  const hits=[],d=new Detector(rate,m=>{if(m.type==='onset')hits.push(m.time);});d.configure({type:'arm',start:0,duration:2});
  const interval=60/280/4,times=Array.from({length:16},(_,i)=>.2+i*interval);
  runDSP(d,rate,1.3,t=>times.reduce((sum,start)=>{const dt=t-start;return sum+(dt>=0 && dt<.04 ? Math.sin(2*Math.PI*1700*dt)*Math.exp(-dt*100)*Math.min(1,dt/.0007)*.18 : 0);},0));
  record(`DSP fastest sixteenths at ${rate} Hz`,hits.length===16 && hits.every((t,i)=>Math.abs(t-times[i])<.007),{hits:hits.length,maxErrorMs:Math.max(...hits.map((t,i)=>Math.abs(t-times[i])*1000))});
}
// Feed synthesized instruments from the actual app through its detector.
el('mic').checked=false;await api.start();
for(const [type,name] of ['kick','snare','hat','cymbal'].entries()) {
  const buffer=api.makeSound(type).getChannelData(0),hits=[],d=new Detector(48000,m=>{if(m.type==='onset')hits.push(m.time);});
  d.configure({type:'arm',start:0,duration:3});
  runDSP(d,48000,3,t=>[.2,1.1,2].reduce((s,start)=>{const index=Math.floor((t-start)*48000);return s+(index>=0 && index<buffer.length ? buffer[index]*.6 : 0);},0));
  record(`DSP synthesized ${name}: one detection per attack`,hits.length===3,{hits});
}
api.stop();
if(el('signature')) {
  el('mic').checked=false;el('click').checked=true;el('bpm').value='100';await el('bpm').fire('change');
  for(const bars of [1,2])for(const division of [4,8,16]) {
    el('bars').value=String(bars);el('division').value=String(division);el('signature').value='3';await el('signature').fire('change');
    const perBar=3*division/4,grid=doc.querySelectorAll('.step');
    record(`3/4: ${bars} bars, 1/${division} has correct steps and duration`,api.state.beats===3 && grid.length===4*bars*perBar && close(api.cycleDuration(),1.8*bars));
    api.pattern.forEach(row=>row.fill(false));api.pattern[0][0]=true;api.pattern[0][16]=true;api.renderGrid();
    const kickCells=doc.querySelectorAll('.step').filter(b=>b.dataset.row===0 && b.attributes['aria-pressed']==='true');
    record(`3/4: ${bars} bars, 1/${division} preserves separate bar pattern storage`,kickCells.length===bars && kickCells.every((cell,i)=>cell.dataset.step===i*perBar));
    const heads=el('sequencer').children.filter(e=>e.dataset?.head!==undefined);
    record(`3/4: ${bars} bars, 1/${division} labels reset every three beats`,heads[0].textContent==='1' && heads[perBar-division/4].textContent==='3' && (bars===1||heads[perBar].textContent==='1'));
    const mark=scheduled.length;await api.start();const ctx=api.getContext(),epoch=api.state.epoch,end=epoch+api.cycleDuration();
    for(let t=0;t<end;t+=.025){ctx.currentTime=t;api.schedule();}
    const clicks=scheduled.slice(mark).filter(s=>s.when>=epoch-1e-6 && s.when<end-1e-6 && close(s.buffer.duration,.04));
    record(`3/4: ${bars} bars, 1/${division} schedules three clicks per bar with correct accents`,clicks.length===3*bars && clicks.every((s,i)=>close(s.when,epoch+i*.6) && (i%3===0 ? s.buffer===clicks[0].buffer : s.buffer!==clicks[0].buffer)));
    api.clearResults();api.addHit(end-.02,'key');record(`3/4: ${bars} bars, 1/${division} maps early next-cycle note correctly`,api.state.events[0].step===0 && api.state.events[0].cycle===1 && close(api.state.events[0].error,-20));api.stop();
  }
  el('bars').value='1';el('division').value='8';el('signature').value='4';await el('signature').fire('change');
  record('Switching back to 4/4 restores the full bar',doc.querySelectorAll('.step').length===32 && close(api.cycleDuration(),2.4) && el('signature-label').textContent==='4/4');
  el('input-mode').value='sustained';await el('input-mode').fire('change');record('Bayan profile selects sensitive -48 dB threshold',Number(el('threshold').value)===-48);
  el('mic').checked=true;micImpl=async()=>fakeStream();await api.start();
  record('Bayan profile is delivered to the microphone detector and locked during playback',api.getFallback().mode==='sustained' && el('input-mode').disabled && el('signature').disabled);api.stop();
  el('input-mode').value='percussive';await el('input-mode').fire('change');record('Percussion profile remains available with -38 dB threshold',Number(el('threshold').value)===-38);
  api.state.running=true;api.state.epoch=10;api.state.readyTime=10;el('latency').value='0';el('tolerance').value='30';api.clearResults();
  for(const [i,jitter] of [-.015,0,.015].entries())api.addHit(10+(2+i*2)*.3+.08+jitter,'mic');
  const previousCount=api.state.count;drawing.length=0;await el('normalize').fire('click');
  record('Normalize sets the microphone latency to the measured +80 ms',close(Number(el('latency').value),80));
  record('Normalize centers existing measurements while preserving individual variation and count',api.state.count===previousCount && Math.abs(api.state.sum/api.state.count)<.001 && api.state.events.every((e,i)=>close(e.error,[-15,0,15][i])) && close(api.state.sumAbs/api.state.count,10));
  record('Normalized chart and accuracy use compensated measurements',el('accuracy').innerHTML.startsWith('100 ') && el('bias').innerHTML.startsWith('0,0') && drawing.filter(d=>d.method==='arc').every(d=>d.fillStyle==='#167657'));
  api.addHit(10+8*.3+.08,'mic');record('Future notes receive the same learned latency correction',close(api.state.events.at(-1).error,0));
  await el('normalize').fire('click');record('Repeated normalization of centered results is stable',close(Number(el('latency').value),80) && api.state.count===4);
  api.clearResults();el('latency').value='40';for(let i=0;i<3;i++)api.addHit(10+(2+i*2)*.3+.08,'mic');await el('normalize').fire('click');
  record('Normalization adds only the residual offset to an existing manual correction',close(Number(el('latency').value),80) && Math.abs(api.state.sum)<.001);api.stop();
  api.state.running=true;api.state.epoch=10;api.state.readyTime=10;el('latency').value='0';api.clearResults();
  for(const [i,error] of [-149,-90,145].entries())api.addHit(10+(3+i*2)*.3+error/1000,'mic');await el('normalize').fire('click');
  record('Median normalization centers wrapped phases across the nearest-grid boundary',close([...api.state.errors].sort((a,b)=>a-b)[1],0,.001) && api.state.events.every(e=>Math.abs(e.error)<=150));api.stop();
  api.clearResults();api.setControls();record('Normalization is disabled without measurements',el('normalize').disabled);
}
if(api.state.attacks){
 api.state.running=true;api.state.epoch=10;api.state.readyTime=10;api.state.bpm=150;api.state.division=16;api.state.beats=3;api.state.bars=1;
 el('mic').checked=true;el('latency').value='0';el('tolerance').value='30';api.clearResults();
 for(const [i,error] of [-49,49].entries())api.addHit(10+(11+i*12)*.1+error/1000,'mic');
 const originals=api.state.attacks.map(e=>e.rawMs),unfittedMse=api.state.sumSq/api.state.count;
 await el('normalize').fire('click');
 record('Global normalization escapes the half-grid local minimum',close(Math.abs(Number(el('latency').value)),50,.001)&&close(api.state.sumSq/api.state.count,1,.001)&&unfittedMse>2400);
 record('Global fit recalculates 3/4 step and cycle assignments',Number(el('latency').value)===-50&&api.state.events[0].step===11&&api.state.events[0].cycle===0&&api.state.events[1].step===0&&api.state.events[1].cycle===2);
 record('Median fit recalculates accuracy, last hit and linear error',el('accuracy').innerHTML.startsWith('100 ')&&el('last-hit').textContent.endsWith('в допуске')&&el('mae').innerHTML.startsWith('1,0')&&el('spread').innerHTML.startsWith('1,0'));
 const snapshot=api.state.attacks.map(e=>[e.step,e.cycle,e.error]);
 for(const correction of [220.375,-121.123,500,-300,-50])api.applyLatencyCorrection(correction);
 record('Repeated correction rebuilds unchanged raw timestamps without cumulative shifts',api.state.attacks.every((e,i)=>e.rawMs===originals[i]&&e.step===snapshot[i][0]&&e.cycle===snapshot[i][1]&&close(e.error,snapshot[i][2])));
 await el('normalize').fire('click');record('Repeated global fit preserves its selected correction',close(Number(el('latency').value),-50,.001)&&close(api.state.sumSq/api.state.count,1,.001));
 api.state.bpm=100;api.state.division=8;api.state.beats=4;el('latency').value='0';api.clearResults();
 api.addHit(10.68,'mic');api.addHit(10.68,'key');api.applyLatencyCorrection(80);
 record('Recalculation compensates microphones individually in mixed history',close(api.state.events[0].error,0)&&close(api.state.events[1].error,80)&&api.state.count===2);
 const originalChartRect=el('chart').getBoundingClientRect;el('chart').getBoundingClientRect=()=>({width:0,height:290});
 api.clearResults();el('latency').value='0';
 for(let i=0;i<3001;i++)api.addHit(10+(2+i)*.3+(i<1501?-.04:.04),'mic');
 const expectedShift=-40;await el('normalize').fire('click');
 record('Integral fit includes every attack beyond the capped chart history',api.state.count===3001&&api.state.attacks.length===3001&&api.state.events.length===3000&&api.state.errors.length===3001&&close(Number(el('latency').value),expectedShift,.001));
 record('Older and visible events use one whole-session median rather than separate bar centers',close(api.state.attacks[0].error,0)&&close(api.state.events.at(-1).error,80)&&Math.abs([...api.state.errors].sort((a,b)=>a-b)[1500])<.001);
 api.stop();api.clearResults();record('Reset clears the complete immutable attack history',api.state.attacks.length===0&&api.state.events.length===0&&api.state.errors.length===0&&api.state.count===0);
 el('chart').getBoundingClientRect=originalChartRect;
}
// The visible table uses the complete corrected history, rather than a
// separately centered rhythm or a percentage based only on recent points.
api.state.running=true;api.state.epoch=10;api.state.readyTime=10;api.state.bpm=100;api.state.division=8;api.state.beats=3;api.state.bars=2;
el('mic').checked=true;el('latency').value='0';el('tolerance').value='30';api.clearResults();
for(const [step,error] of [[2,-10],[4,10],[7,-100],[9,80],[14,20]])api.addHit(10+step*.3+error/1000,'mic');
record('Bar table shows each chronological 3/4 bar with its own absolute error',el('bar-rows').children.length===3&&el('bar-rows').children[0].children[3].textContent==='10,0 мс'&&el('bar-rows').children[1].children[3].textContent==='90,0 мс'&&el('bar-rows').children[2].children[3].textContent==='20,0 мс');
record('The most problematic bar is highlighted and its sample count is visible',el('bar-problem').textContent.includes('такт 2')&&el('bar-problem').textContent.includes('2 атак')&&el('bar-rows').children[1].classList.contains('problem-bar'));
record('Two-bar pattern summary combines matching positions across cycles',el('bar-summary').children.length===2&&el('bar-summary').children[0].textContent.includes('13,3 мс')&&el('bar-summary').children[1].textContent.includes('90,0 мс'));
record('Bar table separates early/late attacks and median bias from magnitude',el('bar-rows').children[1].children[4].textContent==='-10,0 мс'&&el('bar-rows').children[1].children[6].textContent==='1 / 1');
await el('normalize').fire('click');
record('One median correction recomputes every bar without hiding bar-specific drift',close(Number(el('latency').value),10,.001)&&el('bar-rows').children[1].children[3].textContent==='90,0 мс'&&el('bar-problem').textContent.includes('такт 2')&&el('bar-rows').children[2].children[4].textContent==='+10,0 мс');
el('tolerance').value='100';await el('tolerance').fire('change');record('Tolerance changes recompute each bar percentage',el('bar-rows').children[1].children[5].textContent==='50%');
api.clearResults();el('latency').value='0';api.addHit(10+2*.3+.02,'mic');api.addHit(10+14*.3+.03,'mic');
record('An empty chronological bar shows missing data instead of perfect accuracy',el('bar-rows').children[1].children[2].textContent==='0'&&el('bar-rows').children[1].children[3].textContent==='—'&&el('bar-rows').children[1].children[5].textContent==='—');
api.clearResults();for(let bar=0;bar<15;bar++)api.addHit(10+(bar*6+1)*.3+.01,'mic');
record('Long sessions show the last twelve bars while ranking the whole history',el('bar-rows').children.length===12&&el('bar-rows').children[0].dataset.bar===4&&el('bar-range').textContent.includes('из 15')&&!el('show-all-bars').hidden);
await el('show-all-bars').fire('click');record('All-bars control expands the complete chronological table',el('bar-rows').children.length===15&&el('bar-rows').children[0].dataset.bar===1);
await el('show-all-bars').fire('click');record('All-bars control restores the recent twelve bars',el('bar-rows').children.length===12);
api.stop();record('Stop preserves the per-bar results',el('bar-rows').children.length===12&&el('bar-problem').textContent.includes('такт'));
api.clearResults();record('Reset clears the per-bar table and problem indication',el('bar-table-wrap').hidden&&!el('bar-empty').hidden&&el('bar-rows').children.length===0&&el('bar-problem').textContent.includes('Пока нет'));
api.state.beats=4;api.state.bars=1;
// Show that a late outlier cannot shift almost every regular attack earlier.
api.state.running=true;api.state.epoch=10;api.state.readyTime=10;el('latency').value='0';el('tolerance').value='30';
for(const [i,error] of [10,11,12,100].entries())api.addHit(10+(2+i*2)*.3+error/1000,'mic');
await el('normalize').fire('click');
record('Median correction leaves ordinary early and late notes around the line despite an outlier',close(Number(el('latency').value),11.5,.001)&&api.state.errors.filter(e=>e<0).length===2&&api.state.errors.filter(e=>e>0).length===2&&el('bias').innerHTML.startsWith('0,0'));
record('User error score is mean absolute deviation rather than a squared score',el('mae').innerHTML.startsWith('22,8')&&el('spread').innerHTML.startsWith('22,8'));
api.stop();api.clearResults();
el('mic').checked=false;await api.start();
api.getContext().currentTime=api.state.epoch+2*api.cycleDuration()+.1;api.animate();
record('Audible bars with no detected attacks appear as missing observations',el('bar-rows').children.length===3&&el('bar-rows').children.every(row=>row.children[2].textContent==='0'&&row.children[3].textContent==='—'));
api.stop();record('Stop preserves empty trailing bars from the elapsed session',el('bar-rows').children.length===3);
api.clearResults();record('Reset removes elapsed empty bars along with attacks',el('bar-rows').children.length===0&&api.state.lastBar===-1);
if(api.measureLatency){
 const rawStream=()=>{const stream=fakeStream();stream.track.getSettings=()=>({echoCancellation:false,noiseSuppression:false,autoGainControl:false});return stream;};
 el('mic').checked=true;micImpl=async()=>rawStream();el('latency').value='40';api.state.running=true;api.state.epoch=10;api.state.readyTime=10;api.clearResults();
 for(let i=0;i<3;i++)api.addHit(10+(2+i*2)*.3+.08,'mic');
 const beforeMeasurementCount=api.state.count,sourceMark=scheduled.length;await api.measureLatency();
 const ctx=api.getContext(),detector=api.getFallback(),probe=detector.probe,measurementTrack=api.getStream().track;
 record('Loopback requests unprocessed microphone capture',micRequests.at(-1).audio.echoCancellation===false && micRequests.at(-1).audio.noiseSuppression===false && micRequests.at(-1).audio.autoGainControl===false);
 record('Loopback replaces playback with eight isolated metronome clicks',api.state.measuring && !api.state.running && scheduled.length-sourceMark===8 && scheduled.slice(sourceMark).every(s=>close(s.buffer.duration,.04)));
 record('Loopback locks settings and shows a Stop control',el('start').querySelector('span').textContent==='Stop' && el('latency').disabled && el('volume').disabled && el('calibrate').disabled && doc.querySelectorAll('.step').every(s=>s.disabled));
 record('Loopback preserves existing session results while measuring',api.state.count===beforeMeasurementCount);
 const capture=new Float32Array(128),rate=ctx.sampleRate,source=scheduled[sourceMark].buffer.getChannelData(0);
 for(let i=0;i<probe.end*rate+128;i+=128){for(let j=0;j<128;j++){const t=(i+j)/rate;capture[j]=probe.times.reduce((sum,when)=>{const k=Math.floor((t-when-.073)*rate);return sum+(k>=0&&k<source.length?source[k]*.3:0);},0);}detector.process(capture,i/rate);}
 record('Acoustic loopback automatically stores the measured 73 ms correction',Math.abs(Number(el('latency').value)-73)<=2 && !api.state.measuring && el('latency-info').textContent.includes('Поправка применена'));
 record('Acoustic fit displays median delay and mean absolute jitter separately',el('latency-info').textContent.includes('Медианная задержка')&&el('latency-info').textContent.includes('среднее |отклонение|')&&el('latency-info').textContent.includes('8 из 8'));
 record('Acoustic correction recalculates preserved microphone measurements',api.state.count===beforeMeasurementCount && Math.abs(api.state.sum/api.state.count-7)<=2);
 record('Successful loopback releases microphone, context and timers',measurementTrack.stopped && ctx.state==='closed' && !timerCallbacks.size && !api.getStream());
 // A valid latency excursion is included, not rejected as an outlier. Feed
 // the actual app click buffer through DSP and verify the applied whole fit.
 const variableSourceMark=scheduled.length;await api.measureLatency();
 const variableContext=api.getContext(),variableDetector=api.getFallback(),variableProbe=variableDetector.probe,variableBuffer=scheduled[variableSourceMark].buffer.getChannelData(0);
 const lags=[.02,.02,.02,.02,.05,.10,.20,.30],expectedMedian=35;
 for(let i=0;i<variableProbe.end*rate+128;i+=128){for(let j=0;j<128;j++){const t=(i+j)/rate;capture[j]=variableProbe.times.reduce((sum,when,index)=>{const k=Math.floor((t-when-lags[index])*rate);return sum+(k>=0&&k<variableBuffer.length?variableBuffer[k]*.3:0);},0);}variableDetector.process(capture,i/rate);}
 record('Variable acoustic delay applies the median despite large late arrivals',Math.abs(Number(el('latency').value)-expectedMedian)<2&&!api.state.measuring&&variableContext.state==='closed'&&el('latency-info').textContent.includes('8 из 8'));
 record('Jittered acoustic fit recalculates all prior notes relative to its median',api.state.count===beforeMeasurementCount&&Math.abs(api.state.sum/api.state.count-(80-expectedMedian))<2);
 micImpl=async()=>fakeStream();await api.start();record('Normal training restores its usual echo-cancellation request after loopback',api.state.running && micRequests.at(-1).audio.echoCancellation===true);api.stop();
 const savedCorrection=Number(el('latency').value);micImpl=async()=>rawStream();await api.measureLatency();const failedTrack=api.getStream().track;
 api.handleDSP({type:'latency-result',id:api.state.token,ok:false,reason:'not-heard'});
 record('Unheard metronome keeps the previous correction and explains the failure',Number(el('latency').value)===savedCorrection && !api.state.measuring && failedTrack.stopped && el('latency-info').textContent.includes('Прежняя поправка сохранена'));
 await api.measureLatency();api.handleDSP({type:'latency-result',id:api.state.token,ok:true,delayMs:200,maeMs:NaN,matched:8,total:8});
 record('An invalid fit summary cannot apply a correction or leave capture open',Number(el('latency').value)===savedCorrection&&!api.state.measuring&&!api.getStream());
 await api.measureLatency();const cancelledTrack=api.getStream().track,staleID=api.state.token;await el('start').fire('click');
 record('Stop cancels active loopback and releases its resources',!api.state.measuring && !api.state.pending && cancelledTrack.stopped && !timerCallbacks.size && Number(el('latency').value)===savedCorrection && el('latency-info').textContent.includes('Замер отменён'));
 await api.measureLatency();api.handleDSP({type:'latency-result',id:staleID,ok:true,delayMs:400,spreadMs:0,matched:8,total:8});
 record('A late result from a cancelled loopback cannot overwrite a newer measurement',api.state.measuring && Number(el('latency').value)===savedCorrection);api.stop();
 let resolvePermission;micImpl=()=>new Promise(resolve=>resolvePermission=resolve);const pendingMeasurement=api.measureLatency();await Promise.resolve();api.stop();const lateStream=rawStream();resolvePermission(lateStream);await pendingMeasurement;
 record('Stop while loopback permission is pending releases a late microphone stream',lateStream.track.stopped && !api.state.pending && !api.state.measuring && !api.getStream());
 micImpl=async()=>rawStream();await api.measureLatency();api.getContext().currentTime=api.state.measurementEnd+1;for(const callback of [...timerCallbacks.values()])callback();
 record('Loopback watchdog prevents an indefinite measurement and preserves correction',!api.state.measuring && Number(el('latency').value)===savedCorrection && !timerCallbacks.size);
 await api.measureLatency();doc.hidden=true;doc.fire('visibilitychange');doc.hidden=false;record('Changing tabs stops loopback capture',!api.state.measuring && !api.getStream());
 micImpl=async()=>fakeStream();await api.measureLatency();record('A browser that leaves echo cancellation enabled is rejected safely',!api.state.measuring && !api.state.pending && !api.getStream() && Number(el('latency').value)===savedCorrection && el('latency-info').textContent.includes('эхоподавление'));
 el('mic').checked=false;await el('mic').fire('change');record('Loopback button is disabled when microphone capture is off',el('measure-latency').disabled);
}
// Test the enabled feature in the full application, including its archived
// bar results and interactions with manual controls, transport and capture.
api.stop();api.state.bpm=100;api.state.beats=4;api.state.bars=1;api.state.division=8;
el('mic').checked=true;el('auto-normalize').checked=true;el('latency').value='0';el('tolerance').value='30';
api.state.running=true;api.state.epoch=10;api.state.readyTime=10;api.clearResults();
let adaptiveIndex=2;const physicalDelays=[];
const playAdaptive=(delay,kind='mic')=>{const time=10+adaptiveIndex++*.3+delay/1000;if(kind==='mic')physicalDelays.push(delay);api.addHit(time,kind);};
for(let i=0;i<8;i++)playAdaptive(60);
record('Enabled adaptive mode waits for enough attacks before learning an offset',Number(el('latency').value)===0&&api.state.adaptive.samples.length===8&&!api.state.adaptive.ready&&el('adaptive-info').textContent.includes('8 из минимум 9'));
playAdaptive(60);
record('Adaptive bootstrap automatically learns a stable 60 ms microphone offset',close(Number(el('latency').value),60,.001)&&api.state.adaptive.ready&&api.state.count===9);
record('Bootstrap corrects provisional notes once and stores each applied offset',api.state.attacks.every(e=>close(e.error,0,.001)&&close(e.correctionMs,60,.001))&&el('mae').innerHTML.startsWith('0,0'));
const firstArchive=api.state.attacks.map(e=>({...e}));
// The preceding case independently proves an unreferenced +60 ms bootstrap.
// A physical +60 ms anchor makes the following +0..35 ms phase drift local;
// unreferenced phase learning intentionally cannot cross its initial ±60 ms.
const anchored=api.state.adaptive.setAnchor(60,'acoustic',api.state.attacks.at(-1).rawMs);
el('latency').value=String(anchored.delayMs);
let lastOffset=60,maxAdaptiveChange=0;const recentErrors=[];
for(let i=1;i<=100;i++){playAdaptive(60+i*.35);const offset=Number(el('latency').value);maxAdaptiveChange=Math.max(maxAdaptiveChange,Math.abs(offset-lastOffset));lastOffset=offset;if(i>60)recentErrors.push(api.state.attacks.at(-1).error);}
record('Adaptive mode follows gradual player phase drift relative to its acoustic anchor',Number(el('latency').value)>75&&Number(el('latency').value)<95&&recentErrors.reduce((s,e)=>s+Math.abs(e),0)/recentErrors.length<20&&api.state.adaptive.anchorMs===60&&api.state.adaptive.anchorSource==='acoustic'&&Math.abs(api.state.adaptive.phaseOffset)<=60);
record('Automatic updates are smooth rather than a full jump on each hit',maxAdaptiveChange<=6.001&&maxAdaptiveChange>0&&api.state.adaptive.updates>5);
record('Adaptive tracking preserves every old warmup event and bar assignment',firstArchive.every((old,i)=>Object.keys(old).every(key=>api.state.attacks[i][key]===old[key])));
for(let i=0;i<50;i++)playAdaptive(95);
const beforeOutlier=Number(el('latency').value);playAdaptive(195);
record('One late outlier remains in the score while the median correction stays stable',api.state.attacks.at(-1).error>95&&Math.abs(Number(el('latency').value)-beforeOutlier)<1&&el('last-hit').textContent.endsWith('позже'));
const bad=[];for(let i=0;i<8;i++){playAdaptive(185);bad.push({...api.state.attacks.at(-1)});}
for(let i=0;i<60;i++)playAdaptive(95);
record('Later normalization cannot improve a past bad bar retroactively',bad.every(old=>{const event=api.state.attacks.find(e=>e.rawMs===old.rawMs);return event&&event.error===old.error&&event.correctionMs===old.correctionMs&&event.step===old.step&&event.cycle===old.cycle;})&&bad.every(e=>e.error>70));
const archivedErrors=api.state.attacks.map(e=>e.error),archivedRaw=api.state.attacks.map(e=>e.rawMs);
el('auto-normalize').checked=false;await el('auto-normalize').fire('change');const pausedOffset=Number(el('latency').value);
for(let i=0;i<20;i++)playAdaptive(110);
record('Turning auto off freezes its offset immediately and clears the window',Number(el('latency').value)===pausedOffset&&api.state.adaptive.samples.length===0&&el('adaptive-info').textContent.includes('выключена'));
el('auto-normalize').checked=true;await el('auto-normalize').fire('change');
for(let i=0;i<9;i++)playAdaptive(110);
record('Enabling auto during a session waits for two bars and cannot bootstrap old history',Number(el('latency').value)===pausedOffset&&!api.state.adaptive.allowBootstrap&&api.state.adaptive.samples.length===9);
for(let i=0;i<35;i++)playAdaptive(110);
record('Re-enabled auto resumes a gradual correction for future notes',Number(el('latency').value)>pausedOffset&&Number(el('latency').value)<111);
record('Toggling auto never rewrites previously scored attacks',archivedErrors.every((e,i)=>e===api.state.attacks[i].error)&&archivedRaw.every((t,i)=>t===api.state.attacks[i].rawMs));
const sampleCount=api.state.adaptive.samples.length,keyboardOffset=Number(el('latency').value);playAdaptive(80,'key');
record('Keyboard attacks never enter the adaptive microphone estimator',api.state.adaptive.samples.length===sampleCount&&Number(el('latency').value)===keyboardOffset&&api.state.attacks.at(-1).correctionMs===0&&close(api.state.attacks.at(-1).error,80,.001));
for(const flag of ['pending','calibrating','measuring']){api.state[flag]=true;const n=api.state.count;playAdaptive(110);record(`Adaptive updates are suspended while ${flag}`,api.state.count===n&&api.state.adaptive.samples.length===sampleCount&&Number(el('latency').value)===keyboardOffset);api.state[flag]=false;}
el('mic').checked=false;playAdaptive(110);record('Adaptive normalization does not run without microphone mode',Number(el('latency').value)===keyboardOffset&&api.state.adaptive.samples.length===sampleCount);el('mic').checked=true;
// Explicit manual normalization may rebuild all history. It must estimate
// from raw times because adaptive events have different saved corrections.
playAdaptive(110);const rawPhases=api.state.attacks.filter(e=>e.kind==='mic').map(e=>{const p=e.rawMs/300;return (p-Math.round(p))*300;}).sort((a,b)=>a-b),middle=rawPhases.length>>1,expectedManual=rawPhases.length%2?rawPhases[middle]:(rawPhases[middle-1]+rawPhases[middle])/2;
await el('normalize').fire('click');
record('Explicit normalization fits immutable raw timing after adaptive offsets diverge',close(Number(el('latency').value),expectedManual,.001)&&api.state.attacks.filter(e=>e.kind==='mic').every(e=>close(e.correctionMs,expectedManual,.001))&&api.state.adaptive.samples.length===0);
api.stop();const stoppedOffset=Number(el('latency').value),stoppedCount=api.state.count;playAdaptive(0);
record('Stop freezes adaptive scoring and preserves the learned correction',api.state.count===stoppedCount&&Number(el('latency').value)===stoppedOffset);
micImpl=async()=>fakeStream();await api.start();record('New sessions start with a fresh adaptive window and preserved starting offset',api.state.running&&api.state.adaptive.samples.length===0&&!api.state.adaptive.ready&&api.state.adaptive.allowBootstrap&&Number(el('latency').value)===stoppedOffset);api.stop();
api.state.running=true;api.state.epoch=10;api.state.readyTime=10;api.clearResults();for(let i=0;i<9;i++)api.addHit(10+(2+i)*.3+Number(el('latency').value)/1000,'mic');
el('latency').value='40';await el('latency').fire('change');record('Manual correction changes clear old adaptive observations and scores',Number(el('latency').value)===40&&api.state.count===0&&api.state.adaptive.samples.length===0);
api.stop();micImpl=async()=>fakeStream();await api.start(true);record('Calibration locks the auto control and cannot learn from its own rhythm',el('auto-normalize').disabled&&api.state.calibrating&&api.state.adaptive.samples.length===0);api.stop();
const rawAdaptiveStream=()=>{const s=fakeStream();s.track.getSettings=()=>({echoCancellation:false});return s;};micImpl=async()=>rawAdaptiveStream();await api.measureLatency();
record('Acoustic measurement suspends auto normalization and starts with no stale adaptive window',el('auto-normalize').disabled&&api.state.measuring&&api.state.adaptive.samples.length===0);api.stop();api.clearResults();
const summary={target,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,scope:'Synthetic signals and browser API/DOM doubles; no live browser, layout or physical microphone validation.',results};
console.log(JSON.stringify(summary,null,2));
Deno.exitCode = summary.failed ? 1 : 0;
