// Complete embedded detector, as fed by the microphone worker. Acoustic clips
// are licensed accordion recordings, not verified bayan or physical-keypress
// annotations. The waveform onset proxies are documented in provenance.json.
const target=Deno.args[0]??new URL('../index.html',import.meta.url);
const html=await Deno.readTextFile(target),source=html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];
const Detector=new Function(source+';return RhythmDetector;')(),results=[],rate=48000;
const fixtureRoot=Deno.args[1]?Deno.args[1].replace(/\/$/,'')+'/':new URL('./fixtures/reeds/',import.meta.url);
const fixturePath=name=>typeof fixtureRoot==='string'?fixtureRoot+name:new URL(name,fixtureRoot);
const provenance=JSON.parse(await Deno.readTextFile(fixturePath('provenance.json')));

async function wav(path){
 const bytes=await Deno.readFile(path),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let data,format,channels,sampleRate,bits;
 for(let at=12;at+8<=bytes.length;){
  const id=String.fromCharCode(...bytes.subarray(at,at+4)),size=view.getUint32(at+4,true);
  if(id==='fmt '){format=view.getUint16(at+8,true);channels=view.getUint16(at+10,true);sampleRate=view.getUint32(at+12,true);bits=view.getUint16(at+22,true);}
  if(id==='data')data=bytes.subarray(at+8,at+8+size);
  at+=8+size+(size%2);
 }
 if(format!==1||channels!==1||sampleRate!==rate||bits!==16||!data)throw Error('Expected mono 48 kHz PCM16 fixture: '+path);
 const pcm=new DataView(data.buffer,data.byteOffset,data.byteLength);
 return Float32Array.from({length:data.length/2},(_,i)=>pcm.getInt16(i*2,true)/32768);
}

function run(name,samples,expected,{chunk=512,tolerance=.1}={}){
 const messages=[],detector=new Detector(rate,message=>messages.push(message),Detector.compileWasm());
 detector.attribution.setDeferredAnalysis(true);
 for(const message of [{type:'mode',value:'sustained'},{type:'threshold',value:10**(-48/20)},{type:'arm',start:0,duration:2.4},{type:'reference-sync',enabled:true,routed:true,backing:false,id:1}])detector.configure(message);
 const silence=new Float32Array(chunk);
 for(let at=0;at<samples.length;at+=chunk){
  // Worker input is processed in 128-sample pieces, with analysis drained once
  // per posted input block. Delayed analysis must retain source timestamps.
  for(let i=at;i<Math.min(at+chunk,samples.length);i+=128){
   const input=samples.subarray(i,Math.min(i+128,samples.length));
   detector.process(input,i/rate,silence.subarray(0,input.length));
  }
  let work;do{work=detector.attribution.drain({budgetMs:8,maxSteps:64});}while(work.more);
 }
 const detected=messages.filter(message=>message.type==='onset').map(message=>message.time);
 const missing=expected.filter(time=>!detected.some(hit=>Math.abs(time-hit)<=tolerance));
 const extra=detected.filter(hit=>!expected.some(time=>Math.abs(time-hit)<=tolerance));
 const ok=detected.length===expected.length&&!missing.length&&!extra.length;
 results.push({name,status:ok?'PASS':'FAIL',chunk,expected,detected,missing,extra,toleranceSeconds:tolerance});
}

const fixtures=[];
for(const fixture of provenance.fixtures){
 const samples=await wav(fixturePath(fixture.path));fixtures.push({fixture,samples});
 for(const chunk of [256,512])run(fixture.id+' has one acoustic onset and no held-note duplicates',samples,fixture.acoustic_onset_proxy_seconds,{chunk});
}

function signal(duration,sample){return Float32Array.from({length:Math.round(duration*rate)},(_,i)=>sample(i/rate));}
function reed(age,frequency){return Math.sin(2*Math.PI*frequency*age)+.42*Math.sin(4*Math.PI*frequency*age+.2)+.23*Math.sin(6*Math.PI*frequency*age+.4)+.10*Math.sin(10*Math.PI*frequency*age+.6);}
function held(t,start,hold,frequencies,attack=.025){
 const age=t-start;if(age<0||age>=hold)return 0;
 const envelope=Math.min(1,age/attack,(hold-age)/.035);
 return .065/Math.sqrt(frequencies.length)*envelope*frequencies.reduce((sum,f)=>sum+reed(age,f),0);
}

// Interference between simultaneously started reeds changes the envelope
// without a new key action. Dissonance and musette tuning both occur within a
// single synthetic source attack, and must not become extra player points.
for(const [name,frequencies]of[
 ['Musette pair with 4 Hz beating',[220,224]],
 ['High musette pair with 6 Hz beating',[587.3295,593.3295]],
 ['Simultaneous dissonant chord',[220,233.0819,293.6648]],
])run(name+' has one attack',signal(3,t=>held(t,.3,2.2,frequencies)),[.3]);

// Each restart is generated with a new source phase, an explicit zero interval
// and a fresh attack envelope. Suppressing beat maxima must preserve genuine
// repeated articulation, including eighth notes with repeated Dm chords.
const starts=Array.from({length:9},(_,i)=>.3+.2*i);
run('Rearticulated same-pitch reeds at 150 BPM remain nine attacks',signal(2.4,t=>starts.reduce((sum,start)=>sum+held(t,start,.165,[220],.014),0)),starts,{tolerance:.06});
run('Rearticulated musette reeds at 150 BPM remain nine attacks',signal(2.4,t=>starts.reduce((sum,start)=>sum+held(t,start,.165,[220,224],.014),0)),starts,{tolerance:.06});
run('Independent bass-Dm-Dm eighths with silence and fresh phase remain nine attacks',signal(2.4,t=>starts.reduce((sum,start,i)=>sum+held(t,start,.165,i%3===0?[146.8324]:[293.6648,349.2282,440],.014),0)),starts,{tolerance:.06});

// Repeat the complete short recorded chord with a generous silence gap rather
// than truncating its tail or inventing physical playing timestamps. The labels
// are digital montage placement plus the same documented envelope proxy.
const dm=fixtures.find(item=>item.fixture.id==='accordion-Cellini-minor-D-single');
const placements=[0,.65,1.3],montage=new Float32Array(Math.round(2.6*rate));
for(const placement of placements){
 const offset=Math.round(placement*rate);
 for(let i=0;i<dm.samples.length&&offset+i<montage.length;i++)montage[offset+i]+=dm.samples[i];
}
run('Complete Cellini Dm recordings separated by silence remain three acoustic attacks',montage,placements.map(time=>time+dm.fixture.acoustic_onset_proxy_seconds[0]));
run('Silence creates no reed attack',new Float32Array(rate),[]);

const failed=results.filter(result=>result.status==='FAIL').length;
console.log(JSON.stringify({target:String(target),passed:results.length-failed,failed,scope:'Complete embedded streaming detector in sustained mode, CC0 accordion clips and generated known source attacks. Neither instrument is confirmed bayan. Acoustic labels are envelope proxies within 100 ms, not physical keypress truth; recorded-repeat labels are digital montage positions.',results},null,2));
Deno.exitCode=failed?1:0;
