// Deliberate admission-state regressions through the actual embedded detector.
// A previously accepted supplement is seeded explicitly; these tests do not
// measure acoustic recognition, physical key presses, or waveform separation.
const target=Deno.args[0]??new URL('../index.html',import.meta.url);
const html=await Deno.readTextFile(target);
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0]?.[1];
if(!source)throw new Error('Missing embedded DSP script');
const Detector=new Function(source+';return RhythmDetector;')();
const results=[];
function check(name,ok,evidence={}){results.push({name,status:ok?'PASS':'FAIL',evidence});}
const identity=h1=>({h1,first:h1 ? .1 : .001,second:h1 ? .1 : .001,method:'admission-fixture'});
function create(mode='sustained'){
 const messages=[],detector=new Detector(48000,m=>messages.push(m));
 detector.configure({type:'mode',value:mode});
 return {detector,messages};
}
function primary(time,frequency,options={}){
 return {type:'onset',time,frequency,level:.02,source:'periodic',familyProposal:true,
  sourceVerified:true,originalFamilyTime:time+.08,nativeBirthIdentity:identity(false),...options};
}
function seedSupplement(detector,time,frequency,options={}){
 const birth={time,birth:time+.04,frequency,native:true,identity:identity(true),...options};
 detector.supplementalBirths.push(birth);detector.scoredCount++;
 detector.publishInstrumentNote({type:'onset',time,frequency,level:.02,source:'instrument',
  familyProposal:true,sourceVerified:true,supplemental:true,originalFamilyTime:birth.birth,
  nativeBirthIdentity:birth.identity,captureTime:birth.captureTime,id:detector.referenceId,isolated:true});
 return birth;
}
function snapshot(detector,messages){
 return JSON.stringify({acceptedTimes:detector.acceptedTimes,
  acceptedSourceBirths:detector.acceptedSourceBirths,
  supplementalBirths:detector.supplementalBirths,scoredCount:detector.scoredCount,messages});
}

for(const [name,frequency] of [['same family',588],['lower third-harmonic family',196],['upper octave family',1176]]){
 const {detector:d,messages}=create();seedSupplement(d,10.03,588);
 const before=snapshot(d,messages),message=primary(10,frequency),accepted=d.attribution.emit(message);
 check(`An earlier primary ${name} recovered 30ms after supplement admission does not add a second point`,
  accepted===false&&messages.length===1&&snapshot(d,messages)===before,
  {accepted,points:messages.length,scored:d.scoredCount});
}
{
 const {detector:d,messages}=create();seedSupplement(d,10,588);
 const accepted=d.attribution.emit(primary(10.03,196));
 check('A later harmonic primary is also suppressed within the same 60ms neighborhood',
  accepted===false&&messages.length===1&&d.scoredCount===1);
}
{
 const {detector:d,messages}=create();seedSupplement(d,10.03,660);
 const message=primary(10,293.66),accepted=d.attribution.emit(message);
 check('An unrelated native family within 30ms retains its original source timestamp',
  accepted===true&&messages.length===2&&messages[1].time===message.time&&messages[1].frequency===message.frequency&&
  d.acceptedTimes.length===1&&d.acceptedTimes[0]===message.time&&d.acceptedSourceBirths.length===1&&
  d.acceptedSourceBirths[0].birth===message.originalFamilyTime&&d.scoredCount===2);
}
for(const frequency of [196,588]){
 const {detector:d,messages}=create();seedSupplement(d,10,588);
 const message=primary(10.061,frequency),accepted=d.attribution.emit(message);
 check(`A new ${frequency===588?'same-frequency':'harmonic'} primary after 60ms remains admitted`,
  accepted===true&&messages.length===2&&messages[1].time===10.061&&d.scoredCount===2);
}
{
 const {detector:d,messages}=create();seedSupplement(d,10.03,588);
 const accepted=d.attribution.emit(primary(10,196,{sourceVerified:false}));
 check('The new guard applies only to a verified native primary family',
  accepted===true&&messages.length===2&&d.scoredCount===2);
}
{
 const {detector:d,messages}=create('percussive');seedSupplement(d,10.03,588);
 const message=primary(10,196,{source:'attack',familyProposal:false,sourceVerified:false}),accepted=d.attribution.emit(message);
 check('Percussive admission keeps its existing behavior and source timestamp',
  accepted===true&&messages.length===2&&messages[1].time===10&&d.scoredCount===2);
}
{
 const {detector:d,messages}=create();d.attribution.emit(primary(10,196));
 // Isolate the existing supplemental admission gate after its two native
 // measurements have succeeded. No numerical proof is being tested here.
 const a=d.attribution;
 a.sourceBirthIdentity=()=>identity(true);
 a.supplementalNativePhase=()=>({ok:true,reason:'admission-fixture'});
 a.supplementalNativeLocalPeak=()=>({ok:true,reason:'admission-fixture'});
 const before=snapshot(d,messages),job={message:primary(10.03,588)},r={time:10.03,frequency:588,q:{time:10.15,level:.02},proof:{ok:true}};
 const result=a.publishNativeSupplemental(job,r,[],'global60-only');
 check('Primary-first order retains the existing harmonic supplement veto, including weak primary H1',
  result.accepted===false&&result.reason==='primary-family-not-independent'&&snapshot(d,messages)===before,
  {reason:result.reason,points:messages.length,scored:d.scoredCount});
}
{
 const {detector:d,messages}=create();d.attribution.emit(primary(10,196));
 const before=snapshot(d,messages),accepted=d.attribution.emit(primary(10.03,293.66));
 check('The existing primary-to-primary 60ms gate remains unchanged',accepted===false&&snapshot(d,messages)===before);
}
{
 const {detector:d,messages}=create();seedSupplement(d,10,588);
 const accepted=d.attribution.emit(primary(20,196));
 check('Old supplemental history cannot suppress a later attack or alter its timestamp',
  accepted===true&&messages.length===2&&messages[1].time===20&&d.scoredCount===2&&d.supplementalBirths.length===1);
}

