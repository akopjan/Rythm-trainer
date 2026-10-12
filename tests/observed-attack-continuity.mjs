// Native PCM regression for differently refined voices from one observation.
// Source ownership/proof and the first published point are explicit fixtures.
const target=Deno.args[0]??'index.html',html=await Deno.readTextFile(target);
const dsp=html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];
const Detector=new Function(dsp+';return RhythmDetector;')(),module=Detector.compileWasm();
const rate=48000,results=[];
function check(name,ok,evidence={}){results.push({name,status:ok?'PASS':'FAIL',evidence});}

function fixture({parent=260,current=520,delay=.100,phase=0,gap=null,birth=.58,birthGap=.005,captureGap=0,initial=.040,late=.020,partner=true,earlyPartnerRatio=.6,owned=true,proof=true,truncate=false,mode='sustained',supplemental=false,oldStrong=false,newStrong=true}={}){
 const events=[],d=new Detector(rate,m=>{if(m.type==='onset')events.push(m);},module);d.configure({type:'mode',value:mode});
 const a=d.attribution,time=.5,next=time+delay,base=.25,gate=.003,capture=.82;
 a.baseTime=0;
 const samples=Float32Array.from({length:Math.round(.75*rate)},(_,i)=>{
  const t=base+i/rate;if(t<time)return 0;
  if(gap&&t>=gap[0]&&t<gap[1])return .006*Math.sin(2*Math.PI*190*t);
  const rise=Math.max(0,Math.min(1,(t-next+.012)/.024)),angle=2*Math.PI*current*t;
  let x=.025*Math.sin(2*Math.PI*parent*t)+initial*Math.sin(angle)+late*rise*Math.sin(angle+phase);
  if(partner)x+=initial*earlyPartnerRatio*Math.sin(angle*2+.25)+late*.6*rise*Math.sin((angle+phase)*2+.25);
  return x;
 });
 const old={time,frequency:parent,birth,captureTime:capture,native:true,identity:{h1:oldStrong}};
 if(supplemental){d.supplementalBirths.push(old);d.publishInstrumentNote({type:'onset',time,frequency:parent});d.scoredCount++;}
 else a.emit({type:'onset',time,frequency:parent,source:'periodic',familyProposal:true,sourceVerified:true,originalFamilyTime:birth,captureTime:capture,nativeBirthIdentity:old.identity});
 const q={time:birth+birthGap,frequency:current,level:.05};
 const job={start:Math.round(base*rate),y:truncate?samples.subarray(0,Math.round((next-base+.035)*rate)):samples,gate,message:{type:'onset',time:q.time,frequency:current,captureTime:capture+captureGap,familyCandidates:[q]},familyEvidenceSnapshots:[{own:owned}],familyFrameCache:new Map()};
 const r={time:next,frequency:current,q,proof:{ok:proof,sourceTime:next,frequency:current,missingFundamental:!newStrong,first:{parts:[.02,0,0,0],total:.02},second:{parts:[.02,0,0,0],total:.02}}};
 const before=JSON.stringify({events,accepted:d.acceptedSourceBirths,supplemental:d.supplementalBirths,scored:d.scoredCount}),decision=a.sourceFamilyLifetimeAllowed(job,r);
 const readOnly=before===JSON.stringify({events,accepted:d.acceptedSourceBirths,supplemental:d.supplementalBirths,scored:d.scoredCount});
 let admitted=false;if(decision.allow)admitted=a.emit({type:'onset',time:next,frequency:current,source:'periodic',familyProposal:true,sourceVerified:true,originalFamilyTime:q.time,captureTime:job.message.captureTime,nativeBirthIdentity:{h1:true}});
 return {decision,admitted,events,readOnly,next,detector:d,job,r};
}

