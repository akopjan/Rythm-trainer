// Real detector reproductions for preparation gates that never opened.
// The digital reference is always the exact master backing sent to speakers;
// captured echo may have attenuation, room noise, or a causal speaker EQ.
const target = Deno.args[0] ?? 'index.html';
const utilitySource = await Deno.readTextFile(new URL('./echo-leakage.mjs', import.meta.url));
let prefix = utilitySource.slice(0, utilitySource.indexOf("echoOnly('Dry"));
prefix = prefix.replace(/const workerSource =[^\n]+/, 'const workerSource = scripts[0];');
const { backing, bayan, sample, RhythmDetector } = await eval('(async()=>{' + prefix + ';return {backing,bayan,sample,RhythmDetector};})()');
const results = [];

function run({distortion=0,cutoff=null,gain=.7,kind='mixed',rate=8000,times=[]}={}){
 const duration=10,render=backing(rate,duration,kind,100),own=bayan(rate,duration,times,.08),capture=new Float32Array(render.length);let y=0;
 const alpha=cutoff?1-Math.exp(-2*Math.PI*cutoff/rate):1;
 for(let i=0;i<capture.length;i++){y+=alpha*(sample(render,i-.1*rate)-y);const x=y*gain;capture[i]=(distortion?Math.tanh(x*distortion)/distortion:x)+own[i];}
 const messages=[],d=new RhythmDetector(rate,m=>messages.push(m));d.configure({type:'mode',value:'sustained'});d.configure({type:'threshold',value:10**(-48/20)});d.configure({type:'arm',start:.25,duration:2.4});d.configure({type:'reference-sync',enabled:true,id:1,backing:true,routed:true});
 for(let i=0;i<capture.length;i+=128)d.process(capture.subarray(i,i+128),i/rate,render.subarray(i,i+128));
 return {config:{distortion,cutoff,gain,kind,rate,times},onsets:messages.filter(m=>m.type==='onset').map(m=>m.time),background:d.background.info(),reference:d.reference.analysisInfo()};
}
function check(name,config,expected=[]){const audio=run(config),missing=expected.filter(t=>!audio.onsets.some(hit=>Math.abs(hit-t)<.12)),extra=audio.onsets.filter(hit=>!expected.some(t=>Math.abs(hit-t)<.12));results.push({name,status:!missing.length&&!extra.length&&audio.onsets.length===expected.length?'PASS':'FAIL',evidence:{config,expected,detected:audio.onsets,missing,extra}});}
for(const config of [{},{distortion:10},{distortion:40},{cutoff:700,distortion:10},{cutoff:250,distortion:40},{kind:'clicks',distortion:10},{distortion:10,rate:48000},{cutoff:250,distortion:40,rate:48000}])check('Backing alone is never scored, including the first seconds '+JSON.stringify(config),config);
for(const config of [{distortion:10,times:[.93,2.13,3.33]},{distortion:10,times:[6.33,7.53,8.73]},{distortion:10,rate:48000,times:[.93,2.13,3.33]},{distortion:10,rate:48000,times:[6.33,7.53,8.73]}])check('Independent bayan attacks survive distorted backing '+JSON.stringify(config),config,config.times);
const passed=results.filter(r=>r.status==='PASS').length;
console.log(JSON.stringify({passed,failed:results.length-passed,scope:'Synthetic nonlinear speaker path; all onsets from Start are checked, without trimming the warm-up.',results},null,2));
Deno.exitCode=passed===results.length?0:1;
