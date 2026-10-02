import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.value = '';
    this.textContent = ''; this.className = ''; this.hidden = false; this.disabled = false;
    this.listeners = new Map();
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      add: name => { this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
      toggle() {},
    };
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { return this.listeners.get(name)?.({preventDefault(){}}); }
  focus() {}
  appendChild(child) {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(value => value !== child);
    this.children.push(child); child.parentNode = this; return child;
  }
  querySelector(selector) { return this.children.find(child => selector === '.badge' ? child.classList.contains('badge') : child.tagName === selector); }
}
function documentHarness() {
  const elements = new Map(), handlers = new Map(), events = [];
  const query = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const document = {body:new Element(), querySelector:query, querySelectorAll:() => [],
    createElement:tag => new Element(tag), addEventListener:(name, callback) => handlers.set(name, callback),
    dispatchEvent(event) { events.push(event); return handlers.get(event.type)?.(event); }};
  return {document, query, handlers, events};
}
const CustomEvent = class {constructor(type, options = {}) {this.type = type; this.detail = options.detail;}};
const settle = () => new Promise(resolve => setImmediate(resolve));
const html = read('../docs/journal.html');
const cards = [...html.matchAll(/<div class="mini-card" data-anchor-uid="([^"]+)" data-project="([^"]+)" data-horizon="([^"]+)">\s*<span class="badge ([^"]+)">([^<]+)<\/span>\s*<h3>([^<]+)<\/h3>\s*<p>([^<]+)<\/p>/g)];
assert.equal(cards.length, 9, 'all original cards keep their existing markup');
const rendering = documentHarness(), pending = [], requests = [];
const nodes = cards.map(([,uid,project,horizon,kind,badge,title,content]) => {
  const node = new Element(); node.dataset = {anchorUid:uid,project,horizon};
  for (const [tag,text,classes] of [['span',badge,'badge '+kind],['h3',title,''],['p',content,'']]) {
    const child = new Element(tag); child.textContent = text; child.className = classes; node.appendChild(child);
  }
  const column = {firefly:'tianxin',skywork:'skywork',flitfancy:'flitfancy'}[project];
  rendering.query('#'+column+' .mini-grid').appendChild(node);
  return node;
});
rendering.document.querySelectorAll = selector => selector === '[data-anchor-uid]' ? nodes : [];
const location = {hostname:'console.flitfancy.com',hash:'#anchors'};
const window = {location, FlitFancyAdmin:{isAdminHost:()=>true,token:()=> 'fixture-session',
  formatDate:value => value.slice(0,10), request(url, options) {
    requests.push({url,options}); return new Promise(resolve => pending.push(resolve));
  }}};
vm.runInNewContext(read('../docs/assets/anchors.js'), {window,document:rendering.document,location,
  history:{replaceState(){}},CustomEvent});
assert.equal(requests[0].url, '/api/anchors', 'management reads its local saved records');
pending.shift()({rows:[]}); await settle();
nodes[0].children.at(-1).dispatch('click');
const original = rendering.events.at(-1).detail;
assert.equal(original.card, true);
assert.equal(original.title, '大脑');
assert.equal(original.badge, '已跑通');
assert.equal(original.time, '');
rendering.document.dispatchEvent(new CustomEvent('flitfancy:journal-authenticated'));
const saved = {...original,title:'修改后的大脑',content:'第一行\n第二行 <script>',badge:'进行中',badge_kind:'doing'};
rendering.document.dispatchEvent(new CustomEvent('flitfancy:anchor-saved', {detail:saved}));
assert.equal(nodes[0].querySelector('h3').textContent, saved.title);
pending.shift()({rows:[{...original,title:'旧响应'}]}); await settle();
assert.equal(nodes[0].querySelector('h3').textContent, saved.title, 'late reads cannot undo a completed save');
pending.shift()({rows:[saved]}); await settle();
assert.equal(nodes[0].querySelector('p').textContent, saved.content, 'content stays plain text with line breaks');
assert.equal(nodes[0].querySelector('.badge').className, 'badge doing');
assert.equal(rendering.query('[data-role="anchor-count"]').textContent, '锚点 · 显示 0 / 0 条', 'original cards are not duplicated in the dated list');
nodes[0].children.at(-1).dispatch('click');
assert.equal(rendering.events.at(-1).detail.title, saved.title, 're-edit uses the saved values');

const writer = documentHarness();
let token = 'fixture-session', saveError = null, saveResult = null, savePayload = null, resolveSave = null, panelOptions;
const editorWindow = {location:{hostname:'127.0.0.1',hash:'#anchors'},
  FlitFancyAdmin:{isAdminHost:()=>true,token:()=>token,setToken:(_key,value)=>{token=value;},
    nowForInput:()=> '2026-10-02T11:12:13',installErrorHandler(){},isUnauthorized:error=>error.status===401,
    async request(path, options) {
      if (path === '/api/anchors') {
        savePayload = JSON.parse(options.body);
        if (saveError) throw saveError;
        if (saveResult === 'pending') return new Promise(resolve => {resolveSave=resolve;});
        if (saveResult) return saveResult;
        return {anchor:{...saved},public_sync:true};
      }
      return {ok:true};
    }}, FlitFancyPanelShell:{init(options){panelOptions=options;return {show(){}};}}};
