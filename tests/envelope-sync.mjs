// Offline sync-only regressions. An optional private capture may be supplied;
// the default baseline is generated from the app's own sound formulas.
const here=new URL('.',import.meta.url),htmlPath=Deno.args[0]??new URL('../index.html',here).pathname;
const html=await Deno.readTextFile(htmlPath),scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
const dspScript=scripts.find(source=>source.includes('class ReferenceEcho {'));
if(!dspScript)throw new Error('ReferenceEcho was not found in the supplied app HTML');
const referenceStart=dspScript.indexOf('class ReferenceEcho {'),referenceEnd=dspScript.indexOf('\n// GENERATED_ATTRIBUTION_BEGIN',referenceStart);
if(referenceStart<0||referenceEnd<0)throw new Error('Could not isolate the embedded ReferenceEcho class');
const ReferenceEcho=new Function(dspScript.slice(referenceStart,referenceEnd)+';return ReferenceEcho;')();
const main=scripts.find(source=>source.includes('function makeSound('));
if(!main)throw new Error('makeSound was not found in the supplied app HTML');
const rate=48000,context={sampleRate:rate,createBuffer:(_c,n)=>{const d=new Float32Array(n);return{getChannelData:()=>d};}},soundStart=main.indexOf('function makeSound('),soundEnd=main.indexOf('\nfunction playBuffer(',soundStart);
const makeSound=new Function('context',main.slice(soundStart,soundEnd)+';return makeSound;')(context),sounds=[0,1,2].map(i=>makeSound(i).getChannelData(0));
let actual=null;
if(Deno.args[1]){
 const bytes=await Deno.readFile(Deno.args[1]),dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),tag=i=>String.fromCharCode(...bytes.subarray(i,i+4));let data,format;
 for(let i=12;i+8<=bytes.length;){const n=dv.getUint32(i+4,true),body=i+8;if(tag(i)==='fmt ')format={code:dv.getUint16(body,true),channels:dv.getUint16(body+2,true),rate:dv.getUint32(body+4,true),bits:dv.getUint16(body+14,true)};if(tag(i)==='data'){data=[body,n];break;}i=body+n+(n%2);}
 if(!data||!format||format.code!==1||format.channels!==1||format.rate!==rate||format.bits!==16)throw new Error('Optional capture must be 48 kHz mono PCM16');
 actual=Float32Array.from({length:data[1]/2},(_,i)=>dv.getInt16(data[0]+2*i,true)/32768);
}
const durationSamples=actual?.length??rate*16;
function reference(lagMs=100,hats=false){const out=new Float32Array(durationSamples),epoch=-.1070625-lagMs/1000;for(let beat=-8;beat<30;beat++){const start=Math.round((epoch+beat*.3)*rate),kinds=[2];if(!hats&&((beat%4)+4)%4===0)kinds.push(0);if(!hats&&((beat%4)+4)%4===2)kinds.push(1);for(const kind of kinds){const sound=sounds[kind];for(let i=Math.max(0,-start);i<sound.length&&start+i<out.length;i++)out[start+i]+=sound[i]*.4125;}}return out;}
function run(capture,render){const messages=[],snapshots=[],trace=[],engine=new ReferenceEcho(rate,m=>{if(m.type==='acoustic-sync'){messages.push(m);snapshots.push({message:m,cancelReady:engine.cancelReady,hNorm:engine.h.reduce((a,b)=>a+b*b,0)});}}),orig=engine.confirmEnvelope.bind(engine);engine.confirmEnvelope=(scan,t)=>{const result=orig(scan,t);trace.push({time:t,rawScore:scan.bestScore,identityScore:scan.identityScore,identityLagMs:scan.identityLag/engine.fineRate*1000,envelope:scan.envelope,confirmed:result});return result;};
 for(let i=0;i<capture.length;i+=128)engine.process(capture.subarray(i,i+128),render?.subarray(i,i+128),i/rate);return{engine,messages,snapshots,trace};}
