// Local unwrapped phase tracking and independent acoustic-anchor regressions.
// Read production-equivalent JS or a staged standalone HTML; no physical I/O.
const target=Deno.args[0]??'index.html';
const source=await Deno.readTextFile(target),results=[];
const record=(name,ok,evidence={})=>results.push({name,status:ok?'PASS':'FAIL',evidence});
const close=(a,b,epsilon=1e-6)=>Number.isFinite(a)&&Math.abs(a-b)<=epsilon;
const clamp=(x,low,high)=>Math.min(high,Math.max(low,x));
const phase=(raw,step)=>raw-Math.round(raw/step)*step;

function declaration(text,name){
 const start=text.search(new RegExp('class\\s+'+name+'\\s*\\{'));
 if(start<0)throw new Error(`Missing class ${name}`);
 const body=text.indexOf('{',start);let depth=0,quote='',comment='';
 for(let i=body;i<text.length;i++){
  const c=text[i],next=text[i+1];
  if(comment==='line'){if(c==='\n')comment='';continue;}
  if(comment==='block'){if(c==='*'&&next==='/'){comment='';i++;}continue;}
  if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}
  if(c==='/'&&next==='/'){comment='line';i++;continue;}
  if(c==='/'&&next==='*'){comment='block';i++;continue;}
  if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
  if(c==='{')depth++;
  if(c==='}'&&--depth===0)return text.slice(start,i+1);
 }
 throw new Error(`Unclosed class ${name}`);
}
let AdaptiveNormalizer;
try{AdaptiveNormalizer=new Function('clamp',declaration(source,'AdaptiveNormalizer')+';return AdaptiveNormalizer;')(clamp);record('Local adaptive tracker is available without the global circular fit',typeof AdaptiveNormalizer==='function');}
catch(error){record('Local adaptive tracker is available without the global circular fit',false,{error:error.message});}
function check(name,run){try{const evidence=run();record(name,evidence.ok,evidence);}catch(error){record(name,false,{error:error.message});}}

function simulate({count=180,step=300,bar=2400,prior=0,allowBootstrap=true,anchor=null,delay=()=>60,jitter=()=>0,references=null,startIndex=1}={}){
 const tracker=new AdaptiveNormalizer(allowBootstrap),history=[],referenceUpdates=[];
 let correction=prior;
 if(anchor!==null){const update=tracker.setAnchor(anchor,'acoustic',0);if(Number.isFinite(update.delayMs))correction=update.delayMs;referenceUpdates.push(update);}
 for(let i=0;i<count;i++){
  const scheduled=(startIndex+i)*step;
  if(references){const value=references(i,scheduled);if(Number.isFinite(value)){const update=tracker.setAnchor(value,'acoustic',scheduled);if(Number.isFinite(update.delayMs))correction=update.delayMs;referenceUpdates.push(update);}}
  const rawMs=scheduled+delay(i,scheduled)+jitter(i),offsetAtHit=correction,error=phase(rawMs-correction,step),update=tracker.observe(rawMs,step,bar,correction);
  if(Number.isFinite(update.delayMs))correction=update.delayMs;
  history.push({i,scheduled,rawMs,offsetAtHit,error,update,correction});
 }
 return {tracker,history,referenceUpdates,correction};
}

