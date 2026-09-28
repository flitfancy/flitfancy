import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function file(name,bytes) {
  const value=new Blob([bytes]);
  Object.defineProperties(value,{name:{value:name},webkitRelativePath:{value:'album/'+name}});
  return value;
}
function element() {
  return {hidden:false,value:'',textContent:'',disabled:false,files:[],listeners:{},click(){},addEventListener(name,fn){this.listeners[name]=fn;},fire(name,event={}){return this.listeners[name]?.(event);}};
}
async function fixture() {
  const window={},nodes=new Map(),get=name=>{if(!nodes.has(name)) nodes.set(name,element());return nodes.get(name);};
  for (const name of ['bridge-files','bridge-hash','console-bridge']) vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/'+name+'.js',import.meta.url),'utf8'),{window,Blob,setTimeout});
  const state={signedIn:true,task:null,requests:[],payloads:new Map(),writes:new Map(),failPath:null,hook:null,counter:0};
  const settings={configured:true,root:'inbox',chunk_bytes:4194304,max_file_bytes:21474836480,folder_upload:true,task_wait:true,batch_upload:true,batch_max_files:32,batch_max_bytes:4194304,batch_max_file_bytes:262144};
  const snapshot=()=>structuredClone(state.task);
  function complete() {
    const task=state.task;
    if (!['queued','sending'].includes(task.state)) return;
    if(task.kind==='directories'){task.state='succeeded';return;}
    const bytes=state.payloads.get(task.id);
    assert.equal(bytes.length,task.size);
    let failed=false;
    const entries=task.kind==='batch' ? task.files : [{...task,offset:0}];
    for(const item of entries) {
      if(item.state==='succeeded') continue;
      const content=bytes.subarray(item.offset,item.offset+item.size);
      assert.equal(digest(content),item.sha256,'concatenated manifest bytes preserve every file hash');
      if(item.path===state.failPath){state.failPath=null;item.state='failed';item.error='fixture disconnect';failed=true;continue;}
      state.writes.set(item.path,(state.writes.get(item.path)||0)+1);item.state='succeeded';item.error=null;
    }
    task.completed_files=entries.filter(item=>item.state==='succeeded').length;
    task.sent_bytes=entries.filter(item=>item.state==='succeeded').reduce((sum,item)=>sum+item.size,0);
    task.state=failed?'failed':'succeeded';task.retryable=failed;task.error=failed?'fixture disconnect':null;
  }
  async function answer(url,options) {
    if(url.endsWith('/config')) return settings;
    if(url.endsWith('/status')) return {tasks:state.task?[snapshot()]:[]};
    if(!options) {complete();return snapshot();}
    if(url.includes('/chunk?')) {
      const params=new URL(url,'http://fixture').searchParams;
      assert.equal(params.get('id'),state.task.id);
      assert.equal(Number(params.get('offset')),state.task.received_bytes,'resume uses acknowledged aggregate offset');
      assert.equal(options.headers['Content-Type'],'application/octet-stream');
      const bytes=Buffer.from(await options.body.arrayBuffer());
      assert.ok(bytes.length<=262144);
      state.payloads.set(state.task.id,Buffer.concat([state.payloads.get(state.task.id),bytes]));
      state.task.received_bytes+=bytes.length;
      return snapshot();
    }
    const data=JSON.parse(options.body);
    if(url.endsWith('/batches')) {
      assert.ok(!state.task || !['receiving','queued','sending'].includes(state.task.state));
      let offset=0;
      const files=data.files.map(item=>{const result={...item,offset,state:'pending',error:null};offset+=item.size;return result;});
      assert.ok(files.length<=settings.batch_max_files && offset<=settings.batch_max_bytes);
      assert.ok(files.every(item=>item.size<=settings.batch_max_file_bytes));
      state.task={...data,files,id:String(++state.counter),kind:'batch',path:data.folder_root,size:offset,file_count:files.length,completed_files:0,state:'receiving',received_bytes:0,sent_bytes:0};
      state.payloads.set(state.task.id,Buffer.alloc(0));
    } else if(url.endsWith('/transfers')) {
      state.task={...data,id:String(++state.counter),kind:'transfer',state:'receiving',received_bytes:0,sent_bytes:0};
      state.payloads.set(state.task.id,Buffer.alloc(0));
    } else if(url.endsWith('/directories')) {
      state.task={id:String(++state.counter),kind:'directories',state:'queued',size:0,received_bytes:0,sent_bytes:0};
    } else if(url.endsWith('/commit')) {
      assert.equal(data.id,state.task.id);state.task.state='queued';state.task.retryable=false;state.task.error=null;
    } else if(url.endsWith('/cancel')) {
      state.task.state='cancelled';state.task.retryable=false;
    } else assert.fail('unexpected route '+url);
    return snapshot();
  }
  const opts={query:()=>({querySelector:selector=>get(selector.match(/"([^"]+)"/)[1])}),isAdmin:()=>state.signedIn,isServerOnline:()=>true,async request(url,options) {
    state.requests.push({url,options});
    const result=await answer(url,options);
    if(state.hook) await state.hook({url,options,result});
    return result;
  }};
  const controller=window.FlitFancyConsoleBridge.create(opts);controller.start();await controller.refresh();
  return {state,settings,get,controller,choose:async files=>{get('folder').files=files;await get('folder').fire('change');},send:()=>get('send').fire('click'),count:route=>state.requests.filter(request=>request.url.endsWith(route)&&request.options).length};
}

// Twenty tiny files make one binary payload and one completion wait, not 80 requests.
{
  const f=await fixture();
  await f.choose(Array.from({length:20},(_,index)=>file(String(index).padStart(2,'0')+'.txt',Buffer.alloc(1088,index))));
  const before=f.state.requests.length;
  await f.send();
  assert.equal(f.state.requests.length-before,6,'directory create/wait plus batch create/chunk/commit/wait');
  assert.equal(f.count('/batches'),1);assert.equal(f.count('/transfers'),0);
  assert.equal(f.state.writes.size,20);assert.match(f.get('batch-summary').textContent,/20 \/ 20/);
}
// Keep sorted order across large files and retain each content digest.
{
  const f=await fixture();
  await f.choose([file('a.txt','a'),file('b.txt','b'),file('c.bin',Buffer.alloc(262145,42)),file('d.txt','same'),file('e.txt','same'),file('f.empty','')]);
  await f.send();
  const manifests=f.state.requests.filter(request=>request.url.endsWith('/batches')).map(request=>JSON.parse(request.options.body));
  assert.deepEqual(manifests.map(value=>value.files.map(item=>item.path)),[['album/a.txt','album/b.txt'],['album/d.txt','album/e.txt','album/f.empty']]);
  assert.equal(manifests[1].files[0].sha256,manifests[1].files[1].sha256);
  assert.equal(f.count('/transfers'),1);assert.equal(f.state.writes.size,6);
  assert.match(f.get('batch-summary').textContent,/6 \/ 6/);
}
// Both number and byte limits split the batch without losing any entries.
{
  const f=await fixture();
  await f.choose(Array.from({length:35},(_,index)=>file(String(index).padStart(2,'0'),'')));
  await f.send();assert.equal(f.count('/batches'),2);assert.equal(f.state.writes.size,35);
  const g=await fixture();
  await g.choose(Array.from({length:20},(_,index)=>file(String(index).padStart(2,'0'),Buffer.alloc(262144,index))));
  await g.send();assert.equal(g.count('/batches'),2);assert.equal(g.state.writes.size,20);
}
// A failed batch counts only verified items. Retrying uses staged bytes and skips success.
{
  const f=await fixture();f.state.failPath='album/b';
  await f.choose([file('a','one'),file('b','two'),file('c','three')]);await f.send();
  assert.match(f.get('message').textContent,/disconnect/);assert.match(f.get('batch-summary').textContent,/2 \/ 3/);
  const chunks=f.state.requests.filter(request=>request.url.includes('/chunk?')).length;
  await f.send();
  assert.equal(f.count('/batches'),1);assert.equal(f.count('/transfers/commit'),2);
  assert.equal(f.state.requests.filter(request=>request.url.includes('/chunk?')).length,chunks);
  assert.deepEqual([...f.state.writes.values()],[1,1,1]);assert.match(f.get('batch-summary').textContent,/3 \/ 3/);
}
// Pausing as completion arrives must neither resend nor double-count the finished batch.
{
  const f=await fixture();await f.choose([file('a','one'),file('b','two')]);
  f.state.hook=({url,result})=>{if(url.includes('/transfers?id=') && result.kind==='batch'){f.state.hook=null;f.get('pause').fire('click');}};
  await f.send();assert.match(f.get('batch-summary').textContent,/2 \/ 2/);
  // Completion is already displayed; pause does not turn verified bytes back into pending work.
  assert.equal(f.get('batch-progress').value,1);assert.equal(f.state.writes.size,2);assert.equal(f.count('/batches'),1);
}
// Pause mid-payload, refresh, reselect a renamed folder and continue at its aggregate offset.
{
  const f=await fixture(),files=[file('a',Buffer.alloc(200000,1)),file('b',Buffer.alloc(200000,2))];
  await f.choose(files);f.get('path').value='renamed';
  f.state.hook=({url})=>{if(url.includes('/chunk?')){f.state.hook=null;f.get('pause').fire('click');}};
  await f.send();assert.equal(f.state.task.received_bytes,262144);assert.equal(f.state.task.state,'receiving');
  f.controller.clearPrivate();await f.controller.refresh();await f.choose(files);
  assert.equal(f.get('path').value,'renamed');await f.send();
  assert.equal(f.count('/batches'),1);assert.deepEqual([...f.state.writes.keys()],['renamed/a','renamed/b']);
  assert.match(f.get('batch-summary').textContent,/2 \/ 2/);
}
// Cancelling an incomplete batch drops the browser queue and keeps prior completed files.
{
  const f=await fixture();await f.choose(Array.from({length:33},(_,index)=>file(String(index).padStart(2,'0'),'x')));
  f.state.hook=({url})=>{if(url.includes('/chunk?') && f.count('/batches')===2){f.state.hook=null;f.get('pause').fire('click');}};
  await f.send();assert.equal(f.state.writes.size,32);assert.equal(f.state.task.state,'receiving');
  await f.get('cancel').fire('click');assert.equal(f.state.task.state,'cancelled');assert.equal(f.state.writes.size,32);assert.equal(f.get('batch').hidden,true);
}
// A response lost after accepting bytes must not resend or skip any payload.
{
  const f=await fixture();await f.choose([file('a',Buffer.alloc(200000,1)),file('b',Buffer.alloc(200000,2))]);
  f.state.hook=({url})=>{if(url.includes('/chunk?')){f.state.hook=null;throw Error('lost acknowledgement');}};
  await f.send();assert.match(f.get('message').textContent,/暂停/);assert.equal(f.state.task.received_bytes,262144);
  await f.send();assert.equal(f.count('/batches'),1);assert.equal(f.state.writes.size,2);
}
// Lost creation responses recover only an exact receiving manifest, without recreating it.
{
  const f=await fixture();await f.choose([file('a','first'),file('b','second')]);
  f.state.hook=({url})=>{if(url.endsWith('/batches')){f.state.hook=null;throw Error('lost creation response');}};
  await f.send();assert.equal(f.count('/batches'),1);assert.equal(f.state.writes.size,2);assert.match(f.get('batch-summary').textContent,/2 \/ 2/);
  const g=await fixture();await g.choose([file('a','first')]);
  g.state.hook=({url})=>{if(url.endsWith('/batches')){g.state.hook=null;g.state.task.files[0].sha256='0'.repeat(64);throw Error('unrelated task');}};
  await g.send();assert.match(g.get('message').textContent,/unrelated task/);assert.equal(g.count('/transfers/commit'),0);assert.equal(g.state.writes.size,0);
}
// Reselection validates hashes, not just same-sized names, before writing or committing.
{
  const f=await fixture(),files=[file('a','first'),file('b','second')];await f.choose(files);
  f.state.hook=({url})=>{if(url.endsWith('/batches')){f.state.hook=null;f.get('pause').fire('click');}};
  await f.send();f.controller.clearPrivate();await f.controller.refresh();
  await f.choose([file('a','other'),files[1]]);const before=f.state.requests.length;
  await f.send();assert.match(f.get('message').textContent,/不同/);assert.equal(f.state.requests.length,before);assert.equal(f.state.writes.size,0);
}
// A retryable batch can also be recovered after refresh; verified files remain single writes.
{
  const f=await fixture(),files=[file('a','one'),file('b','two')];f.state.failPath='album/b';
  await f.choose(files);await f.send();f.controller.clearPrivate();await f.controller.refresh();
  assert.equal(f.get('choose-folder').disabled,false);await f.choose(files);await f.send();
  assert.equal(f.count('/batches'),1);assert.deepEqual([...f.state.writes.values()],[1,1]);assert.match(f.get('batch-summary').textContent,/2 \/ 2/);
}
// Late responses after logout cannot repopulate the queue or launch further requests.
for (const delayed of ['/batches','/chunk?','/transfers?id=']) {
  const f=await fixture();await f.choose([file('private.txt','private payload')]);
  let release,entered;
  const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.state.hook=async ({url})=>{if(url.includes(delayed) && (delayed!=='/transfers?id=' || f.state.task.kind==='batch')){f.state.hook=null;entered();await held;}};
  const sending=f.send();await ready;const before=f.state.requests.length;
  f.state.signedIn=false;f.controller.clearPrivate();release();await sending;
  assert.equal(f.state.requests.length,before);assert.equal(f.get('selected').textContent,'');assert.equal(f.get('batch').hidden,true);assert.equal(f.get('body').hidden,true);
}
{
  const f=await fixture();await f.choose([file('private.txt','private payload')]);
  let release,entered;
  const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.state.hook=async ({url})=>{if(url.endsWith('/batches')) throw Error('lost creation response');if(url.endsWith('/status')){entered();await held;}};
  const sending=f.send();await ready;const before=f.state.requests.length;
  f.state.signedIn=false;f.controller.clearPrivate();release();await sending;
  assert.equal(f.state.requests.length,before);assert.equal(f.get('selected').textContent,'');assert.equal(f.get('batch').hidden,true);
}
console.log('bridge batch UI: bounded request reduction, mixed files, hashes, partial success, resume, lost ACK and logout passed');
