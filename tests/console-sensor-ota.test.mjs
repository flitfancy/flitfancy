import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../docs/assets/console-sensor-ota.js', import.meta.url), 'utf8');
const FIXTURE_SESSION = 'fixture-session';
const nodes = {}, requests = [], uploads = [], timers = [];
for (const role of ['toggle','panel','file','select','start','name','status','version','progress']) {
  nodes[role] = {hidden: role === 'panel' || role === 'progress', disabled: false, value: '', files: [],
    textContent: '', handlers: {}, setAttribute(name, value) { this[name] = value; },
    addEventListener(event, callback) { this.handlers[event] = callback; }, click() {}};
}
class XHR {
  constructor() { this.upload = {}; this.headers = {}; uploads.push(this); }
  open(method, path) { this.method = method; this.path = path; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(file) { this.file = file; }
  abort() { this.aborted = true; this.onabort?.(); }
}
let admin = false, online = true, device = {board_connected:true, firmware_version:'1.3.3',
  ota_supported:true, max_firmware_bytes:0x640000, boot_partition:'app1'}, delayed = null;
const window = {XMLHttpRequest:XHR, FlitFancyAdmin:{token:()=>admin?FIXTURE_SESSION:''},
  setTimeout(callback) { const timer = {callback}; timers.push(timer); return timer; },
  clearTimeout(timer) { timer.cancelled = true; }};
vm.runInNewContext(source, {window, document:{}, Date});
const module = window.FlitFancySensorOta.create({
  query:selector=>nodes[selector.match(/sensor-ota-([a-z]+)"/)[1]],
  isAdmin:()=>admin, isServerOnline:()=>online,
  request:async path=>{ requests.push(path); return delayed ? delayed : {...device}; },
});
const flush = () => new Promise(resolve=>setImmediate(resolve));
module.start();
await nodes.toggle.handlers.click(); await flush();
assert.equal(requests.length, 0, 'anonymous page must not read device metadata');
assert.equal(nodes.select.disabled, true);
admin = true;
await nodes.toggle.handlers.click(); await nodes.toggle.handlers.click(); await flush();
assert.equal(nodes.version.textContent, '当前 v1.3.3');
nodes.file.files = [{name:'wrong.txt',size:1024}]; nodes.file.handlers.change();
assert.equal(nodes.start.disabled, true);
nodes.file.files = [{name:'sense.bin',size:1024}]; nodes.file.handlers.change();
assert.equal(nodes.start.disabled, false);
const completed = nodes.start.handlers.click();
assert.equal(uploads[0].path, '/api/sensors/firmware');
assert.equal(uploads[0].headers.Authorization, 'Bearer ' + FIXTURE_SESSION);
assert.equal(nodes.select.disabled, true);
uploads[0].upload.onprogress({lengthComputable:true,loaded:512,total:1024});
assert.match(nodes.status.textContent, /50%/);
uploads[0].status = 200;
uploads[0].responseText = JSON.stringify({ok:true, previous_partition:'app1'});
uploads[0].onload(); await flush();
assert.match(nodes.status.textContent, /等待感知板重启/);
device = {...device,boot_partition:'app0',firmware_version:'1.3.4'};
timers.at(-1).callback(); await completed;
assert.match(nodes.status.textContent, /升级完成/);
assert.equal(nodes.version.textContent, '当前 v1.3.4');
assert.equal(nodes.start.disabled, true);

// A status response begun before logout must not restore private version data.
let deliver;
delayed = new Promise(resolve=>{ deliver = resolve; });
const pending = module.refresh();
admin = false; module.clearPrivate(); deliver({...device,firmware_version:'9.9.9'});
await pending; delayed = null;
assert.equal(nodes.panel.hidden, true);
assert.doesNotMatch(nodes.version.textContent, /9\.9\.9/);

// Cancel a pending upload and ignore even a late successful response.
admin = true;
await nodes.toggle.handlers.click(); await flush();
nodes.file.files = [{name:'next.bin',size:1024}]; nodes.file.handlers.change();
const cancelled = nodes.start.handlers.click();
admin = false; module.clearPrivate(); await cancelled;
assert.equal(uploads[1].aborted, true);
uploads[1].status = 200; uploads[1].responseText = '{"ok":true,"previous_partition":"app0"}';
uploads[1].onload(); await flush();
assert.equal(nodes.panel.hidden, true);
assert.equal(nodes.progress.hidden, true);
assert.equal(nodes.name.textContent, '选择 FIREFLY-SENSE 应用固件');
assert.equal(nodes.start.disabled, true);
module.dispose();
console.log('sensor OTA UI: authentication, validation, progress, reboot confirmation and logout races passed');
