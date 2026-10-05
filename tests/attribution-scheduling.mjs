// Bounded scheduling changes when a waveform audit runs, never its source clock
// or the source/evidence tests that distinguish a player from speaker echoes.
const target=Deno.args[0]??new URL('../dsp/echo-attribution.js',import.meta.url);
const text=await Deno.readTextFile(target),source=String(target).endsWith('.html')?text.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)?.[1]:text;
const Attribution=new Function(source+';return EchoAttribution;')(),results=[];
const assert=(condition,message)=>{if(!condition)throw Error(message);};
function test(name,run){try{results.push({name,status:'PASS',evidence:run()});}catch(error){results.push({name,status:'FAIL',error:error.message});}}
function drainReady(a,options={budgetMs:1000,maxSteps:64}){
 let calls=0,steps=0,last;
 do{last=a.drain(options);steps+=last.steps;if(++calls>128)throw Error('Ready-work drain failed to stop');}while(last.more);
 return {...last,calls,steps};
}
const read=(array,position)=>{const at=Math.floor(position),f=position-at;return at>=0&&at+1<array.length?array[at]*(1-f)+array[at+1]*f:0;};
function simulate({accelerated=false,kind='bayan',rate=48000,delay=.065,clockLeadSamples=0}={}){
 const length=Math.ceil(rate*3.2),render=new Float32Array(length),capture=new Float32Array(length),emitted=[],decisions=[],times=[.45,1.15,1.85],events=times.map(t=>t+delay+.026);
 let seed=173;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};
 for(const time of times)for(let i=0;i<Math.ceil(.075*rate);i++){const age=i/rate;render[Math.round(time*rate)+i]+=.18*Math.min(1,age/.001)*Math.exp(-age*65)*(.45*random()+.5*Math.sin(2*Math.PI*70*age)+.15*Math.sin(2*Math.PI*1700*age));}
 for(let i=0;i<length;i++){
  const time=i/rate;let player=kind==='held'? .08:0;
  if(kind==='bayan')for(const event of events){const age=time-(event-.006);if(age>=0&&age<.38)player+=.012*Math.min(1,age/.018)*Math.min(1,(.38-age)/.025);}
  capture[i]=.55*read(render,i-delay*rate)+.25*read(render,i-(delay+.02)*rate)+player*(Math.sin(2*Math.PI*220*time)+.32*Math.sin(2*Math.PI*440*time)+.19*Math.sin(2*Math.PI*660*time));
 }
 const a=new Attribution(rate,message=>{emitted.push({...message});decisions.push({time:message.time,reason:'instrument',observedAt:a.currentTime});});a.setDeferredAnalysis(accelerated);
 const reject=a.reject.bind(a);a.reject=(job,reason)=>{reject(job,reason);decisions.push({time:job.message.time,reason,observedAt:a.currentTime});};
 let queued=0;
 for(let start=0;start<length;start+=128){
  const end=Math.min(start+128,length),offset=start?clockLeadSamples:0,meta={enabled:true,ready:true,canAudit:true,referencePresent:true,renderRecent:true,cancelReady:true,delayMs:delay*1000};
  a.process(render.subarray(start,end),capture.subarray(start,end),capture.subarray(start,end),(start+offset)/rate,meta);
  while(queued<events.length&&events[queued]+.006<end/rate){a.queue({type:'onset',time:events[queued],captureTime:events[queued]+.006,level:.05},.004);queued++;}
  if(accelerated)drainReady(a);
 }
 return {a,emitted,decisions,events};
}
for(const kind of ['speaker','bayan','held'])for(const delay of [.065,.07333])test(`${kind} admission and source timestamps survive faster scheduling at ${(delay*1000).toFixed(2)} ms`,()=>{
 const slow=simulate({kind,delay}),fast=simulate({kind,delay,accelerated:true});
 const outcome=run=>run.decisions.map(({time,reason})=>({time,reason}));
 assert(slow.decisions.length===3,'Conservative truth did not resolve every fixture event');
 assert(JSON.stringify(outcome(slow))===JSON.stringify(outcome(fast)),'Scheduling changed an admission reason or source timestamp');
 assert(fast.emitted.length===(kind==='bayan'?3:0),'Speaker/held-tone leaked or quiet coincident bayan was lost');
 assert(!Object.keys(fast.a.dropCounts).length,'Faster scheduling lost an audit window');
 return {accepted:fast.emitted.length,decisions:outcome(fast)};
});
test('Ready audits use CPU immediately instead of waiting for another input quantum',()=>{
 const slow=simulate({kind:'bayan'}),fast=simulate({kind:'bayan',accelerated:true});
 const slowWait=slow.decisions.map(d=>d.observedAt-d.time),fastWait=fast.decisions.map(d=>d.observedAt-d.time);
 assert(fastWait.every((wait,i)=>wait<slowWait[i]-.020),'Fixture did not remove at least20 ms of input-quantum waiting');
 return {conservativeDecisionWaitMs:slowWait.map(v=>v*1000),drainedDecisionWaitMs:fastWait.map(v=>v*1000),scope:'Deterministic source-time wait, not a browser CPU benchmark'};
});
test('A small raw-clock lead cannot replace the missing future PCM',()=>{
 const rate=48000,a=new Attribution(rate,()=>{throw Error('Incomplete waveform was admitted');}),block=new Float32Array(128).fill(.01),meta={enabled:true,ready:true,canAudit:true,renderRecent:true};a.setDeferredAnalysis(true);
 for(let offset=0;offset<rate*.6;offset+=128)a.process(block,block,block,(offset+(offset?256:0))/rate,meta);
 const signal=a.baseTime+a.total/rate;a.queue({type:'onset',time:signal,captureTime:signal,toneCheck:true},.004);
 const first=a.drain({budgetMs:100,maxSteps:64}),second=a.drain({budgetMs:100,maxSteps:64});
 assert(first.steps===0&&second.steps===0&&first.blocked&&second.blocked&&!first.more&&!second.more&&a.pending.length===1,'Missing samples triggered work or a retry spin');
 assert(a.pending[0].stage===undefined&&!a.rejected,'Premature prepare changed a candidate');
 return {blocked:first.blocked,pending:a.pending.length,receivedEnd:signal,rawClockEnd:a.currentTime};
});
test('Late harmonic evidence is awaited and cannot be manufactured by a continuation',()=>{
 const rate=48000,event=.4,emitted=[],a=new Attribution(rate,m=>emitted.push(m)),render=new Float32Array(128);let evidenceTime=-Infinity;a.setDeferredAnalysis(true);
 const feed=offset=>{const capture=Float32Array.from({length:128},(_,i)=>{const t=(offset+i)/rate;return t<event?0:.03*(Math.sin(2*Math.PI*220*t)+.36*Math.sin(2*Math.PI*440*t)+.19*Math.sin(2*Math.PI*660*t));});evidenceTime=(offset+128)/rate-1024/rate;a.process(render,capture,capture,offset/rate,{enabled:true,ready:true,canAudit:true,renderRecent:true,evidenceTime,instrumentEvidence:()=>evidenceTime>=event+.13});};
 let offset=0;for(;offset<Math.ceil(event*rate/128)*128;offset+=128)feed(offset);
 a.queue({type:'onset',time:event,captureTime:event,toneCheck:true,spectralCheck:true,profileReady:true},.004);
 for(;offset<Math.ceil((event+.134)*rate/128)*128;offset+=128)feed(offset);
 assert(a.total>=a.captureEnd(a.pending[0])&&evidenceTime<event+.13,'Fixture must close PCM before harmonic lookahead');
 const early=drainReady(a),again=drainReady(a);
 assert(early.steps===0&&again.steps===0&&early.blocked&&!early.more&&!again.more&&a.pending.length===1&&!a.rejected,'Incomplete evidence was consumed or repeatedly scheduled');
 for(;evidenceTime<event+.13;offset+=128)feed(offset);
 const final=drainReady(a);
 assert(emitted.length===1&&emitted[0].time===event&&a.rejected===0&&a.pending.length===0,'Completed harmonic evidence did not preserve the original instrument attack');
 return {blocked:early.blocked,decisionTime:a.lastDecision?.time,acceptedTime:emitted[0].time,completionSteps:final.steps};
});
test('A drain obeys its work-step bound and never advances the source clock',()=>{
 const rate=48000,block=Float32Array.from({length:128},(_,i)=>.04*Math.sin(2*Math.PI*i/19)),a=new Attribution(rate,()=>{}),meta={enabled:true,ready:true,canAudit:true,renderRecent:true,cancelReady:true,delayMs:65};a.setDeferredAnalysis(true);
 for(let offset=0;offset<rate*.7;offset+=128)a.process(block,block,block,offset/rate,meta);
 a.queue({type:'onset',time:.5,captureTime:.5},.004);
 const clock=a.currentTime,total=a.total,first=a.drain({budgetMs:1000,maxSteps:1});
 assert(first.steps===1&&first.pending===1&&first.more,'One-step fixture must retain unfinished ready work');
 for(let i=0;i<4;i++){const result=a.drain({budgetMs:1000,maxSteps:1});assert(result.steps<=1,'Drain exceeded its deterministic work-step bound');}
 assert(a.total===total&&a.currentTime===clock,'Continuation invented input samples or advanced audio time');
 return {steps:first.steps,pending:first.pending,more:first.more,sourceTime:clock};
});
test('FIFO stays bounded and captures are not advanced by draining queued jobs',()=>{
 const rate=48000,a=new Attribution(rate,()=>{}),block=new Float32Array(128).fill(.02),silent=new Float32Array(128),meta={enabled:true,ready:true,renderRecent:true};a.setDeferredAnalysis(true);
 for(let offset=0;offset<rate;offset+=128)a.process(silent,block,block,offset/rate,meta);
 const accepted=[];a.emit=m=>accepted.push(m.time);
 for(let i=0;i<9;i++)a.queue({type:'onset',time:.5+i*.01,captureTime:.5+i*.01},.004);
 assert(a.pending.length===8&&a.dropCounts['queue-full']===1,'Pending queue lost its memory bound');
 const total=a.total;drainReady(a);
 assert(accepted.length===8&&accepted.every((time,i)=>time===.5+i*.01),'Ready audit completion changed FIFO order or event times');
 assert(a.total===total&&a.pending.length===0,'Draining fabricated input or left completed jobs queued');
 return {acceptedTimes:accepted,dropped:a.dropCounts['queue-full'],total};
});
test('Lost reference drops deferred work without continuing a stale fit',()=>{
 const a=new Attribution(48000,()=>{throw Error('Missing reference admitted a point');}),block=new Float32Array(128).fill(.02);a.setDeferredAnalysis(true);
 a.process(block,block,block,0,{enabled:true,ready:true,canAudit:true,renderRecent:true});a.queue({type:'onset',time:0},.004);
 a.process(block,block,block,128/48000,{enabled:true,ready:false,canAudit:false,noEchoProof:false,renderRecent:true});
 const stopped=drainReady(a);
 assert(a.pending.length===0&&a.dropCounts['reference-unavailable']===1&&stopped.steps===0&&!stopped.more,'Reference loss did not stop queued attribution');
 return {dropCounts:a.dropCounts,steps:stopped.steps};
});
test('Clock reset clears deferred source jobs and preserves their diagnostic',()=>{
 const a=new Attribution(48000,()=>{throw Error('Stale source job admitted a point');}),block=new Float32Array(128).fill(.02),meta={enabled:true,ready:true,canAudit:true,renderRecent:true};a.setDeferredAnalysis(true);
 a.process(block,block,block,0,meta);a.queue({type:'onset',time:0},.004);a.process(block,block,block,1,meta);
 const stopped=drainReady(a);
 assert(a.pending.length===0&&a.dropCounts['clock-reset']===1&&stopped.steps===0&&!stopped.more&&a.baseTime===1,'Discontinuous source clocks kept stale work alive');
 return {dropCounts:a.dropCounts,baseTime:a.baseTime};
});
const summary={passed:results.filter(v=>v.status==='PASS').length,failed:results.filter(v=>v.status==='FAIL').length,scope:'Synthetic waveform classification and source-time scheduling. No microphone, browser underrun, or CPU deadline claims.',results};
console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
