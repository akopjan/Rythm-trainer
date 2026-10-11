// Deterministic residual-spectrum fixtures test visual lifecycle behavior.
// They are not a claim of transcription accuracy on an acoustic recording.
const target=Deno.args[0]??new URL('../dsp/note-duration.js',import.meta.url);
const Tracker=new Function(await Deno.readTextFile(target)+';return NoteDurationTracker;')();
const rate=48000,n=2048,results=[];
function check(name,ok){results.push({name,status:ok?'PASS':'FAIL'});}
function create(){const events=[],tracker=new Tracker(rate,m=>events.push(m));tracker.reset(7);return {tracker,events};}
function spectrum(tones=[]){const p=new Float64Array(n/2+1).fill(1e-12);for(const tone of tones){const [f,power,shift=0]=tone;for(let h=1;h<=6;h++){const k=Math.round(f*h*n/rate)+shift;if(k>1&&k<p.length-1)p[k]+=power/(h*h);}}return p;}
function feed(tracker,start,end,tones){for(let t=start;t<end-1e-7;t+=.01)tracker.observe({power:spectrum(typeof tones==='function'?tones(t):tones),time:t,complete:true});}
{
 const {tracker:t,events:e}=create();feed(t,0,.2,[]);const id=t.accept({time:.2,frequency:220}).durationId;feed(t,.2,.65,[[220,1e-4]]);feed(t,.65,.73,[]);
 check('An accepted body has one measured release after observed silence',e.filter(m=>m.type==='note-end'&&m.state==='released').length===1&&e.some(m=>m.durationId===id&&m.state==='sounding'));
 const end=e.find(m=>m.type==='note-end');check('Release and confirmation use the source frame clock',end.time>=.65&&end.time<=.66&&end.confirmedAt>=end.time+.019&&end.uncertaintySeconds>.02);
 check('The visual observer never emits an onset',e.every(m=>m.type!=='onset'));
}
{
 const {tracker:t,events:e}=create();feed(t,0,.2,[]);t.accept({time:.2,frequency:220});feed(t,.2,2,t=>[[220,t<.4?1e-4:1e-6,t<1?1:-1]]);
 check('A long held note with vibrato and 20dB dynamics has no duration timer',e.some(m=>m.state==='sounding')&&!e.some(m=>m.type==='note-end'));
 const updates=e.filter(m=>m.state==='sounding');check('Stem updates are throttled and advance only on observed source frame times',updates.length>4&&updates.length<40&&updates.every(m=>Math.abs(m.duration-(m.time-.2))<1e-10&&m.observedEnd===m.time)&&updates.every((m,k)=>k===0||m.time-updates[k-1].time>=.045-1e-9));
}
{
 const {tracker:t,events:e}=create();feed(t,0,.2,[]);const a=t.accept({time:.2,frequency:220}).durationId;feed(t,.2,.5,[[220,1e-4]]);const b=t.accept({time:.5,frequency:330}).durationId;feed(t,.5,.8,[[220,1e-4],[330,1e-4]]);feed(t,.8,.9,[[330,1e-4]]);
 check('Polyphonic families release independently',e.some(m=>m.durationId===a&&m.state==='released')&&!e.some(m=>m.durationId===b&&m.type==='note-end'));
}
{
 const {tracker:t,events:e}=create();feed(t,0,.2,[]);const a=t.accept({time:.2,frequency:220}).durationId;feed(t,.2,.5,[[220,1e-4]]);const b=t.accept({time:.5,frequency:220}).durationId;
 check('Same-frequency accepted rearticulation divides by unique note identity',a!==b&&e.some(m=>m.durationId===a&&m.state==='divided'&&m.time===.5&&m.reason==='rearticulated'));
 feed(t,.5,.8,[[220,1e-4]]);feed(t,.8,.9,[]);check('The repeated same-frequency body remains measurable without treating the preceding note as noise',e.some(m=>m.durationId===b&&m.state==='sounding')&&e.some(m=>m.durationId===b&&m.state==='released'));
}
{
 const {tracker:t,events:e}=create();feed(t,0,.2,[]);feed(t,.2,.6,[[220,1e-4]]);feed(t,.6,.7,[]);const r=t.accept({time:.2,frequency:220});
 check('Late attribution replays observed spectral history without delaying the attack',r.durationId!==null&&e.some(m=>m.state==='released'&&m.onsetTime===.2&&m.time<.65));
}
{
 const {tracker:t,events:e}=create();feed(t,0,.2,[]);t.accept({time:.2,frequency:220});feed(t,.2,.5,[[220,1e-4]]);const size=e.length;
 t.observe({power:spectrum(),time:.6,complete:false});t.observe({power:spectrum(),time:.4,complete:true});
 check('Incomplete and backward frames do not release a note',e.length===size);
 t.reset(8,'clock-reset');const interrupted=e.slice(size);feed(t,.6,.9,[]);check('Reset reports interruption under the old token without fabricating release',interrupted.length===1&&interrupted[0].id===7&&interrupted[0].interrupted===true&&interrupted[0].reason==='clock-reset'&&interrupted[0].type==='note-state'&&interrupted[0].observedDuration>0&&e.length===size+1&&t.history.length<128&&t.notes.length===0);
 const bad=t.accept({time:1});check('Missing frequency remains unavailable instead of guessing a duration',bad.durationId===null&&bad.durationStatus==='unavailable');
}
{
 const {tracker:t,events:e}=create();feed(t,0,.2,[]);t.accept({time:.2,frequency:220});feed(t,.2,.8,[]);
 check('An unmeasurable body becomes unavailable without a false release',e.some(m=>m.state==='unavailable'&&m.reason==='body-not-measurable')&&!e.some(m=>m.type==='note-end'));
 feed(t,.8,3,[]);check('Spectrum memory is bounded',t.history.length<=t.maxHistory&&t.notes.length<=t.maxNotes);
}
{
 const order=[],t=new Tracker(rate,m=>order.push(m.type));t.reset(7);feed(t,0,.2,[]);feed(t,.2,.6,[[220,1e-4]]);feed(t,.6,.7,[]);let calls=0,id=null;
 t.accept({time:.2,frequency:220},value=>{calls++;id=value;order.push('accepted');});
 check('Original onset callback is exactly once before synchronous lifecycle replay',calls===1&&Number.isInteger(id)&&order[0]==='accepted'&&order.includes('note-end'));
 let invalidCalls=0,invalidId=1;t.accept({time:.8},value=>{invalidCalls++;invalidId=value;});check('Unavailable duration still calls the original onset callback once with null',invalidCalls===1&&invalidId===null);
 const before=t.sequence;t.reset(7);t.accept({time:1,frequency:440});check('Note IDs remain unique when toggling or resetting within the same token',t.sequence>before);
}
const summary={passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,scope:'Visual lifecycle on existing complete residual spectral fixtures; no onset detector or microphone accuracy claim.',results};
console.log(JSON.stringify(summary,null,2));Deno.exitCode=summary.failed?1:0;
