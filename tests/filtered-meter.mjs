// Exercise the public meter, readiness messages, and explicit setup action together.
const html=await Deno.readTextFile(Deno.args[0]||'index.html');
const setupStart=html.indexOf('function filterSetupBusy(){'),setupEnd=html.indexOf('// Read-only explanation of where current note recognition is waiting.',setupStart);
const start=html.indexOf('function resetFilteredMeter(){'),end=html.indexOf('function resetBackground(){',start);
const isolationStart=html.indexOf('function resetIsolation(){'),isolationEnd=html.indexOf('function hasAudibleBacking(){',isolationStart);
if(setupStart<0||setupEnd<setupStart||start<0||end<start||isolationStart<0||isolationEnd<isolationStart)throw Error('Filter setup or isolation helper missing');
const source=html.slice(setupStart,setupEnd)+'\n'+html.slice(start,end)+'\n'+html.slice(isolationStart,isolationEnd);
let passed=0;
const check=(name,condition)=>{if(!condition)throw Error(name);passed++;};

function fixture(){
 const attributes={},nodes=new Map();
 nodes.set('filtered-meter',{style:{width:'0%'},parentElement:{setAttribute:(key,value)=>attributes[key]=value}});
 for(const id of ['filtered-meter-status','filter-setup-help','isolation-info'])nodes.set(id,{textContent:''});
 nodes.set('filter-setup',{disabled:false});nodes.set('mic',{checked:true});
 const state={running:true,pending:false,measuring:false,calibrating:false,token:4,count:9,events:[{time:1}],isolation:{status:'preparing',time:-Infinity,reason:'startup'}};
 const recorder={pending:false,active:null},observed={backing:true,calibrations:0,status:[]};
 const api=new Function('state','$','sampleRecorderState','hasAudibleBacking','beginCalibration','setStatus',source+';return {resetFilteredMeter,acceptFilteredLevel,updateFilteredMeter,setupFilter,updateFilterSetupControls,prepareInputStatus,updateIsolationInfo,acceptAnalysis};')(
  state,id=>nodes.get(id),recorder,()=>observed.backing,
  ()=>{observed.calibrations++;state.calibrating=true;},text=>observed.status.push(text));
 api.resetFilteredMeter();
 return {state,recorder,observed,nodes,attributes,api,width:()=>parseFloat(nodes.get('filtered-meter').style.width),label:()=>nodes.get('filtered-meter-status').textContent,help:()=>nodes.get('filter-setup-help').textContent};
}

const f=fixture(),{api,state,nodes,attributes}=f,events=state.events;
check('Unconfigured filter has no false filtered signal',f.width()===0&&f.label()==='Фильтр не настроен'&&!nodes.get('filter-setup').disabled);
api.acceptFilteredLevel({id:4,time:1,value:.001,active:true});check('Minus 60 dB is meter floor',f.width()===0);
api.acceptFilteredLevel({id:4,time:2,value:Math.sqrt(.001),active:true});check('Minus 30 dB is halfway',Math.abs(f.width()-50)<1e-10);
check('Accessible value tracks level',attributes['aria-valuenow']==='50'&&attributes['data-active']==='true');
check('Actual filtering enables its label and disables redundant setup',f.label()==='Фильтр работает'&&nodes.get('filter-setup').disabled);
api.acceptFilteredLevel({id:4,time:3,value:0,active:true});check('Zero filtered input stays finite',f.width()===0);
api.acceptFilteredLevel({id:4,time:4,value:4,active:true});check('Filtered level is capped',f.width()===100);
api.acceptFilteredLevel({id:4,time:5,value:1,active:false});
check('Loud raw input never fills the filtered meter',f.width()===0&&attributes['aria-valuenow']==='0'&&attributes['data-active']==='false'&&f.label()==='Фильтр не настроен');
check('Losing filtering restores setup guidance',!nodes.get('filter-setup').disabled&&f.observed.status.at(-1).includes('Настроить фильтр'));
const previous=state.filteredLevel;
for(const [name,message]of [
 ['old session',{id:3,time:8,value:1,active:true}],['equal timestamp',{id:4,time:5,value:1,active:true}],['older timestamp',{id:4,time:4,value:1,active:true}],
 ['nonfinite timestamp',{id:4,time:NaN,value:1,active:true}],['nonfinite level',{id:4,time:8,value:NaN,active:true}],['negative level',{id:4,time:8,value:-1,active:true}],['nonboolean active',{id:4,time:8,value:1,active:'true'}],
]){
 const statusCount=f.observed.status.length;api.acceptFilteredLevel(message);
 check(name+' cannot change the meter, status, or setup state',state.filteredLevel===previous&&f.width()===0&&f.observed.status.length===statusCount&&!nodes.get('filter-setup').disabled);
}
for(const flag of ['pending','measuring']){
 state[flag]=true;api.acceptFilteredLevel({id:4,time:8,value:1,active:true});check(flag+' rejects meter callbacks',state.filteredLevel===previous);state[flag]=false;
}
state.running=false;api.acceptFilteredLevel({id:4,time:8,value:1,active:true});check('Stopped session rejects meter callbacks',state.filteredLevel===previous);
api.resetFilteredMeter();check('Stop clears meter and accessible value',f.width()===0&&attributes['aria-valuenow']==='0'&&f.label()==='Фильтр выключен');
state.pending=true;api.updateFilteredMeter();check('Pending Start names input preparation',f.label()==='Подготовка входа…'&&nodes.get('filter-setup').disabled);
state.pending=false;state.running=true;state.token++;api.resetFilteredMeter();api.acceptFilteredLevel({id:4,time:100,value:1,active:true});check('New session rejects late active callback',f.width()===0&&f.label()==='Фильтр не настроен');
nodes.get('mic').checked=false;api.updateFilteredMeter();check('Mic disabled is explicit',f.label()==='Микрофон выключен'&&f.width()===0);
check('Meter and readiness never change score history',state.count===9&&state.events===events);