// These aliases share an observed source event and audit capture. Distinct
// physical attacks are represented by independent event/capture clocks below.
function sharedEvent(time,frequency,h1,options={}){
 return primary(time,frequency,{originalFamilyTime:20.12,captureTime:20.35,nativeBirthIdentity:identity(h1),...options});
}
for(const [name,dt,frequency,oldH1,newH1]of[
 ['weak sixth-harmonic alias',.072,1176,false,false],
 ['weak-to-strong octave alias',.064,392,false,true],
 ['weak fifth-harmonic alias just outside 60ms',.06001,980,false,false],
 ['strong-to-weak alias',.1,588,true,false],
 ['same-root source alias',.1,196,false,false],
 ['eighth-harmonic boundary',.1,1568,false,false],
 ['quarter-second timing boundary',.25,588,false,false],
]){
 const {detector:d,messages}=create();d.attribution.emit(sharedEvent(20,196,oldH1));
 const before=snapshot(d,messages),accepted=d.attribution.emit(sharedEvent(20+dt,frequency,newH1));
 check(name+' adds no second primary point or history mutation',accepted===false&&snapshot(d,messages)===before,
  {accepted,points:messages.length,scored:d.scoredCount});
}
{
 const {detector:d,messages}=create();d.attribution.emit(sharedEvent(20.072,1176,false));
 const before=snapshot(d,messages),accepted=d.attribution.emit(sharedEvent(20,196,false));
 check('A backdated primary alias recovered after the upper family is also suppressed',accepted===false&&snapshot(d,messages)===before);
}
{
 const {detector:d,messages}=create();seedSupplement(d,20,196,{birth:20.12,captureTime:20.35,identity:identity(true)});
 const before=snapshot(d,messages),accepted=d.attribution.emit(sharedEvent(20.072,1176,false));
 check('A shared-event primary alias sees already published supplemental history',accepted===false&&snapshot(d,messages)===before);
}
{
 const {detector:d,messages}=create();d.attribution.emit(sharedEvent(20,196,false));
 const before=snapshot(d,messages),accepted=d.attribution.emit(sharedEvent(20.1,588,false,{originalFamilyTime:20.12+1/48000,captureTime:20.35+1/48000}));
 check('One source sample of clock-rounding difference keeps the same observed event identity',accepted===false&&snapshot(d,messages)===before);
}
for(const [name,priorOptions,currentOptions,time,frequency,mode]of[
 ['different source births',{}, {originalFamilyTime:20.12+2/48000},20.1,588],
 ['different audit captures',{}, {captureTime:20.35+2/48000},20.1,588],
 ['genuine close repetition',{}, {originalFamilyTime:20.245,captureTime:20.475},20.125,196],
 ['genuine close harmonic note',{}, {originalFamilyTime:20.245,captureTime:20.475},20.125,392],
 ['unrelated frequency in the same event',{}, {},20.1,293.66],
 ['two measured fundamentals', {nativeBirthIdentity:identity(true)}, {nativeBirthIdentity:identity(true)},20.1,588],
 ['ratio beyond the eight-harmonic bound',{}, {},20.1,1764],
 ['outside the source-time bound',{}, {},20.2501,588],
 ['missing previous identity', {nativeBirthIdentity:null}, {},20.1,588],
 ['missing current identity',{}, {nativeBirthIdentity:null},20.1,588],
 ['missing previous capture clock', {captureTime:undefined}, {},20.1,588],
 ['missing current capture clock',{}, {captureTime:undefined},20.1,588],
 ['missing current source birth',{}, {originalFamilyTime:undefined},20.1,588],
 ['unverified current proposal',{}, {sourceVerified:false},20.1,588],
 ['unverified previous proposal', {sourceVerified:false}, {},20.1,588],
 ['nonperiodic current source',{}, {source:'attack'},20.1,588],
 ['percussive mode',{}, {},20.1,588,'percussive'],
]){
 const {detector:d,messages}=create(mode);d.attribution.emit(sharedEvent(20,196,false,priorOptions));
 const m=sharedEvent(time,frequency,false,currentOptions),accepted=d.attribution.emit(m);
 check(name+' stays admitted with its original timestamp and score bookkeeping',accepted===true&&messages.length===2&&messages[1].time===m.time&&messages[1].frequency===m.frequency&&d.scoredCount===2&&d.acceptedTimes.length===2&&d.acceptedSourceBirths.length===2,
  {accepted,points:messages.length,scored:d.scoredCount});
}
for(const [priorHistory,priorH1,currentH1]of[['primary',false,false],['primary',false,true],['supplemental',true,false]]){
 const {detector:d,messages}=create();
 if(priorHistory==='primary')d.attribution.emit(sharedEvent(20,196,priorH1));
 else seedSupplement(d,20,196,{birth:20.12,captureTime:20.35,identity:identity(priorH1)});
 const a=d.attribution;let phaseCalls=0,peakCalls=0;
 a.sourceBirthIdentity=()=>identity(currentH1);
 a.supplementalNativePhase=()=>{phaseCalls++;return {ok:true};};
 a.supplementalNativeLocalPeak=()=>{peakCalls++;return {ok:true};};
 const before=snapshot(d,messages),job={message:sharedEvent(20.1,588,currentH1)},r={time:20.1,frequency:588,q:{time:20.12,level:.02},proof:{ok:true}};
 const result=a.publishNativeSupplemental(job,r,[],'global60-only');
 check(`A ${currentH1?'strong':'weak'} supplemental source alias sees ${priorHistory} history before another measured proof`,result.accepted===false&&result.reason==='source-alias-already-published'&&phaseCalls===0&&peakCalls===0&&snapshot(d,messages)===before,
  {reason:result.reason,phaseCalls,peakCalls});
}
{
 const {detector:d,messages}=create();seedSupplement(d,20,196,{birth:20.12,captureTime:20.35,identity:identity(true)});
 const a=d.attribution;a.sourceBirthIdentity=()=>identity(true);a.supplementalNativePhase=()=>({ok:true});a.supplementalNativeLocalPeak=()=>({ok:true});
 const job={message:sharedEvent(20.1,588,true)},r={time:20.1,frequency:588,q:{time:20.12,level:.02},proof:{ok:true}};
 const result=a.publishNativeSupplemental(job,r,[],'global60-only');
 check('Two measured supplemental fundamentals remain independent after their unchanged native admission checks',result.accepted===true&&messages.length===2&&messages[1].time===20.1&&d.scoredCount===2&&d.supplementalBirths.length===2&&d.supplementalBirths[1].captureTime===20.35);
}
const failed=results.filter(r=>r.status==='FAIL').length;
console.log(JSON.stringify({target:String(target),passed:results.length-failed,failed,total:results.length,
 scope:'Actual primary and supplemental admission gates on explicit synthetic state; no waveform, physical bass, or complete acoustic recall claim.',results},null,2));
Deno.exitCode=failed?1:0;
