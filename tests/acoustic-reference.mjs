// Independent synthetic acoustic loopback QA. No physical audio or microphone.
const target=Deno.args[0]??'index.html';
const html=await Deno.readTextFile(target),scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const results=[],record=(name,ok,evidence={})=>results.push({name,status:ok?'PASS':'FAIL',evidence});
function declaration(source,name,kind='class'){
 const start=source.search(new RegExp(kind+'\\s+'+name+(kind==='class'?'\\s*\\{':'\\s*\\(')));if(start<0)throw new Error('Missing '+name);
 let depth=0,quote='',comment='';const body=source.indexOf('{',start);
 for(let i=body;i<source.length;i++){const c=source[i],next=source[i+1];if(comment==='line'){if(c==='\n')comment='';continue;}if(comment==='block'){if(c==='*'&&next==='/'){comment='';i++;}continue;}if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}if(c==='/'&&next==='/'){comment='line';i++;continue;}if(c==='/'&&next==='*'){comment='block';i++;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c==='{')depth++;if(c==='}'&&--depth===0)return source.slice(start,i+1);}
 throw new Error('Unclosed '+name);
}
const engineSource=declaration(scripts[0],'ReferenceEcho');
const ReferenceEcho=new Function(engineSource+';return ReferenceEcho;')();
const RhythmDetector=new Function(scripts[0]+';return RhythmDetector;')();
const soundSource=declaration(scripts[1],'makeSound','function');
const rms=(array,start=0,end=array.length)=>{let power=0;for(let i=start;i<end;i++)power+=array[i]*array[i];return Math.sqrt(power/Math.max(1,end-start));};
const sample=(array,position)=>{if(position<0||position>=array.length-1)return 0;const index=Math.floor(position),f=position-index;return array[index]*(1-f)+array[index+1]*f;};
function backing(rate,duration,kind='mixed'){
 const context={sampleRate:rate,createBuffer(ch,n,r){const pcm=new Float32Array(n);return {duration:n/r,getChannelData:()=>pcm};}},makeSound=new Function('context',soundSource+';return makeSound;')(context),buffers=[0,1,2,3].map(type=>makeSound(type).getChannelData(0)),result=new Float32Array(Math.round(rate*duration));
 const add=(type,time,gain)=>{const offset=Math.round(time*rate),buffer=buffers[type];for(let i=0;i<buffer.length&&offset+i<result.length;i++)result[offset+i]+=buffer[i]*gain;};
 for(let step=0;step*.3<duration;step++){const time=.25+step*.3;if(kind!=='silent')add(2,time,.36);if(kind==='mixed'){if(step%4===0)add(0,time,.45);if(step%4===2)add(1,time,.40);if(step%16===15)add(3,time,.12);}}
 return result;
}
function bayan(rate,duration,times,amplitude=.14,frequencies=[220,293.66,329.63,246.94]){
 const result=new Float32Array(Math.round(rate*duration));
 for(let i=0;i<result.length;i++){const t=i/rate;for(let note=0;note<times.length;note++){const dt=t-times[note];if(dt<0||dt>.44)continue;const f=frequencies[note%frequencies.length],envelope=Math.min(1,dt/.018)*Math.min(1,(.44-dt)/.035);result[i]+=amplitude*envelope*(Math.sin(2*Math.PI*f*t)+.32*Math.sin(4*Math.PI*f*t)+.19*Math.sin(6*Math.PI*f*t));}}
 return result;
}
function run({rate=8000,duration=10,kind='mixed',delay=()=>.08,gain=.55,near=null,room=null,echo=true,block=128}={}){
 const reference=backing(rate,duration,kind),player=near??new Float32Array(reference.length),capture=new Float32Array(reference.length),cleaned=new Float32Array(reference.length),messages=[],durations=[];
 for(let i=0;i<capture.length;i++){const t=i/rate,lag=delay(t)*rate;capture[i]=(echo?gain*sample(reference,i-lag):0)+(room?room(reference,i,t,lag):0)+(player[i]||0);}
 const engine=new ReferenceEcho(rate,m=>{if(m.type==='acoustic-sync')messages.push(m);});
 for(let i=0;i<capture.length;i+=block){const start=performance.now(),output=engine.process(capture.subarray(i,Math.min(capture.length,i+block)),reference.subarray(i,Math.min(reference.length,i+block)),i/rate);durations.push(performance.now()-start);cleaned.set(output,i);}
 return {engine,messages,reference,capture,cleaned,player,durations,rate,duration};
}
function onsets(run,source=run.cleaned,mode='percussive',start=5){
 const messages=[],detector=new RhythmDetector(run.rate,m=>messages.push(m));detector.configure({type:'mode',value:mode});detector.configure({type:'threshold',value:.006});detector.configure({type:'arm',start,duration:2.4});
 for(let i=0;i<source.length;i+=128)detector.process(source.subarray(i,Math.min(source.length,i+128)),i/run.rate);
 return messages.filter(m=>m.type==='onset');
}
function check(name,run){try{const evidence=run();record(name,evidence.ok,evidence);}catch(error){record(name,false,{error:error.message,stack:error.stack?.split('\n').slice(0,3)});}}

