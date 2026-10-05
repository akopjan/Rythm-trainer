// High-family rise regressions through the actual embedded source-attribution gate.
// Synthetic projected PCM makes the old/new veto comparison reproducible.
const target=Deno.args[0]??'index.html',html=await Deno.readTextFile(target);
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0]?.[1];
if(!script)throw Error('Embedded DSP script missing');
const Attribution=new Function(script+';return EchoAttribution;')();
if(typeof Attribution.prototype.highHarmonicFamilyRise!=='function')throw Error('High-family evidence method missing');
const rate=48000,gate=.004,length=Math.round(.104*rate),eventIndex=Math.round(.024*rate),results=[];
const tone=(f,t,phase=0)=>Math.sin(2*Math.PI*f*t+phase)+.32*Math.sin(4*Math.PI*f*t+phase*.7)+.19*Math.sin(6*Math.PI*f*t+phase*.4);
const waveform=sample=>Float32Array.from({length},(_,i)=>sample(i/rate-.024));
function classified(highFamily,y,{own=true,profile=true,toneCheck=true,source='sustained'}={}){
 const emitted=[],a=new Attribution(rate,m=>emitted.push(m)),energy=y.reduce((sum,x)=>sum+x*x,0),job={message:{type:'onset',time:1,source,toneCheck,profileReady:profile,waveformReady:true},evidenceSnapshot:{own,tonal:true},y,eventIndex,length:y.length,energy,original:energy+.0004*y.length,gate};if(!highFamily)a.highHarmonicFamilyRise=()=>false;a.meta={enabled:true,ready:true,canAudit:true};a.currentTime=2;a.accept(job);return{accepted:emitted.length,sourceTimes:emitted.map(x=>x.time),decision:a.lastDecision,highFamily};
}
const assert=(v,m)=>{if(!v)throw Error(m);};const test=(name,run)=>{try{results.push({name,status:'PASS',evidence:run()});}catch(error){results.push({name,status:'FAIL',error:error.message});}};
let oldPositiveAccepted=0,newPositiveAccepted=0;
for(const frequency of [1661,1864,2217,2359,2489,2659,3136])for(const ratio of [.25,.5,1])for(const phase of [0,1.2])test(`High new family ${frequency}Hz ratio ${ratio}, phase ${phase}`,()=>{
 const y=waveform(t=>.03*tone(110,t)+(t>=0?ratio*.03*Math.min(1,t/.012)*tone(frequency,t,phase):0)),old=classified(false,y),next=classified(true,y);oldPositiveAccepted+=old.accepted;newPositiveAccepted+=next.accepted;
 assert(next.accepted===1&&next.sourceTimes[0]===1,'New high family lost or timestamp moved');return{oldAccepted:old.accepted,accepted:next.accepted};
});
for(const ratio of [.25,.5,1])for(const phase of [0,1.2])test(`D7 family2359Hz over heldC#7 2217Hz ratio ${ratio}, phase ${phase}`,()=>{
 const y=waveform(t=>.03*tone(2217,t)+(t>=0?ratio*.03*Math.min(1,t/.012)*tone(2359,t,phase):0)),old=classified(false,y),next=classified(true,y);oldPositiveAccepted+=old.accepted;newPositiveAccepted+=next.accepted;
 assert(next.accepted===1&&next.sourceTimes[0]===1,'New D7 family lost or timestamp moved');return{oldAccepted:old.accepted,accepted:next.accepted};
});
const negative=(name,sample)=>test(`No new admission for ${name}`,()=>{
 const y=waveform(sample),old=classified(false,y),next=classified(true,y),a=new Attribution(rate,()=>{}),method=a.highHarmonicFamilyRise({y,eventIndex,gate});
 assert(next.accepted===old.accepted&&JSON.stringify(next.sourceTimes)===JSON.stringify(old.sourceTimes),'NEW high extension admission');assert(!method,'High-family method itself admitted a negative fixture');return{oldAccepted:old.accepted,accepted:next.accepted,highMethod:method};
});
for(const frequency of [1661,2217,2359,2659,3136])negative(`held ${frequency}Hz`,t=>.03*tone(frequency,t));
for(const frequency of [1661,2359,2659])for(const cents of [10,30,60])for(const phase of [0,1.2,2.4,3.6])negative(`held high${frequency}Hz vibrato${cents}c phase${phase}`,t=>{const depth=(2**(cents/1200)-1)*frequency;return .03*tone(frequency,t+depth/(frequency*2*Math.PI*5)*Math.sin(2*Math.PI*5*t+phase));});
for(const frequency of [2359,2659])for(const depth of [.1,.25,.35,.5])for(const speed of [1.3,2,5])for(const phase of [0,1.2])negative(`same high${frequency}Hz bellowsLFO${depth}/${speed}/phase${phase}`,t=>.03*(1+depth*Math.sin(2*Math.PI*speed*t+phase))*tone(frequency,t));
let seed=381;const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};
for(const level of [.001,.004,.01])negative(`held2359Hz plusnoise${level}`,t=>.03*tone(2359,t)+level*noise());
for(const carrier of ['click','keyboard','snare','distorted-tone'])negative(`held high plus${carrier}`,t=>{const p=t<0?0:carrier==='click'?.12*Math.exp(-t*90)*(Math.sin(2*Math.PI*2310*t)+.25*Math.sin(2*Math.PI*3470*t)):carrier==='keyboard'?.1*Math.exp(-t*45)*(Math.sin(2*Math.PI*2500*t)+.6*Math.sin(2*Math.PI*3337*t)):carrier==='snare'?.12*Math.exp(-t*55)*noise():.08*Math.exp(-t*55)*Math.tanh(10*Math.sin(2*Math.PI*1830*t));return .03*tone(2359,t)+p;});
// These are three inharmonic physical partials above the16k audit's Nyquist,
// not a new1864/2217/2637Hz reed. Unfiltered decimation folds them into one.
for(const alias of [1864,2217,2637])negative(`out-of-band physical partials folding onto${alias}Hz over held bass`,t=>{
 const frequencies=[16000-alias,16000-2*alias,16000-3*alias];
 const upper=t<0?0:.0075*Math.min(1,t/.012)*(Math.sin(2*Math.PI*frequencies[0]*t)+.32*Math.sin(2*Math.PI*frequencies[1]*t)+.19*Math.sin(2*Math.PI*frequencies[2]*t));
 return .03*tone(110,t)+upper;
});
const upper=waveform(t=>.03*tone(110,t)+(t>=0?.0075*Math.min(1,t/.012)*tone(2359,t):0));
for(const options of [{own:false},{profile:false},{profile:false,toneCheck:false}])test(`Existing context gate ${JSON.stringify(options)}`,()=>{const old=classified(false,upper,options),next=classified(true,upper,options);assert(next.accepted===old.accepted,'Existing source/context gate bypassed');return{old,next};});
test('No unavailable second observation',()=>{const a=new Attribution(rate,()=>{}),y=upper.subarray(0,eventIndex+Math.round(.060*rate));assert(a.highHarmonicFamilyRise({y,eventIndex,gate})===false,'Incomplete source observation admitted');return{postMs:60};});
test('No subgate upper family',()=>{const a=new Attribution(rate,()=>{}),y=waveform(t=>.03*tone(110,t)+(t>=0?.0006*Math.min(1,t/.012)*tone(2359,t):0));assert(a.highHarmonicFamilyRise({y,eventIndex,gate})===false,'Subgate family admitted');return{amplitude:.0006,gate};});
test('8k source cannot prove2ndharmonic of2359Hz',()=>{const a=new Attribution(8000,()=>{}),y=Float32Array.from({length:832},(_,i)=>tone(2359,i/8000));assert(a.highHarmonicFamilyRise({y,eventIndex:192,gate})===false,'High search exceeded observable second harmonic');return{rate:8000,highestAuditable:1800};});
const summary={target,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,oldPositiveAccepted,newPositiveAccepted,scope:'Actual embedded attribution with synthetic projected PCM. Baseline disables only the high-family method on its instance; all other admission paths remain actual. No physical all-note recall claim.',results};console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
