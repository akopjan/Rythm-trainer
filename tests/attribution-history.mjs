// Synthetic source audits only. No recordings, device data or microphone access.
const target=Deno.args[0]??new URL('../dsp/echo-attribution.js',import.meta.url);
const input=await Deno.readTextFile(target),source=String(target).endsWith('.js')?input:input.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)?.[1];
if(!source)throw Error('Missing audio DSP source');
const Attribution=new Function(source+';return EchoAttribution;')();
const results=[];
function assert(value,message){if(!value)throw Error(message);}
function check(name,run){try{results.push({name,status:'PASS',evidence:run()});}catch(error){results.push({name,status:'FAIL',error:String(error)});}}
function legacyRing(a){
 a.size=2**Math.ceil(Math.log2(a.rate*1.1+512));a.mask=a.size-1;
 for(const name of ['render','capture','lowRender','lowCapture'])a[name]=new Float32Array(a.size);
 a.reset();
}
const read=(array,position)=>{const i=Math.floor(position),f=position-i;return i>=0&&i+1<array.length?array[i]*(1-f)+array[i+1]*f:0;};
function delayedAudit(rate,nearAmplitude=0,legacy=false){
 const n=128,delay=.108,renderTime=2,eventTime=renderTime+delay+.006;
 const length=Math.ceil(4*rate),render=new Float32Array(length),capture=new Float32Array(length),cleaned=new Float32Array(length),messages=[];
 let seed=317;
 const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};
 const start=Math.round(renderTime*rate);
 for(let i=0;i<Math.ceil(.09*rate);i++){
  const t=i/rate;render[start+i]=.24*Math.min(1,t/.001)*Math.exp(-t*60)*(.55*noise()+.35*Math.sin(2*Math.PI*70*t)+.1*Math.sin(2*Math.PI*1700*t));
 }
 for(let i=0;i<length;i++){
  const t=i/rate,dt=t-(renderTime+delay),env=dt>=0&&dt<.4?Math.min(1,dt/.018)*Math.min(1,(.4-dt)/.025):0;
  const near=nearAmplitude*env*(Math.sin(2*Math.PI*220*t)+.32*Math.sin(4*Math.PI*220*t)+.19*Math.sin(6*Math.PI*220*t));
  capture[i]=.65*read(render,i-delay*rate)+near;cleaned[i]=near;
 }
 const a=new Attribution(rate,m=>messages.push({...m}));if(legacy)legacyRing(a);
 const meta={enabled:true,ready:true,canAudit:true,referencePresent:true,renderRecent:true,cancelReady:true,delayMs:delay*1000,instrumentEvidence:()=>nearAmplitude>0};
 let queuedAt=null,releaseAt=null,preparedAt=null,targetJob=null;
 for(let i=0;i<length;i+=n){
  const end=Math.min(length,i+n);
  if(queuedAt!==null&&i/rate>=releaseAt&&a.pending[0]?.fixtureHead)a.pending[0].done=true;
  const wasStaged=targetJob?.stage;
  a.process(render.subarray(i,end),capture.subarray(i,end),cleaned.subarray(i,end),i/rate,meta);
  if(targetJob?.stage&&!wasStaged)preparedAt=i/rate;
  if(queuedAt===null&&end/rate>=eventTime+.064){
   // Park one head as a scheduler fixture while real paired PCM keeps arriving.
   // Its result is deliberately outside the assertions. The second job uses
   // the production queue, bounds, source snapshots and complete source fit.
   a.queue({type:'onset',time:eventTime});
   a.pending[0].fixtureHead=true;a.pending[0].stage='fixture-wait';
   a.queue({type:'onset',time:eventTime,captureTime:end/rate,source:'periodic',frequency:220,toneCheck:true,profileReady:true},.004);
   targetJob=a.pending[1];queuedAt=end/rate;releaseAt=queuedAt+.912;
  }
 }
 return {a,messages,eventTime,queuedAt,preparedAt,waitSeconds:preparedAt===null?null:preparedAt-queuedAt,targetJob};
}
for(const rate of [44100,48000,96000])for(const nearAmplitude of [0,.012])check(`A queued ${rate} Hz audit ${nearAmplitude?'retains quiet simultaneous instrument timing':'rejects pure delayed backing'}`,()=>{
 const run=delayedAudit(rate,nearAmplitude),{a,messages}=run;
 assert(Object.keys(a.dropCounts).length===0,'bounded queued audit lost source history');
 assert(run.waitSeconds>=.912&&run.waitSeconds<.912+256/rate,'fixture did not wait behind its head');
 assert(a.pending.length===0,'queued audit did not drain');
 if(nearAmplitude)assert(messages.length===1&&a.accepted===1&&messages[0].time===run.eventTime,'quiet independent source or its timestamp changed');
 else assert(messages.length===0&&a.accepted===0&&a.rejected===1&&a.lastDecision.reason==='speaker','known backing was published');
 return {ringSamples:a.size,ringSeconds:a.size/rate,waitSeconds:run.waitSeconds,accepted:a.accepted,rejected:a.rejected,dropCounts:a.dropCounts,expectedTime:run.eventTime,actualTimes:messages.map(m=>m.time)};
});
check('The old ring loses render history in the same bounded queued fixture',()=>{
 const {a,messages}=delayedAudit(48000,0,true),d=a.lastDrop;
 assert(a.dropCounts['history-unavailable']===1&&messages.length===0,'fixture does not reproduce original expired history');
 assert(d.start>=d.total-d.size&&d.historyStart<d.total-d.size,'fixture expired capture rather than the older rendered source');
 return {size:d.size,oldest:d.total-d.size,captureStart:d.start,renderStart:d.historyStart,accepted:a.accepted,rejected:a.rejected};
});
check('The observed queue bounds fit the retained history and not its previous capacity',()=>{
 // Scalar bounds of a delayed audit; source audio is synthetic constant PCM.
 const rate=48000,total=2024192,historyStart=1954875,captureStart=1969664,a=new Attribution(rate,()=>{});
 assert(total-historyStart===69317,'recorded bound arithmetic changed');
 assert(total-historyStart>a.rate*1.1+512,'fixture no longer distinguishes earlier allocation');
 assert(captureStart>=total-65536&&historyStart<total-65536,'older ring did not isolate render expiry');
 assert(historyStart>=total-a.size,'new ring does not retain observed render bounds');
 // The ring is filled by ordinary process() calls, including a full wrap.
 const n=128,render=new Float32Array(n).fill(.1),capture=new Float32Array(n).fill(.02),meta={enabled:true,ready:true,renderRecent:true,canAudit:true};
 for(let i=0;i<total;i+=n)a.process(render,capture,capture,i/rate,meta);
 assert(a.total===total&&Math.abs(a.at(a.render,historyStart)-.1)<1e-7&&Math.abs(a.at(a.capture,captureStart)-.02)<1e-7,'retained source/capture samples are not accessible');
 return {requiredSamples:total-historyStart,previousSize:65536,newSize:a.size,oldestRetained:a.total-a.size,renderValue:a.at(a.render,historyStart),captureValue:a.at(a.capture,captureStart)};
});
check('An audit with genuinely expired capture still rejects without publishing',()=>{
 const rate=48000,n=128,messages=[],a=new Attribution(rate,m=>messages.push(m)),x=new Float32Array(n).fill(.02),meta={enabled:true,ready:true,canAudit:true,renderRecent:true};
 const duration=a.size+Math.round(rate*.8);let at=0;
 for(;at<duration;at+=n)a.process(x,x,x,at/rate,meta);
 a.queue({type:'onset',time:.25,captureTime:at/rate,toneCheck:true});
 for(let k=0;k<100&&a.pending.length;k++)a.process(x,x,x,(at+k*n)/rate,meta);
 assert(messages.length===0&&a.dropCounts['history-unavailable']===1,'genuine capture expiry was accepted');
 assert(a.lastDrop.start<a.lastDrop.total-a.lastDrop.size&&a.lastDrop.historyStart===null,'capture expiry was not identified');
 return {published:messages.length,drop:a.lastDrop};
});
check('An audit with genuinely expired render history still rejects retained capture',()=>{
 const rate=48000,n=128,messages=[],a=new Attribution(rate,m=>messages.push(m)),x=new Float32Array(n).fill(.02),meta={enabled:true,ready:true,canAudit:true,renderRecent:true};
 let at=0;for(;at<a.size+rate;at+=n)a.process(x,x,x,at/rate,meta);
 const oldest=at-a.size,eventTime=(oldest+Math.round(rate*.20))/rate;
 a.queue({type:'onset',time:eventTime,captureTime:at/rate,toneCheck:true});
 for(let k=0;k<100&&a.pending.length;k++)a.process(x,x,x,(at+k*n)/rate,meta);
 assert(messages.length===0&&a.dropCounts['history-unavailable']===1,'genuine render expiry was accepted');
 const d=a.lastDrop;assert(d.start>=d.total-d.size&&d.historyStart<d.total-d.size,'source expiry did not distinguish retained capture');
 return {published:messages.length,captureRetained:true,drop:d};
});
const summary={target:String(target),passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,scope:'Synthetic queued source-history regression. The scheduler fixture models a parked audit head; no physical playback or note-recall claim.',results};
console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
