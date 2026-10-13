// Full embedded streaming detector. Synthetic attacks have known start times;
// downloaded single notes use observed audio starts only. argv[1] may override
// the bundled fixture directory when validating another prepared corpus.
const target=Deno.args[0]??'index.html',html=await Deno.readTextFile(target),source=html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];
const {Detector,FrontEnd}=new Function(source+';return {Detector:RhythmDetector,FrontEnd:StruckStringOnset};')(),results=[];
function record(name,ok,evidence={}){results.push({name,status:ok?'PASS':'FAIL',...evidence});}
function guitar(t,start,frequencies=[110],{amplitude=.065,decay=.20,sweep=0}={}){
 return frequencies.reduce((sum,f,n)=>{const age=t-start-n*sweep;if(age<0||age>decay*7)return sum;
  const e=Math.min(1,age/.0015)*Math.exp(-age/decay),partials=[1,.42,.23,.13,.07];
  return sum+amplitude/Math.sqrt(frequencies.length)*e*partials.reduce((s,a,h)=>s+a*Math.sin(2*Math.PI*f*(h+1)*age+.13*h),0);
 },0);
}
function piano(t,start,frequencies=[293.6648],{amplitude=.075,decay=.25}={}){
 return frequencies.reduce((sum,f)=>{const age=t-start;if(age<0||age>decay*7)return sum;
  const e=Math.min(1,age/.0008)*Math.exp(-age/decay),partials=[1,.36,.20,.11,.05];
  return sum+amplitude/Math.sqrt(frequencies.length)*e*partials.reduce((s,a,h)=>s+a*Math.sin(2*Math.PI*f*(h+1)*Math.sqrt(1+.0003*(h+1)**2)*age+.1*h),0);
 },0);
}
function run(name,{mode,rate=48000,duration=3,signal,expected,referenceSync=true,render=null,chunk=128,tolerance=.035}){
 const messages=[],d=new Detector(rate,m=>messages.push(m),Detector.compileWasm());
 d.attribution.setDeferredAnalysis(true);
 for(const m of [{type:'mode',value:mode},{type:'threshold',value:10**(-46/20)},{type:'arm',start:0,duration:2.4},{type:'reference-sync',enabled:referenceSync,routed:true,backing:!!render,id:5}])d.configure(m);
 for(let at=0;at<Math.round(duration*rate);at+=chunk){
  const n=Math.min(chunk,Math.round(duration*rate)-at),samples=Float32Array.from({length:n},(_,i)=>signal((at+i)/rate));
  const reference=render?render.subarray(at,at+n):new Float32Array(n);
  d.process(samples,at/rate,reference);let work;do{work=d.attribution.drain({budgetMs:8,maxSteps:64});}while(work.more);
 }
 const detected=messages.filter(m=>m.type==='onset').map(m=>m.time),missing=expected.filter(t=>!detected.some(h=>Math.abs(t-h)<=tolerance)),extra=detected.filter(h=>!expected.some(t=>Math.abs(t-h)<=tolerance));
 record(name,d.mode===mode&&detected.length===expected.length&&!missing.length&&!extra.length,{mode,rate,chunk,expected,detected,missing,extra});return {d,messages};
}
const guitarFront=new FrontEnd(48000,()=>{}),pianoFront=new FrontEnd(48000,()=>{});pianoFront.configure('piano');
record('Guitar and piano use distinct attack-group and envelope parameters',guitarFront.group>pianoFront.group&&guitarFront.slowSeconds>pianoFront.slowSeconds);
for(const mode of ['guitar','piano']){
 const hits=[],d=new FrontEnd(48000,m=>hits.push(m.time));d.configure(mode);
 const note=mode==='guitar'?guitar:piano;
 const feed=(start,end,onset)=>{for(let at=Math.round(start*48000);at<end*48000;at+=128){const s=Float32Array.from({length:128},(_,i)=>note((at+i)/48000,onset,[330],{decay:.06})),level=Math.sqrt(s.reduce((a,x)=>a+x*x,0)/s.length);d.process(s,at/48000,level,10**(-46/20));}};
 feed(0,.65,.4);feed(1,1.65,1.4);
 record('A source clock gap resets incomplete '+mode+' windows without shifting new source time',hits.length===2&&Math.abs(hits[0]-.4)<.025&&Math.abs(hits[1]-1.4)<.025,{detected:hits});
 d.configure(mode==='guitar'?'piano':'guitar');
 record('Changing '+mode+' profile resets its pending attack and spectral history',d.total===0&&d.pending===null&&d.baseTime===null&&d.armed&&d.previous.every(x=>x===0));
}
for(const rate of [44100,48000]){
 const starts=Array.from({length:9},(_,i)=>.4+.2*i),chords=[[110],[293.6648,349.2282,440],[293.6648,349.2282,440]];
 run('Guitar bass-chord-chord eighth notes over ringing tails',{mode:'guitar',rate,duration:2.65,expected:starts,signal:t=>starts.reduce((s,at,i)=>s+guitar(t,at,chords[i%3]),0)});
 run('Guitar swept chord is one stroke, repeated eighths remain separate',{mode:'guitar',rate,duration:2.65,expected:starts,signal:t=>starts.reduce((s,at)=>s+guitar(t,at,[82.4069,110,146.8324,196,246.9417,329.6276],{sweep:.012,decay:.16}),0)});
 run('Piano repeated Dm eighth chords over ringing tails',{mode:'piano',rate,duration:2.65,expected:starts,signal:t=>starts.reduce((s,at)=>s+piano(t,at,[293.6648,349.2282,440]),0)});
 const rapid=Array.from({length:12},(_,i)=>.4+.10*i);
 run('Piano 100 ms repeated hammer strikes stay separate',{mode:'piano',rate,duration:2.15,expected:rapid,signal:t=>rapid.reduce((s,at)=>s+piano(t,at,[440],{decay:.075}),0)});
 for(const mode of ['guitar','piano']){
  const note=mode==='guitar'?guitar:piano;
  run('Fast '+mode+' decay is detected once without a long sustain requirement',{mode,rate,duration:1.7,expected:[.4,1],signal:t=>note(t,.4,[330],{decay:.06})+note(t,1,[392],{decay:.06})});
  run('Ringing '+mode+' chord with mild beating produces one attack',{mode,rate,duration:4,expected:[.4],signal:t=>note(t,.4,[220,277.18,329.63],{decay:1.2})*(1+.12*Math.sin(2*Math.PI*2.2*t))});
  run('Quiet noise creates no '+mode+' attacks',{mode,rate,duration:1,expected:[],signal:t=>.0006*(Math.sin(2*Math.PI*91*t)+Math.sin(2*Math.PI*1433*t))});
 }
}
for(const chunk of [256,512])for(const mode of ['guitar','piano']){
 const starts=[.4,.6,.8,1,1.2,1.4],note=mode==='guitar'?guitar:piano;
 run('Streaming '+mode+' attack clock works at '+chunk+' sample blocks',{mode,chunk,duration:2,expected:starts,signal:t=>starts.reduce((s,at)=>s+note(t,at,[220]),0)});
}
// Smooth coherent amplitude growth must not be mistaken for new hammer or
// pluck attacks. Weak same-pitch repeats on louder tails remain conservative.
for(const mode of ['guitar','piano'])for(const [hz,depth]of[[6,.30],[8,.30],[10,.30],[6,.50]]){
 run('Single ringing '+mode+' tone with '+hz+' Hz '+(100*depth)+' percent smooth amplitude modulation stays one attack',{mode,duration:2.4,expected:[.3],signal:t=>{const age=t-.3;if(age<0)return 0;return .08*Math.min(1,age/.001)*Math.exp(-age/1.5)*[1,.42,.23,.13,.07].reduce((sum,a,h)=>sum+a*Math.sin(2*Math.PI*220*(h+1)*age),0)*(1+depth*Math.sin(2*Math.PI*hz*t));}});
}
for(const mode of ['guitar','piano']){
 const note=mode==='guitar'?guitar:piano;
 run('Legacy fallback without reference sync uses the '+mode+' profile',{mode,referenceSync:false,duration:1.5,expected:[.4,1],signal:t=>note(t,.4)+note(t,1)});
}
const echoUtility=await Deno.readTextFile(new URL('./echo-leakage.mjs',import.meta.url)),prefix=echoUtility.slice(0,echoUtility.indexOf("echoOnly('Dry"));
const utility=await eval('(async()=>{'+prefix+';return {backing,sample};})()');
for(const mode of ['guitar','piano']){
 const duration=5.6,render=utility.backing(48000,duration,'mixed',100),echo=t=>.6*utility.sample(render,(t-.1)*48000),starts=[2.1,2.7,3.3,3.9],note=mode==='guitar'?guitar:piano;
 run('Known rendered drums alone never produce '+mode+' points',{mode,duration,render,expected:[],signal:echo});
 run('Own '+mode+' attacks survive projection over known rendered drums',{mode,duration,render,expected:starts,tolerance:.05,signal:t=>echo(t)+starts.reduce((s,at)=>s+note(t,at,[293.6648,349.2282,440],{decay:.18}),0)});
}
{
 async function wav(path){const bytes=await Deno.readFile(path),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let data,rate,channels,bits;
  for(let at=12;at+8<=bytes.length;){const key=String.fromCharCode(...bytes.subarray(at,at+4)),size=view.getUint32(at+4,true);if(key==='fmt '){channels=view.getUint16(at+10,true);rate=view.getUint32(at+12,true);bits=view.getUint16(at+22,true);}if(key==='data')data=bytes.subarray(at+8,at+8+size);at+=8+size+(size%2);}
  if(rate!==48000||channels!==1||bits!==16||!data)throw Error('Fixture must be mono 48 kHz PCM16: '+path);
  const pcm=new DataView(data.buffer,data.byteOffset,data.byteLength);return Float32Array.from({length:data.length/2},(_,i)=>pcm.getInt16(i*2,true)/32768);
 }
 for(const [mode,file]of[['guitar','guitar-b3-mf.wav'],['piano','piano-d4-mf.wav']]){
  const path=Deno.args[1]?Deno.args[1]+'/'+file:new URL('./fixtures/instruments/'+file,import.meta.url),samples=await wav(path),signal=t=>samples[Math.floor(t*48000)]??0;
  run('Downloaded Iowa '+mode+' single note is one observed attack',{mode,duration:samples.length/48000,expected:[.150],signal,tolerance:.055});
 }
}
const failed=results.filter(r=>r.status==='FAIL').length;console.log(JSON.stringify({target,passed:results.length-failed,failed,scope:'Complete embedded detector, synthetic known attacks and acoustic-reference rejection. Optional downloaded single notes verify observed audio starts, not physical playing timing or broad instrument accuracy.',results},null,2));Deno.exitCode=failed?1:0;