const dry=run();
check('Mixed backing produces an absolute acoustic anchor instead of an eighth-note alias',()=>{
 const locked=dry.messages.filter(m=>m.status==='locked');return {ok:locked.length>=3&&locked.every(m=>Math.abs(m.delayMs-80)<2&&m.confidence>=.65)&&dry.engine.locked,lockedMessages:locked.length,delaysMs:locked.map(m=>m.delayMs)};
});
check('Echo-only backing is removed as a waveform rather than blanking its attack times',()=>{
 const first=Math.round(5*dry.rate),remaining=rms(dry.cleaned,first),original=rms(dry.capture,first);return {ok:remaining<original*.035,originalRms:original,residualRms:remaining,ratio:remaining/original};
});
check('Cleaned backing produces no player onsets after the anchor is learned',()=>{
 const raw=onsets(dry,dry.capture),cleaned=onsets(dry);return {ok:raw.length>=8&&cleaned.length===0,rawOnsets:raw.length,cleanedOnsets:cleaned.length};
});
check('Synchronization messages never exceed two per second',()=>({ok:dry.messages.every((m,i)=>!i||m.time-dry.messages[i-1].time>=.5-1e-7),messages:dry.messages.length,minimumIntervalSeconds:Math.min(...dry.messages.slice(1).map((m,i)=>m.time-dry.messages[i].time))}));

for(const delayMs of [0,17,127,315,499])check(`Mixed rhythm resolves a nonnegative ${delayMs} ms echo delay`,()=>{
 const result=run({duration:8,delay:()=>delayMs/1000}),locked=result.messages.filter(m=>m.status==='locked');return {ok:locked.length>0&&locked.every(m=>m.delayMs>=0&&m.delayMs<=500&&Math.abs(m.delayMs-delayMs)<2),delaysMs:locked.map(m=>m.delayMs)};
});

const periodic=run({kind:'hats',delay:()=>.38});
check('Repeating hats never masquerade as an absolute hardware anchor',()=>({ok:periodic.messages.some(m=>m.status==='ambiguous')&&!periodic.messages.some(m=>m.status==='locked')&&!periodic.engine.locked&&periodic.messages.every(m=>m.delayMs===null),statuses:periodic.messages.map(m=>m.status)}));
check('Periodic waveform aliases can cancel hats while keeping the hardware anchor unknown',()=>{
 const first=Math.round(5*periodic.rate),residual=rms(periodic.cleaned,first),original=rms(periodic.capture,first),hits=onsets(periodic);return {ok:periodic.engine.cancelReady&&residual<original*.05&&hits.length===0,physicalDelayMs:380,cancellationDelayMs:periodic.engine.cancelDelayMs,residualRatio:residual/original,cleanedOnsets:hits.length};
});

