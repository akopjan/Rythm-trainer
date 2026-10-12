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
function seedSupplement(detector,time,frequency){
 const birth={time,birth:time+.04,frequency,native:true,identity:identity(true)};
 detector.supplementalBirths.push(birth);detector.scoredCount++;
 detector.publishInstrumentNote({type:'onset',time,frequency,level:.02,source:'instrument',
  familyProposal:true,sourceVerified:true,supplemental:true,originalFamilyTime:birth.birth,
  nativeBirthIdentity:birth.identity,id:detector.referenceId,isolated:true});
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
const failed=results.filter(r=>r.status==='FAIL').length;
console.log(JSON.stringify({target:String(target),passed:results.length-failed,failed,total:results.length,
 scope:'Actual primary and supplemental admission gates on explicit synthetic state; no waveform, physical bass, or complete acoustic recall claim.',results},null,2));
Deno.exitCode=failed?1:0;
