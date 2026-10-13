// Causal pluck/hammer onset front end. Positive spectral growth uses the
// previous spectrum's frequency-neighbour maximum to suppress moving partials
// (the SuperFlux principle). One small FFT per 256 samples, no pitch search.
// These are attack profiles, not classifiers or instrument sound generators.
class StruckStringOnset {
 constructor(rate,emit){
  this.rate=rate;this.emit=emit;this.n=2048;this.hop=256;
  this.ring=new Float32Array(this.n);this.real=new Float32Array(this.n);this.imag=new Float32Array(this.n);
  this.previous=new Float32Array(this.n/2+1);this.magnitude=new Float32Array(this.n/2+1);
  this.window=new Float32Array(this.n);this.reverse=new Uint16Array(this.n);
  this.cos=new Float32Array(this.n/2);this.sin=new Float32Array(this.n/2);
  for(let i=0;i<this.n;i++){this.window[i]=.5-.5*Math.cos(2*Math.PI*i/(this.n-1));let x=i,r=0;for(let b=0;b<11;b++){r=(r<<1)|(x&1);x>>=1;}this.reverse[i]=r;}
  for(let i=0;i<this.n/2;i++){this.cos[i]=Math.cos(2*Math.PI*i/this.n);this.sin[i]=-Math.sin(2*Math.PI*i/this.n);}
  this.configure('guitar');
 }
 configure(mode){
  this.mode=mode==='piano'?'piano':'guitar';
  // Guitar strings can start sequentially within one stroke; piano hammer
  // attacks need a shorter group so repeated key strikes remain eligible.
  this.group=this.mode==='guitar'?.085:.040;
  this.riseLimit=this.mode==='guitar'?.06:.08;
  this.releaseLimit=this.mode==='guitar'?.035:.045;
  this.slowSeconds=this.mode==='guitar'?.040:.028;
  this.reset();
 }
 reset(){
  this.ring.fill(0);this.previous.fill(0);this.cursor=0;this.total=0;this.baseTime=null;this.nextTime=null;
  this.fast=0;this.slow=0;this.pending=null;this.lastHit=-Infinity;this.flux=0;this.fluxFloor=0;
  this.armed=true;this.quietSince=null;this.lastFluxTime=-Infinity;this.lastSpectralRise=-Infinity;
 }
 spectrum(time,gate){
  const n=this.n,re=this.real,im=this.imag;
  for(let i=0;i<n;i++){re[this.reverse[i]]=this.ring[(this.cursor+i)%n]*this.window[i];im[i]=0;}
  for(let size=2;size<=n;size*=2){const half=size/2,stride=n/size;for(let base=0;base<n;base+=size)for(let j=0;j<half;j++){
   const a=base+j,b=a+half,k=j*stride,vr=re[b]*this.cos[k]-im[b]*this.sin[k],vi=re[b]*this.sin[k]+im[b]*this.cos[k];
   re[b]=re[a]-vr;im[b]=im[a]-vi;re[a]+=vr;im[a]+=vi;
  }}
  const first=Math.max(1,Math.ceil((this.mode==='piano'?28:60)*n/this.rate)),last=Math.min(n/2-1,Math.floor(11000*n/this.rate));
  let positive=0,total=0;
  for(let k=first-1;k<=last+1;k++)this.magnitude[k]=Math.hypot(re[k],im[k]);
  for(let k=first;k<=last;k++){
   const magnitude=this.magnitude[k],prior=Math.max(this.previous[k-1],this.previous[k],this.previous[k+1]);
   positive+=Math.max(0,magnitude-prior);total+=magnitude;
  }
  const flux=total>1e-8?positive/total:0,oldFlux=this.flux;
  this.flux=flux;this.lastFluxTime=time;
  const limit=Math.max(this.riseLimit,this.fluxFloor*2.5+.035);
  const strong=flux>limit&&this.fast>gate;
  if(flux<this.releaseLimit)this.fluxFloor+=(flux-this.fluxFloor)*.06;
  if(flux<this.releaseLimit){
   if(this.quietSince===null)this.quietSince=time;
   if(time-this.quietSince>=.012)this.armed=true;
  }else this.quietSince=null;
  // A spectral candidate must have a new rising edge. This avoids reporting
  // successive string/partial maxima of the same still-rising attack.
  const spectralEdge=strong&&oldFlux<=limit&&(flux>.15||this.fast>this.slow*.90);
  if(strong&&(this.pending||spectralEdge&&this.armed)){
   const message=this.pending||{time:Math.max(this.baseTime,time-n/(2*this.rate)),level:this.fast};
   if(message.time-this.lastHit>=this.group){
    this.lastHit=message.time;this.armed=false;
    this.emit({type:'onset',time:message.time,level:message.level,inputProfile:this.mode,source:'struck-string'});
   }
   this.pending=null;this.lastSpectralRise=time;
  }
  this.previous.set(this.magnitude);
 }
 process(samples,t,level,gate){
  if(this.nextTime!==null&&Math.abs(t-this.nextTime)>.03)this.reset();
  if(this.baseTime===null)this.baseTime=t;
  this.nextTime=t+samples.length/this.rate;
  const duration=samples.length/this.rate;
  this.fast+=(level-this.fast)*(1-Math.exp(-duration/.003));
  this.slow+=(level-this.slow)*(1-Math.exp(-duration/this.slowSeconds));
  const energyRise=this.fast>gate&&this.fast>this.slow*1.4&&this.fast-this.slow>gate*.25;
  if(energyRise&&t-this.lastHit>=this.group&&this.armed&&!this.pending){
   let first=0;while(first<samples.length&&Math.abs(samples[first])<=gate)first++;
   this.pending={time:t+Math.min(first,samples.length-1)/this.rate,level};
  }
  if(this.pending){this.pending.level=Math.max(this.pending.level,level);if(t-this.pending.time>.048)this.pending=null;}
  for(let i=0;i<samples.length;i++){
   this.ring[this.cursor]=samples[i];this.cursor=(this.cursor+1)%this.n;this.total++;
   if(this.total>=this.n&&this.total%this.hop===0)this.spectrum(this.baseTime+this.total/this.rate,gate);
  }
 }
}