vm.runInNewContext(read('../docs/assets/journal-admin.js'), {window:editorWindow,document:writer.document,CustomEvent});
const field = role => writer.query('[data-role="anchor-'+role+'"]');
writer.document.dispatchEvent(new CustomEvent('flitfancy:edit-anchor',{detail:original}));
assert.equal(field('title').value, original.title);
assert.equal(field('badge').value, original.badge);
assert.equal(field('date-field').hidden, true);
assert.equal(field('save').textContent, '保存修改');
saveError = Object.assign(new Error('离线，请重试'), {status:0});
await field('save').dispatch('click');
assert.equal(savePayload.time, '', 'editing an undated card does not invent a date');
assert.equal(savePayload.badge, original.badge);
assert.equal(field('uid').value, original.uid, 'failed saves retain the original identity for retry');
assert.equal(field('save').textContent, '保存修改');
saveError = null;
await field('save').dispatch('click');
assert.equal(writer.events.at(-1).type, 'flitfancy:anchor-saved');
assert.equal(writer.events.at(-1).detail.title, saved.title);
assert.equal(field('uid').value, '');
assert.equal(field('badge-field').hidden, true);
const dated = {...original,card:false,uid:'dated-anchor-0001',time:'2026-08-21T12:34:56+08:00',precision:'second'};
writer.document.dispatchEvent(new CustomEvent('flitfancy:edit-anchor',{detail:dated}));
panelOptions.onExpand();
assert.equal(field('date').value, '2026-08-21', 'expanding the panel keeps the original date');
assert.equal(field('time').value, '12:34:56');
field('cancel-edit').dispatch('click');
assert.equal(field('uid').value, '');
assert.equal(field('save').textContent, '建立锚点');
writer.document.dispatchEvent(new CustomEvent('flitfancy:edit-anchor',{detail:original}));
saveResult='pending';
const inFlight=field('save').dispatch('click');
await writer.query('[data-role="memory-logout"]').dispatch('click');
const eventCount=writer.events.length;
resolveSave({anchor:saved,public_sync:true}); await inFlight;
assert.equal(writer.events.length,eventCount,'sign-out suppresses late save UI');
assert.equal(field('uid').value,'');

token='fixture-session';
saveResult={anchor:saved,public_sync:false,public_sync_note:'云端尚未支持旧卡片修改，请更新云端服务后重试同步。'};
writer.document.dispatchEvent(new CustomEvent('flitfancy:edit-anchor',{detail:original}));
await field('save').dispatch('click');
assert.match(field('write-status').textContent,/已保存在本机.*请更新云端服务/);
assert.doesNotMatch(field('write-status').textContent,/自动补传/,'a deployment mismatch must not promise an automatic retry will fix it');

function realSessionHarness() {
  const dom=documentHarness(), storage=new Map(), state={};
  const role=name=>dom.query('[data-role="'+name+'"]');
  role('memory-login-overlay').hidden=true;
  const browser={location:{hostname:'127.0.0.1',hash:'#anchors'},addEventListener(){},
    FlitFancyPanelShell:{init:()=>({show(){role('memory-editor').hidden=false;}})}};
  const context=vm.createContext({window:browser,document:dom.document,CustomEvent,AbortController,setTimeout,clearTimeout,
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    async fetch(path) {
      const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});
      if (path==='/api/anchors') return new Promise(resolve=>{state.respond=(status,body)=>resolve(response(status,body));});
      return response(200,path==='/api/admin/login' ? {token:'new-fixture-session'} : {ok:true});
    }});
  vm.runInContext(read('../docs/assets/admin-core.js'),context);
  browser.FlitFancyAdmin.setToken('flitfancy.admin.token','fixture-session');
  vm.runInContext(read('../docs/assets/journal-admin.js'),context);
  dom.document.dispatchEvent(new CustomEvent('flitfancy:edit-anchor',{detail:original}));
  return {dom,role,state,browser};
}

const expired=realSessionHarness();
const expiringSave=expired.role('anchor-save').dispatch('click');
expired.state.respond(401,{error:'登录已过期'}); await expiringSave;
assert.equal(expired.browser.FlitFancyAdmin.token(),'','the real shared request core clears the expired session');
assert.equal(expired.role('memory-login-overlay').hidden,false);
assert.match(expired.role('memory-login-status').textContent,/登录已过期/);
assert.match(expired.role('anchor-write-status').textContent,/保存失败.*重新登录/);
assert.equal(expired.role('anchor-title').value,original.title,'expiry keeps the draft available for retry');
assert.equal(expired.role('anchor-save').disabled,false);

const signedOut=realSessionHarness();
const rejectedAfterLogout=signedOut.role('anchor-save').dispatch('click');
await signedOut.role('memory-logout').dispatch('click');
signedOut.state.respond(401,{error:'late expiry'}); await rejectedAfterLogout;
assert.equal(signedOut.role('memory-login-overlay').hidden,true,'a late 401 must not reopen login after deliberate sign-out');
assert.equal(signedOut.role('anchor-uid').value,'');

const switched=realSessionHarness();
const rejectedOldSession=switched.role('anchor-save').dispatch('click');
switched.role('memory-username').value='fixture';
switched.role('memory-password').value='fixture';
await switched.role('memory-login').dispatch('click');
switched.state.respond(401,{error:'old session expired'}); await rejectedOldSession;
assert.equal(switched.browser.FlitFancyAdmin.token(),'new-fixture-session','late 401s preserve a new login');
assert.equal(switched.role('memory-login-overlay').hidden,true);
assert.doesNotMatch(switched.role('memory-login-status').textContent,/登录已过期/);
console.log('anchor editing: original cards, local reads, status, races, retry, precision, real session expiry and synchronization guidance passed');
