// Actual native PCM continuity and lifetime gates, with explicit previously
// accepted-source/owned-proof fixtures. This is not an end-to-end keypress test.
const target=Deno.args[0]??'index.html',html=await Deno.readTextFile(target);
const dsp=html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];
const Detector=new Function(dsp+';return RhythmDetector;')(),module=Detector.compileWasm();
const rate=48000,results=[];
function check(name,ok,evidence={}){results.push({name,status:ok?'PASS':'FAIL',evidence});}

function fixture({delay=.100,parent=110,current=330,phase=0,gap=null,missingCarrier=false,missingPartner=false,oldStrong=false,newStrong=false,owned=true,mode='sustained',proof=true,sourceOffset=0,truncate=false,supplemental=false}={}){
 const events=[],d=new Detector(rate,m=>{if(m.type==='onset')events.push(m);},module);d.configure({type:'mode',value:mode});
 const a=d.attribution,time=.5,next=time+delay,base=.25,length=.75,gate=.003;
 a.baseTime=0;
 const samples=Float32Array.from({length:Math.round(length*rate)},(_,i)=>{
  const t=base+i/rate;if(t<time)return 0;
  const quiet=gap&&t>=gap[0]&&t<gap[1];if(quiet)return .006*Math.sin(2*Math.PI*190*t);
  const rise=Math.max(0,Math.min(1,(t-next+.012)/.024)),angle=2*Math.PI*current*t;
  const initial=missingCarrier?0:.018,late=.048*rise;
  // The same carrier can grow without starting a second oscillator; a true
  // independently phased voice has its own phase and starts over the old one.
  let x=.025*Math.sin(2*Math.PI*parent*t);
  x+=initial*Math.sin(angle)+late*Math.sin(angle+phase);
  if(!missingPartner)x+=initial*.6*Math.sin(angle*2+.25)+late*.6*Math.sin((angle+phase)*2+.25);
  return x;
 });
 const birth={time,frequency:parent,birth:time+.08,captureTime:time+.16,native:true,identity:{h1:oldStrong}};
 if(supplemental){d.supplementalBirths.push(birth);d.publishInstrumentNote({type:'onset',time,frequency:parent});d.scoredCount++;}
 else d.attribution.emit({type:'onset',time,frequency:parent,source:'periodic',familyProposal:true,sourceVerified:true,originalFamilyTime:birth.birth,captureTime:birth.captureTime,nativeBirthIdentity:birth.identity});
 const q={time:next+.07,frequency:current,level:.05};
 const job={start:Math.round(base*rate),y:truncate?samples.subarray(0,Math.round((next-base+.035)*rate)):samples,gate,message:{type:'onset',time:q.time,frequency:current,captureTime:q.time+.12,familyCandidates:[q]},familyEvidenceSnapshots:[{own:owned}],familyFrameCache:new Map()};
 const r={time:next,frequency:current,q,proof:{ok:proof,sourceTime:next+sourceOffset,frequency:current,missingFundamental:!newStrong,first:{parts:[.02,0,0,0],total:.02},second:{parts:[.02,0,0,0],total:.02}}};
 const before=JSON.stringify({events,accepted:d.acceptedSourceBirths,supplemental:d.supplementalBirths,scored:d.scoredCount}),decision=a.sourceFamilyLifetimeAllowed(job,r);
 const after=JSON.stringify({events,accepted:d.acceptedSourceBirths,supplemental:d.supplementalBirths,scored:d.scoredCount});
 let admitted=false;if(decision.allow)admitted=a.emit({type:'onset',time:next,frequency:current,source:'periodic',familyProposal:true,sourceVerified:true,originalFamilyTime:q.time,captureTime:job.message.captureTime,nativeBirthIdentity:{h1:newStrong}});
 return {decision,admitted,events,readOnly:before===after,initialTime:time,nextTime:next};
}

for(const delay of [.070,.100,.180]){
 const r=fixture({delay});check(`Continuous growing bass harmonic at${delay*1000}ms remains one point`,!r.decision.allow&&r.decision.reason==='bass-partial-still-active'&&r.events.length===1&&r.readOnly,{decision:r.decision,points:r.events.length});
}
for(const current of [220,440,880]){
 const r=fixture({current});check(`Continuous${current}Hz harmonic description remains one point`,!r.decision.allow&&r.events.length===1,{reason:r.decision.reason});
}
for(const phase of [1.6,-1.6,2.4]){
 const r=fixture({phase,delay:.125});check(`Independent harmonic voice phase${phase} at an eighth-note interval stays admitted`,r.decision.allow&&r.admitted&&r.events.length===2&&r.events[1].time===r.nextTime&&r.readOnly,{reason:r.decision.reason,points:r.events.length});
}
for(const gap of [[.550,.590],[.542,.554]]){
 const r=fixture({gap});check(`Released family with a${Math.round((gap[1]-gap[0])*1000)}ms gap can articulate again`,r.decision.allow&&r.events.length===2&&r.readOnly,{reason:r.decision.reason});
}
for(const [name,options]of[
 ['A shared carrier absent before the new note', {missingCarrier:true}],
 ['An unmeasured partner carrier', {missingPartner:true}],
 ['Two independently measured fundamental identities', {oldStrong:true,newStrong:true}],
 ['An unrelated new pitch', {current:277.18}],
 ['A same-pitch repetition', {current:110}],
 ['A new lower bass below an already sounding upper voice', {parent:220,current:110}],
 ['A later independent attack', {delay:.250}],
 ['Missing source ownership', {owned:false}],
 ['An unverified body', {proof:false}],
 ['A mismatched source clock', {sourceOffset:.003}],
 ['An incomplete observed body', {truncate:true}],
 ['Percussive mode', {mode:'percussive'}],
 ['Two non-bass roots', {parent:330,current:660}],
]){
 const r=fixture(options);check(name+' preserves lifetime admission',r.decision.allow&&r.readOnly,{reason:r.decision.reason,points:r.events.length});
}
{
 const r=fixture({supplemental:true});check('An already published supplemental bass also owns its continuous harmonic',!r.decision.allow&&r.events.length===1&&r.readOnly,{reason:r.decision.reason});
}
const failed=results.filter(r=>r.status==='FAIL').length;
console.log(JSON.stringify({target,passed:results.length-failed,failed,scope:'Actual native-frame/phase/power and detector lifetime wrapper on synthetic PCM with explicit accepted-source and owned-proof fixtures. Existing source proofs are not regenerated; no complete physical keypress recall claim.',results},null,2));
if(failed)Deno.exit(1);
