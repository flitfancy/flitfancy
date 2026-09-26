import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const window={};
for(const name of ['bridge-files','bridge-hash','console-bridge']) vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/'+name+'.js',import.meta.url),'utf8'),{window,Blob,setTimeout});
function file(name,body,path=''){const value=new Blob([body]);Object.defineProperties(value,{name:{value:name},webkitRelativePath:{value:path}});return value;}
function entry(name,body){const value=file(name,body);return {name,isFile:true,file:ok=>ok(value)};}
function directory(name,children){return {name,isDirectory:true,createReader(){let i=0;return {readEntries(ok){ok(children.slice(i,i+=100));}};}};}
const root=directory('album',[...Array.from({length:201},(_,i)=>entry('item-'+i+'.txt','x')),directory('nested',[entry('empty.txt',''),directory('empty',[])])]);
const collected=await window.FlitFancyBridgeFiles.fromDrop({items:[{kind:'file',webkitGetAsEntry:()=>root}],files:[]},()=>false,()=>{});
assert.equal(collected.files.length,202,'must consume all readEntries pages, not only first 100');
assert.deepEqual(Array.from(collected.directories),['album','album/nested','album/nested/empty']);
assert.equal(collected.total,201);
const justEmpty=await window.FlitFancyBridgeFiles.fromDrop({items:[{kind:'file',webkitGetAsEntry:()=>directory('empty',[])}],files:[]},()=>false,()=>{});
assert.equal(justEmpty.files.length,0);assert.equal(justEmpty.directories.length,1);
const picked=window.FlitFancyBridgeFiles.fromPicker([file('a.txt','a','album/a.txt'),file('b.txt','b','album/sub/b.txt')],true);
assert.deepEqual(Array.from(picked.directories),['album','album/sub']);
assert.throws(()=>window.FlitFancyBridgeFiles.fromPicker([file('x','x','album/../x')],true));
assert.throws(()=>window.FlitFancyBridgeFiles.fromPicker([file('a','x','album/a'),file('A','y','album/A')],true),/同名/);
await assert.rejects(window.FlitFancyBridgeFiles.fromDrop({items:[{kind:'file',webkitGetAsEntry:()=>root}]},()=>true,()=>{}),/停止/);
function element(){return {hidden:false,value:'',textContent:'',disabled:false,files:[],listeners:{},click(){},addEventListener(n,f){this.listeners[n]=f;},fire(n,e={}){return this.listeners[n]?.(e);}};}
const nodes=new Map(),get=n=>{if(!nodes.has(n))nodes.set(n,element());return nodes.get(n);};
const panel={querySelector:s=>get(s.match(/"([^"]+)"/)[1])};
let tasks=[],begins=[],directories=[],chunks=[],counter=0,failSecond=true,pauseNext=false,signedIn=true;
let pollingSleeps=0;
const settings={configured:true,root:'inbox',chunk_bytes:4194304,max_file_bytes:21474836480,folder_upload:true,task_wait:true};
const opts={query:()=>panel,isAdmin:()=>signedIn,isServerOnline:()=>true,wait:async()=>{pollingSleeps++;},async request(url,options){
  if(url.endsWith('/config'))return settings;
  if(url.endsWith('/status'))return {tasks:structuredClone(tasks)};
  if(!options){
    assert.match(url,/wait_ms=2000/,'wait for completion without browser timers');
    const task=tasks[0];
    if(['queued','sending'].includes(task.state)){
      if(task.path==='album/sub/b.txt' && failSecond){task.state='failed';task.retryable=true;task.error='fixture disconnect';failSecond=false;}
      else {task.state='succeeded';task.sent_bytes=task.size;task.retryable=false;}
      if(pauseNext && task.kind==='transfer'){pauseNext=false;get('pause').fire('click');}
    }
    return structuredClone(task);
  }
  if(url.includes('/chunk?')){assert.equal(tasks[0].state,'receiving');chunks.push({path:tasks[0].path,bytes:options.body.size});tasks[0].received_bytes+=options.body.size;return structuredClone(tasks[0]);}
  const body=JSON.parse(options.body);
  if(url.endsWith('/directories')){directories.push(body.paths);tasks=[{id:String(++counter),kind:'directories',state:'queued',size:0,paths:body.paths}];}
  else if(url.endsWith('/transfers')){begins.push(body);tasks=[{id:String(++counter),kind:'transfer',state:'receiving',received_bytes:0,sent_bytes:0,...body}];}
  else if(url.endsWith('/commit')){tasks[0].state='queued';tasks[0].error=null;}
  else if(url.endsWith('/cancel')){tasks[0].state='cancelled';tasks[0].retryable=false;}
  return structuredClone(tasks[0]);
}};
const module=window.FlitFancyConsoleBridge.create(opts);module.start();await module.refresh();
const files=[file('a.txt','first','album/a.txt'),file('b.txt','second','album/sub/b.txt'),file('empty.txt','','album/sub/empty.txt')];
get('folder').files=files;await get('folder').fire('change');
assert.match(get('selected').textContent,/3 个文件/);assert.equal(get('path').value,'album');
await get('send').fire('click');
assert.match(get('message').textContent,/disconnect/);assert.match(get('batch-summary').textContent,/1 \/ 3/);
assert.deepEqual(begins.map(item=>item.path),['album/a.txt','album/sub/b.txt']);
assert.equal(begins.every(item=>item.reuse_identical),true);
await get('send').fire('click');
assert.match(get('message').textContent,/全部存入/);assert.match(get('batch-summary').textContent,/3 \/ 3/);
assert.equal(get('batch-progress').value,1);assert.equal(begins.filter(item=>item.path==='album/a.txt').length,1,'retry must not resend completed files');
assert.equal(begins.at(-1).sha256,createHash('sha256').update('').digest('hex'),'legitimate empty files inside folder are preserved');
assert.deepEqual(directories[0],['album','album/sub']);
assert.equal(pollingSleeps,0,'folder queue must not sleep between files when completion can be awaited on the server');
// Pause while the NAS finishes one file, then continue without double-counting it.
get('folder').files=files;await get('folder').fire('change');pauseNext=true;
await get('send').fire('click');assert.equal(get('send').disabled,false);
await get('send').fire('click');assert.match(get('batch-summary').textContent,/3 \/ 3/);
// A completely empty folder creates a directory, never a fake zero-byte file.
const before=begins.length;
await get('drop').fire('drop',{preventDefault(){},dataTransfer:{items:[{kind:'file',webkitGetAsEntry:()=>directory('only-empty',[])}],files:[]}});
await get('send').fire('click');assert.equal(begins.length,before);assert.deepEqual(directories.at(-1),['only-empty']);assert.equal(get('batch-progress').value,1);
// A renamed root survives a page refresh: resume the exact nested file, then the remaining files.
module.clearPrivate();signedIn=true;
tasks=[{id:'restored',kind:'transfer',state:'receiving',path:'renamed/sub/b.txt',folder_root:'renamed',size:6,sha256:createHash('sha256').update('second').digest('hex'),received_bytes:2,sent_bytes:0}];
await module.refresh();get('folder').files=files;await get('folder').fire('change');
assert.equal(get('path').value,'renamed');
const beginCount=begins.length;
await get('send').fire('click');assert.match(get('batch-summary').textContent,/3 \/ 3/);
assert.equal(begins.slice(beginCount).some(item=>item.path==='renamed/sub/b.txt'),false,'resumed task must not be recreated');
assert.equal(begins.slice(beginCount).every(item=>item.path.startsWith('renamed/')),true);
// Logout clears the local queue and its private filenames.
signedIn=false;module.clearPrivate();assert.equal(get('batch').hidden,true);assert.equal(get('selected').textContent,'');
console.log('folder upload: paginated traversal, nesting, empty entries, sequential queue, retry, pause and logout passed');
