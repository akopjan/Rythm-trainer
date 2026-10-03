// The filtered meter must never display a stale session or unfiltered input.
const html=await Deno.readTextFile(Deno.args[0]||'index.html');
const start=html.indexOf('function resetFilteredMeter(){'),end=html.indexOf('function resetBackground(){',start);
if(start<0||end<start)throw Error('Filtered meter helper missing');
const source=html.slice(start,end);
const nodes=new Map();
const attributes={};
nodes.set('filtered-meter',{style:{width:'0%'},parentElement:{setAttribute:(key,value)=>attributes[key]=value}});
nodes.set('filtered-meter-status',{textContent:''});nodes.set('mic',{checked:true});
const state={running:true,pending:false,measuring:false,token:4,count:9,events:[{time:1}]};
const api=new Function('state','$',source+';return {resetFilteredMeter,acceptFilteredLevel,updateFilteredMeter};')(state,id=>nodes.get(id));
let passed=0;const check=(name,condition)=>{if(!condition)throw Error(name);passed++;};
const width=()=>parseFloat(nodes.get('filtered-meter').style.width),label=()=>nodes.get('filtered-meter-status').textContent;
const events=state.events;
api.resetFilteredMeter();check('Preparation has no false filtered signal',width()===0&&label()==='Фильтр готовится');
api.acceptFilteredLevel({id:4,time:1,value:.001,active:true});check('Minus 60 dB is meter floor',width()===0);
api.acceptFilteredLevel({id:4,time:2,value:Math.sqrt(.001),active:true});check('Minus 30 dB is halfway',Math.abs(width()-50)<1e-10);
check('Accessible value tracks level',attributes['aria-valuenow']==='50'&&attributes['data-active']==='true');
check('Active filter label',label()==='Фильтр работает');
api.acceptFilteredLevel({id:4,time:3,value:0,active:true});check('Zero input stays finite',width()===0);
api.acceptFilteredLevel({id:4,time:4,value:4,active:true});check('Level is capped',width()===100);
api.acceptFilteredLevel({id:4,time:5,value:1,active:false});check('Unfiltered input stays out of filtered meter',width()===0&&attributes['data-active']==='false'&&label()==='Фильтр готовится');
const previous=state.filteredLevel;
for(const message of[{id:3,time:8,value:1,active:true},{id:4,time:5,value:1,active:true},{id:4,time:4,value:1,active:true},{id:4,time:NaN,value:1,active:true},{id:4,time:8,value:NaN,active:true},{id:4,time:8,value:-1,active:true},{id:4,time:8,value:1,active:'true'}]){
 api.acceptFilteredLevel(message);check('Stale or invalid message is rejected',state.filteredLevel===previous);
}
for(const flag of['pending','measuring']){
 state[flag]=true;api.acceptFilteredLevel({id:4,time:8,value:1,active:true});check(flag+' rejects updates',state.filteredLevel===previous);state[flag]=false;
}
state.running=false;api.acceptFilteredLevel({id:4,time:8,value:1,active:true});check('Stopped session rejects updates',state.filteredLevel===previous);
api.resetFilteredMeter();check('Stop clears bar and accessible value',width()===0&&attributes['aria-valuenow']==='0'&&label()==='Фильтр выключен');
state.pending=true;api.updateFilteredMeter();check('Pending Start shows preparation',label()==='Фильтр готовится');
state.pending=false;state.running=true;state.token++;api.resetFilteredMeter();api.acceptFilteredLevel({id:4,time:100,value:1,active:true});check('New session rejects old callback',width()===0);
nodes.get('mic').checked=false;api.updateFilteredMeter();check('Mic disabled is explicit',label()==='Микрофон выключен'&&width()===0);
check('Meter never alters scoring',state.count===9&&state.events===events);
console.log(JSON.stringify({passed,total:passed}));
