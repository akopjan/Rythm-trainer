// Actual embedded FFT and evidence gates, using deterministic synthetic PCM.
// This isolates high-note confirmation; it does not measure onset recall,
// physical microphone latency, or the effectiveness of the spectral mask.
const target=Deno.args[0]??'index.html',html=await Deno.readTextFile(target);
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0]?.[1];
if(!script)throw Error('Embedded DSP script missing');
const {Core,Background,Detector,Attribution}=new Function(script+';return {Core:RhythmWasmCore,Background:AdaptiveBackgroundSpectrum,Detector:RhythmDetector,Attribution:EchoAttribution};')();
const core=new Core(),results=[];
function check(name,condition,evidence){results.push({name,status:condition?'PASS':'FAIL',evidence});}
function evidence({rate=48000,frequencies=[2637.02,5274.04],weights=[1,.32],amplitude=.025,frames=18,knownSource=false,noise=false,pulseSeconds=null}={}){
 const model=new Background(rate);model.configure({duration:.24,backing:true});
 // An analytically silent, independently vetted room profile is the baseline.
 // Known-source tests supply the rendered source's exact measured spectrum.
 const zero=new Float64Array(model.bins),mean=Array.from({length:model.rows},()=>zero);
 model.seed({mean,counts:new Uint32Array(model.rows).fill(2)});
 const detector=Object.create(Detector.prototype);detector.rate=rate;detector.background=model;
 const total=(frames-1)*256+2048,pcm=new Float64Array(total);let seed=38119;
 for(let i=0;i<total;i++){
  if(noise){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pcm[i]=amplitude*(seed/2147483648-1);}
  else if(pulseSeconds===null||i/rate>=.05&&i/rate<.05+pulseSeconds)for(let k=0;k<frequencies.length;k++)pcm[i]+=amplitude*weights[k]*Math.sin(2*Math.PI*frequencies[k]*i/rate);
 }
 let harmonic=false,firstHarmonic=null,maxPersistent=0,peakRms=0,feature=null;
 for(let frame=0;frame<frames;frame++){
  if(!core.analyze(pcm.subarray(frame*256,frame*256+2048)))throw Error('WASM analysis failed');
  const power=Float64Array.from(core.power);
  feature=model.features(power,{background:knownSource?power:zero,spread:zero},knownSource?power:zero);
  harmonic=detector.independentHarmonics({rawPower:power});
  if(harmonic&&firstHarmonic===null)firstHarmonic=frame;
  maxPersistent=Math.max(maxPersistent,feature.persistent);peakRms=Math.max(peakRms,feature.rms);
 }
 // Source projection normally precedes this gate. Here it is deliberately
 // excluded: the actual tone-confirmation gate must see independent harmonic
 // evidence, even when its candidate already has a vetted background profile.
 let accepted=0;const attribution=new Attribution(rate,()=>accepted++);
 attribution.meta={ready:true,canAudit:true,renderRecent:true};
 const job={message:{time:.1,toneCheck:true,profileReady:model.ready},gate:10**(-59/20),evidenceSnapshot:{own:harmonic,tonal:feature.persistent>0}};
 attribution.accept(job);
 return {rate,frequencies,frames,knownSource,pulseSeconds,harmonic,firstHarmonic,maxPersistent,peakRms,accepted,reason:attribution.lastDecision?.reason,profileReady:model.ready};
}

for(const rate of [44100,48000])for(const frequency of [1864.66,2217.46,2637.02]){
 const out=evidence({rate,frequencies:[frequency,frequency*2],weights:[1,.32]});
 check('High reed with fundamental and second harmonic is independently confirmed at '+frequency+' Hz / '+rate+' Hz',out.harmonic&&out.accepted===1&&out.profileReady,out);
}
for(const rate of [44100,48000]){
 const out=evidence({rate,frequencies:[2637.02,2637.02*3],weights:[1,.19]});
 check('High reed remains confirmable with third harmonic and absent second at '+rate+' Hz',out.harmonic&&out.accepted===1,out);
}
for(const [rate,frequency]of [[8000,220],[8000,1108.73],[48000,220],[48000,1567.98]]){
 const out=evidence({rate,frequencies:[frequency,frequency*2],weights:[1,.32]});
 check('Existing lower-note evidence survives at '+frequency+' Hz / '+rate+' Hz',out.harmonic&&out.accepted===1,out);
}
for(const [rate,frequency]of [[8000,1750],[16000,3500],[44100,3900],[48000,3900]]){
 const out=evidence({rate,frequencies:[frequency,frequency*2],weights:[1,.32]});
 check('Resolvable harmonic pair near the supported upper band is confirmed at '+rate+' Hz',out.harmonic&&out.accepted===1,out);
}
for(const [name,config]of [
 ['Loud known harmonic source is not independent instrument evidence',{frequencies:[2637.02,5274.04,7911.06],weights:[1,.6,.3],amplitude:.3,knownSource:true}],
 ['Known low backing remains excluded',{frequencies:[220,440,660],weights:[1,.6,.3],amplitude:.3,knownSource:true}],
 ['One loud high-note FFT observation cannot satisfy persistence',{frequencies:[2637.02,5274.04],weights:[1,.32],amplitude:.3,frames:1}],
 ['A3ms high-frequency click has no persistent harmonic evidence across overlapping FFT frames',{frequencies:[2637.02,5274.04],weights:[1,.32],amplitude:.3,pulseSeconds:.003}],
 ['Persistent pure high sine has no independent harmonic family',{frequencies:[2637.02],weights:[1],amplitude:.3}],
 ['Strong persistent inharmonic partials are not a harmonic family',{frequencies:[2637.02,4614.785],weights:[1,.7],amplitude:.15}],
 ['Persistent broadband noise does not become a high note',{noise:true,amplitude:.3}],
 ['Near-Nyquist single partial at8k has no fabricated harmonic',{rate:8000,frequencies:[3800],weights:[1],amplitude:.3}],
 ['A second partial above the guarded8k band cannot confirm a family',{rate:8000,frequencies:[1900,3800],weights:[1,.32],amplitude:.03}],
 ['A second partial above the guarded16k band cannot confirm a family',{rate:16000,frequencies:[3750,7500],weights:[1,.32],amplitude:.03}],
 ['Harmonic outside the evidence band cannot confirm an unsupported upper fundamental',{frequencies:[4800,9600],weights:[1,.32],amplitude:.03}],
]){
 const out=evidence(config);
 check(name,out.firstHarmonic===null&&!out.harmonic&&out.accepted===0&&out.reason==='tone-unconfirmed',out);
}
const passed=results.filter(r=>r.status==='PASS').length;
console.log(JSON.stringify({target,passed,failed:results.length-passed,scope:'Actual embedded WASM FFT, adaptive spectral persistence, independent harmonic evidence, and tone-confirmation gate. Analytic vetted background fixtures; no full onset-recall or physical-device claim.',results},null,2));
Deno.exitCode=passed===results.length?0:1;
