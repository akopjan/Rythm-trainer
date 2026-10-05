// Already-projected waveform fixtures exercise the final held-tone veto.
// This is not a recording, full detector note-recall test, or background filter.
const target=Deno.args[0]??new URL('../dsp/echo-attribution.js',import.meta.url);
const text=await Deno.readTextFile(target),source=String(target).endsWith('.html')?text.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)?.[1]:text;
const Attribution=new Function(source+';return EchoAttribution;')(),results=[];
const rate=48000,gate=.004,length=Math.round(.292*rate),eventIndex=Math.round(.16*rate),tone=(f,t,phase=0)=>Math.sin(2*Math.PI*f*t+phase)+.32*Math.sin(4*Math.PI*f*t+phase*.7)+.19*Math.sin(6*Math.PI*f*t+phase*.4);
const assert=(v,m)=>{if(!v)throw Error(m);};function test(name,run){try{results.push({name,status:'PASS',evidence:run()});}catch(error){results.push({name,status:'FAIL',error:error.message});}}
const waveform=sample=>Float32Array.from({length},(_,i)=>sample(i/rate-.16));
function classified(y,{disableRise=false,own=true,profile=true,toneCheck=true,waveformReady=false,canAudit=false}={}){
 const emitted=[],a=new Attribution(rate,m=>emitted.push(m));if(disableRise)a.harmonicFamilyRise=()=>false;
 a.meta={enabled:true,ready:true,canAudit};
 const energy=y.reduce((sum,x)=>sum+x*x,0),job={message:{type:'onset',time:1,toneCheck,profileReady:profile,waveformReady},evidenceSnapshot:{own,tonal:true},y,eventIndex,length:y.length,energy,original:energy+.0004*y.length,gate};
 a.currentTime=2;a.accept(job);return{accepted:emitted.length,sourceTimes:emitted.map(m=>m.time),decision:a.lastDecision};
}
let baselinePositiveAccepted=0,newPositiveAccepted=0;
for(const frequency of [220,293.66,329.63,392])for(const ratio of [.25,.5,1])for(const phase of [0,1.2])test(`A new${frequency} Hz upper note survives a held110 Hz bass at ratio${ratio}, phase${phase}`,()=>{
 const y=waveform(t=>.03*tone(110,t)+(t>=0?ratio*.03*Math.min(1,t/.012)*tone(frequency,t,phase):0)),baseline=classified(y,{disableRise:true}),now=classified(y);
 baselinePositiveAccepted+=baseline.accepted;newPositiveAccepted+=now.accepted;
 assert(now.accepted===1&&now.sourceTimes[0]===1,'New independent harmonic family was lost or moved in time');return{baselineAccepted:baseline.accepted,accepted:now.accepted,sourceTime:now.sourceTimes[0]};
});
const negative=(name,sample)=>test(`The extension adds no admission for${name}`,()=>{
 const y=waveform(sample),baseline=classified(y,{disableRise:true}),now=classified(y);
 // A strong volume rise or a keyboard transient may already pass an older
 // path. The regression here is a new admission introduced by this extension.
 assert(now.accepted===baseline.accepted&&JSON.stringify(now.sourceTimes)===JSON.stringify(baseline.sourceTimes),'Harmonic extension introduced a false candidate admission');return{baselineAccepted:baseline.accepted,accepted:now.accepted,baselineAlreadyAdmitted:baseline.accepted>0};
});
for(const frequency of [110,220,293.66,440])negative(`a held${frequency} Hz tone`,t=>.03*tone(frequency,t));
for(const cents of [10,30,60])negative(`held110 Hz vibrato${cents} cents`,t=>{const depth=(2**(cents/1200)-1)*110;return .03*tone(110,t+depth/(110*2*Math.PI*5)*Math.sin(2*Math.PI*5*t));});
for(const depth of [.1,.25,.35,.5])for(const frequency of [1.3,2,5])negative(`bellows amplitudeLFO depth${depth}, rate${frequency} Hz`,t=>.03*(1+depth*Math.sin(2*Math.PI*frequency*t))*tone(110,t));
let seed=381;const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};
for(const level of [.001,.004,.01])negative(`held110 Hz plus broadbandnoise${level}`,t=>.03*tone(110,t)+level*noise());
for(const carrier of ['dry','keyboard','snare'])negative(`held110 Hz plus inharmonic${carrier}`,t=>{const percussion=t<0?0:carrier==='dry'?.12*Math.exp(-t*90)*(Math.sin(2*Math.PI*1170*t)+.25*Math.sin(2*Math.PI*1810*t)):carrier==='keyboard'?.1*Math.exp(-t*45)*(Math.sin(2*Math.PI*1300*t)+.6*Math.sin(2*Math.PI*1537*t)):.12*Math.exp(-t*55)*noise();return .03*tone(110,t)+percussion;});
const quietUpper=waveform(t=>.03*tone(110,t)+(t>=0?.0075*Math.min(1,t/.012)*tone(293.66,t):0));
test('A new harmonic family does not bypass missing independent instrument evidence',()=>{
 const baseline=classified(quietUpper,{disableRise:true,own:false}),now=classified(quietUpper,{own:false});assert(now.accepted===0&&now.accepted===baseline.accepted,'Harmonic rise bypassed independent source evidence');return{baseline,now};
});
test('A harmonic family cannot replace missing trusted source audit context',()=>{
 const now=classified(quietUpper,{profile:false,toneCheck:false});assert(now.accepted===0&&now.decision.reason==='held-tone','Harmonic rise bypassed the known-source gate');return now;
});
test('Cold-start waveform and audit proof alone do not enable the new-family exception',()=>{
 const options={profile:false,waveformReady:true,canAudit:true},baseline=classified(quietUpper,{...options,disableRise:true}),now=classified(quietUpper,options);
 assert(now.accepted===0&&now.decision.reason==='held-tone'&&now.accepted===baseline.accepted,'Unprepared profile bypassed the cold-start held-tone veto');return{baseline,now};
});
test('A missing second post-onset window cannot prove a new harmonic family',()=>{
 const a=new Attribution(rate,()=>{}),y=quietUpper.subarray(0,eventIndex+Math.round(.060*rate));assert(a.harmonicFamilyRise({y,eventIndex,length:y.length,gate})===false,'Incomplete observation window was used as proof');return{availablePostMs:60};
});
test('A harmonic increase below the absolute attack gate does not become an onset',()=>{
 const y=waveform(t=>.03*tone(110,t)+(t>=0?.0006*Math.min(1,t/.012)*tone(293.66,t):0)),a=new Attribution(rate,()=>{});assert(a.harmonicFamilyRise({y,eventIndex,length:y.length,gate})===false,'Sub-gate harmonic variation became a new-note proof');return{upperAmplitude:.0006,gate};
});
const summary={target:String(target),passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,positiveCases:24,baselinePositiveAccepted,newPositiveAccepted,scope:'Synthetic projected residuals and independent-evidence/context gates. Negative cases compare against the unchanged earlier admission paths; no claim that all earlier false positives or physical notes are covered.',results};
console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
