const target=Deno.args[0]??'index.html';
const html=await Deno.readTextFile(target),source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0][1];
const Detector=new Function(source+';return RhythmDetector;')(),results=[];
const offsets=[0,.67,1.46,2.23,3.11,3.91,4.70,5.59],start=.1,first=.45;
function click(t){return t>=0&&t<.04?Math.sin(2*Math.PI*1100*t)*Math.exp(-t*95)*.32*Math.min(1,t/.0008):0;}
function run(name,{rate=48000,delay=.08,amplitude=.3,noise=.0003,missing=[],varying=null,echo=null,signal=null,expected=true,tolerance=4}={}){
 const times=offsets.map(t=>first+t),end=times.at(-1)+.62,template=Float32Array.from({length:Math.ceil(rate*.04)},(_,i)=>click(i/rate)),messages=[];
 const d=new Detector(rate,m=>messages.push(m));d.configure({type:'measure-latency',start,end,times,template});
 const block=new Float32Array(128);let seed=23;
 for(let i=0;i<end*rate+256;i+=128){for(let j=0;j<128;j++){
  const t=(i+j)/rate;seed=(Math.imul(seed,1664525)+1013904223)>>>0;let sample=(seed/2147483648-1)*noise;
  if(signal)sample+=signal(t);else for(let k=0;k<times.length;k++)if(!missing.includes(k)){const lag=varying?varying[k]:delay;sample+=amplitude*click(t-times[k]-lag);if(echo)sample+=amplitude*echo.gain*click(t-times[k]-lag-echo.delay);}
  block[j]=sample;
 }d.process(block,i/rate);}
 const completed=messages.filter(m=>m.type==='latency-result'),result=completed[0];
 const arrivals=(varying??times.map(()=>delay)).filter((_,i)=>!missing.includes(i)).map(lag=>lag*1000).sort((a,b)=>a-b),middle=arrivals.length>>1,median=arrivals.length%2?arrivals[middle]:(arrivals[middle-1]+arrivals[middle])/2;
 const mae=arrivals.reduce((s,x)=>s+Math.abs(x-median),0)/arrivals.length;
 const fitChecks=!expected||(Math.abs(result?.delayMs-median)<=tolerance&&Math.abs(result?.maeMs-mae)<=2&&result?.matched===arrivals.length);
 const ok=completed.length===1&&result?.ok===expected&&fitChecks;
 results.push({name,status:ok?'PASS':'FAIL',result,expectedDelayMs:median,expectedMaeMs:mae});
}
for(const rate of [44100,48000,96000])for(const delay of [.012,.08,.235,.46])run(`${rate} Hz, ${delay*1000} ms loopback`,{rate,delay});
run('Zero-delay loopback is a valid measurement',{delay:0});
run('500 ms boundary is measurable',{delay:.5});
run('Sound outside the 500 ms measurement range is rejected',{delay:.56,expected:false});
run('Quiet click on background noise',{amplitude:.055,noise:.0006});
run('Inverted microphone polarity',{amplitude:-.3});
run('Reflection after the direct sound',{echo:{delay:.065,gain:.6}});
run('A louder delayed reflection does not replace the first credible direct click',{echo:{delay:.065,gain:2}});
run('Two missing clicks still permit robust measurement',{missing:[2,6]});
run('A late outlier affects absolute jitter but cannot pull the median correction',{varying:[.08,.08,.08,.22,.08,.08,.08,.08]});
run('Asymmetric jitter uses the median rather than the mean',{varying:[.02,.02,.02,.02,.05,.10,.20,.30]});
run('Monotonically drifting latency remains measurable and reports linear residual',{varying:[.03,.06,.09,.12,.15,.18,.21,.24]});
run('Missing clicks are absent from the absolute-jitter denominator',{varying:[.02,.03,.08,.13,.18,.23,.28,.33],missing:[2,6]});
run('Silence does not overwrite the previous correction',{amplitude:0,noise:0,expected:false});
run('Noise alone is rejected',{amplitude:0,noise:.015,expected:false});
run('Sustained tone is not mistaken for eight metronome clicks',{signal:t=>.07*Math.sin(2*Math.PI*1100*t),expected:false});
run('Variable latency is fitted across all beats without discarding jitter',{varying:[.04,.13,.22,.31,.40,.12,.27,.46]});
run('Insufficient audible clicks are rejected',{missing:[0,1,2,3],expected:false});
console.log(JSON.stringify({target,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,scope:'Synthetic acoustic loopback, not physical microphone/output measurements.',results},null,2));Deno.exitCode=results.some(r=>r.status==='FAIL')?1:0;
