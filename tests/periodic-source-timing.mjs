// Synthetic projected microphone residuals exercise the actual admission rule.
// The job has verified speaker energy removed; no recording or private profile.
const target=Deno.args[0]??new URL('../dsp/echo-attribution.js',import.meta.url),source=await Deno.readTextFile(target),Attribution=new Function(source+';return EchoAttribution;')();
const rate=48000,gate=10**(-38/20),origin=.5,candidate=.615,results=[];
function reed(t,env=1){return .045*env*(Math.sin(2*Math.PI*220*t)+.36*Math.sin(2*Math.PI*440*t)+.19*Math.sin(2*Math.PI*660*t));}
const soft=t=>t<origin?0:reed(t,Math.min(1,(t-origin)/.22));
function attempt({signal=soft,time=candidate,frequency=220,known=true,own=true,waveform=false,audit=false,type='periodic'}={}){
 const emitted=[],a=new Attribution(rate,m=>emitted.push({...m})),meta={enabled:true,ready:true,renderRecent:true,canAudit:audit,instrumentEvidence:()=>own,tonalEvidence:()=>own};
 const samples=Math.ceil(Math.max(.9,time+.3)*rate);for(let offset=0;offset<samples;offset+=128){const length=Math.min(128,samples-offset),capture=Float32Array.from({length},(_,i)=>signal((offset+i)/rate)),render=new Float32Array(length);a.process(render,capture,capture,offset/rate,meta);}
 const message={type:'onset',time,source:type,toneCheck:true,spectralCheck:true,profileReady:known,waveformReady:waveform};if(frequency!==null)message.frequency=frequency;
 const job={message,signalTime:time+.064,gate,evidenceSnapshot:{own,tonal:own,renderRecent:true,time:time+.13}};a.prepare(job);
 // The samples are the analytically known projected residual. Add the known
 // removed speaker energy to the original captured-energy accounting.
 job.energy=job.y.reduce((sum,x)=>sum+x*x,0);job.original=job.energy+job.length*.018**2;
 a.accept(job);return {emitted,reason:a.lastDecision?.reason,originalTime:time,refinedTime:job.message.time};
}
function check(name,run,ok){results.push({name,status:ok?'PASS':'FAIL',evidence:run});}
const accepted=attempt();check('A confirmed soft periodic note previously classified held is admitted and backdated',accepted,accepted.emitted.length===1&&accepted.refinedTime>=origin-.015&&accepted.refinedTime<=origin+.065&&accepted.refinedTime<candidate-.05);
const waveform=attempt({known:false,waveform:true});check('A verified linear waveform path admits the same stable soft note before the spectral bank is ready',waveform,waveform.emitted.length===1&&waveform.refinedTime>=origin-.015&&waveform.refinedTime<=origin+.065);
const projected=attempt({known:false,waveform:false,audit:true});check('A received rendered reference permits fully projected own-note proof before either filter profile is ready',projected,projected.emitted.length===1&&projected.refinedTime>=origin-.015&&projected.refinedTime<=origin+.065);
const missingOwn=attempt({known:false,waveform:false,audit:true,own:false});check('Audit eligibility alone never supplies instrument evidence',missingOwn,missingOwn.emitted.length===0);
for(const [name,options] of [['Missing source-time instrument proof',{own:false}],['A source without profile, waveform or audit proof',{known:false}],['Missing tracked frequency',{frequency:null}],['Unrelated tracked frequency',{frequency:330}],['A harmonic-only frequency cannot label a new fundamental',{frequency:440}],['An absent subharmonic cannot label a new fundamental',{frequency:110}]]){
 const run=attempt(options);check(name+' preserves the held-tone veto',run,run.emitted.length===0);
}
const unstable=attempt({signal:t=>t>=origin&&t<origin+.18?reed(t,Math.min(1,(t-origin)/.22)):0});check('A short projected tone without stable late support does not override the veto',unstable,unstable.emitted.length===0);
const heldResults=[];for(const time of [.6,.8,1,1.2,1.4,1.6])heldResults.push(attempt({time,signal:t=>reed(t,1+.25*Math.sin(2*Math.PI*1.4*t))}));check('Held periodic sound with bellows modulation creates no extra source starts',heldResults,heldResults.every(run=>run.emitted.length===0));
const ordinary=attempt({type:'attack'});check('Ordinary attack evidence still uses its24ms before-window and keeps the original time',ordinary,ordinary.emitted.length===0&&ordinary.refinedTime===candidate);
// Verify that ordinary waveform jobs retain the short capture prefix. A second
// longer prefix is reserved for periodic source-time refinement only.
const prepared=new Attribution(rate,()=>{}),zero=new Float32Array(128);for(let offset=0;offset<rate;offset+=128){const captured=Float32Array.from({length:128},(_,i)=>reed((offset+i)/rate));prepared.process(zero,captured,captured,offset/rate,{enabled:true,ready:true,renderRecent:true});}
const plainJob={message:{type:'onset',time:candidate,source:'attack',toneCheck:true},signalTime:candidate+.064,gate};prepared.prepare(plainJob);check('Ordinary projection starts24ms before its timestamp', {prefix:(candidate-prepared.baseTime)-plainJob.start/rate,eventTime:plainJob.message.time},Math.abs((candidate-prepared.baseTime)-plainJob.start/rate-.024)<2/rate&&plainJob.message.time===candidate);
const periodicJob={message:{type:'onset',time:candidate,source:'periodic',toneCheck:true},signalTime:candidate+.064,gate};prepared.prepare(periodicJob);check('Periodic projection retains160ms for locating the earlier source beginning',{prefix:(candidate-prepared.baseTime)-periodicJob.start/rate},Math.abs((candidate-prepared.baseTime)-periodicJob.start/rate-.16)<2/rate);
const summary={passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,scope:'Actual source-attribution classifier with analytically defined projected residuals and removed speaker energy. Timing is synthetic truth; no real instrument note-recall claim.',results};console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
