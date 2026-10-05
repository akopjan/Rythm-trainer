// Candidate waveform attribution only; synthetic audio, no physical microphone.
const target=Deno.args[0]??'index.html';
const html=await Deno.readTextFile(target),source=String(target).endsWith('.js')?html:html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)?.[1];
if(!source)throw new Error('Missing inline audio DSP script');
const EchoAttribution=new Function(source+';return EchoAttribution;')();
const results=[],record=(name,ok,evidence={})=>results.push({name,status:ok?'PASS':'FAIL',evidence});
const read=(array,position)=>{const i=Math.floor(position),f=position-i;return i>=0&&i+1<array.length?array[i]*(1-f)+array[i+1]*f:0;};
const check=(name,run)=>{try{const evidence=run();record(name,evidence.ok,evidence);}catch(error){record(name,false,{error:error.message});}};
function simulate({rate=8000,delay=.065,reflections=[[.02,.25]],nearAmplitude=0,frequency=220,kind='mixed',inverted=false,changed=null,noEchoProof=false,ready=true,anchor=true,headphones=false,heldAmplitude=0,legato=false,directGain=.55,callbackLag=0,canAudit=false,backgroundNoise=0,pitches=[330,440,293.66],clockLeadSamples=0,clockJitter=false}={}){
 const duration=3.6,length=Math.ceil(duration*rate),render=new Float32Array(length),capture=new Float32Array(length),clean=new Float32Array(length),predicted=new Float32Array(length),times=[.45,1.15,1.85],events=[],emitted=[],timings=[];
 let seed=173;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};
 const pulseLength=Math.ceil(.075*rate);
 for(const when of times){const offset=Math.round(when*rate);for(let j=0;j<pulseLength;j++){const dt=j/rate;render[offset+j]+=.18*Math.min(1,dt/.001)*Math.exp(-dt*65)*(kind==='click'?Math.sin(2*Math.PI*1100*dt):.45*random()+.5*Math.sin(2*Math.PI*70*dt)+.15*Math.sin(2*Math.PI*1700*dt));}}
 const echoTimes=times.map(time=>time+delay+(reflections[0]?.[0]??0));
 for(let i=0;i<length;i++){
  const t=i/rate,direct=headphones?0:(inverted?-directGain:directGain)*read(render,i-delay*rate);let residual=0,near=0;
  for(const [offset,gain] of reflections)residual+=(headphones?0:gain)*read(render,i-(delay+offset)*rate);
  if(changed!==null)residual+=(headphones?0:.55)*read(render,i-changed*rate)-direct;
  for(const when of echoTimes){const dt=t-when;if(dt>=0&&dt<.38){const envelope=Math.min(1,dt/.018)*Math.min(1,(.38-dt)/.025);near+=nearAmplitude*envelope*(Math.sin(2*Math.PI*frequency*t)+.32*Math.sin(4*Math.PI*frequency*t)+.19*Math.sin(6*Math.PI*frequency*t));}}
  if(heldAmplitude){let old=frequency,current=frequency,cross=1;for(let note=0;note<echoTimes.length;note++){if(t<echoTimes[note])break;old=current;current=legato?pitches[note]:frequency;cross=Math.min(1,(t-echoTimes[note])/.018);}const tone=f=>Math.sin(2*Math.PI*f*t)+.32*Math.sin(4*Math.PI*f*t)+.19*Math.sin(6*Math.PI*f*t);near+=heldAmplitude*((1-cross)*tone(old)+cross*tone(current));}
  near+=backgroundNoise*random();
  predicted[i]=direct;capture[i]=direct+residual+near;clean[i]=residual+near;
 }
 const classifier=new EchoAttribution(rate,m=>emitted.push({...m}));
 for(let i=0;i<length;i+=128){
  const end=Math.min(i+128,length),t=i/rate,start=performance.now();
  // The paired PCM is continuous even when raw AudioWorklet timestamps take
  // a small forward step or repeat/catch up. Neither changes received samples.
  const jitter=clockJitter?(i/128%60===8?-128:i/128%60===24?128:0):0,clockOffset=i>0?(clockLeadSamples+jitter)/rate:0;
  classifier.process(render.subarray(i,end),capture.subarray(i,end),clean.subarray(i,end),t+clockOffset,{enabled:true,ready,canAudit,noEchoProof,renderRecent:true,cancelReady:anchor,delayMs:anchor?delay*1000:null,predictedBlock:predicted.subarray(i,end)});
  for(const when of echoTimes)if(when+.006+callbackLag>=t&&when+.006+callbackLag<end/rate){const m={type:'onset',time:when+.006,level:.05};events.push(m);classifier.queue(m,.004);}
  timings.push(performance.now()-start);
 }
 return {classifier,emitted,events,echoTimes,timings};
}
for(const [name,options] of [
 ['A delayed room reflection is attributed to backing',{}],
 ['Several signed room paths are attributed without muting a time window',{reflections:[[.02,.25],[.061,-.12],[.102,.08]]}],
 ['An inverted acoustic copy is attributed with signed gains',{reflections:[[.04,-.35]],inverted:true}],
 ['A changed earlier hardware path and stale subtraction are both attributed',{reflections:[],changed:.025}],
 ['A changed later hardware path and stale subtraction are both attributed',{reflections:[],changed:.105}],
 ['A changed backing gain is attributed to its direct waveform',{reflections:[[0,.55]]}],
 ['Metronome room tails are attributed',{kind:'click',reflections:[[.035,.3]]}],
 ['Quiet-headphone proof still audits newly unmuted speaker echoes',{noEchoProof:true,ready:false,anchor:false,reflections:[[0,.55]]}],
 ])check(name,()=>{const run=simulate(options);return {ok:run.emitted.length===0&&run.classifier.rejected===3,published:run.emitted.length,rejected:run.classifier.rejected,pending:run.classifier.pending.length};});
