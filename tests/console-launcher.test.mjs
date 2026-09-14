import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
function element() {
  return { hidden: true, value: "", checked: false, children: [], textContent: "", listeners: {},
    classList: { add() {}, remove() {} }, focus() {}, contains() { return false; },
    append(...items) { this.children.push(...items); }, appendChild(item) { this.append(item); },
    replaceChildren(...items) { this.children = items; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    async fire(name, event = {}) { return this.listeners[name]?.(event); } };
}
const nodes = new Map(), get = name => { if (!nodes.has(name)) nodes.set(name, element()); return nodes.get(name); };
const root = element(); root.querySelector = selector => get(selector.match(/"([^"]+)"/)[1]);
let signedIn = false, cards = [], jobs = [], pendingGet = null;
const writes = [], reads = [];
const window = { confirm: () => true, FlitFancyAdmin: { isUnauthorized: e => e.status === 401 } };
vm.runInNewContext(fs.readFileSync(new URL("../docs/assets/console-launcher.js", import.meta.url), "utf8"), {
  window, document: { createElement: element, hidden: false }, setInterval() {},
});
const module = window.FlitFancyConsoleLauncher.create({ query: () => root, isAdmin: () => signedIn, isServerOnline: () => true,
  async request(url, options) {
    if (!options) { reads.push(url); if (pendingGet) return pendingGet; return { cards, jobs, agent_online: true }; }
    const body = JSON.parse(options.body); writes.push({url,body});
    if (url.endsWith('/save')) { cards = [{...body,id:'saved-id'}]; return {}; }
    if (url.endsWith('/run')) { jobs = [{card_id:body.id,state:'done',message:'已启动'}]; return {job_id:'run-id'}; }
    if (url.endsWith('/delete')) { cards = []; return {}; }
    if (url.endsWith('/pick')) return {job_id:'picker-id'};
    if (url.endsWith('/resolve')) return {path:''};
  },
});
module.start();
assert.equal(root.hidden, true); assert.equal(reads.length, 0);
signedIn = true; await module.refresh(); assert.equal(root.hidden, false);
await get('add').fire('click');
get('path').value = '"C:\\Tools\\hello world.py"'; await get('path').fire('change');
assert.equal(get('path').value, 'C:\\Tools\\hello world.py');
assert.equal(get('name').value, 'hello world'); assert.equal(get('hidden').checked, true);
get('name').value = '<img src=x onerror=alert(1)>';
get('args').value = 'first value\nsecond';
await get('save').fire('click');
assert.deepEqual(writes.at(-1).body.args, ['first value', 'second']);
const launch = get('cards').children[0].children[0];
assert.equal(launch.children[1].textContent, '<img src=x onerror=alert(1)>');
await launch.fire('click');
assert.deepEqual(writes.at(-1).body, {id:'saved-id'}, 'launch only sends the saved ID');
// Only private PNG data may be used as a native icon; never load an arbitrary URL.
cards[0].icon = 'https://untrusted.example/tracking.png';
await module.refresh();
assert.match(get('cards').children[0].children[0].children[0].src, /^data:image\/svg\+xml,/);
cards[0].icon = 'data:image/png;base64,iVBORw0KGgo=';
await module.refresh();
const nativeIcon = get('cards').children[0].children[0].children[0];
assert.equal(nativeIcon.src, cards[0].icon);
await nativeIcon.fire('error');
assert.match(nativeIcon.src, /^data:image\/svg\+xml,/, 'broken native icons fall back');
await get('add').fire('click'); await get('pick').fire('click');
jobs = [{id:'picker-id',kind:'pick',state:'done',path:'C:\\Tools\\app.exe',message:'已选择'}];
await module.refresh(); assert.equal(get('path').value,'C:\\Tools\\app.exe'); assert.equal(get('hidden').checked,false);
await root.fire('drop', { preventDefault() {}, dataTransfer: { getData: () => '', files: [{name:'unknown.py'}] } });
assert.equal(get('name').value,'unknown'); assert.match(get('status').textContent,/完整路径/);
// A successful response arriving after sign-out must not restore private cards.
let resolveGet; pendingGet = new Promise(resolve => { resolveGet = resolve; });
const refresh = module.refresh(); signedIn = false; module.clearPrivate();
resolveGet({ cards, jobs, agent_online: true }); await refresh;
assert.equal(root.hidden,true); assert.equal(get('cards').children.length,0);
console.log('launcher UI: hidden auth, path input, safe names, saved-ID launches, picker, drops and sign-out race passed');