for(const [parent,current,birthGap]of [[260,520,.005],[145,217.5,.011],[292,730,.027],[109,545,.011],[520,260,.005]]){
 const r=fixture({parent,current,birthGap});
 check(`One observed ${parent}/${current}Hz attack with a weak first root remains one point`,!r.decision.allow&&['observed-family-same-attack','bass-partial-still-active'].includes(r.decision.reason)&&r.events.length===1&&r.readOnly,{decision:r.decision});
}
for(const delay of [.070,.125,.180]){
 const r=fixture({delay});check(`Continuous shared-observation voice with ${delay*1000}ms timing disagreement adds no point`,!r.decision.allow&&r.events.length===1&&r.readOnly,{reason:r.decision.reason});
}
{
 const r=fixture({earlyPartnerRatio:.05});
 check('A measured weak early partner can strengthen within the same native attack',!r.decision.allow&&r.decision.reason==='observed-family-same-attack'&&r.events.length===1&&r.readOnly,{decision:r.decision});
}
for(const phase of [1.6,-1.6,2.4]){
 const r=fixture({phase,delay:.200,birth:.68,initial:.035,late:.048});check(`A separate octave voice over a strong old carrier with phase ${phase} stays admitted`,r.decision.allow&&r.admitted&&r.events.length===2&&r.events[1].time===r.next&&r.readOnly,{reason:r.decision.reason});
}
for(const gap of [[.550,.590],[.542,.554]]){
 const r=fixture({gap});check(`A real repeated chord with ${Math.round((gap[1]-gap[0])*1000)}ms release stays admitted`,r.decision.allow&&r.admitted&&r.events.length===2&&r.readOnly,{reason:r.decision.reason});
}
for(const [name,options]of [
 ['Independent eighth-note observation', {delay:.125,birthGap:.125,captureGap:.125}],
 ['Different capture despite nearby proposal times', {captureGap:2/rate}],
 ['Different proposed source attacks in one capture', {birthGap:.036}],
 ['Newly starting upper fundamental', {initial:0}],
 ['Unmeasured second carrier', {partner:false}],
 ['An early partner below the native gate floor', {earlyPartnerRatio:.001}],
 ['Unrelated upper pitch', {current:277.18}],
 ['Unavailable source ownership', {owned:false}],
 ['Unverified source body', {proof:false}],
 ['Incomplete source PCM', {truncate:true}],
 ['Percussive mode', {mode:'percussive'}],
 ['Later independent attack', {delay:.250}],
 ['Two independently measured strong fundamentals', {oldStrong:true}],
 ['Existing same-pitch admission', {current:260}],
 ['A weak second native root', {newStrong:false}],
 ['A sharp new aligned octave voice over an old partial', {delay:.200,birth:.68,initial:.05,late:.048,phase:0}],
 ['An independent phase birth over an even stronger old carrier', {delay:.200,birth:.68,initial:.05,late:.048,phase:1.6}],
 ['A true 200ms observation with overlapping same-pitch harmonic tail', {delay:.200,birthGap:.200,initial:.05,late:.02,phase:0}],
]){
 const r=fixture(options);check(name+' preserves admission',r.decision.allow&&r.readOnly,{reason:r.decision.reason});
}
{
 const r=fixture({supplemental:true});check('The same observation sees already published supplemental history',!r.decision.allow&&r.events.length===1&&r.readOnly,{reason:r.decision.reason});
}
{
 const f=fixture(),a=f.detector.attribution;
 const job={...f.job,familyIndex:1,familyResults:[{...f.r,lineage:[f.r.q]}],familyDebug:[]};
 a.advanceFamilyVerification(job);
 const later={...f.r,time:f.r.time+.012,proof:{...f.r.proof,sourceTime:f.r.time+.012}};
 const decision=a.sourceFamilyLifetimeAllowed(f.job,later);
 check('A merged native voice keeps its lifetime and cannot return as a point in the next batch',f.events.length===1&&a.sourceFamilyLifetimes.some(p=>p.time===f.r.time&&p.frequency===f.r.frequency)&&!decision.allow&&decision.reason==='native-family-already-emitted',{decision});
}
const failed=results.filter(r=>r.status==='FAIL').length;
console.log(JSON.stringify({target,passed:results.length-failed,failed,scope:'Actual native phase/power and lifetime wrapper on synthetic PCM, with explicit verified-source fixtures. No complete physical-keypress recall claim.',results},null,2));
if(failed)Deno.exit(1);
