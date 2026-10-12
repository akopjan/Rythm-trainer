// Full embedded detector on known synthetic bass-Dm-Dm attacks at the
// recording's 48 kHz rate. No physical keypress annotation is inferred.
const target=Deno.args[0]??new URL('../index.html',import.meta.url),html=await Deno.readTextFile(target),source=html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];
const Detector=new Function(source+';return RhythmDetector;')(),results=[];
for(const rate of [48000]){
 const times=Array.from({length:9},(_,i)=>.9+.2*i),voices=[[146.8324],[293.6648,349.2282,440],[293.6648,349.2282,440]],length=Math.round(3.1*rate),mic=new Float32Array(length),reference=new Float32Array(length),messages=[];
 for(let n=0;n<times.length;n++){
  const start=Math.round(times[n]*rate),hold=.165;
  for(let i=0;i<Math.round(hold*rate);i++){
   const age=i/rate,t=(start+i)/rate,envelope=Math.min(1,age/.016,(hold-age)/.024);
   for(const f of voices[n%3])mic[start+i]+=.06/Math.sqrt(voices[n%3].length)*envelope*(Math.sin(2*Math.PI*f*t)+.32*Math.sin(4*Math.PI*f*t+.2)+.19*Math.sin(6*Math.PI*f*t+.4));
  }
 }
 const d=new Detector(rate,m=>messages.push(m),Detector.compileWasm());d.attribution.setDeferredAnalysis(true);
 for(const m of [{type:'mode',value:'sustained'},{type:'threshold',value:10**(-48/20)},{type:'arm',start:.25,duration:2.4},{type:'reference-sync',enabled:true,routed:true,backing:false,id:1}])d.configure(m);
 for(let at=0;at<length;at+=512){for(let i=at;i<Math.min(at+512,length);i+=128)d.process(mic.subarray(i,i+128),i/rate,reference.subarray(i,i+128));let r;do{r=d.attribution.drain({budgetMs:8,maxSteps:64});}while(r.more);}
 const detected=messages.filter(m=>m.type==='onset').map(m=>m.time),missing=times.filter(t=>!detected.some(d=>Math.abs(t-d)<.06)),extra=detected.filter(d=>!times.some(t=>Math.abs(t-d)<.06));
 results.push({rate,passed:detected.length===times.length&&!missing.length&&!extra.length,expected:times,detected,missing,extra});
}
console.log(JSON.stringify({target:String(target),passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,scope:'Complete embedded detector, nine synthetic bass-Dm-Dm attacks at 150 BPM in headphones, including repeated chords. This does not measure physical recording recall.',results},null,2));if(results.some(r=>!r.passed))Deno.exitCode=1;