const times=[5.13,6.33,7.53,8.73],player=bayan(8000,10,times),mixed=run({near:player});
check('Simultaneous bayan attacks survive backing subtraction',()=>{
 const first=Math.round(5*mixed.rate),difference=Float32Array.from(mixed.cleaned,(value,i)=>value-mixed.player[i]),ratio=rms(difference,first)/rms(mixed.player,first),retained=rms(mixed.cleaned,first)/rms(mixed.player,first);return {ok:ratio<.25&&retained>.85&&retained<1.2,relativeReconstructionError:ratio,retainedRmsRatio:retained};
});
check('Bayan onsets coincident with backing hits remain detectable',()=>{
 const hits=onsets(mixed,mixed.cleaned,'sustained',5);return {ok:times.every(time=>hits.some(hit=>Math.abs(hit.time-time)<.12)),expectedTimes:times,detectedTimes:hits.map(hit=>hit.time)};
});
check('Returning to backing-only audio after bayan does not create new player hits',()=>{
 const hits=onsets(mixed,mixed.cleaned,'sustained',5),afterPlaying=hits.filter(hit=>hit.time>times.at(-1)+.5);return {ok:afterPlaying.length===0,unexpectedOnsetTimes:afterPlaying.map(hit=>hit.time)};
});
check('Strong bayan notes do not train the echo filter into removing the instrument',()=>{
 const strong=bayan(8000,10,times,.45),result=run({near:strong}),first=5*result.rate,retained=rms(result.cleaned,first)/rms(strong,first);return {ok:retained>.85&&retained<1.2,retainedRmsRatio:retained};
});
check('Bayan bass notes coincident with kick drums retain their own low-frequency energy',()=>{
 const bass=bayan(48000,10,times,.18,[55,65.41,73.42,61.74]),result=run({rate:48000,near:bass}),first=5*result.rate,retained=rms(result.cleaned,first)/rms(bass,first),afterPlaying=onsets(result,result.cleaned,'sustained',5).filter(hit=>hit.time>times.at(-1)+.5);return {ok:retained>.9&&retained<1.2&&afterPlaying.length===0,retainedRmsRatio:retained,unexpectedOnsets:afterPlaying.length};
});
check('Legacy background calibration does not subtract a quiet bayan attack a second time',()=>{
 const rate=48000,times=[8.13,9.33],own=bayan(rate,10,times,.025),audio=run({rate,near:own}),messages=[],detector=new RhythmDetector(rate,m=>messages.push(m));
 detector.configure({type:'mode',value:'sustained'});detector.configure({type:'threshold',value:.006});detector.configure({type:'reference-sync',enabled:true,id:1});detector.configure({type:'arm',start:0,duration:2.4});detector.configure({type:'calibrate',start:0,duration:2.4});
 for(let i=0;i<audio.capture.length;i+=128)detector.process(audio.capture.subarray(i,Math.min(audio.capture.length,i+128)),i/rate,audio.reference.subarray(i,Math.min(audio.reference.length,i+128)));
 const hits=messages.filter(m=>m.type==='onset'),unexpected=hits.filter(hit=>!times.some(time=>hit.time>=time-.04&&hit.time<=time+.5));return {ok:messages.some(m=>m.type==='calibrated')&&times.every(time=>hits.some(hit=>Math.abs(hit.time-time)<.12))&&unexpected.length===0,expectedTimes:times,detectedTimes:hits.map(hit=>hit.time),unexpectedTimes:unexpected.map(hit=>hit.time)};
});
check('Ambiguous hats can be suppressed while coincident bayan remains present',()=>{
 const result=run({kind:'hats',delay:()=>.38,near:player}),first=5*result.rate,difference=Float32Array.from(result.cleaned,(value,i)=>value-player[i]),retained=rms(result.cleaned,first)/rms(player,first);return {ok:!result.messages.some(m=>m.status==='locked')&&retained>.85&&retained<1.2&&rms(difference,first)<rms(player,first)*.2,retainedRmsRatio:retained,residualDifferenceRatio:rms(difference,first)/rms(player,first)};
});

