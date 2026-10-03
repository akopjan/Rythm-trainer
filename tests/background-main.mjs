// Independent state checks: automatic learning must never pause or erase scoring.
const html=await Deno.readTextFile(Deno.args[0]||'index.html');
const start=html.indexOf('function resetBackground(){'),end=html.indexOf('function resetIsolation(){',start);
if(start<0||end<start)throw Error('Background UI helper missing');
const targets=new Map(['background-info','mic'].map(id=>[id,{textContent:'',checked:true}]));
const state={running:true,pending:false,measuring:false,token:3,count:4,events:[{time:1}],calibrating:false};
const api=new Function('state','$',html.slice(start,end)+';return {resetBackground,acceptBackground,updateBackgroundInfo};')(state,id=>targets.get(id));
let passed=0;const check=(name,condition)=>{if(!condition)throw Error(name);passed++;};
api.resetBackground();
const events=state.events;
for(const [i,status]of['learning','instrument','unknown'].entries()){
 api.acceptBackground({type:'background-state',id:3,time:i+1,status,reason:'test',version:i,ready:i>0});
 check('Current status '+status,state.background.status===status);
 check('Scoring stays active '+status,state.running&&!state.calibrating&&state.count===4&&state.events===events);
}
const current=state.background;
for(const message of[{id:2,time:10,status:'learning'},{id:3,time:1,status:'learning'},{id:3,time:NaN,status:'learning'},{id:3,time:4,status:'bad'}]){
 api.acceptBackground(message);check('Reject stale or invalid state',state.background===current);
}
state.measuring=true;api.acceptBackground({id:3,time:4,status:'learning'});check('Measurement cannot consume background updates',state.background===current);
state.measuring=false;state.pending=true;api.acceptBackground({id:3,time:4,status:'learning'});check('Pending session rejects updates',state.background===current);
state.pending=false;state.running=false;api.acceptBackground({id:3,time:4,status:'learning'});check('Stopped session rejects updates',state.background===current);
api.resetBackground();check('New session resets only background',state.background.version===0&&state.count===4&&state.events===events);
console.log(JSON.stringify({passed,total:passed}));
