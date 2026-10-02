const html = await Deno.readTextFile(Deno.args[0] ?? 'index.html');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
const Detector = new Function(scripts[0]+';return RhythmDetector;')();
let passed=0;
function assert(ok, message){if(!ok)throw new Error(message);passed++;console.log('PASS '+message);}
function approx(a,b,tol=.001){return Math.abs(a-b)<tol;}
function pulse(t,f=800,amplitude=.18){return t>=0&&t<.06?Math.sin(2*Math.PI*f*t)*Math.exp(-t*100)*Math.min(1,t/.0007)*amplitude:0;}
function runDSP(detector,duration,fn,rate=48000){const chunk=new Float32Array(128);for(let i=0;i<duration*rate;i+=128){for(let k=0;k<128;k++)chunk[k]=fn((i+k)/rate);detector.process(chunk,i/rate);}}
for(const rate of [44100,48000]){
 const hits=[],d=new Detector(rate,m=>{if(m.type==='onset')hits.push(m.time)});d.configure({type:'arm',start:0,duration:2});runDSP(d,2,t=>[.2,.5,.8,1.1,1.4].reduce((s,x)=>s+pulse(t-x),0),rate);assert(hits.length===5,`DSP ${rate} Hz: exactly 5 separate attacks, no tail duplicates`);assert(hits.every((t,i)=>approx(t,[.2,.5,.8,1.1,1.4][i],.007)),`DSP ${rate} Hz: onset timestamps within 7 ms`);
}
{
 const hits=[],d=new Detector(48000,m=>{if(m.type==='onset')hits.push(m)});d.configure({type:'arm',start:0,duration:2});let seed=42;runDSP(d,2,t=>{seed=(seed*1664525+1013904223)>>>0;return (seed/2147483648-1)*.001});assert(hits.length===0,'DSP: quiet broadband noise does not create attacks');
}
{
 const hits=[],d=new Detector(48000,m=>{if(m.type==='onset')hits.push(m.time)});d.configure({type:'arm',start:0,duration:2});const interval=60/280/4;const onsets=Array.from({length:16},(_,i)=>.2+i*interval);runDSP(d,1.5,t=>onsets.reduce((s,x)=>s+pulse(t-x,1800),0));assert(hits.length===16,`DSP: fastest supported sixteenths (280 BPM), got ${hits.length}/16`);
}
{
 const hits=[],messages=[],d=new Detector(48000,m=>{messages.push(m);if(m.type==='onset')hits.push(m.time)});d.configure({type:'calibrate',start:0,duration:1});runDSP(d,5,t=>{const phase=t%1;let x=[.1,.35,.6,.85].reduce((s,a)=>s+pulse(phase-a,1000,.08),0);if(t>=4)x+=pulse(t-4.1,750,.23);return x;});assert(messages.filter(m=>m.type==='calibrated').length===1,'Echo profile completes once after three cycles');assert(hits.length===1&&approx(hits[0],4.1,.012),`Echo subtraction: background suppressed, simultaneous player hit retained (${JSON.stringify(hits)})`);
}
const elements = new Map();
function element(id){if(!elements.has(id))elements.set(id,{id,value:({bpm:'100',bars:'1',division:'8',tolerance:'30',latency:'0',volume:'55',threshold:'-38'})[id]||'',checked:['mic','click'].includes(id),disabled:false,style:{},dataset:{},append(){},replaceChildren(){},classList:{toggle(){},remove(){}},setAttribute(){},getBoundingClientRect(){return {width:0,height:290}},querySelector(){return {textContent:'',setAttribute(){}}},parentElement:{setAttribute(){}},getContext(){return {}},focus(){}});return elements.get(id);}
const doc={getElementById:element,querySelectorAll:()=>[],createElement:()=>element('temp')};
let gumImpl=async()=>fakeStream();
const nav={mediaDevices:{getUserMedia:(...a)=>gumImpl(...a)}};
let closed=0,trackStops=0,started=0,stopped=0;
function fakeStream(){return {getTracks(){return this.getAudioTracks()},getAudioTracks(){return [{stop(){trackStops++},addEventListener(){},getSettings(){return {echoCancellation:true}}}]}};}
class FakeContext{
 constructor(){this.currentTime=0;this.sampleRate=48000;this.state='running';this.destination={};this.baseLatency=.01}
 async resume(){} async close(){closed++}
 createGain(){return {gain:{value:0,setTargetAtTime(){}},connect(){},disconnect(){}}}
 createMediaStreamSource(){return {connect(){},disconnect(){}}}
 createScriptProcessor(){return {connect(){},disconnect(){},onaudioprocess:null}}
 createBuffer(ch,n,rate){const data=new Float32Array(n);return {getChannelData(){return data}}}
 createBufferSource(){return {connect(){},disconnect(){},start(){started++},stop(){stopped++}}}
}
const main=scripts[1].split("$('start').addEventListener")[0];
const api=new Function('document','window','navigator','RhythmDetector','requestAnimationFrame','cancelAnimationFrame','setInterval','clearInterval',main+';return {state,pattern,addHit,updateStats,clearResults,start,stop,schedule,stepDuration,stepCount,beginCalibration,audibleTime,getContext:()=>context,getStream:()=>stream};')(doc,{AudioContext:FakeContext},nav,Detector,()=>1,()=>{},()=>1,()=>{});
api.state.running=true;api.state.epoch=10;api.state.readyTime=10;
for(const bars of [1,2])for(const division of [4,8,16]){api.state.bars=bars;api.state.division=division;api.clearResults();const step=api.stepDuration();for(const error of [-.03,0,.03])api.addHit(10+step*3+error);assert(api.state.events.every((e,i)=>approx(e.error,[-30,0,30][i])),`Grid ${bars} bars × 1/${division}: signed offsets`);api.clearResults();api.addHit(10+step*api.stepCount()-.02);assert(api.state.events[0].step===0&&api.state.events[0].cycle===1&&approx(api.state.events[0].error,-20),`Grid ${bars} bars × 1/${division}: early attack across loop boundary`);}
api.state.bars=1;api.state.division=8;api.clearResults();element('tolerance').value=15;for(const error of [-.02,0,.02])api.addHit(10+.6+error);assert(approx(api.state.sumAbs/api.state.count,40/3),'Statistics: MAE for [-20,0,20] is 13.333 ms');assert(approx(api.state.sum/api.state.count,0),'Statistics: signed bias is zero');assert(element('spread').innerHTML.includes('13,3'),'Statistics: mean absolute deviation is 13.3 ms');assert(element('accuracy').innerHTML.startsWith('33 '),'Statistics: 33% inside ±15 ms');
api.clearResults();element('latency').value=80;api.addHit(10+.6+.08);assert(approx(api.state.events[0].error,0),'Microphone latency compensation subtracts configured offset');element('latency').value=0;api.stop();
await api.start();assert(api.state.running&&api.getStream(),'Start: audio and microphone start');api.getContext().currentTime=.20;api.schedule();assert(started>0,'Scheduler queues generated audio buffers');api.stop();assert(!api.state.running&&!api.getStream()&&stopped===started&&closed>=1&&trackStops>=1,'Stop: releases mic tracks, scheduled sources, context');
let resolveMic;gumImpl=()=>new Promise(resolve=>resolveMic=resolve);const pending=api.start();await Promise.resolve();assert(api.state.pending,'Permission request can remain pending');api.stop();const stopsBefore=trackStops;resolveMic(fakeStream());await pending;assert(!api.state.running&&trackStops===stopsBefore+1,'Stop while permission pending: late stream immediately released');
gumImpl=async()=>{const err=new Error('denied');err.name='NotAllowedError';throw err};await api.start();assert(!api.state.pending&&!api.state.running&&element('status').textContent.includes('не разрешён'),'Permission denied: recoverable visible error');
gumImpl=async()=>fakeStream();await api.start();assert(api.state.running,'Start works again after permission failure');api.stop();
// Regressions for rapid restarts and input-device loss while startup is pending.
let resolveOld;gumImpl=()=>new Promise(resolve=>resolveOld=resolve);const oldStart=api.start();await Promise.resolve();api.stop();gumImpl=async()=>fakeStream();await api.start();const live=api.getStream(),oldStops=trackStops;resolveOld(fakeStream());await oldStart;assert(api.state.running&&api.getStream()===live&&trackStops===oldStops+1,'Rapid Stop→Start: stale permission result cannot replace live stream');
api.getContext().getOutputTimestamp=()=>({contextTime:10,performanceTime:1000});assert(approx(api.audibleTime(975),9.975),'Keyboard maps the event timestamp, not delayed callback time');api.stop();
let onEnded,finishConstraints;const track={readyState:'live',stop(){trackStops++},getSettings(){return {echoCancellation:'all'}},getCapabilities(){return {echoCancellation:['all']}},applyConstraints(){return new Promise(r=>finishConstraints=r)},addEventListener(name,fn){if(name==='ended')onEnded=fn}};const lostStream={getAudioTracks:()=>[track],getTracks:()=>[track]};gumImpl=async()=>lostStream;const losingStart=api.start();await Promise.resolve();await Promise.resolve();assert(api.state.pending&&!!finishConstraints,'Microphone startup is cancellable during constraint negotiation');track.readyState='ended';onEnded();finishConstraints();await losingStart;assert(!api.state.running&&!api.state.pending&&!api.getStream(),'Device lost during pending startup: no dead microphone session');
// Weak player hit coincident with a louder calibrated rhythm.
for(const amplitude of [.04,.06,.08]){const hits=[];const d=new Detector(48000,m=>{if(m.type==='onset')hits.push(m.time)});d.configure({type:'calibrate',start:0,duration:1});runDSP(d,5,t=>[.1,.35,.6,.85].reduce((v,x)=>v+pulse(t%1-x,1000,.16),0)+pulse(t-4.1,1750,amplitude));assert(hits.length===1&&approx(hits[0],4.1,.01),`Echo: simultaneous hit at amplitude ${amplitude} survives louder .16 reference`);}
assert(!/<(?:script|link)[^>]+(?:src|href)="https?:\/\//.test(html),'Standalone HTML has no remote scripts, styles or fonts');
console.log(`\n${passed} checks passed.`);