for(const [name,apply]of [
 ['stopped',g=>g.state.running=false],['pending Start',g=>g.state.pending=true],['calibration',g=>g.state.calibrating=true],['latency measurement',g=>g.state.measuring=true],
 ['microphone off',g=>g.nodes.get('mic').checked=false],['no backing',g=>g.observed.backing=false],['no audible echo',g=>g.state.isolation.status='clear'],
 ['recording initialization',g=>g.recorder.pending=true],['recording with instrument',g=>g.recorder.active={kind:'with'}],['recording background',g=>g.recorder.active={kind:'without'}],
 ['already active filter',g=>g.state.filteredLevel.active=true],
]){
 const g=fixture();apply(g);g.api.updateFilteredMeter();g.api.setupFilter();
 check(name+' disables setup and rejects direct invocation',g.nodes.get('filter-setup').disabled&&g.observed.calibrations===0);
 if(name==='calibration')check('Calibration gives visible no-playing instruction',g.label()==='Настройка: не играйте'&&g.help().includes('Не играйте на баяне'));
 if(name==='recording background')check('Background recording explains why setup is unavailable',g.help().includes('Запоминаем ритм из записи'));
}
const setup=fixture();setup.api.setupFilter();setup.api.setupFilter();setup.api.updateFilteredMeter();
check('Explicit safe click starts calibration exactly once',setup.observed.calibrations===1&&setup.state.calibrating&&setup.nodes.get('filter-setup').disabled);
check('Setup cannot be triggered automatically by UI updates',fixture().observed.calibrations===0);

const ready=fixture();ready.api.acceptAnalysis({id:4,time:1,status:'ready',reason:'echo-model-ready'});
check('Echo readiness does not claim that raw input is filtered',ready.label()==='Фильтр не настроен'&&ready.width()===0&&ready.nodes.get('isolation-info').textContent.includes('фильтр ещё не настроен')&&ready.observed.status.at(-1).includes('Настроить фильтр'));
ready.api.acceptFilteredLevel({id:4,time:2,value:.02,active:true});
check('Actual active meter refreshes readiness and playing instruction',ready.nodes.get('isolation-info').textContent.startsWith('Фильтр работает')&&ready.observed.status.at(-1)==='Фильтр работает. Можно играть.');
ready.api.acceptFilteredLevel({id:4,time:3,value:.5,active:false});
check('Filter loss removes the stale suppression promise',ready.width()===0&&ready.nodes.get('isolation-info').textContent.includes('фильтр ещё не настроен')&&ready.observed.status.at(-1).includes('Настроить фильтр'));
const oldIsolation=ready.state.isolation,statusCount=ready.observed.status.length;
ready.api.acceptAnalysis({id:3,time:100,status:'clear',reason:'no-audible-echo'});
check('Old analysis callback cannot disguise an unconfigured filter as clear',ready.state.isolation===oldIsolation&&ready.observed.status.length===statusCount&&ready.label()==='Фильтр не настроен');
for(const reason of ['backing-silent','no-audible-echo']){
 const g=fixture();g.api.acceptAnalysis({id:4,time:1,status:'clear',reason});g.api.acceptFilteredLevel({id:4,time:2,value:1,active:false});
 check(reason+' names raw input without a false suppression promise',g.label()==='Без фильтра'&&g.width()===0&&g.nodes.get('isolation-info').textContent.includes('Используется вход микрофона')&&g.observed.status.at(-1)==='Слушаем микрофон. Играйте в выбранную сетку.'&&g.nodes.get('filter-setup').disabled);
}
const silent=fixture();silent.observed.backing=false;silent.api.updateFilteredMeter();silent.api.updateIsolationInfo();
check('Silent backing needs no filter setup',silent.label()==='Без фильтра'&&silent.width()===0&&silent.nodes.get('isolation-info').textContent.includes('Используется вход микрофона')&&silent.api.prepareInputStatus()==='Слушаем микрофон. Играйте в выбранную сетку.');
console.log(JSON.stringify({passed,total:passed}));
