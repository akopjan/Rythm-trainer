// Polyphonic instrument regressions through the actual embedded detector.
// Sound fixtures use the app's drum synthesis and independent harmonic triads.
// These are synthetic source attacks, not annotated physical instrument notes.
const target = Deno.args[0] ?? 'index.html';
const utilitySource = await Deno.readTextFile(new URL('./echo-leakage.mjs', import.meta.url));
const prefix = utilitySource.slice(0, utilitySource.indexOf("echoOnly('Dry")).replace("if (step % 16 === 15) add(sounds[3], time, .12);", '');
const {backing, sample, RhythmDetector} = await eval('(async()=>{' + prefix + ';return {backing,sample,RhythmDetector};})()');
const results = [];
const triads = [[220, 277.18, 329.63], [196, 246.94, 293.66], [220, 277.18, 329.63]];

function instrument(rate, duration, times, {pitches=triads, amplitude=.08, hold=.44}={}) {
 const output=new Float32Array(Math.round(rate*duration));
 for(let note=0;note<times.length;note++) {
  const chord=pitches[note%pitches.length],start=Math.round(times[note]*rate),count=Math.round(hold*rate);
  const buffer=new Float64Array(count);let power=0,singletonPower=0;
  // Normalize the finite chord envelope to the corresponding single note's
  // exact RMS, including all harmonics and start phase.
  for(let j=0;j<count&&start+j<output.length;j++) {
   const since=j/rate,time=(start+j)/rate,envelope=Math.min(1,since/.018)*Math.min(1,(hold-since)/.035);
   for(const frequency of chord)buffer[j]+=amplitude/Math.sqrt(chord.length)*envelope*(Math.sin(2*Math.PI*frequency*time)+.32*Math.sin(4*Math.PI*frequency*time)+.19*Math.sin(6*Math.PI*frequency*time));
   const frequency=chord[0],single=amplitude*envelope*(Math.sin(2*Math.PI*frequency*time)+.32*Math.sin(4*Math.PI*frequency*time)+.19*Math.sin(6*Math.PI*frequency*time));
   power+=buffer[j]**2;singletonPower+=single**2;
  }
  const normalization=Math.sqrt(singletonPower/Math.max(1e-30,power));
  for(let j=0;j<count&&start+j<output.length;j++)output[start+j]+=buffer[j]*normalization;
 }
 return output;
}

function run({rate=8000,times=[],duration=14,distortion=10,cutoff=null,pitches=triads,hold=.44}={}) {
 const render=backing(rate,duration,'mixed',100),own=instrument(rate,duration,times,{pitches,hold}),capture=new Float32Array(render.length);
 const alpha=cutoff?1-Math.exp(-2*Math.PI*cutoff/rate):1;let speaker=0;
 for(let i=0;i<capture.length;i++) {
  speaker+=alpha*(sample(render,i-.1*rate)-speaker);
  const x=speaker*.7;capture[i]=(distortion?Math.tanh(x*distortion)/distortion:x)+own[i];
 }
 const messages=[],detector=new RhythmDetector(rate,m=>messages.push(m));
 detector.configure({type:'mode',value:'sustained'});
 detector.configure({type:'threshold',value:10**(-48/20)});
 detector.configure({type:'arm',start:.25,duration:2.4});
 detector.configure({type:'reference-sync',enabled:true,id:1,backing:true,routed:true});
 const readiness=times.map(time=>({time,profileReady:null}));let next=0,readyAt=null;
 for(let i=0;i<capture.length;i+=128) {
  const time=i/rate;
  while(next<readiness.length&&time>=readiness[next].time){readiness[next].profileReady=detector.background?.ready===true;next++;}
  detector.process(capture.subarray(i,i+128),time,render.subarray(i,i+128));
  if(readyAt===null&&detector.background?.ready)readyAt=time;
 }
 return {onsets:messages.filter(m=>m.type==='onset').map(m=>m.time),readiness,readyAt,background:detector.background?.info(),reference:detector.reference.analysisInfo()};
}

function check(name,config,{cold=false,warm=false,tolerance=.12}={}) {
 const audio=run(config),expected=config.times??[],missing=expected.filter(time=>!audio.onsets.some(hit=>Math.abs(hit-time)<tolerance)),extra=audio.onsets.filter(hit=>!expected.some(time=>Math.abs(hit-time)<tolerance));
 const phaseCorrect=(!cold||audio.readiness.every(item=>item.profileReady===false))&&(!warm||audio.readiness.every(item=>item.profileReady===true));
 results.push({name,status:!missing.length&&!extra.length&&audio.onsets.length===expected.length&&phaseCorrect?'PASS':'FAIL',evidence:{config,expected,detected:audio.onsets,missing,extra,readiness:audio.readiness,readyAt:audio.readyAt,phaseCorrect}});
}

for(const rate of [8000,48000]) {
 check(`Cold-start triads survive before a background profile at ${rate} Hz`,{rate,times:[.93,2.13,3.33]},{cold:true});
 check(`${rate===8000?'Triads survive after automatic background preparation':'Late triads remain recognized'} at ${rate} Hz`,{rate,times:[9.33,10.53,11.73]},{warm:rate===8000});
 if(rate===48000)check(`Rapid independent note changes remain recognized at ${rate} Hz`,{rate,times:[9.33,9.63,9.93],pitches:[[220],[277.18],[329.63]],hold:.25},{tolerance:.10});
 check(`Distorted drums never create player points at ${rate} Hz`,{rate});
 check(`Dark, strongly distorted drums never create player points at ${rate} Hz`,{rate,cutoff:250,distortion:40});
}

const passed=results.filter(r=>r.status==='PASS').length;
console.log(JSON.stringify({target,passed,failed:results.length-passed,scope:'Actual embedded RhythmDetector, independent single notes and polyphonic chords, complete synthetic speaker loopback from Start; no physical recording or note-recall claim.',results},null,2));
Deno.exitCode=passed===results.length?0:1;
