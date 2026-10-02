import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../docs/assets/resources-admin.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function element(tag = 'div') {
  let text = '';
  const node = {tag,children:[],listeners:new Map(),attributes:new Map(),value:'',hidden:false,disabled:false,files:[],
    classList:{add(){},remove(){}},
    get textContent(){return text;},set textContent(value){text=value;this.children=[];},
    appendChild(child){this.children.push(child);child.parentNode=this;return child;},
    addEventListener(type, listener){this.listeners.set(type,listener);},
    fire(type){return this.listeners.get(type)?.({preventDefault(){}});},
    setAttribute(name,value){this.attributes.set(name,value);},
    closest(){return this.wrapper || (this.wrapper=element('label'));},focus(){},
  };
  return node;
}
const original = {id:'res-existing',group:'firefly',title:'已发布资料',desc:'原简介',details:'原详情\n第二行',
  versions:[{label:'1.0',date:'2026-10-01',file:'files/res-existing/v1.zip',sha256:'a'.repeat(64),size:123}]};
function harness({admin=true}={}) {
  const nodes=new Map(),writes=[], state={token:'fixture-session',entries:[copy(original)],error:null,deferred:null,publishError:null};
  const query=selector=>{
    if (selector===null) return null;
    if (!nodes.has(selector)) nodes.set(selector,element());
    return nodes.get(selector);
  };
  const role=name=>query('[data-role="res-'+name+'"]');
  role('target').value='__new__';
  role('group').value='naturecraft';
  role('edit-form').hidden=true;
  const document={querySelector:query,createElement:element,body:element()};
  const context={document,Blob:class {},
    XMLHttpRequest:class {
      open(){} setRequestHeader(){}
      constructor(){this.upload={};this.status=200;}
      send(){this.onload();}
    },
    fetch:async()=>({ok:true,json:async()=>copy(state.entries)}),
    window:{location:{hash:'#manage',href:''},confirm:()=>true,
      FlitFancyPanelShell:{init:()=>({show(){role('manager').hidden=false;},hide(){role('manager').hidden=true;},clearCollapsed(){}})},
      FlitFancyAdmin:{isAdminHost:()=>admin,token:()=>state.token,setToken:(_key,value)=>{state.token=value;},
        installErrorHandler(){},isUnauthorized:error=>error.status===401,
        async request(path,options={}) {
          if (path==='/api/resources') {
            const resources=copy(state.entries);
            if (state.deferLoad) return new Promise(resolve=>{state.resolveLoad=()=>resolve({resources});});
            return {resources};
          }
          if (path==='/api/admin/logout') return {ok:true};
          const body=JSON.parse(options.body || '{}');
          writes.push({path,body});
          if (path==='/api/resources/update') {
            if (state.deferred) return new Promise(resolve=>{state.resolve=resolve;});
            if (state.error) {
              if (state.error.status===401) state.token='';
              throw state.error;
            }
            const entry=state.entries.find(item=>item.id===body.id);
            Object.assign(entry,body);
            return {ok:true,entry:copy(entry)};
          }
          if (path==='/api/resources/publish') {
            if (state.publishError) throw state.publishError;
            return {ok:true};
          }
          if (path==='/api/resources/prepare') return {token:'fixture-upload'};
          return {ok:true};
        }},
    }};
  vm.runInNewContext(source,context,{filename:'resources-admin.js'});
  return {role,query,state,writes,context,edit(){return role('admin-list').children[0].children[0].children[1].fire('click');}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const test=harness(); await settle();
test.edit();
assert.equal(test.role('edit-title').value,original.title);
assert.equal(test.role('edit-group').value,original.group);
assert.equal(test.role('edit-desc').value,original.desc);
assert.equal(test.role('edit-details').value,original.details);
assert.equal(test.role('upload-form').hidden,true);
test.role('edit-title').value='修改后的标题';
test.role('edit-desc').value='';
test.role('edit-details').value='第一行\n第二行 <script>';
test.role('edit-group').value='flitfancy';
test.role('edit-title').fire('input');
assert.equal(test.role('edit-publish').disabled,true,'unsaved fields cannot be published');
await test.role('edit-publish').fire('click');
assert.equal(test.writes.length,0);
await test.role('edit-save').fire('click'); await settle();
assert.equal(test.writes[0].path,'/api/resources/update');
assert.deepEqual(test.writes[0].body,{id:original.id,title:'修改后的标题',group:'flitfancy',desc:'',details:'第一行\n第二行 <script>'});
assert.deepEqual(test.state.entries[0].versions,original.versions);
assert.equal(test.writes.length,1,'save does not upload or publish');
assert.equal(test.query('[data-column="firefly"]').children.length,0);
const movedCard=test.query('[data-column="flitfancy"]').children[0];
assert.equal(movedCard.children[0].textContent,'修改后的标题 · 1.0');
assert.equal(movedCard.children.find(node=>node.tag==='a').href,'resources/'+original.versions[0].file);
assert.equal(test.role('edit-publish').disabled,false);
test.state.publishError=Object.assign(new Error('timeout'),{status:0});
await test.role('edit-publish').fire('click');
assert.match(test.role('edit-status').textContent,/未确认.*保存在本机/);
test.state.publishError=null;
await test.role('edit-publish').fire('click');
assert.match(test.role('edit-status').textContent,/已发布/);
await test.role('edit-cancel').fire('click');
assert.equal(test.role('edit-form').hidden,true);
assert.equal(test.role('upload-form').hidden,false);

const retry=harness(); await settle(); retry.edit();
retry.role('edit-title').value='需要重试';
retry.state.error=Object.assign(new Error('offline'),{status:0});
await retry.role('edit-save').fire('click');
assert.equal(retry.role('edit-title').value,'需要重试');
assert.equal(retry.role('edit-save').disabled,false);
retry.state.error=null;
await retry.role('edit-save').fire('click');
assert.equal(retry.writes.at(-1).body.id,original.id);

const expired=harness(); await settle(); expired.edit();
expired.state.error=Object.assign(new Error('unauthorized'),{status:401});
await expired.role('edit-save').fire('click');
assert.equal(expired.role('edit-form').hidden,true);
assert.equal(expired.role('login-overlay').hidden,false);
assert.match(expired.role('login-status').textContent,/登录已过期/);

const race=harness(); await settle(); race.edit(); race.state.deferred=true;
const saving=race.role('edit-save').fire('click');
race.role('logout').fire('click');
race.state.resolve({ok:true,entry:{...original,title:'late response'}});
await saving;
assert.equal(race.role('edit-form').hidden,true);
assert.equal(race.role('edit-title').value,'');
assert.equal(race.role('admin-list').children.length,0,'late saves do not restore the signed-out manager');

const reloadRace=harness(); await settle(); reloadRace.edit();
reloadRace.state.deferLoad=true;
const reloading=reloadRace.role('reload').fire('click');
reloadRace.role('edit-title').value='保存后的最新标题';
reloadRace.role('edit-details').value='保存后的最新详情';
await reloadRace.role('edit-save').fire('click');
reloadRace.state.resolveLoad(); await reloading;
reloadRace.edit();
assert.equal(reloadRace.role('edit-title').value,'保存后的最新标题','late reloads cannot restore pre-save fields');
assert.equal(reloadRace.role('edit-details').value,'保存后的最新详情');
assert.match(reloadRace.role('list-status').textContent,/已更新/);

const duringSave=harness(); await settle(); duringSave.edit(); duringSave.state.deferred=true;
const writing=duringSave.role('edit-save').fire('click');
duringSave.state.deferLoad=true;
await duringSave.role('reload').fire('click');
assert.equal(duringSave.state.resolveLoad,undefined,'reloads wait until the metadata write is complete');
duringSave.state.resolve({ok:true,entry:copy(original)}); await writing;

const upload=harness(); await settle();
upload.role('target').value=original.id;
upload.role('title').value='stale hidden title';
upload.role('desc').value='stale hidden description';
upload.role('target').fire('change');
assert.equal(upload.role('group').value,'firefly','existing uploads use the saved resource category');
upload.role('label').value='2.0';
await upload.role('save').fire('click');
const preparation=upload.writes.find(write=>write.path==='/api/resources/prepare').body;
assert.equal(preparation.id,original.id);
assert.equal(preparation.group,'firefly');
assert.equal(preparation.title,undefined);
assert.equal(preparation.desc,undefined,'uploading a version cannot overwrite card text with hidden form leftovers');
const visitor=harness({admin:false}); await settle();
assert.equal(visitor.context.window.location.href,'https://console.flitfancy.com/resources.html#manage');
assert.equal(visitor.writes.length,0);
console.log('resource UI: original fields, clear text, category moves, stable downloads, explicit publication, retry, session races and version uploads passed');
