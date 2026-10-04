// Recognition telemetry explains zero points without changing scoring or audio.
const html=await Deno.readTextFile(Deno.args[0]||'index.html');
const start=html.indexOf('function resetDetection(){'),end=html.indexOf('function resetFilteredMeter(){',start);
if(start<0||end<start)throw Error('Detection UI helper missing');
const nodes=new Map([['mic',{checked:true}],['detection-info',{textContent:'stable layout'}],['detection-message',{textContent:''}],['detection-candidates',{textContent:''}],['detection-accepted',{textContent:''}],['detection-rejected',{textContent:''}]]);
const state={running:true,pending:false,measuring:false,calibrating:false,token:8,count:5,events:[{time:1}]};
const api=new Function('state','$',html.slice(start,end)+';return {resetDetection,acceptDetection,updateDetectionInfo};')(state,id=>nodes.get(id));
let passed=0;const check=(name,condition)=>{if(!condition)throw Error(name);passed++;};
const label=()=>nodes.get('detection-message').textContent,events=state.events;
const counts=()=>['detection-candidates','detection-accepted','detection-rejected'].map(id=>nodes.get(id).textContent).join('/');
api.resetDetection();check('Awaiting input is explicit',label().includes('ждём звук микрофона'));
check('Fresh diagnostic resets each fixed-position counter',counts()==='0/0/0');
let time=0;
const message=(extra={})=>({id:8,time:++time,mode:'sustained',level:.03,gate:.01,pausedReason:null,candidates:0,accepted:0,rejected:0,lastDecision:null,...extra});
api.acceptDetection(message({level:.005}));check('Below-threshold bottleneck is visible',label().includes('ниже порога'));
api.acceptDetection(message());check('Above threshold with no beginnings is visible',label().includes('Ищем начало или смену'));
api.acceptDetection(message({mode:'percussive'}));check('Percussive mode describes hits rather than note changes',label().includes('Ищем начало удара'));
for(const [pausedReason,needle]of[['calibration','пока не играйте'],['reference','Нет звуковой опоры'],['learning','дайте рисунку']]){
 api.acceptDetection(message({pausedReason}));check('Pause '+pausedReason+' is explained',label().includes(needle));
}
api.acceptDetection(message({candidates:1}));check('Pending beginning check is visible',label().includes('Проверяем'));
api.acceptDetection(message({candidates:1,rejected:1,lastDecision:{time:time+.5,reason:'speaker'}}));
check('Speaker rejection is explained',label().includes('барабаны или метроном')&&nodes.get('detection-rejected').textContent==='1');
for(const [reason,needle]of[['tone-unconfirmed','нота пока не подтверждена'],['held-tone','Нота продолжается'],['below-threshold','слишком тихое']]){
 api.acceptDetection(message({candidates:1,rejected:1,lastDecision:{time:time+.5,reason}}));check('Decision '+reason+' is explained',label().includes(needle));
}
api.acceptDetection(message({candidates:2,accepted:1,rejected:1,lastDecision:{time:time+.5,reason:'instrument'}}));check('Accepted note and counts are visible',label().includes('Ноты распознаются')&&counts()==='2/1/1');
check('Changing explanations never includes counters in the message line',!label().includes('подтверждено')&&!label().includes('отсеяно'));
api.acceptDetection(message({candidates:2,accepted:1,rejected:1,lastDecision:{time:time-10,reason:'speaker'}}));check('Old decision does not mask current search',label().includes('Ищем начало'));
api.acceptDetection(message({candidates:3,accepted:1,rejected:1,pending:0}));check('Dropped or duplicate candidate is not mistaken for pending verification',label().includes('Ищем начало'));
for(const [i,reason,needle]of[[0,'speaker','похоже на барабаны или метроном'],[1,'tone-unconfirmed','нота пока не подтверждена'],[2,'held-tone','продолжается прежняя нота'],[3,'below-threshold','слишком тихое для выбранного порога']]){
 api.acceptDetection(message({candidates:4+i,accepted:1,rejected:1+i,pending:1,lastDecision:{time:time+.5,reason}}));
 check('Queued next attack does not conceal recent '+reason+' rejection',label().includes('Проверяем')&&label().includes(needle));
}
api.acceptDetection(message({candidates:7,accepted:1,rejected:4,pending:1,lastDecision:{time:time-10,reason:'speaker'}}));check('Old rejection is not shown for a new pending attack',label().includes('Проверяем')&&!label().includes('Предыдущее начало'));
api.acceptDetection(message({candidates:7,accepted:1,rejected:4,pending:1,pausedReason:'calibration',lastDecision:{time:time+.5,reason:'speaker'}}));check('Calibration pause keeps priority over pending and rejection explanation',label().includes('Калибровка')&&!label().includes('Проверяем')&&!label().includes('Предыдущее начало'));
const old=state.detection;
const valid={id:8,time:100,mode:'sustained',level:.03,gate:.01,pausedReason:null,candidates:7,accepted:1,rejected:4,pending:0,lastDecision:null};
for(const change of[{id:7},{time:old.time},{time:NaN},{mode:'bad'},{level:-1},{level:NaN},{gate:NaN},{pausedReason:'bad'},{candidates:.2},{candidates:1},{accepted:0},{accepted:4},{rejected:-1},{pending:-1},{pending:.5},{pending:8},{lastDecision:{time:101,reason:'speaker'}},{lastDecision:{time:99,reason:'bad'}}]){
 api.acceptDetection({...valid,...change});check('Stale or invalid telemetry is rejected',state.detection===old);
}
for(const key of['pending','measuring']){state[key]=true;api.acceptDetection(valid);check(key+' excludes telemetry',state.detection===old);state[key]=false;}
state.running=false;api.acceptDetection(valid);check('Stop excludes telemetry',state.detection===old);api.resetDetection();check('Stop resets only diagnostic counts',state.detection.candidates===0&&counts()==='0/0/0'&&label()==='Распознавание остановлено.');
state.pending=true;api.updateDetectionInfo();check('Start preparation is visible',label().includes('подготовка входа'));state.pending=false;state.running=true;state.token++;api.resetDetection();api.acceptDetection(valid);check('Fresh session rejects old callbacks',state.detection.time===-Infinity);
nodes.get('mic').checked=false;api.updateDetectionInfo();check('Mic disabled is explicit',label().includes('микрофон выключен'));
check('Telemetry never changes score, history, or calibration',state.count===5&&state.events===events&&!state.calibrating);
check('Live updates preserve the parent layout and its counter cells',nodes.get('detection-info').textContent==='stable layout');
console.log(JSON.stringify({passed,total:passed}));
