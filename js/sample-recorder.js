// Diagnostic capture is parallel to recognition: two inputs share one audio clock.
// Hooks: initSampleRecorder(), recordSampleDiagnostics(message), stopSampleRecording(reason).
const sampleRecorderWorklet=String.raw`
class RhythmSampleCapture extends AudioWorkletProcessor {
 constructor(options){super();const p=options.processorOptions||{};this.limit=Math.max(1,Math.min(Math.round(sampleRate*20),Math.round(p.samples)||1));this.batch=Math.max(128,Math.round(sampleRate/4));this.mic=new Float32Array(this.batch);this.reference=new Float32Array(this.batch);this.used=0;this.count=0;this.first=null;this.expectedSourceFrame=null;this.lastSourceEndFrame=null;this.finished=false;this.referenceMissing=0;this.clockBoundaryCount=0;this.clockMetadataTruncatedAt=null;this.port.onmessage=e=>{if(e.data?.type==='stop')this.finish('manual');};}
 clockSummary(){return {clockBoundaryCount:this.clockBoundaryCount,clockBoundariesDropped:Math.max(0,this.clockBoundaryCount-64),clockMetadataTruncatedAt:this.clockMetadataTruncatedAt,lastSourceEndFrame:this.lastSourceEndFrame};}
 flush(){if(!this.used)return;const mic=this.mic.slice(0,this.used),reference=this.reference.slice(0,this.used);this.port.postMessage({type:'chunk',offset:this.count-this.used,mic,reference,...this.clockSummary()},[mic.buffer,reference.buffer]);this.used=0;}
 finish(reason,details={}){if(this.finished)return;this.flush();this.finished=true;this.port.postMessage({type:reason==='missing-input'?'error':'done',reason,samples:this.count,startFrame:this.first,endFrame:this.clockBoundaryCount?null:this.lastSourceEndFrame,referenceMissingSamples:this.referenceMissing,...this.clockSummary(),...details});}
 process(inputs,outputs){
  for(const output of outputs)for(const channel of output)channel.fill(0);if(this.finished)return true;const mic=inputs[0]?.[0],reference=inputs[1]?.[0];
  if(!mic?.length){if(this.first!==null)this.finish('missing-input',{expectedFrame:this.expectedSourceFrame,actualFrame:currentFrame,inputLength:0,referenceLength:reference?.length||0});return true;}
  if(this.first===null){this.first=currentFrame;this.port.postMessage({type:'started',startFrame:this.first});}
  else if(currentFrame!==this.expectedSourceFrame){
   // A source-clock observation cannot prove PCM was lost or duplicated.
   // Preserve arrival order and record timing boundaries separately.
   if(this.clockBoundaryCount<64)this.flush();this.clockBoundaryCount++;
   if(this.clockBoundaryCount<=64)this.port.postMessage({type:'clock-boundary',offset:this.count,expectedFrame:this.expectedSourceFrame,actualFrame:currentFrame,deltaFrames:currentFrame-this.expectedSourceFrame,inputLength:mic.length});
   else if(this.clockMetadataTruncatedAt===null)this.clockMetadataTruncatedAt=this.count;
  }
  const n=Math.min(mic.length,this.limit-this.count);this.referenceMissing+=Math.max(0,n-(reference?.length||0));
  for(let i=0;i<n;i++){this.mic[this.used]=mic[i];this.reference[this.used]=reference?.[i]||0;this.used++;this.count++;this.lastSourceEndFrame=currentFrame+i+1;if(this.used===this.batch)this.flush();}
  this.expectedSourceFrame=currentFrame+mic.length;if(this.count===this.limit)this.finish('complete');return true;
 }
}
registerProcessor('rhythm-sample-capture',RhythmSampleCapture);
`;
const sampleRecorderState={active:null,pending:false,exporting:false,deleting:false,deletedRecords:new Set(),generation:0,records:new Map(),dbPromise:null,objectURLs:[],initialized:false,workletModules:new WeakMap()};
function sampleWav(samples,sampleRate){
 if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>384000)throw new Error('Некорректная частота записи.');
 const data=new ArrayBuffer(44+samples.length*2),view=new DataView(data);
 const text=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
 text(0,'RIFF');view.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
 for(let i=0;i<samples.length;i++){const value=Number.isFinite(samples[i])?Math.max(-1,Math.min(1,samples[i])):0;view.setInt16(44+i*2,Math.round(value*(value<0?32768:32767)),true);}
 return new Blob([data],{type:'audio/wav'});
}
function sampleCRC32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
async function sampleZip(entries){
 const encoder=new TextEncoder(),chunks=[],central=[];let offset=0;
 for(const entry of entries){const name=encoder.encode(entry.name);const bytes=entry.data instanceof Blob?new Uint8Array(await entry.data.arrayBuffer()):entry.data instanceof Uint8Array?entry.data:encoder.encode(String(entry.data));const crc=sampleCRC32(bytes),header=new Uint8Array(30+name.length),v=new DataView(header.buffer);
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint32(14,crc,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,name.length,true);header.set(name,30);chunks.push(header,bytes);
  const index=new Uint8Array(46+name.length),d=new DataView(index.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x0800,true);d.setUint32(16,crc,true);d.setUint32(20,bytes.length,true);d.setUint32(24,bytes.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);index.set(name,46);central.push(index);offset+=header.length+bytes.length;
 }
 const centralSize=central.reduce((n,x)=>n+x.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
 return new Blob([...chunks,...central,end],{type:'application/zip'});
}
function sampleRecorderDB(){
 if(!sampleRecorderState.dbPromise)sampleRecorderState.dbPromise=new Promise((resolve,reject)=>{
  if(!window.indexedDB){reject(new Error('Браузер не поддерживает сохранение записи.'));return;}
  const request=window.indexedDB.open('rhythm-trainer.samples.v1',1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('samples'))request.result.createObjectStore('samples',{keyPath:'kind'});};request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};request.onerror=()=>reject(request.error||new Error('Не удалось открыть хранилище записи.'));request.onblocked=()=>reject(new Error('Закройте другие вкладки тренажёра и повторите сохранение.'));
 });
 return sampleRecorderState.dbPromise;
}
async function sampleStore(record){const db=await sampleRecorderDB();await new Promise((resolve,reject)=>{const tx=db.transaction('samples','readwrite');tx.objectStore('samples').put(record);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('Не удалось сохранить запись.'));tx.onabort=tx.onerror;});}
async function sampleLoad(){const db=await sampleRecorderDB();return await new Promise((resolve,reject)=>{const tx=db.transaction('samples','readonly'),request=tx.objectStore('samples').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Не удалось прочитать сохранённые записи.'));});}
function sampleLoadForExport(){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Хранилище не ответило за 3 секунды.')),3000);sampleLoad().then(records=>{clearTimeout(timer);resolve(records);},error=>{clearTimeout(timer);reject(error);});});}
function sampleRecordIdentity(record){return record?JSON.stringify([record.kind,record.metadata,record.mic?.size,record.reference?.size]):null;}
async function sampleDelete(record){
 if(sampleRecorderState.deleting||sampleRecorderState.exporting||sampleRecorderState.active||sampleRecorderState.pending)return;
 if(sampleRecorderState.records.get(record.kind)!==record){sampleRenderList();sampleSetStatus('Список записей обновился. Выберите запись ещё раз.');return;}
 const label=`${record.kind.startsWith('with-')||record.kind==='with'?'С баяном':'Без баяна'} · ${record.metadata.durationSeconds.toFixed(1)} с · ${sampleRecordDate(record)}`;
 if(!window.confirm(`Удалить запись «${label}» из этого браузера?
Будут удалены звук микрофона, звук ритма и диагностика этой записи. Скачанные файлы останутся.`))return;
 const identity=sampleRecordIdentity(record);sampleRecorderState.deleting=true;++sampleRecorderState.generation;sampleRecorderControls();sampleSetStatus('Удаляем выбранную запись…');
 try{
  const db=await sampleRecorderDB();let stored=null,matched=false;
  await new Promise((resolve,reject)=>{const tx=db.transaction('samples','readwrite'),store=tx.objectStore('samples'),request=store.get(record.kind);request.onsuccess=()=>{stored=request.result;if(!stored||sampleRecordIdentity(stored)===identity){matched=true;store.delete(record.kind);}};tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Не удалось удалить запись из хранилища.'));});
  if(!matched){if(sampleRecorderState.records.get(record.kind)===record&&sampleValidRecord(stored))sampleRecorderState.records.set(record.kind,stored);else sampleMergeRecords([stored]);sampleSetStatus('В хранилище уже другая запись. Она сохранена; выберите нужную запись ещё раз.');}
  else {sampleRecorderState.deletedRecords.add(identity);if(sampleRecordIdentity(sampleRecorderState.records.get(record.kind))===identity)sampleRecorderState.records.delete(record.kind);sampleSetStatus('Выбранная запись удалена из этого браузера. Скачанные файлы остались.');}
 }catch(error){sampleSetStatus(`Не удалось удалить запись: ${error.message} Запись сохранена в списке.`);}
 finally{sampleRecorderState.deleting=false;sampleRenderList();}
}
function sampleSetStatus(text){const node=$('sample-status');if(node)node.textContent=text;}
function sampleRecorderControls(){
 const busy=sampleRecorderState.pending||Boolean(sampleRecorderState.active);
 for(const id of ['sample-with','sample-without'])if($(id))$(id).disabled=busy||sampleRecorderState.deleting||state.pending||state.measuring||state.calibrating;
 if($('sample-stop'))$('sample-stop').disabled=!busy;
 if($('sample-save'))$('sample-save').disabled=busy||sampleRecorderState.deleting||sampleRecorderState.exporting||sampleRecorderState.records.size===0;
 if($('sample-list')){for(const button of $('sample-list').querySelectorAll('button'))button.disabled=busy||sampleRecorderState.deleting||sampleRecorderState.exporting;$('sample-list').hidden=busy;if(busy)for(const player of $('sample-list').querySelectorAll('audio'))player.pause();}
}
function updateSampleControls(){sampleRecorderControls();}
function sampleRecordFolder(kind){return {'with':'with-bayan','without':'without-bayan','with-error':'with-bayan-error','without-error':'without-bayan-error'}[kind];}
function sampleErrorLabel(error){const reason=error?.reason||'unknown';return ({'missing-input':'Микрофон прервал передачу звука','clock-gap':'Пропуск в аудиочасах','clock-backward':'Аудиочасы пошли назад','too-many-gaps':'В записи слишком много пропусков','gap-invalid':'Нарушились сведения о пропуске','clock-boundary-invalid':'Нарушились сведения о временных метках','processor-error':'Ошибка обработчика записи','chunk-order':'Нарушен порядок звуковых блоков','transfer-incomplete':'Получены не все звуковые блоки'}[reason]||'Запись прервана')+` (${reason}).`;}
function sampleRecordTime(record){const value=Date.parse(record?.metadata?.createdAt);return Number.isFinite(value)?value:-Infinity;}
function sampleSortedRecords(records=sampleRecorderState.records.values()){return [...records].sort((a,b)=>sampleRecordTime(b)-sampleRecordTime(a));}
function sampleValidRecord(record){return Boolean(sampleRecordFolder(record?.kind)&&record.mic instanceof Blob&&record.reference instanceof Blob&&Number.isFinite(record.metadata?.durationSeconds));}
function sampleMergeRecords(records){for(const record of records){if(!sampleValidRecord(record)||sampleRecorderState.deletedRecords.has(sampleRecordIdentity(record)))continue;const current=sampleRecorderState.records.get(record.kind);if(!current||sampleRecordTime(record)>sampleRecordTime(current))sampleRecorderState.records.set(record.kind,record);}}
function sampleRecordDate(record){return Number.isFinite(sampleRecordTime(record))?new Date(record.metadata.createdAt).toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'дата неизвестна';}
function sampleRenderList(){
 for(const url of sampleRecorderState.objectURLs)URL.revokeObjectURL(url);sampleRecorderState.objectURLs=[];
 const list=$('sample-list');if(!list)return;list.replaceChildren();
 const records=sampleSortedRecords();for(const record of records){const kind=record.kind,item=document.createElement('div'),label=document.createElement('p'),button=document.createElement('button'),withBayan=kind==='with'||kind==='with-error',failed=kind.endsWith('-error');
  const uncertain=record.metadata.timingReliable===false,partial=record.metadata.incomplete??failed;
  label.textContent=`${withBayan?'С баяном':'Без баяна'} · ${record.metadata.durationSeconds.toFixed(1)} с · ${sampleRecordDate(record)}${record===records[0]&&Number.isFinite(sampleRecordTime(record))?' · Последняя':''}${uncertain?' · временные метки нестабильны':''}${record.metadata.hasGaps?' · запись с пропусками: '+(record.metadata.missingSamples/record.metadata.sampleRate*1000).toFixed(1)+' мс':''}${partial?' · неполная запись'+(record.metadata.captureError?' · '+sampleErrorLabel(record.metadata.captureError):''):''}${record.metadata.samples===0?' Звук не получен; сохранена диагностика.':''}`;
  item.append(label);if(record.metadata.samples!==0){const player=document.createElement('audio');player.controls=true;player.preload='metadata';player.setAttribute('aria-label',withBayan?'Запись микрофона с баяном':'Запись микрофона без баяна');player.addEventListener('play',()=>{if(state.running)stop();});const url=URL.createObjectURL(record.mic);sampleRecorderState.objectURLs.push(url);player.src=url;item.append(player);}button.type='button';button.textContent=failed?'Скачать запись и диагностику (ZIP)':'Скачать эту запись (ZIP)';button.addEventListener('click',()=>sampleDownload([record]));item.append(button);const remove=document.createElement('button');remove.type='button';remove.textContent='Удалить';remove.setAttribute('aria-label',`Удалить запись ${withBayan?'с баяном':'без баяна'} от ${sampleRecordDate(record)}`);remove.addEventListener('click',()=>sampleDelete(record));item.append(remove);list.append(item);
 }
 sampleRecorderControls();
}
async function sampleDownload(selectedRecords){
 const globalExport=selectedRecords===undefined;if(sampleRecorderState.exporting||sampleRecorderState.deleting)return;
 const statusGeneration=sampleRecorderState.generation,mayUpdateStatus=()=>sampleRecorderState.generation===statusGeneration&&!sampleRecorderState.active&&!sampleRecorderState.pending;
 let records=selectedRecords?[...selectedRecords]:null;const storageRefresh={attempted:globalExport,success:null,error:null};
 sampleRecorderState.exporting=true;sampleRecorderControls();
 try{
  if(globalExport){
   try{sampleMergeRecords(await sampleLoadForExport());storageRefresh.success=true;}
   catch(error){storageRefresh.success=false;storageRefresh.error=String(error?.message||error||'Storage read failed').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,160);}
   // Choose one snapshot after the read; newer in-memory captures always win.
   records=sampleSortedRecords();if(!sampleRecorderState.active&&!sampleRecorderState.pending)sampleRenderList();
  }
  records=records.filter(sampleValidRecord);if(!records.length)return;
  const exportedAt=new Date().toISOString(),entries=[],manifest=[];
  for(const record of records){const folder=sampleRecordFolder(record.kind);entries.push({name:`${folder}/mic.wav`,data:record.mic},{name:`${folder}/reference.wav`,data:record.reference},{name:`${folder}/metadata.json`,data:JSON.stringify(record.metadata,null,2)});manifest.push({kind:record.kind,folder,createdAt:record.metadata.createdAt,durationSeconds:record.metadata.durationSeconds,samples:record.metadata.samples,appVersion:record.metadata.appVersion||'unversioned'});}
  entries.push({name:'export-info.json',data:JSON.stringify({version:1,exportedAt,currentAppVersion:document.querySelector('meta[name="rhythm-trainer-version"]')?.content||window.location.search||'unversioned',currentPageURL:window.location.href,storageRefresh,records:manifest},null,2)});
  const blob=await sampleZip(entries),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`rhythm-trainer-samples-${exportedAt.replace(/[:.]/g,'-')}.zip`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);if(mayUpdateStatus())sampleSetStatus(`Архив скачан. Записей: ${records.length}. Отправьте ZIP в чат.${storageRefresh.success===false?' Хранилище недоступно; скачаны записи, доступные на странице.':''}`);
 }catch(error){if(mayUpdateStatus())sampleSetStatus(`Не удалось скачать запись: ${error.message}`);}
 finally{sampleRecorderState.exporting=false;sampleRecorderControls();}
}

function sampleDiagnosticsValue(value,depth=0){
 if(value===null||typeof value==='boolean')return value;if(typeof value==='number')return Number.isFinite(value)?value:null;if(typeof value==='string')return value.slice(0,160);if(depth>=3)return null;
 if(Array.isArray(value))return value.slice(0,16).map(x=>sampleDiagnosticsValue(x,depth+1));if(value&&typeof value==='object'){const result={};for(const key of Object.keys(value).slice(0,24))if(key!=='samples'&&key!=='reference'&&key!=='profile'&&key!=='buffer')result[key]=sampleDiagnosticsValue(value[key],depth+1);return result;}return null;
}
function recordSampleDiagnostics(message){
 const recording=sampleRecorderState.active;if(!recording||!['detection-state','filtered-level','background-state','analysis-state','acoustic-sync'].includes(message?.type)||message.id!==undefined&&message.id!==recording.sessionId)return;
 const snapshot=sampleDiagnosticsValue(message);snapshot.receivedContextTime=Number.isFinite(recording.ctx?.currentTime)?recording.ctx.currentTime:null;recording.diagnosticLatest[message.type]=snapshot;
 if(recording.diagnostics.length<2000)recording.diagnostics.push(snapshot);else recording.diagnosticsDropped++;
}
function sampleClockSummary(recording,message){
 if(Number.isInteger(message.clockBoundaryCount)&&message.clockBoundaryCount>=(recording.clockBoundaryCount||0))recording.clockBoundaryCount=message.clockBoundaryCount;
 if(Number.isInteger(message.clockBoundariesDropped)&&message.clockBoundariesDropped>=0)recording.clockBoundariesDropped=message.clockBoundariesDropped;
 if(Number.isInteger(message.clockMetadataTruncatedAt)&&message.clockMetadataTruncatedAt>=0)recording.clockMetadataTruncatedAt=message.clockMetadataTruncatedAt;
 if(Number.isFinite(message.lastSourceEndFrame))recording.lastSourceEndFrame=message.lastSourceEndFrame;
}
function sampleReceive(recording,message){
 if(sampleRecorderState.active!==recording||recording.finished)return;
 if(message.type==='error'){sampleClockSummary(recording,message);sampleCaptureFailure(recording,message);return;}
 if(message.type==='started'){recording.startFrame=message.startFrame;sampleSetStatus(recording.kind==='with'?'Запись идёт — играйте на баяне. Осталось 20 с.':'Запись идёт — баян пока не играйте. Осталось 8 с.');return;}
 if(message.type==='clock-boundary'){
  if(!Number.isInteger(message.offset)||message.offset!==recording.count||!Number.isInteger(message.expectedFrame)||!Number.isInteger(message.actualFrame)||message.deltaFrames!==message.actualFrame-message.expectedFrame||message.deltaFrames===0){sampleCaptureFailure(recording,{...message,reason:'clock-boundary-invalid'});return;}
  recording.clockBoundaryCount=(recording.clockBoundaryCount||0)+1;recording.clockBoundaries??=[];
  if(recording.clockBoundaries.length<64)recording.clockBoundaries.push({offset:message.offset,expectedFrame:message.expectedFrame,actualFrame:message.actualFrame,deltaFrames:message.deltaFrames,inputLength:message.inputLength});
  else {recording.clockBoundariesDropped=(recording.clockBoundariesDropped||0)+1;recording.clockMetadataTruncatedAt??=message.offset;}
  sampleSetStatus('Временные метки звука изменились. Запись продолжается; полученный звук сохраняется.');return;
 }
 if(message.type==='chunk'){
  const mic=message.mic,reference=message.reference;if(!(mic instanceof Float32Array)||!(reference instanceof Float32Array)||mic.length!==reference.length||message.offset!==recording.count||recording.count+mic.length>recording.limit){sampleCaptureFailure(recording,{reason:'chunk-order',offset:message.offset,inputLength:mic?.length,referenceLength:reference?.length});return;}
  recording.mic.push(mic);recording.reference.push(reference);recording.count+=mic.length;sampleClockSummary(recording,message);if(recording.count-(recording.progressAt||0)>=recording.sampleRate/4||recording.count===recording.limit){recording.progressAt=recording.count;const remaining=Math.max(0,(recording.limit-recording.count)/recording.sampleRate);sampleSetStatus(`Запись ${recording.kind==='with'?'с баяном':'без баяна'}: ${Math.ceil(remaining)} с осталось. ${recording.kind==='with'?'Играйте.':'Не играйте на баяне.'}${recording.clockBoundaryCount?' Временные метки нестабильны, запись продолжается.':''}`);}return;
 }
 if(message.type==='done'){
  if(message.samples!==recording.count){sampleCaptureFailure(recording,{...message,reason:'transfer-incomplete'});return;}
  if(Number.isFinite(message.startFrame))recording.startFrame=message.startFrame;sampleClockSummary(recording,message);recording.referenceMissingSamples=message.referenceMissingSamples||0;sampleFinish(recording,message.reason==='complete'?'complete':'manual');
 }
}
function sampleCaptureFailure(recording,message){
 const details={reason:typeof message.reason==='string'?message.reason.slice(0,80):'unknown',mode:recording.metadata.captureMode||'unknown',receivedSamples:recording.count};
 for(const key of ['expectedFrame','actualFrame','inputLength','referenceLength','samples','startFrame','endFrame','offset','referenceMissingSamples'])details[key]=Number.isFinite(message[key])?message[key]:null;
 recording.captureError=details;if(Number.isFinite(message.referenceMissingSamples))recording.referenceMissingSamples=message.referenceMissingSamples;
 sampleFinish(recording,'capture-error',sampleErrorLabel(details));
}
function sampleDisconnect(recording){
 clearTimeout(recording.stopTimer);clearTimeout(recording.watchdog);if(recording.node?.port)recording.node.port.onmessage=null;if(recording.node){recording.node.onaudioprocess=null;recording.node.onprocessorerror=null;}
 try{recording.micSource?.disconnect(recording.merger||recording.node);}catch{}try{recording.renderSource?.disconnect(recording.merger||recording.node);}catch{}
 try{recording.merger?.disconnect();}catch{}try{recording.node?.disconnect();}catch{}try{recording.silent?.disconnect();}catch{}
}
async function sampleFinish(recording,reason,errorText=''){
 if(recording.finished)return;recording.finished=true;sampleDisconnect(recording);if(sampleRecorderState.active===recording)sampleRecorderState.active=null;sampleRecorderState.pending=false;sampleRecorderControls();
 const timingReliable=!(recording.clockBoundaryCount||0),failed=reason==='capture-error'||!timingReliable;if(!failed&&recording.count===0){sampleSetStatus(errorText||'Запись остановлена до получения звука. Повторите её.');return;}
 const join=chunks=>{const result=new Float32Array(recording.count);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;};
 const completed=reason==='complete'&&recording.count===recording.limit,clockBoundaries=recording.clockBoundaries||[],mappedEnd=recording.clockMetadataTruncatedAt??recording.count;
 const starts=Number.isFinite(recording.startFrame)?[{offset:0,sourceStartFrame:recording.startFrame},...clockBoundaries.map(item=>({offset:item.offset,sourceStartFrame:item.actualFrame}))]:[];
 const sourceSegments=starts.map((item,index)=>({...item,length:Math.max(0,(starts[index+1]?.offset??mappedEnd)-item.offset)}));
 const metadata={...recording.metadata,startFrame:recording.startFrame,startContextTime:Number.isFinite(recording.startFrame)?recording.startFrame/recording.sampleRate:null,endContextTime:timingReliable&&Number.isFinite(recording.startFrame)?(recording.startFrame+recording.count)/recording.sampleRate:null,lastObservedSourceEndTime:Number.isFinite(recording.lastSourceEndFrame)?recording.lastSourceEndFrame/recording.sampleRate:null,samples:recording.count,durationSeconds:recording.count/recording.sampleRate,stopReason:reason,completed,incomplete:!completed,timelineComplete:completed,timingReliable,clockBoundaryCount:recording.clockBoundaryCount||0,clockBoundaries,clockBoundariesDropped:recording.clockBoundariesDropped||0,clockMetadataTruncatedAt:recording.clockMetadataTruncatedAt??null,sourceSegments,sourceSegmentsComplete:!(recording.clockBoundariesDropped||0),sampleOrderNote:'WAVs contain paired PCM in received-sample order. Clock changes do not insert silence or remove samples. Source segments map observed clock values, not verified physical time. Absolute beat alignment across boundaries is uncertain.',hasGaps:false,gaps:[],missingSamples:timingReliable?0:null,recordedSamples:recording.count,gapEncoding:null,captureError:recording.captureError||null,unflushedTailPossible:reason==='capture-error'||reason==='trainer-stop'||reason==='manual-interrupted'||reason==='audio-interrupted',referenceMissingSamples:recording.referenceMissingSamples??null,missingReferenceNote:'An inactive master-bus input is represented by zeros and counted; it can mean silence between backing sounds. Null means the worklet final counter was not received.',diagnostics:recording.diagnostics,diagnosticLatest:recording.diagnosticLatest,diagnosticsDropped:recording.diagnosticsDropped};
 const warning=recording.captureError?(errorText||sampleErrorLabel(recording.captureError)):!timingReliable?'Временные метки нестабильны. '+(completed?'Вся запись сохранена.':'Полученная часть записи сохранена.'):'',record={kind:recording.kind+(failed?'-error':''),mic:sampleWav(join(recording.mic),recording.sampleRate),reference:sampleWav(join(recording.reference),recording.sampleRate),metadata};sampleRecorderState.records.set(record.kind,record);sampleRenderList();if(failed)sampleSetStatus(`${warning} Нажмите «Скачать записи».`);
 const statusGeneration=sampleRecorderState.generation;const mayUpdateStatus=()=>sampleRecorderState.generation===statusGeneration&&!sampleRecorderState.active&&!sampleRecorderState.pending&&sampleRecorderState.records.get(record.kind)===record;
 try{await sampleStore(record);if(mayUpdateStatus())sampleSetStatus(failed?`${warning} ${recording.count?'Полученный звук и диагностика сохранены':'Звук не получен; диагностика сохранена'} в этом браузере. Нажмите «Скачать записи».`:`${record.kind==='with'?'Запись с баяном':'Запись без баяна'} сохранена в этом браузере. ${sampleRecorderState.records.has('with')&&sampleRecorderState.records.has('without')?'Обе записи готовы — нажмите «Скачать записи» и сообщите в чате, что ZIP скачан.':'Можно записать второй образец или скачать этот.'}`);}catch(error){if(mayUpdateStatus())sampleSetStatus(`${failed?warning+' ':''}Запись доступна до закрытия страницы. Скачайте её сейчас: ${error.message}`);}
}
async function startSampleRecording(kind){
 if(!['with','without'].includes(kind)||sampleRecorderState.pending||sampleRecorderState.active||sampleRecorderState.deleting)return;
 const generation=++sampleRecorderState.generation;let recording=null;sampleRecorderState.pending=true;sampleRecorderControls();sampleSetStatus('Подготовка записи…');
 try{
  if(state.pending||state.measuring||state.calibrating)throw new Error('Дождитесь запуска, калибровки или завершения замера задержки.');
  if(!state.running){if(!$('mic').checked){$('mic').checked=true;$('mic').dispatchEvent(new Event('change'));}await start();}
  if(generation!==sampleRecorderState.generation)return;
  if(!state.running||!context||context.state!=='running'||!source||!master||!stream?.getAudioTracks().some(track=>track.readyState==='live'))throw new Error('Для записи нужен работающий микрофон. Включите «Микрофон» и нажмите Start.');
  const ctx=context,token=state.token,duration=kind==='with'?20:8;recording={kind,sessionId:token,ctx,sampleRate:ctx.sampleRate,limit:Math.round(ctx.sampleRate*duration),count:0,startFrame:null,mic:[],reference:[],diagnostics:[],diagnosticLatest:{},diagnosticsDropped:0,finished:false,micSource:source,renderSource:master,metadata:{version:2,kind,createdAt:new Date().toISOString(),requestedDurationSeconds:duration,sampleRate:ctx.sampleRate,settings:captureSettings(),trackSettings:sampleDiagnosticsValue(stream.getAudioTracks()[0].getSettings?.()||{}),context:{baseLatency:ctx.baseLatency??null,outputLatency:ctx.outputLatency??null,requestedAt:ctx.currentTime},pageURL:window.location.href,appVersion:document.querySelector('meta[name="rhythm-trainer-version"]')?.content||window.location.search||'unversioned',reference:'Actual rendered master bus after instrument and overall gains; paired by sample with microphone. Microphone is before application filters; browser processing is listed in trackSettings.'}};
  let workletError=null;
  if(ctx.audioWorklet&&window.AudioWorkletNode){
   try{if(!sampleRecorderState.workletModules.has(ctx)){const moduleURL=URL.createObjectURL(new Blob([sampleRecorderWorklet],{type:'application/javascript'}));const loading=ctx.audioWorklet.addModule(moduleURL).finally(()=>URL.revokeObjectURL(moduleURL));sampleRecorderState.workletModules.set(ctx,loading);}await sampleRecorderState.workletModules.get(ctx);if(generation!==sampleRecorderState.generation||context!==ctx||state.token!==token||!state.running)return;recording.node=new AudioWorkletNode(ctx,'rhythm-sample-capture',{numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit',processorOptions:{samples:recording.limit}});recording.node.port.onmessage=event=>sampleReceive(recording,event.data);recording.metadata.captureMode='AudioWorklet';}catch(error){workletError=error;}
  }
  if(generation!==sampleRecorderState.generation||context!==ctx||state.token!==token||!state.running){sampleDisconnect(recording);return;}
  if(!recording.node){
   if(!ctx.createScriptProcessor||!ctx.createChannelMerger)throw new Error('Этот браузер не поддерживает синхронную запись. Откройте страницу в современном браузере.');
   recording.referenceMissingSamples=0;recording.metadata.captureMode='ScriptProcessor';recording.metadata.fallbackReason=workletError?String(workletError.message).slice(0,160):'AudioWorklet unavailable';recording.metadata.timestampNote='Fallback start time is estimated from input block playbackTime minus inputBuffer duration.';
   recording.merger=ctx.createChannelMerger(2);recording.node=ctx.createScriptProcessor(1024,2,1);recording.node.onaudioprocess=event=>{
    event.outputBuffer.getChannelData(0).fill(0);if(recording.finished||sampleRecorderState.active!==recording)return;
    const frame=Math.round((event.playbackTime-event.inputBuffer.duration)*ctx.sampleRate),mic=event.inputBuffer.getChannelData(0),reference=event.inputBuffer.getChannelData(1);
    if(!mic?.length){if(recording.startFrame!==null)sampleReceive(recording,{type:'error',reason:'missing-input',expectedFrame:recording.expectedSourceFrame,actualFrame:frame,inputLength:0,referenceLength:reference?.length||0,samples:recording.count});return;}
    if(recording.startFrame===null)sampleReceive(recording,{type:'started',startFrame:frame});
    else if(Math.abs(frame-recording.expectedSourceFrame)>1)sampleReceive(recording,{type:'clock-boundary',offset:recording.count,expectedFrame:recording.expectedSourceFrame,actualFrame:frame,deltaFrames:frame-recording.expectedSourceFrame,inputLength:mic.length});
    const n=Math.min(mic.length,recording.limit-recording.count);recording.expectedSourceFrame=frame+mic.length;recording.lastSourceEndFrame=frame+n;recording.referenceMissingSamples+=Math.max(0,n-(reference?.length||0));
    const pairedReference=new Float32Array(n);if(reference)pairedReference.set(reference.subarray(0,n));sampleReceive(recording,{type:'chunk',offset:recording.count,mic:mic.slice(0,n),reference:pairedReference});
    if(recording.count===recording.limit)sampleReceive(recording,{type:'done',reason:'complete',samples:recording.count,startFrame:recording.startFrame,lastSourceEndFrame:recording.lastSourceEndFrame,referenceMissingSamples:recording.referenceMissingSamples});
   };
  }
  recording.node.onprocessorerror=()=>sampleReceive(recording,{type:'error',reason:'processor-error',expectedFrame:recording.expectedSourceFrame??null,samples:recording.count,startFrame:recording.startFrame,endFrame:recording.lastSourceEndFrame??null});recording.silent=ctx.createGain();recording.silent.gain.value=0;recording.node.connect(recording.silent);recording.silent.connect(ctx.destination);sampleRecorderState.active=recording;sampleRecorderState.pending=false;
  if(recording.merger){recording.micSource.connect(recording.merger,0,0);recording.renderSource.connect(recording.merger,0,1);recording.merger.connect(recording.node);}else{recording.micSource.connect(recording.node,0,0);recording.renderSource.connect(recording.node,0,1);}
  recording.watchdog=setTimeout(()=>{if(sampleRecorderState.active===recording){sampleFinish(recording,'audio-interrupted');sampleSetStatus('Поток звука прервался. Доступная часть сохранена; повторите запись.');}},(duration+5)*1000);
  sampleRecorderControls();sampleSetStatus(kind==='with'?'Запись началась — играйте на баяне 20 секунд.':'Запись началась — 8 секунд не играйте на баяне. Ритм звучит.');
 }catch(error){if(recording)sampleDisconnect(recording);if(sampleRecorderState.active===recording)sampleRecorderState.active=null;if(generation===sampleRecorderState.generation){sampleRecorderState.pending=false;sampleSetStatus(`Запись не началась: ${error.message}`);sampleRecorderControls();}}
}
function stopSampleRecording(reason='manual'){
 ++sampleRecorderState.generation;sampleRecorderState.pending=false;const recording=sampleRecorderState.active;
 if(!recording){sampleRecorderControls();return;}
 if(reason!=='manual'||!recording.node?.port){sampleFinish(recording,reason);return;}
 recording.node.port.postMessage({type:'stop'});recording.stopTimer=setTimeout(()=>sampleFinish(recording,'manual-interrupted'),500);sampleSetStatus('Завершаем запись…');
}
function initSampleRecorder(){
 if(sampleRecorderState.initialized)return;sampleRecorderState.initialized=true;
 const loadGeneration=sampleRecorderState.generation;
 $('sample-with')?.addEventListener('click',()=>startSampleRecording('with'));$('sample-without')?.addEventListener('click',()=>startSampleRecording('without'));$('sample-stop')?.addEventListener('click',()=>stopSampleRecording());$('sample-save')?.addEventListener('click',()=>sampleDownload());sampleRecorderControls();
 sampleLoad().then(records=>{sampleMergeRecords(records);sampleRenderList();if(records.length&&sampleRecorderState.generation===loadGeneration&&!sampleRecorderState.active&&!sampleRecorderState.pending)sampleSetStatus('Предыдущие записи и сведения об ошибках сохранены в этом браузере. Их можно скачать.');}).catch(()=>{if(sampleRecorderState.generation===loadGeneration&&!sampleRecorderState.active&&!sampleRecorderState.pending)sampleSetStatus('Записи можно скачать после завершения. Постоянное хранилище этого браузера недоступно.');});
}
