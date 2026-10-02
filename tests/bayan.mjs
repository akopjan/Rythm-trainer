const target = Deno.args[0] ?? 'index.html';
const html = await Deno.readTextFile(target);
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)][0][1];
const Detector = new Function(source+';return RhythmDetector;')();
const results = [];
const rate = 48000;
function run(name,duration,signal,expected,{threshold=-48,mode='sustained',tolerance=.075}={}) {
  const hits=[],detector=new Detector(rate,m=>{if(m.type==='onset')hits.push(m.time);});
  detector.configure({type:'mode',value:mode});detector.configure({type:'threshold',value:10**(threshold/20)});detector.configure({type:'arm',start:0,duration:4});
  const block=new Float32Array(128);
  for(let i=0;i<duration*rate;i+=128) {for(let j=0;j<128;j++)block[j]=signal((i+j)/rate);detector.process(block,i/rate);}
  const ok=hits.length===expected.length && hits.every((t,i)=>t>=expected[i]-.015 && t-expected[i]<=tolerance);
  results.push({name,status:ok?'PASS':'FAIL',expected,hits,delaysMs:hits.map((t,i)=>(t-expected[i])*1000)});
}
function note(t,start,length,freq,amplitude=.09,attack=.08,release=.035) {
  const age=t-start;if(age<0||age>=length)return 0;
  const envelope=Math.min(1,age/attack,(length-age)/release);
  // Synthetic reed-like tone with multiple harmonics, not a recording of a bayan.
  return amplitude*envelope*(Math.sin(2*Math.PI*freq*age)+.42*Math.sin(2*Math.PI*2*freq*age)+.23*Math.sin(2*Math.PI*3*freq*age)+.1*Math.sin(2*Math.PI*5*freq*age));
}
for(const attack of [.025,.08,.15]) {
  const starts=[.3,1.1,1.9,2.7];run(`Separated notes with ${attack*1000} ms attack`,3.4,t=>starts.reduce((s,start)=>s+note(t,start,.6,220,.07,attack),0),starts);
}
run('Quiet reed notes above a sensitive threshold',3,t=>[.3,1.2,2.1].reduce((s,start)=>s+note(t,start,.55,330,.016,.08),0),[.3,1.2,2.1],{threshold:-52});
run('Held note has one onset, no periodic duplicates',8,t=>note(t,.3,7.4,196,.09,.08),[.3]);
run('Held note with gentle bellows-like modulation has one onset',8,t=>note(t,.3,7.4,220,.09,.08)*(1+.15*Math.sin(2*Math.PI*1.3*t)),[.3]);
run('Melody changes over a held bass',4.2,t=>note(t,.3,3.6,110,.07,.06)+[.9,1.7,2.5].reduce((s,start,i)=>s+note(t,start,.75,[330,392,440][i],.06,.07),0),[.3,.9,1.7,2.5]);
run('Legato transitions at similar volume',3.6,t=>[.3,1.1,1.9,2.7].reduce((s,start,i)=>s+note(t,start,.86,[220,277.18,329.63,392][i],.065,.045,.06),0),[.3,1.1,1.9,2.7]);
run('Quiet background noise produces no notes',3,t=>.0008*(Math.sin(2*Math.PI*91*t)+Math.sin(2*Math.PI*1433*t)),[]);
run('Notes remain detectable after a long held tone',7,t=>note(t,.3,4.6,196,.08,.08)+note(t,5.2,.7,330,.065,.08)+note(t,6.1,.65,392,.065,.08),[.3,5.2,6.1]);
run('Rapid repeated notes at 180 BPM eighths',2.5,t=>Array.from({length:10},(_,i)=>.3+i/6).reduce((s,start)=>s+note(t,start,.14,330,.08,.02,.02),0),Array.from({length:10},(_,i)=>.3+i/6));
const summary={target,scope:'Synthetic reed-like signals, not a physical instrument recording.',passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
