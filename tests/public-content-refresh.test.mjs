import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../docs/assets/essays.js', import.meta.url), 'utf8');
function element() {
  let text = '';
  return {children:[], hidden:false, appendChild(child){this.children.push(child);},
    set textContent(value){text=value;this.children=[];},
    get textContent(){return text + this.children.map(child => child.textContent).join('');}};
}
for (const hostname of ['flitfancy.com', 'console.flitfancy.com', '127.0.0.1']) {
  const nodes = new Map(['essay-library','essay-list','essay-prologue'].map(name => [`[data-role="${name}"]`,element()]));
  let spec, requested = '', current = {title:'old',content:'old body'}, fail = false;
  const handlers = new Map();
  const document = {querySelector:selector => nodes.get(selector), createElement:element,
    addEventListener:(name,fn)=>handlers.set(name,fn)};
  const window = {FlitFancyPublicRefresh:{register(value){spec=value; return {refresh:()=>spec.run()};}}};
  const context = {window,document,location:{hostname},AbortController,setTimeout,clearTimeout,
    fetch:async (url) => {requested=url; if(fail) throw new Error('offline'); return {ok:true,json:async()=>({essay:current})};}};
  vm.runInNewContext(source,context);
  assert.equal(spec.interval,15000);
  await spec.run();
  assert.equal(requested,'https://api.flitfancy.com/essays/featured', 'every public view reads the published source');
  const list = nodes.get('[data-role="essay-list"]');
  assert.match(list.textContent,/old body/);
  const originalNode = list.children[0];
  await spec.run();
  assert.equal(list.children[0],originalNode, 'unchanged refresh keeps the reading DOM');
  current = {title:'new',content:'new body'};
  await spec.run();
  assert.match(list.textContent,/new body/, 'already-open readers receive published updates');
  fail = true;
  assert.equal((await spec.run()).ok,false);
  assert.match(list.textContent,/new body/, 'offline refresh preserves the last readable content');
  assert.ok(handlers.has('flitfancy:essay-saved'));
}
console.log('public reader refresh: shared source, updates, stable DOM and offline retention passed');
