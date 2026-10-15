// Independent source actions are defined by the PCM generator, not detector
// metadata. All ranks in a slow chord begin together, with different rises.
// Repeats and quiet legato supply distinct known source actions as controls.
const target=Deno.args[0]??new URL('../index.html',import.meta.url);
const html=await Deno.readTextFile(target),source=html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];
const Detector=new Function(source+';return RhythmDetector;')(),module=Detector.compileWasm();
const rate=48000,results=[];
const tone=(frequency,age)=>Math.sin(2*Math.PI*frequency*age)
 +.32*Math.sin(4*Math.PI*frequency*age+.2)+.19*Math.sin(6*Math.PI*frequency*age+.4);

function run(name,duration,signal,expected,chunk=512){
 const pcm=Float32Array.from({length:Math.ceil(duration*rate)},(_,i)=>signal(i/rate));
 const messages=[],cues=[],detector=new Detector(rate,message=>messages.push(message),module);
 detector.attribution.setDeferredAnalysis(true);
 const onset=detector.onset.bind(detector);
 // Observe genuine front-end cue proposals without changing admission,
 // timestamps, source ownership or any candidate evidence.
 detector.onset=(message,gate)=>{
  if(message.familyProposal!==true&&message.source!=='periodic')cues.push(message.time);
  return onset(message,gate);
 };
 for(const message of [{type:'mode',value:'sustained'},{type:'threshold',value:10**(-48/20)},
  {type:'arm',start:0,duration:2.4},{type:'reference-sync',enabled:true,routed:true,backing:false,id:1}])detector.configure(message);
 const silence=new Float32Array(128);
 for(let at=0;at<pcm.length;at+=chunk){
  for(let i=at;i<Math.min(at+chunk,pcm.length);i+=128){
   const samples=pcm.subarray(i,i+128);detector.process(samples,i/rate,silence.subarray(0,samples.length));
  }
  let work;do{work=detector.attribution.drain({budgetMs:8,maxSteps:64});}while(work.more);
 }
 const onsets=messages.filter(message=>message.type==='onset');
 const detected=onsets.map(message=>message.time),tolerance=.06;
 const missing=expected.filter(time=>!detected.some(hit=>Math.abs(time-hit)<=tolerance));
 const extra=detected.filter(hit=>!expected.some(time=>Math.abs(time-hit)<=tolerance));
 const ok=detected.length===expected.length&&!missing.length&&!extra.length;
 results.push({name,status:ok?'PASS':'FAIL',chunk,expected,detected,missing,extra,cues,
  families:onsets.map(message=>({time:message.time,birth:message.originalFamilyTime,frequency:message.frequency}))});
}

function chord(attacks){
 const frequencies=[146.8324,293.6648,349.2282],amplitudes=[.07,.03,.02];
 return time=>{
  const age=time-.4,hold=.65;if(age<0||age>=hold)return 0;
  return frequencies.reduce((sum,frequency,i)=>sum+amplitudes[i]
   *Math.min(1,age/attacks[i],(hold-age)/.03)*tone(frequency,age),0);
 };
}
for(const chunk of [256,512])run('One chord with simultaneous 20/80/140 ms rank rises scores once',1.4,chord([.020,.080,.140]),[.4],chunk);
run('One chord with simultaneous 30/100/140 ms rank rises scores once',1.4,chord([.030,.100,.140]),[.4]);

for(const interval of [1/6,.2])for(const chunk of [256,512]){
 const expected=[.4,.4+interval],hold=interval-.03;
 const signal=time=>expected.reduce((sum,start)=>{
  const age=time-start;if(age<0||age>=hold)return sum;
  // A new phase, zero interval and attack envelope define a genuine repeat.
  return sum+.06*Math.min(1,age/.014,(hold-age)/.020)*tone(330,age);
 },0);
 run(`Two real same-pitch actions ${Math.round(interval*1000)} ms apart remain separate`,1.2,signal,expected,chunk);
}

for(const chunk of [256,512]){
 const expected=[.4,.4+1/6],end=expected[1]+.30;
 const signal=time=>{
  if(time<expected[0]||time>=end)return 0;
  const envelope=Math.min(1,(time-expected[0])/.020,(end-time)/.020);
  const cross=Math.max(0,Math.min(1,(time-expected[1])/.008));
  // Equal-amplitude neighboring pitches, with an 8 ms crossfade and no
  // silence. This is a new source pitch even without a loudness attack cue.
  return .008*envelope*((1-cross)*tone(220,time)+cross*tone(233.0819,time));
 };
 run('A quiet new legato pitch over continuous sound remains a second action',1.2,signal,expected,chunk);
}

const failed=results.filter(result=>result.status==='FAIL').length;
console.log(JSON.stringify({target:String(target),passed:results.length-failed,failed,
 scope:'Complete embedded streaming detector on generated PCM with independently known source actions, real front-end cue proposals and silent rendered backing. No physical instrument, speaker echo or browser timing claim.',results},null,2));
Deno.exitCode=failed?1:0;