for(const [name,options] of [
 ['Coincident bayan remains independently audible',{nearAmplitude:.14}],
 ['A quiet coincident bayan remains independently audible',{nearAmplitude:.012}],
 ['A bass bayan coincident with a kick remains independently audible',{nearAmplitude:.04,frequency:55}],
 ['A quiet bass bayan remains after loud echo attribution',{nearAmplitude:.012,frequency:55}],
 ['A bayan whose fundamental overlaps the metronome retains its harmonics',{nearAmplitude:.018,frequency:1100,kind:'click'}],
 ['A headphone player is retained despite a continuously rendered backing',{headphones:true,noEchoProof:true,ready:true,anchor:false,nearAmplitude:.025}],
 ])check(name,()=>{const run=simulate(options);return {ok:run.emitted.length===3&&run.emitted.every((message,i)=>message.time===run.events[i].time),published:run.emitted.length,expectedTimes:run.events.map(m=>m.time),actualTimes:run.emitted.map(m=>m.time)};});
for(const rate of [44100,48000,96000])check(`Fractional echo phase remains attributable at ${rate} Hz`,()=>{const run=simulate({rate,delay:.07333,reflections:[[.02217,.3]]}),sorted=[...run.timings].sort((a,b)=>a-b);return {ok:run.emitted.length===0&&run.classifier.rejected===3,published:run.emitted.length,rejected:run.classifier.rejected,p99BlockMs:sorted[Math.floor(sorted.length*.99)],maxBlockMs:Math.max(...sorted)};});
for(const clockJitter of [false,true])for(const nearAmplitude of [0,.012])check(`A 256-sample clock lead${clockJitter?' with paired 128-sample jitter':''} ${nearAmplitude?'retains quiet bayan timestamps':'still rejects the backing'}`,()=>{
 const run=simulate({rate:48000,clockLeadSamples:256,clockJitter,nearAmplitude}),expected=nearAmplitude?3:0,drops=run.classifier.dropCounts;
 return {ok:run.emitted.length===expected&&run.classifier.rejected===3-expected&&Object.keys(drops).length===0&&run.emitted.every((m,i)=>m.time===run.events[i].time),published:run.emitted.length,rejected:run.classifier.rejected,dropCounts:drops,actualTimes:run.emitted.map(m=>m.time)};
});
check('The recorded 132 ms observation window waits for its missing 193 samples',()=>{
 const rate=48000,base=.08533333333333333,block=new Float32Array(128),messages=[],classifier=new EchoAttribution(rate,m=>messages.push(m)),meta={enabled:true,ready:false,canAudit:true,referencePresent:true,renderRecent:true};
 let queued=false,early=null,almost=null;
 for(let offset=0;offset<38400;offset+=128){
  classifier.process(block,block,block,base+(offset+(offset?256:0))/rate,meta);
  if(!queued&&classifier.total>=32128){classifier.queue({type:'onset',time:.7493333333333334,captureTime:.7520000000000001,toneCheck:true});queued=true;}
  if(classifier.total===38144)early={pending:classifier.pending.length,rejected:classifier.rejected,stage:classifier.pending[0]?.stage??null};
  if(classifier.total===38272)almost={pending:classifier.pending.length,rejected:classifier.rejected};
 }
 return {ok:early?.pending===1&&early.rejected===0&&early.stage===null&&almost?.pending===1&&almost.rejected===0&&classifier.pending.length===0&&classifier.rejected===1&&classifier.lastDecision.reason==='below-threshold'&&Object.keys(classifier.dropCounts).length===0&&messages.length===0,early,almost,rejected:classifier.rejected,lastDecision:classifier.lastDecision,dropCounts:classifier.dropCounts};
});
check('An unlocked model still audits proven digital backing with signed room paths',()=>{const run=simulate({ready:false,canAudit:true,anchor:false,reflections:[[.02,.25],[.061,-.12],[.102,.08]]});return {ok:run.emitted.length===0&&run.classifier.rejected===3,published:run.emitted.length,rejected:run.classifier.rejected,pending:run.classifier.pending.length};});
check('A noisy microphone preserves quiet bayan while the acoustic model is unlocked',()=>{const run=simulate({ready:false,canAudit:true,anchor:false,nearAmplitude:.012,backgroundNoise:.006});return {ok:run.emitted.length===3,published:run.emitted.length,rejected:run.classifier.rejected};});
check('Background noise plus unlocked backing does not prove an instrument attack',()=>{const run=simulate({ready:false,canAudit:true,anchor:false,backgroundNoise:.006});return {ok:run.emitted.length===0,published:run.emitted.length,rejected:run.classifier.rejected};});
check('An unproven isolation state cannot publish raw candidate attacks',()=>{const run=simulate({ready:false,anchor:false});return {ok:run.emitted.length===0&&run.classifier.pending.length===0,published:run.emitted.length};});
check('Accepted analysis is queued with bounded storage and reset drops stale jobs',()=>{const classifier=new EchoAttribution(48000,()=>{});classifier.meta={enabled:true,ready:true};for(let i=0;i<100;i++)classifier.queue({type:'onset',time:i/100},.004);const before=classifier.pending.length;classifier.reset();return {ok:before===8&&classifier.pending.length===0&&classifier.total===0,queued:before};});
check('An overwritten reference window cannot prove a retained capture is an own attack',()=>{const rate=48000,messages=[],classifier=new EchoAttribution(rate,m=>messages.push(m)),block=new Float32Array(128).fill(.02),meta={enabled:true,ready:true,noEchoProof:true,renderRecent:true,cancelReady:false};for(let i=0;i<classifier.size+8192;i+=128)classifier.process(block,block,block,i/rate,meta);const oldest=classifier.total-classifier.size,signalTime=(oldest+.224*rate)/rate,captureStart=Math.floor((signalTime-.024)*rate);classifier.pending.push({message:{type:'onset',time:signalTime},signalTime,gate:.004});classifier.process(block,block,block,classifier.total/rate,meta);return {ok:captureStart>oldest&&messages.length===0&&classifier.pending.length===0&&classifier.lastDrop?.reason==='history-unavailable',captureRetained:captureStart>oldest,published:messages.length,pending:classifier.pending.length};});
check('The clear drained state publishes a candidate with its exact timestamp',()=>{const messages=[],classifier=new EchoAttribution(48000,m=>messages.push(m));classifier.meta={enabled:true,ready:true,noEchoProof:true,renderRecent:false};classifier.queue({type:'onset',time:4.1234,level:.01},.004);return {ok:messages.length===1&&messages[0].time===4.1234,published:messages.length};});
for(const [name,options] of [
 ['A backing attack during a held bayan is rejected',{heldAmplitude:.14}],
 ['A weak backing attack during a loud held bayan is rejected',{heldAmplitude:.14,directGain:.15,reflections:[[.02,.08]]}],
 ['A held bass bayan does not turn a backing attack into a new note',{heldAmplitude:.08,frequency:55}],
 ])check(name,()=>{const run=simulate(options);return {ok:run.emitted.length===0,published:run.emitted.length,rejected:run.classifier.rejected};});
