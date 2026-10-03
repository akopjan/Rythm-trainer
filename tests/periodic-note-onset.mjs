const path=Deno.args[0]??new URL('../dsp/periodic-note-onset.js',import.meta.url);
const source=await Deno.readTextFile(path),Follower=new Function(source+';return PeriodicNoteOnset;')();
const rate=48000,results=[];
function simulate(signal,seconds,{chunk=128,gate=.004}={}){const hits=[],follower=new Follower(rate,m=>hits.push(m));for(let offset=0;offset<seconds*rate;offset+=chunk){const count=Math.min(chunk,Math.round(seconds*rate)-offset),samples=Float32Array.from({length:count},(_,i)=>signal((offset+i)/rate,offset+i));follower.process(samples,offset/rate,gate);}return hits;}
function note(t,start,length,freq,amplitude=.065,attack=.15,release=.05){const age=t-start;if(age<0||age>=length)return 0;const e=Math.min(1,age/attack,(length-age)/release);return amplitude*e*(Math.sin(2*Math.PI*freq*age)+.36*Math.sin(2*Math.PI*freq*2*age)+.19*Math.sin(2*Math.PI*freq*3*age));}
function check(name,signal,seconds,expected,options={}){const hits=simulate(signal,seconds,options),tolerance=options.tolerance??.100,ok=hits.length===expected.length&&hits.every((h,i)=>h.time>=expected[i]-.035&&h.time<=expected[i]+tolerance);results.push({name,status:ok?'PASS':'FAIL',expected,hits});return hits;}
const starts=[.5,1.5,2.5];for(const attack of [.08,.18,.28])check('Soft periodic starts with '+attack+' second rise',t=>starts.reduce((s,at)=>s+note(t,at,.7,330,.065,attack),0),3.5,starts,{tolerance:.12});
const changes=[.4,1.2,2,2.8],frequencies=[220,277.18,329.63,392];
const legato=t=>{if(t<.4||t>=3.6)return 0;const i=Math.min(3,Math.floor((t-.4)/.8)),age=t-changes[i],env=t<.48?(t-.4)/.08:1;return .065*env*(Math.sin(2*Math.PI*frequencies[i]*age)+.36*Math.sin(2*Math.PI*frequencies[i]*2*age)+.19*Math.sin(2*Math.PI*frequencies[i]*3*age));};
check('Equal-RMS legato pitch changes',legato,4,changes,{tolerance:.10});
const adjacent=t=>{if(t<.4||t>=2.8)return 0;const i=Math.min(2,Math.floor((t-.4)/.8)),freq=[330,349.63,369.99][i],age=t-(.4+i*.8),env=t<.48?(t-.4)/.08:1;return .065*env*(Math.sin(2*Math.PI*freq*age)+.36*Math.sin(2*Math.PI*freq*2*age)+.19*Math.sin(2*Math.PI*freq*3*age));};
check('Adjacent-semitone legato changes',adjacent,3.2,[.4,1.2,2],{tolerance:.11});

check('Held periodic note produces one event',t=>note(t,.4,4.5,220),5.2,[.4]);
check('Held note with bellows amplitude modulation',t=>note(t,.4,4.5,220)*(1+.35*Math.sin(2*Math.PI*1.3*t)),5.2,[.4]);
check('Held vibrato does not create new notes',t=>{if(t<.4||t>=4.9)return 0;const age=t-.4,phase=2*Math.PI*330*age+330*.012/5*Math.sin(2*Math.PI*5*age),env=Math.min(1,age/.12);return .065*env*(Math.sin(phase)+.36*Math.sin(2*phase)+.19*Math.sin(3*phase));},5.2,[.4]);
let random=0x784fa124;const noise=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return (random/2**32-.5)*.045;};check('Broadband noise creates no periodic notes',noise,3,[]);
check('Subthreshold tonal background remains silent',t=>.001*(Math.sin(2*Math.PI*220*t)+.4*Math.sin(2*Math.PI*440*t)),3,[]);
check('Pitch-sweeping kicks and short clicks create no periodic notes',t=>{let s=0;for(let at=.3;at<3;at+=.3){const age=t-at;if(age>=0&&age<.18)s+=.18*Math.exp(-age/0.04)*Math.sin(2*Math.PI*(52*age+100*(1-Math.exp(-age/0.03))*.03));if(age>=0&&age<.020)s+=.04*Math.exp(-age/.006)*Math.sin(2*Math.PI*1100*age);}return s;},3.5,[]);
const a=simulate(legato,4,{chunk:128}),b=simulate(legato,4,{chunk:512});results.push({name:'128/512 callback chunk invariance at48kHz',status:JSON.stringify(a)===JSON.stringify(b)?'PASS':'FAIL',hits128:a,hits512:b});
const summary={passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,scope:'Synthetic periodic signals; candidate proposals require rendered-backing attribution in the app.',results};console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
