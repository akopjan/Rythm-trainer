// Test source-time evidence while slow waveform jobs wait in the audit queue.
const target=Deno.args[0]??new URL('../dsp/echo-attribution.js',import.meta.url),source=await Deno.readTextFile(target),Attribution=new Function(source+';return EchoAttribution;')();
const rate=8000,block=new Float32Array(64),results=[];
function run({early=false,latePositive=false,sourceRender=true}={}){
 const emitted=[],a=new Attribution(rate,m=>emitted.push(m.time)),seen=[],jobs=[];let clock=0;
 a.prepare=job=>{job.stage='test-delay';return true;};
 a.advance=job=>{if(clock>=.95)a.accept(job);};
 for(let offset=0;offset<rate*1.1;offset+=block.length){
  clock=(offset+block.length)/rate;const evidenceTime=clock-.024;
  const meta={enabled:true,ready:true,renderRecent:clock<.60?sourceRender:!sourceRender,evidenceTime,
   instrumentEvidence:time=>{seen.push({time,clock,evidenceTime});if(time===.25)return latePositive&&clock>.6;if(early&&evidenceTime<time+.13)return false;return clock<.6;},
   tonalEvidence:()=>clock<.6};
  a.process(block,block,block,offset/rate,meta);
  for(const [queuedAt,time] of [[.144,.12],[.208,.18],[.28,.25]])if(clock>=queuedAt&&!jobs.some(j=>j.message.time===time)){
   a.queue({type:'onset',time,toneCheck:true,profileReady:true,captureTime:clock},.004);jobs.push(a.pending.at(-1));
  }
 }
 return {emitted,jobs:jobs.map(j=>({time:j.message.time,snapshot:j.evidenceSnapshot,done:j.done})),seen,accepted:a.accepted,rejected:a.rejected};
}
const positive=run();results.push({name:'Evidence for all queued events survives the rolling source history',status:positive.emitted.join(',')==='0.12,0.18'&&positive.jobs.every(j=>j.snapshot?.time<.6)?'PASS':'FAIL',evidence:positive});
const guarded=run({early:true});results.push({name:'An event is not frozen before its130ms source lookahead exists',status:guarded.emitted.join(',')==='0.12,0.18'&&guarded.seen.every(x=>x.evidenceTime>=x.time+.13)?'PASS':'FAIL',evidence:guarded});
const negative=run({latePositive:true});results.push({name:'Later instrument activity cannot convert a background event to an own note',status:negative.emitted.join(',')==='0.12,0.18'&&negative.jobs.find(j=>j.time===.25)?.snapshot?.own===false?'PASS':'FAIL',evidence:negative});
const noRender=run({sourceRender:false});results.push({name:'Tonal snapshot preserves whether rendered backing was recent at the source observation',status:noRender.jobs.every(j=>j.snapshot?.tonal===false&&j.snapshot?.renderRecent===false)?'PASS':'FAIL',evidence:noRender.jobs});
const bypass=new Attribution(rate,()=>{});bypass.meta={enabled:false};bypass.queue({type:'onset',time:1});results.push({name:'Immediate non-audited events still pass through without a waveform snapshot',status:bypass.accepted===1&&bypass.pending.length===0?'PASS':'FAIL'});
const summary={passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,scope:'The actual public attribution classifier with an intentionally delayed audit head; source-time evidence is independent of acceptance time.',results};console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