check('A backdated spectral callback retains the real quiet bayan onset',()=>{const run=simulate({nearAmplitude:.012,callbackLag:.064});return {ok:run.emitted.length===3&&run.emitted.every((m,i)=>m.time===run.events[i].time),published:run.emitted.length};});
check('A legato pitch change remains an own attack after backing projection',()=>{const run=simulate({heldAmplitude:.04,legato:true});return {ok:run.emitted.length===3,published:run.emitted.length,rejected:run.classifier.rejected};});
for(const [name,options] of [
 ['Semitone legato remains an instrument attack after backing projection',{heldAmplitude:.04,legato:true,pitches:[233.08,246.94,261.63]}],
 ['Whole-tone legato remains an instrument attack after backing projection',{heldAmplitude:.04,legato:true,pitches:[246.94,277.18,311.13]}],
 ['Headphone semitone legato survives incidental rendered-tone correlation',{heldAmplitude:.04,legato:true,pitches:[233.08,246.94,261.63],headphones:true,anchor:false,noEchoProof:true}],
 ])check(name,()=>{const run=simulate(options);return {ok:run.emitted.length===3&&run.emitted.every((m,i)=>m.time===run.events[i].time),published:run.emitted.length,rejected:run.classifier.rejected};});
const passed=results.filter(r=>r.status==='PASS').length,failed=results.length-passed;
console.log(JSON.stringify({target,passed,failed,scope:'Synthetic candidate echo attribution; no physical microphone/browser validation.',results},null,2));Deno.exitCode=failed?1:0;