if(AdaptiveNormalizer){
 check('Eight attacks never initialize a phase offset',()=>{const run=simulate({count:8});return {ok:run.correction===0&&!run.tracker.ready&&run.tracker.samples.length===8,correction:run.correction};});
 check('Nine coherent attacks spanning a bar learn an initial 60 ms at a 300 ms grid',()=>{const run=simulate({count:9});return {ok:close(run.correction,60)&&run.history.at(-1).update.status==='bootstrap'&&run.tracker.anchorMs===0&&close(run.tracker.phaseOffset,60),correction:run.correction,phaseOffset:run.tracker.phaseOffset};});
 check('Submillisecond alternating jitter is retained around a local median',()=>{const run=simulate({count:100,delay:()=>30,jitter:i=>i%2?.5:-.5});return {ok:Math.abs(run.correction-30)<.6&&run.history.slice(-40).some(row=>row.error<-.1)&&run.history.slice(-40).some(row=>row.error>.1),correction:run.correction};});
 check('A half-grid alternating cluster is held with an explicit local-bound reason',()=>{const run=simulate({count:180,delay:()=>0,jitter:i=>i%2?149:-149});return {ok:run.correction===0&&run.history.every(row=>row.correction===0)&&run.history[8].update.status==='bounded',correction:run.correction,status:run.history[8].update.status};});
 check('A slightly asymmetric half-grid cluster still cannot jump by an eighth note',()=>{const run=simulate({count:180,delay:()=>0,jitter:i=>i%3?148:-147});return {ok:run.correction===0&&Math.abs(run.tracker.phaseOffset)<=60,correction:run.correction,phaseOffset:run.tracker.phaseOffset};});
 check('A coherent distant cluster is rejected with the local-bound reason',()=>{const run=simulate({delay:()=>100});return {ok:run.correction===0&&!run.tracker.ready&&run.history.some(row=>row.update.status==='bounded'),correction:run.correction};});
 check('A later distant cluster cannot accumulate multiple local corrections',()=>{const run=simulate({count:350,delay:i=>i<30?60:120});return {ok:run.history.every(row=>Math.abs(row.correction)<=60+1e-6)&&close(run.correction,60)&&run.history.slice(80).some(row=>row.update.status==='bounded'),correction:run.correction,maxCorrection:Math.max(...run.history.map(row=>row.correction))};});
 check('The initial session prior remains the center of the phase bound',()=>{const run=simulate({prior:180,delay:()=>210});return {ok:close(run.correction,210)&&run.tracker.anchorMs===180&&run.history.every(row=>Math.abs(row.correction-180)<=60+1e-6),correction:run.correction,anchor:run.tracker.anchorMs};});
 check('Tracking a local change is gradual and does not bootstrap twice',()=>{const run=simulate({count:220,delay:i=>i<50?20:45});let largest=0;for(let i=1;i<run.history.length;i++)if(run.history[i].update.status==='tracking')largest=Math.max(largest,Math.abs(run.history[i].correction-run.history[i-1].correction));return {ok:run.correction>43&&run.correction<=45&&largest<=10+1e-6&&run.history.filter(row=>row.update.status==='bootstrap').length===1,correction:run.correction,largestStep:largest};});
 check('Every phase-learning target remains fixed after local updates',()=>{const run=simulate({count:140,delay:()=>30,jitter:i=>i%2?8:-8});return {ok:run.tracker.entries.every(entry=>entry.targetIndex===Math.round((entry.rawMs-entry.anchorAtHit)/300)&&close(entry.phaseMs,entry.rawMs-entry.targetIndex*300-entry.anchorAtHit)),samples:run.tracker.entries.length};});
 check('A proposed target-changing bootstrap is held with the explicit alias reason',()=>{const run=simulate({count:9,delay:()=>40,jitter:i=>i===0?-189:0});return {ok:run.correction===0&&!run.tracker.ready&&run.history.at(-1).update.status==='alias',correction:run.correction,status:run.history.at(-1).update.status};});
 check('Broad dispersion inside the local bound has the distinct uncertainty reason',()=>{const values=[-80,-50,-20,0,20,50,80,-80,-50],run=simulate({count:9,delay:()=>0,jitter:i=>values[i]});return {ok:run.correction===0&&!run.tracker.ready&&run.history.at(-1).update.status==='uncertain',correction:run.correction,status:run.history.at(-1).update.status};});
 check('A bad bar does not move a previously stable phase correction',()=>{const run=simulate({count:42,delay:()=>30,jitter:i=>i>=12&&i<24?(i%2?110:-110):0});return {ok:run.history.filter(row=>row.i>=12&&row.i<24).every(row=>close(row.correction,30))&&close(run.correction,30),correction:run.correction};});
 check('Initial tracking without bootstrap waits for two complete bars',()=>{const run=simulate({count:9,allowBootstrap:false,delay:()=>40});return {ok:run.correction===0&&run.history.every(row=>!Number.isFinite(row.update.delayMs)),correction:run.correction};});
 check('Phase tracking enabled mid-session learns only gradual local changes',()=>{const run=simulate({allowBootstrap:false,delay:()=>40});return {ok:run.correction>38&&!run.history.some(row=>row.update.status==='bootstrap')&&run.history.every(row=>Math.abs(row.correction)<=60+1e-6),correction:run.correction};});
 check('A long silent gap clears samples but preserves anchor and learned phase',()=>{const run=simulate({count:9,delay:()=>30});const update=run.tracker.observe(run.history.at(-1).rawMs+20000,300,2400,run.correction);return {ok:run.tracker.samples.length===1&&run.tracker.ready&&run.tracker.anchorMs===0&&close(run.tracker.phaseOffset,30)&&!Number.isFinite(update.delayMs)&&!run.tracker.allowBootstrap,samples:run.tracker.samples.length,phase:run.tracker.phaseOffset};});
 check('A post-gap distant phase cannot trigger a second startup jump',()=>{const run=simulate({count:9,delay:()=>30});let correction=run.correction;const updates=[];for(let i=0;i<30;i++){const update=run.tracker.observe(30000+i*300+120,300,2400,correction);if(Number.isFinite(update.delayMs))correction=update.delayMs;updates.push(update);}return {ok:close(correction,30)&&updates.every(update=>update.status!=='bootstrap'),correction};});
 check('Fractional 3/4 grids preserve a local bootstrap without integer rounding',()=>{const step=60000/137/4,run=simulate({step,bar:step*12,count:14,delay:()=>20});return {ok:close(run.correction,20,.002)&&run.tracker.entries.every(entry=>close(entry.phaseMs,20,.002)),step,correction:run.correction};});
 check('Hardware anchors allow a genuine initial 300 ms delay on a 300 ms grid',()=>{const run=simulate({count:60,anchor:300,delay:()=>300});return {ok:close(run.correction,300)&&run.tracker.anchorMs===300&&run.tracker.entries.every(entry=>entry.targetIndex===Math.round((entry.rawMs-300)/300)),correction:run.correction};});
 check('A hardware anchor retains both early and late jitter at a half-grid absolute delay',()=>{const run=simulate({count:120,anchor:150,delay:()=>150,jitter:i=>i%2?10:-10});const tail=run.history.slice(-40);return {ok:Math.abs(run.correction-150)<=10&&tail.some(row=>row.error< -5)&&tail.some(row=>row.error>5)&&run.tracker.entries.every(entry=>close(Math.abs(entry.phaseMs),10)),correction:run.correction};});
 check('The first acoustic anchor replaces unreferenced hardware-like phase without double correction',()=>{const run=simulate({count:25,delay:()=>40}),update=run.tracker.setAnchor(300,'acoustic',10000);return {ok:update.firstAcoustic&&close(update.delayMs,300)&&run.tracker.phaseOffset===0&&run.tracker.samples.length===0&&run.tracker.anchorSource==='acoustic',update};});
 check('Later acoustic drift preserves learned player phase and existing samples',()=>{const run=simulate({anchor:80,delay:()=>100,count:80}),before=run.tracker.entries.map(entry=>({...entry})),update=run.tracker.setAnchor(90,'acoustic',25000);return {ok:close(run.tracker.phaseOffset,20)&&close(update.delayMs,110)&&close(update.targetDelayMs,110)&&run.tracker.entries.length===before.length&&run.tracker.entries.every((entry,i)=>entry.targetIndex===before[i].targetIndex&&entry.anchorAtHit===80&&entry.phaseMs===before[i].phaseMs),update};});
 check('Old player samples do not cancel a new physical acoustic delay',()=>{const run=simulate({anchor:80,delay:()=>100,count:80});let correction=run.tracker.setAnchor(90,'acoustic',25000).delayMs;const update=run.tracker.observe(81*300+110,300,2400,correction);if(Number.isFinite(update.delayMs))correction=update.delayMs;return {ok:close(correction,110)&&close(run.tracker.phaseOffset,20)&&run.tracker.entries.at(-1).anchorAtHit===90&&close(run.tracker.entries.at(-1).phaseMs,20),correction,phase:run.tracker.phaseOffset};});
 check('A sudden later acoustic change is rate capped while exposing its absolute target',()=>{const tracker=new AdaptiveNormalizer();tracker.setAnchor(300,'acoustic',0);const update=tracker.setAnchor(480,'acoustic',1000),repeated=tracker.setAnchor(480,'acoustic',1000);return {ok:close(update.delayMs,310)&&close(update.targetDelayMs,480)&&!update.firstAcoustic&&close(repeated.delayMs,310),update,repeated};});
 check('Reference-driven hardware drift can exceed the original local phase neighborhood',()=>{const run=simulate({count:600,anchor:80,delay:(_,time)=>80+time*.001+20,references:(i,time)=>i%4===0?80+time*.001:null});const tail=run.history.slice(-40);return {ok:run.correction>260&&Math.abs(run.tracker.phaseOffset-20)<2&&tail.every(row=>Math.abs(row.error)<3)&&run.tracker.entries.every(entry=>Math.abs(entry.phaseMs)<23),correction:run.correction,anchor:run.tracker.anchorMs,phase:run.tracker.phaseOffset,maxTailError:Math.max(...tail.map(row=>Math.abs(row.error)))};});
 check('When acoustic references stop, the last anchor remains fixed',()=>{const run=simulate({anchor:80,count:180,delay:()=>100});return {ok:run.tracker.anchorMs===80&&run.tracker.anchorSource==='acoustic'&&close(run.correction,100)&&close(run.tracker.phaseOffset,20),correction:run.correction,anchor:run.tracker.anchorMs};});
 check('Player phase cannot learn a full step beyond an acoustic anchor',()=>{const run=simulate({anchor:80,count:120,delay:()=>190});return {ok:close(run.correction,80)&&run.tracker.phaseOffset===0&&run.history.some(row=>row.update.status==='bounded'),correction:run.correction,phase:run.tracker.phaseOffset};});
 check('Upper correction limits constrain total acoustic plus player offset',()=>{const run=simulate({anchor:495,step:2000,bar:8000,count:70,delay:()=>508,startIndex:10});return {ok:run.history.every(row=>row.correction<=500&&row.correction>=-300)&&close(run.correction,500),correction:run.correction,phase:run.tracker.phaseOffset};});
 check('Lower correction limits constrain total session plus phase offset',()=>{const run=simulate({prior:-295,step:2000,bar:8000,count:70,delay:()=>-308,startIndex:10});return {ok:run.history.every(row=>row.correction<=500&&row.correction>=-300)&&close(run.correction,-300),correction:run.correction};});
 check('Invalid and out-of-order attacks leave the sample window unchanged',()=>{const run=simulate({count:9}),before=JSON.stringify(run.tracker.entries),last=run.history.at(-1).rawMs,updates=[NaN,Infinity,-Infinity,last,last-100].map(raw=>run.tracker.observe(raw,300,2400,run.correction));return {ok:JSON.stringify(run.tracker.entries)===before&&updates.every(update=>!Number.isFinite(update.delayMs)),samples:run.tracker.samples.length};});
 check('Invalid acoustic references cannot overwrite the last reliable anchor',()=>{const tracker=new AdaptiveNormalizer();tracker.setAnchor(80,'acoustic',0);const updates=[NaN,Infinity,-301,501].map(value=>tracker.setAnchor(value,'acoustic',1000));return {ok:tracker.anchorMs===80&&tracker.lastCorrection===80&&updates.every(update=>!Number.isFinite(update.delayMs)),anchor:tracker.anchorMs};});
 check('The bounded sample buffer keeps raw times aligned with their fixed targets',()=>{const run=simulate({count:600,delay:()=>30});return {ok:run.tracker.samples.length<=48&&run.tracker.samples.length>=9&&run.tracker.entries.length===run.tracker.samples.length&&run.tracker.samples.every((raw,i)=>raw===run.tracker.entries[i].rawMs),samples:run.tracker.samples.length};});
 check('Reset releases the prior anchor and learned phase for a new session',()=>{const run=simulate({anchor:80,delay:()=>100});run.tracker.reset(false);return {ok:run.tracker.anchorMs===null&&run.tracker.phaseOffset===0&&run.tracker.samples.length===0&&!run.tracker.ready&&!run.tracker.allowBootstrap,anchor:run.tracker.anchorMs,phase:run.tracker.phaseOffset};});
}

const passed=results.filter(result=>result.status==='PASS').length,failed=results.length-passed;
console.log(JSON.stringify({target,passed,failed,scope:'Pure anchored phase and acoustic-delay timing; no physical browser or audio verification.',results},null,2));
Deno.exitCode=failed?1:0;