check('Headphones without acoustic leakage preserve microphone playing and never acquire a delay',()=>{
 const own=bayan(8000,10,[.4,1.6,2.8,4,5.2,6.4,7.6,8.8],.20),result=run({near:own,echo:false}),difference=Float32Array.from(result.cleaned,(value,i)=>value-own[i]);return {ok:!result.engine.locked&&!result.engine.cancelReady&&!result.messages.some(m=>m.status==='locked')&&rms(difference)<1e-8,maximumDifference:Math.max(...difference.map(Math.abs)),statuses:result.messages.map(m=>m.status)};
});
check('An absent digital reference never changes the captured instrument signal',()=>{
 const own=bayan(8000,8,[.4,1.6,2.8,4,5.2,6.4],.2),result=run({duration:8,kind:'silent',near:own}),difference=Float32Array.from(result.cleaned,(value,i)=>value-own[i]);return {ok:rms(difference)<1e-8&&!result.engine.locked&&!result.engine.cancelReady,relativeError:rms(difference)};
});
check('Silent headphones cannot turn a previously learned echo into inverted backing attacks',()=>{
 const rate=8000,duration=11,reference=backing(rate,duration),engine=new ReferenceEcho(rate,()=>{}),output=new Float32Array(reference.length);
 for(let i=0;i<reference.length;i+=128){const cap=Float32Array.from(reference.subarray(i,i+128),(_,j)=>(i+j)/rate<5?.55*sample(reference,i+j-.08*rate):0);output.set(engine.process(cap,reference.subarray(i,i+128),i/rate),i);}
 return {ok:rms(output,Math.round(5.1*rate))<1e-8&&!engine.cancelReady,residualRms:rms(output,Math.round(5.1*rate))};
});
check('A short colored room response is learned without residual drum onsets',()=>{
 const result=run({room:(reference,index,time,lag)=>.1*sample(reference,index-lag-.001*8000)}),first=6*result.rate,hits=onsets(result,result.cleaned,'percussive',6);return {ok:rms(result.cleaned,first)<rms(result.capture,first)*.10&&hits.length===0,residualRatio:rms(result.cleaned,first)/rms(result.capture,first),cleanedOnsets:hits.length};
});
check('Slow physical latency drift is tracked without grid-sized jumps',()=>{
 const result=run({duration:16,delay:t=>.08+Math.max(0,t-5)*.00065}),locked=result.messages.filter(m=>m.status==='locked'),last=locked.at(-1),jumps=locked.slice(1).map((m,i)=>Math.abs(m.delayMs-locked[i].delayMs));return {ok:locked.length>=5&&last.delayMs>84&&Math.abs(last.delayMs-(80+Math.max(0,last.time-5)*.65))<4&&jumps.every(jump=>jump<=2+1e-6),lockedMessages:locked.length,lastDelayMs:last?.delayMs,maxJumpMs:Math.max(...jumps)};
});

for(const rate of [44100,48000,96000])check(`Acoustic matching and cancellation stay accurate at ${rate} Hz`,()=>{
 const result=run({rate,duration:8,delay:()=>.073}),locked=result.messages.filter(m=>m.status==='locked'),first=5*rate,ratio=rms(result.cleaned,first)/rms(result.capture,first),sorted=result.durations.slice(100).sort((a,b)=>a-b);return {ok:locked.length>0&&Math.abs(locked.at(-1).delayMs-73)<1&&ratio<.08,delayMs:locked.at(-1)?.delayMs,residualRatio:ratio,p99BlockMilliseconds:sorted[Math.floor(sorted.length*.99)],maximumBlockMilliseconds:Math.max(...sorted)};
});
check('Engine storage stays fixed during a long audio stream',()=>{
 const result=run({duration:25}),engine=result.engine,totalBytes=[engine.ref,engine.cap,engine.rawRef,engine.rawCap,...engine.envRef,...engine.envCap,engine.filters,engine.powers,engine.h].reduce((sum,array)=>sum+array.byteLength,0);return {ok:totalBytes<6000000&&engine.ref.length===2**Math.ceil(Math.log2(engine.rate*3.5+512))&&engine.rawRef.length===32768&&engine.envRef.every(array=>array.length===4096),allocatedPersistentBytes:totalBytes};
});
check('Reset releases learned anchors and cancellation coefficients',()=>{
 dry.engine.reset();return {ok:!dry.engine.locked&&!dry.engine.cancelReady&&dry.engine.total===0&&dry.engine.h.every(value=>value===0)&&dry.engine.scan===null,locked:dry.engine.locked};
});
check('Missing reference input and empty audio blocks are accepted safely',()=>{
 const engine=new ReferenceEcho(48000,()=>{}),capture=new Float32Array([.1,-.1,.2]),output=engine.process(capture,undefined,0),empty=engine.process(new Float32Array(),new Float32Array(),3/48000);return {ok:output.length===capture.length&&output.every((value,i)=>value===capture[i])&&empty.length===0,outputLength:output.length};
});

const passed=results.filter(result=>result.status==='PASS').length,failed=results.length-passed;
console.log(JSON.stringify({target,passed,failed,scope:'Synthetic digital/acoustic paths and real detector logic; no microphone, loudspeaker or physical latency verification.',results},null,2));
Deno.exitCode=failed?1:0;
