// Actual attribution proof against independent synthetic PCM. No private
// recordings, helper injections, or device-specific assumptions.
const target=Deno.args[0]??'index.html';
const input=await Deno.readTextFile(target),source=target.endsWith('.js')?input:input.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)?.[1];
if(!source)throw Error('Missing actual embedded detector source');
const Echo=new Function(source+';return EchoAttribution;')();
if(typeof Echo.prototype.lowPeriodicSourceProof!=='function')throw Error('Missing actual lowPeriodicSourceProof');
const rows=[];
function check(name,{rate=48000,f=293,tone='new',oldF=329,newParts=[1,.32,.18],own=true,known=true,source='periodic',physical=null,physicalAmplitudes=null,kickDecay=.014,kickFrequency=293,hold=.12,baseTime=0,startSeconds=0,profileReady=false,waveformReady=false}={},expected=false){
 const a=new Echo(rate,()=>{});a.meta={canAudit:known,instrumentEvidence:()=>true};a.baseTime=baseTime;const duration=.38,event=.20,onset=.16,N=Math.round(duration*rate),y=new Float32Array(N),gate=.001122018454301963;
 const family=(q,t,parts)=>parts.reduce((sum,v,i)=>sum+v*Math.sin(2*Math.PI*q*(i+1)*t+.17*i),0);
 for(let i=0;i<N;i++){
  const t=i/rate,env=Math.max(0,Math.min(1,(t-onset)/.018));let value=0;
  if(tone==='legato')value=.018*(1-env)*family(oldF,t,[1,.32,.18])+.018*env*family(f,t,newParts);
  else if(tone==='polyphonic')value=.026*family(110,t,[1,.12,.05])+.025*env*family(f,t,newParts);
  else if(tone==='held')value=.025*family(f,t,newParts);
  else if(tone==='volume')value=.02*(1+.75*Math.sin(2*Math.PI*4*t))*family(f,t,newParts);
  else if(tone==='vibrato'){const phase=2*Math.PI*f*t+f*.02/5*(1-Math.cos(2*Math.PI*5*t));value=.025*newParts.reduce((s,v,k)=>s+v*Math.sin((k+1)*phase),0);}
  else if(tone==='alias')value=.025*env*physical.reduce((s,q,k)=>s+(physicalAmplitudes?.[k]??[1,.32,.18,.14][k])*Math.sin(2*Math.PI*q*t),0);
  else if(tone==='pitched-kick'){const dt=t-onset;value=.018*family(110,t,[1,.2,.08,.04]);if(dt>=0)value+=.055*Math.exp(-dt/kickDecay)*family(kickFrequency,dt,[1,.24,.14,.1]);}
  else if(tone==='duration'){const tail=Math.max(0,Math.min(1,(onset+hold-t)/.006));value=.025*env*tail*family(f,t,newParts);}
  else if(tone==='click')value=t>=onset?.025*Math.exp(-(t-onset)/.003)*family(f,t,newParts):0;
  else value=.025*env*family(f,t,newParts);
  y[i]=value;
 }
 const job={message:{time:baseTime+startSeconds+event,source,frequency:f,profileReady,waveformReady},evidenceSnapshot:{own,tonal:true},y,eventIndex:Math.round(event*rate),start:Math.round(startSeconds*rate),length:N,gate};
 const candidateTime=job.message.time,physicalOnset=baseTime+startSeconds+onset,r=a.lowPeriodicSourceProof(job),timeCorrect=!r.ok||(Number.isFinite(r.time)&&r.time<=candidateTime&&Math.abs(r.time-physicalOnset)<=.030&&job.message.time===candidateTime);rows.push({name,expected,actual:r.ok,pass:r.ok===expected&&timeCorrect,reason:r.reason??null,time:r.time??null,physicalOnset,timeCorrect,rate,f,shape:r.shape??null});
}
for(const rate of [8000,16000,44100,48000]){
 check(`new D4 at${rate}`,{rate},true);check(`equal-level E4 toD4 at${rate}`,{rate,tone:'legato'},true);check(`held D4 at${rate}`,{rate,tone:'held'},false);check(`bellows LFO at${rate}`,{rate,tone:'volume'},false);check(`vibrato2pct at${rate}`,{rate,tone:'vibrato'},false);check(`3ms click at${rate}`,{rate,tone:'click'},false);
}
check('new D4 overheld bass',{tone:'polyphonic'},true);
check('8k-decimation alias fakeD4 native48k',{tone:'alias',physical:[7707,7414,7121]},false);
check('8k-decimation alias fakeD4 withnativefundamental',{tone:'alias',physical:[293,7414,7121]},false);
check('8k Nyquist alias fakeH3 of1400',{rate:8000,f:1400,tone:'alias',physical:[1400,3800]},false);
check('16k valid1400 H3',{rate:16000,f:1400},true);
check('8k valid1400 H2only',{rate:8000,f:1400,newParts:[1,.32,0]},true);
check('own evidence absent',{own:false},false);check('source proof absent',{known:false},false);check('nonperiodic candidate',{source:'sustained'},false);
// H4 is optional evidence measured at its native physical frequency. The
// fixture primitives deliberately retain all supplied partials; a Nyquist
// alias must be rejected by the proof rather than hidden by fixture filtering.
for(const rate of [8000,16000,44100,48000]){
 check(`native H4-only support at ${rate}`,{rate,newParts:[1,0,0,.32]},true);
 check(`held H4 family at ${rate}`,{rate,tone:'held',newParts:[1,0,0,.32]},false);
 check(`H4 family bellows LFO at ${rate}`,{rate,tone:'volume',newParts:[1,0,0,.32]},false);
 check(`H4 family vibrato at ${rate}`,{rate,tone:'vibrato',newParts:[1,0,0,.32]},false);
 check(`inharmonic fourth displaced80Hz at ${rate}`,{rate,tone:'alias',physical:[293,4*293+80]},false);
 check(`inharmonic fourth displacedminus80Hz at ${rate}`,{rate,tone:'alias',physical:[293,4*293-80]},false);
}
for(const rate of [8000,48000])for(const kickDecay of [.006,.014,.024,.04])check(`pitched kick + heldbass rate${rate} decay${kickDecay}`,{rate,tone:'pitched-kick',kickDecay},false);
for(const f of [1100,1200,1400])check(`native8k aliased H4 of ${f}`,{rate:8000,f,tone:'alias',physical:[f,8000-4*f]},false);
check('native8k H4 outside safe band but below Nyquist',{rate:8000,f:950,tone:'alias',physical:[950,3800]},false);
check('native8k valid H4 just inside safe band',{rate:8000,f:899,newParts:[1,0,0,.32]},true);
check('native8k valid H4 at safe boundary',{rate:8000,f:900,newParts:[1,0,0,.32]},true);
check('native48k 8k-folded fake H4 withtrue lowfundamental',{tone:'alias',physical:[293,8000-4*293]},false);
check('H4 supported D4 overheld bass',{tone:'polyphonic',newParts:[1,0,0,.4]},true);
for(const rate of [8000,48000]){
 check(`120ms note preserves onset at ${rate}`,{rate,tone:'duration',hold:.12},true);
 check(`25ms tonal burst is not a stable note at ${rate}`,{rate,tone:'duration',hold:.025},false);
 check(`source time includes ring start and session base at ${rate}`,{rate,baseTime:11.25,startSeconds:.8},true);
}
check('ready profile proves source without current audit',{known:false,profileReady:true},true);
check('ready waveform proves source without background profile',{known:false,waveformReady:true},true);
check('live own callback cannot replace frozen own=false',{own:false,profileReady:true},false);
check('H4 source proof cannot admit below-range frequency',{f:79},false);
check('H4 source proof cannot admit above-range frequency',{f:1401},false);
const passed=rows.filter(x=>x.pass).length;
console.log(JSON.stringify({target,passed,failed:rows.length-passed,total:rows.length,scope:'Actual lowPeriodicSourceProof with native synthetic waveforms, source-time assertions, independent aliased and inharmonic negatives.',rows},null,2));
Deno.exitCode=passed===rows.length?0:1;
