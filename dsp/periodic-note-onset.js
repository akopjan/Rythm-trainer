// A small note follower for cleaned microphone samples. It proposes starts and
// pitch changes; the caller must still audit them against its rendered backing.
class PeriodicNoteOnset {
 constructor(rate,emit){
  this.rate=rate;this.emit=emit;this.stride=Math.max(1,Math.round(rate/8000));this.sampledRate=rate/this.stride;
  this.n=512;this.hop=64;this.ring=new Float64Array(this.n);this.frame=new Float64Array(this.n);this.correlations=new Float64Array(128);
  this.window=new Float64Array(this.n);this.windowSum=0;for(let i=0;i<this.n;i++){this.window[i]=.5-.5*Math.cos(2*Math.PI*i/(this.n-1));this.windowSum+=this.window[i];}
  this.alpha=1-Math.exp(-2*Math.PI*3200/rate);this.reset();
 }
 reset(){this.ring.fill(0);this.cursor=0;this.total=0;this.nativeTotal=0;this.baseTime=null;this.low=0;this.low2=0;this.divider=0;this.pitch=null;this.pending=null;this.invalidSince=null;this.lastHit=-10;this.lastFeature=null;}
 process(samples,t,gate=.004){
  if(!samples?.length||!Number.isFinite(t))return;
  if(this.baseTime===null)this.baseTime=t;
  else if(Math.abs(t-(this.baseTime+this.nativeTotal/this.rate))>.015){this.reset();this.baseTime=t;}
  for(let i=0;i<samples.length;i++){
   const x=Number.isFinite(samples[i])?samples[i]:0;this.low+=this.alpha*(x-this.low);this.low2+=this.alpha*(this.low-this.low2);this.nativeTotal++;
   if(++this.divider<this.stride)continue;this.divider=0;this.ring[this.cursor]=this.low2;this.cursor=(this.cursor+1)%this.n;this.total++;
   if(this.total>=this.n&&this.total%this.hop===0)this.observe(this.baseTime+this.nativeTotal/this.rate,Math.max(1e-6,gate));
  }
 }
 feature(gate){
  const x=this.frame,n=this.n;let mean=0;for(let i=0;i<n;i++){x[i]=this.ring[(this.cursor+i)%n];mean+=x[i];}mean/=n;
  let energy=0,early=0,late=0;for(let i=0;i<n;i++){x[i]-=mean;const p=x[i]*x[i];energy+=p;if(i<n/2)early+=p;else late+=p;}
  const rms=Math.sqrt(energy/n);if(rms<gate*.85||late<early*.58)return null;
  const minimum=Math.max(3,Math.ceil(this.sampledRate/1400)),maximum=Math.min(this.correlations.length-2,Math.floor(this.sampledRate/80));let best=0;
  for(let lag=minimum;lag<=maximum;lag++){let dot=0,a=0,b=0;for(let i=lag;i<n;i++){dot+=x[i]*x[i-lag];a+=x[i]*x[i];b+=x[i-lag]*x[i-lag];}const c=a*b>1e-20?dot/Math.sqrt(a*b):0;this.correlations[lag]=c;if(c>best)best=c;}
  if(best<.78)return null;
  let selected=-1;for(let lag=minimum+1;lag<maximum;lag++)if(this.correlations[lag]>=Math.max(.78,best*.94)&&this.correlations[lag]>=this.correlations[lag-1]&&this.correlations[lag]>this.correlations[lag+1]){selected=lag;break;}
  if(selected<0)return null;
  const a=this.correlations[selected-1],b=this.correlations[selected],c=this.correlations[selected+1],offset=Math.abs(a-2*b+c)>1e-12?.5*(a-c)/(a-2*b+c):0;
  const frequency=this.sampledRate/(selected+Math.max(-.5,Math.min(.5,offset))),coefficient=f=>2*Math.cos(2*Math.PI*f/this.sampledRate);
  const power=f=>{let p=0,q=0;const k=coefficient(f);for(let i=0;i<n;i++){const value=x[i]*this.window[i]+k*p-q;q=p;p=value;}return Math.max(0,p*p+q*q-k*p*q)/(this.windowSum*this.windowSum);};
  const fundamental=power(frequency),harmonics=power(frequency*2)+power(frequency*3),fraction=2*fundamental/(energy/n);
  // Autocorrelation alone also follows repetitive broadband transients.
  if(fraction<.08||harmonics<fundamental*.012&&b<.96)return null;
  return {frequency,cents:1200*Math.log2(frequency),rms,correlation:b,retention:late/Math.max(1e-20,early)};
 }
 observe(end,gate){
  const f=this.feature(gate),time=end-this.n/(2*this.sampledRate);this.lastFeature=f;
  if(!f){if(this.invalidSince===null)this.invalidSince=time;if(time-this.invalidSince>.060){this.pitch=null;this.pending=null;}return;}
  this.invalidSince=null;
  const changed=this.pitch===null||Math.abs(f.cents-this.pitch)>85;
  if(!changed){this.pending=null;this.pitch+=(f.cents-this.pitch)*.015;return;}
  if(!this.pending||Math.abs(f.cents-this.pending.pitch)>38){this.pending={time,pitch:f.cents,count:1,level:f.rms};return;}
  this.pending.count++;this.pending.pitch+=(f.cents-this.pending.pitch)*.2;this.pending.level=Math.max(this.pending.level,f.rms);
  if(time-this.pending.time<.032||this.pending.count<4)return;
  const candidate=this.pending;this.pitch=candidate.pitch;this.pending=null;
  if(candidate.time-this.lastHit<.090)return;
  this.lastHit=candidate.time;this.emit({type:'onset',time:Math.max(this.baseTime,candidate.time),level:candidate.level,frequency:2**(candidate.pitch/1200),source:'periodic'});
 }
}