const results=[],check=(name,ok,evidence)=>results.push({name,status:ok?'PASS':'FAIL',evidence});
const ref=reference();
if(actual){
 const baseline=run(actual,ref),locks=baseline.messages.filter(m=>m.status==='locked'&&m.method==='envelope');
 check('Physical baseline establishes virtual100ms envelope anchor before waveform authority',locks.length>=1&&locks.every(m=>Math.abs(m.delayMs-100)<=2),{delays:locks.map(m=>m.delayMs),firstLock:locks[0]?.time});
 check('Envelope anchor never authorizes waveform cancellation',baseline.snapshots.filter(s=>s.message.status==='locked'&&s.message.method==='envelope').every(s=>!s.cancelReady&&s.hNorm===0),{snapshots:baseline.snapshots});
 check('Envelope metadata declares coarse resolution separately',locks.length>0&&locks.every(m=>m.reason==='spectral-envelope'&&m.resolutionMs===2&&m.envelopeConfidence>=.65),{locks});
 check('Independent stable windows are required before bootstrap',locks.length>0&&baseline.trace.filter(t=>t.envelope&&t.rawScore>=.25&&t.identityScore>=.2&&t.time<locks[0].time).length>=1&&locks[0].time>=4.3,{firstLock:locks[0]?.time});
 check('Acoustic anchor never shifts by a300ms grid alias',locks.length>0&&baseline.messages.filter(m=>m.locked).every(m=>Math.abs(m.delayMs-100)<12),{delays:baseline.messages.filter(m=>m.locked).map(m=>m.delayMs)});
 for(const gain of[-1,2]){const result=run(Float32Array.from(actual,x=>x*gain),ref),locked=result.messages.filter(m=>m.status==='locked'&&m.method==='envelope');check('Signed/gain-changed physical baseline still synchronizes '+gain,locked.length>0&&locked.every(m=>Math.abs(m.delayMs-100)<=2),{delays:locked.map(m=>m.delayMs)});}
 const branch=run(actual,reference(400)),branchLocks=branch.messages.filter(m=>m.status==='locked'&&m.method==='envelope');check('Known reference clock selects400ms branch rather than100ms alias',branchLocks.length>0&&branchLocks.every(m=>Math.abs(m.delayMs-400)<=2),{delays:branchLocks.map(m=>m.delayMs)});
}
const controlCapture=actual??reference(0);
const silent=run(new Float32Array(controlCapture.length),ref);check('Silent headphones acquire no hardware anchor',!silent.engine.locked&&!silent.messages.some(m=>m.status==='locked'),{statuses:silent.messages.map(m=>m.status)});
const absent=run(controlCapture,null);check('Missing render cannot confirm envelope hardware anchor',!absent.engine.locked&&!absent.messages.some(m=>m.status==='locked'),{statuses:absent.messages.map(m=>m.status)});
// Deliberately mimic the backing's3band amplitude envelopes using unrelated
// pitched carriers. Rhythm/envelope similarity must not substitute for identity.
const fake=new Float32Array(ref.length),a=[300,2500].map(f=>1-Math.exp(-2*Math.PI*f/rate));let lo=0,mi=0,p0=0,p1=0,p2=0;const amp=Array.from({length:3},()=>new Float32Array(ref.length));
for(let i=0;i<ref.length;i++){lo+=a[0]*(ref[i]-lo);mi+=a[1]*(ref[i]-mi);const smoothing=.01;p0+=smoothing*(lo*lo-p0);p1+=smoothing*((mi-lo)**2-p1);p2+=smoothing*((ref[i]-mi)**2-p2);amp[0][i]=Math.sqrt(p0);amp[1][i]=Math.sqrt(p1);amp[2][i]=Math.sqrt(p2);}
for(let i=4800;i<fake.length;i++){const t=i/rate,j=i-4800;fake[i]=1.414*(amp[0][j]*Math.sin(2*Math.PI*95*t)+amp[1][j]*Math.sin(2*Math.PI*630*t)+amp[2][j]*Math.sin(2*Math.PI*6100*t));}
 const own=run(fake,ref);check('Rhythm-matched headphone instrument cannot fabricate hardware delay',!own.engine.locked&&!own.messages.some(m=>m.status==='locked'),{statuses:own.messages.map(m=>m.status),traceCount:own.trace.length});
if(actual){const hats=reference(100,true),periodicCapture=new Float32Array(hats.length);for(let i=4800;i<hats.length;i++)periodicCapture[i]=hats[i-4800]*.2;const periodic=run(periodicCapture,hats);check('Periodic hats retain unresolved absolute delay',!periodic.engine.locked&&!periodic.messages.some(m=>m.status==='locked'),{statuses:periodic.messages.map(m=>m.status)});}
const passed=results.filter(r=>r.status==='PASS').length;console.log(JSON.stringify({passed,failed:results.length-passed,privateCapture:!!actual,scope:'Sync-only virtual-clock regression from app-embedded ReferenceEcho, generated backing controls, and optional private speaker baseline. No physical hardware latency ground truth.',results},null,2));Deno.exitCode=passed===results.length?0:1;
