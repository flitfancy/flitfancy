import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash, randomBytes} from 'node:crypto';
const window={};
let hashTimers=0;
vm.runInNewContext(fs.readFileSync(new URL("../docs/assets/bridge-files.js",import.meta.url),"utf8"),{window});
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/bridge-hash.js',import.meta.url),'utf8'),{window,setTimeout(fn){hashTimers++;return setTimeout(fn,0);}});
for (const length of [0,1,55,56,63,64,65,127,128,129,65537,1048593]) {
  const bytes=randomBytes(length), expected=createHash('sha256').update(bytes).digest('hex');
  for (const split of [1,13,64,1000]) {
    if (length>100000 && split===1) continue;
    const hash=window.FlitFancyBridgeHash.createHasher();
    for (let i=0;i<length;i+=split) hash.update(bytes.subarray(i,i+split));
    assert.equal(hash.hex(),expected,`length ${length}, split ${split}`);
  }
  assert.equal(await window.FlitFancyBridgeHash.fileHash(new Blob([bytes]),()=>{},()=>false),expected);
}
assert.equal(hashTimers,0,'hashing must not depend on timers throttled in background browser tabs');
await assert.rejects(window.FlitFancyBridgeHash.fileHash(new Blob(['abc']),()=>{},()=>true),/暂停/);
function element(){return {hidden:false,value:'',textContent:'',disabled:false,files:[],listeners:{},addEventListener(n,f){this.listeners[n]=f;},fire(n,e={}){return this.listeners[n]?.(e);},click(){}};}
const nodes=new Map(), get=n=>{if(!nodes.has(n))nodes.set(n,element());return nodes.get(n);};
const root={querySelector:s=>get(s.match(/"([^"]+)"/)[1])};
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/console-bridge.js',import.meta.url),'utf8'),{window,Blob,setTimeout});
let signedIn=false,tasks=[],requests=[],lostChunk=false,hold=null;
const settings={configured:true,root:'test/inbox',chunk_bytes:4194304,max_file_bytes:21474836480};
const opts={query:()=>root,isAdmin:()=>signedIn,isServerOnline:()=>true,async request(url,options){
  requests.push({url,options});
  if (hold && !options) return hold;
  if (url.endsWith('/config')) return settings;
  if (url.endsWith('/status')) return {tasks:structuredClone(tasks)};
  if (!options) return structuredClone(tasks[0]);
  if (url.includes('/chunk?')) {
    assert.equal(options.headers['Content-Type'],'application/octet-stream');
    tasks[0].received_bytes+=options.body.size;
    if(lostChunk){lostChunk=false;throw Error('lost response');}
    return structuredClone(tasks[0]);
  }
  const data=JSON.parse(options.body);
  if (url.endsWith('/transfers')) {
    tasks=[{...data,id:'fixture',kind:'transfer',state:'receiving',received_bytes:0,sent_bytes:0}];
  } else if (url.endsWith('/commit')) {tasks[0].state='sending';}
  else if (url.endsWith('/cancel')) {tasks[0].state='cancelled';tasks[0].retryable=false;}
  else if (url.endsWith('/test')) {tasks=[{id:'probe',kind:'connection',state:'testing',size:0}];}
  return structuredClone(tasks[0]);
}};
const module=window.FlitFancyConsoleBridge.create(opts);module.start();await module.refresh();
assert.equal(requests.length,0);assert.equal(get('body').hidden,true);
signedIn=true;await module.refresh();assert.equal(get('body').hidden,false);assert.equal(get('send').disabled,true);
const file=new Blob([randomBytes(600000)]);Object.defineProperty(file,'name',{value:'<unsafe>.bin'});
get('file').files=[file];await get('file').fire('change');
assert.equal(get('selected').textContent,'<unsafe>.bin · 585.9 KB');
assert.equal(get('path').value,'<unsafe>.bin');get('path').value='sample.bin';
lostChunk=true;await get('send').fire('click');
assert.match(get('message').textContent,/暂停/);assert.equal(tasks[0].received_bytes,262144);
assert.equal(get('send').textContent,'继续上传');
await get('send').fire('click');assert.equal(tasks[0].state,'sending');
assert.equal(tasks[0].received_bytes,file.size);assert.equal(get('send').disabled,true);
tasks[0].state='succeeded';tasks[0].sent_bytes=file.size;await module.refresh();assert.match(get('message').textContent,/校验通过/);
get('file').files=[file];await get('file').fire('change');await module.refresh();assert.equal(get('job').hidden,true,'choosing a new file must not show an old success');
await get('test').fire('click');await module.refresh();assert.equal(get('path').value,file.name,'connection status must not erase selected filename');
tasks=[];module.clearPrivate();signedIn=true;await module.refresh();
// Restore a partially received task: require exactly the same file before continuing.
tasks=[{id:'partial',kind:'transfer',state:'receiving',path:'old.bin',size:3,sha256:'0'.repeat(64),received_bytes:1,sent_bytes:0}];
await module.refresh();get('file').files=[file];await get('file').fire('change');
const previous=requests.length;await get('send').fire('click');assert.match(get('message').textContent,/不同/);
assert.equal(requests.slice(previous).some(r=>r.options),false);
await get('cancel').fire('click');assert.equal(tasks[0].state,'cancelled');
// Responses arriving after logout must not restore private paths or progress.
let release;hold=new Promise(resolve=>{release=resolve;});const refresh=module.refresh();
signedIn=false;module.clearPrivate();release({tasks,configured:true});await refresh;
assert.equal(get('body').hidden,true);assert.equal(get('selected').textContent,'');assert.equal(get('destination').textContent,'');
// A directory entry without readable contents must not become a zero-byte File.
hold=null;tasks=[];signedIn=true;await module.refresh();
const folder=new Blob([]);Object.defineProperty(folder,'name',{value:'photos'});
await get('drop').fire('drop',{preventDefault(){},dataTransfer:{files:[folder],items:[{kind:'file',webkitGetAsEntry:()=>({name:'photos',isDirectory:true,createReader:()=>({readEntries:(ok,fail)=>fail(Error('directory unreadable'))})})}]}});
assert.equal(get('send').disabled,true);
// File entries can supply the actual file even if the drag File is only a placeholder.
const actualFile=new Blob(['non-empty contents']);Object.defineProperty(actualFile,'name',{value:'normal.txt'});
await get('drop').fire('drop',{preventDefault(){},dataTransfer:{files:[folder],items:[{kind:'file',webkitGetAsEntry:()=>({name:'normal.txt',isFile:true,file:resolve=>resolve(actualFile)})}]}});
assert.equal(get('selected').textContent,'normal.txt · 18 B');
assert.equal(Boolean(get('send').disabled),false);
// An unresolved zero-byte placeholder must clear the previous selection, not upload it by accident.
await get('drop').fire('drop',{preventDefault(){},dataTransfer:{files:[folder],items:[]}});
assert.equal(get('send').disabled,true);assert.equal(get('selected').textContent,'');
assert.match(get('message').textContent,/0 B/);
get('file').files=[folder];await get('file').fire('change');assert.equal(get('send').disabled,true);
// A delayed file-entry callback after logout must not restore the selected file.
let resolveEntry;
const dropping=get('drop').fire('drop',{preventDefault(){},dataTransfer:{files:[folder],items:[{kind:'file',webkitGetAsEntry:()=>({name:'normal.txt',isFile:true,file:resolve=>{resolveEntry=resolve;}})}]}});
signedIn=false;module.clearPrivate();resolveEntry(actualFile);await dropping;
assert.equal(get('selected').textContent,'');assert.equal(get('body').hidden,true);
// Shared request helper preserves explicit binary content type and still defaults JSON.
let sentHeaders;
const coreWindow={location:{hostname:'localhost'}};
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/admin-core.js',import.meta.url),'utf8'),{
  window:coreWindow,sessionStorage:{getItem:()=>'',removeItem(){}},AbortController,setTimeout,clearTimeout,
  fetch:async(url,options)=>{sentHeaders=options.headers;return {ok:true,status:200,json:async()=>({})};},
});
await coreWindow.FlitFancyAdmin.request('/api/bridge/transfers/chunk',{method:'POST',body:new Blob(['abc']),headers:{'Content-Type':'application/octet-stream'}});
assert.equal(sentHeaders['Content-Type'],'application/octet-stream');
await coreWindow.FlitFancyAdmin.request('/api/test',{method:'POST',body:'{}'});assert.equal(sentHeaders['Content-Type'],'application/json');
console.log('bridge UI: incremental hash, auth, upload, lost response resume, recovery and logout races passed');
