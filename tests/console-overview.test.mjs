import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/console-overview.js", import.meta.url), "utf8"
);
const window = {};
vm.runInNewContext(source, { window });

const trend = window.FlitFancyConsoleOverview.pressureTrendText;
assert.equal(trend([]), "");
assert.equal(trend(Array.from({ length: 21 }, () => ({ pressure_pa: 100000 }))),
  "气压 3h 趋势：平稳");

const rising = Array.from({ length: 21 }, (_, index) => ({
  pressure_pa: index >= 18 ? 100200 : 100000,
}));
assert.match(trend(rising), /↑ \+2\.0 hPa/);

const falling = Array.from({ length: 21 }, (_, index) => ({
  pressure_pa: index >= 18 ? 99800 : 100000,
}));
assert.match(trend(falling), /↓ -2\.0 hPa/);

// Closed/replaced history views cannot render a late response or start a fallback fetch.
const flush = () => new Promise(resolve => setImmediate(resolve));
const roles = new Map();
class Element {
  constructor() { this.children = []; this.handlers = new Map(); this.dataset = {}; this.style = {}; this.classList = {toggle() {}}; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { if (key === 'data-role') roles.set(value, this); }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  querySelectorAll() { return []; }
  getContext() { return new Proxy({}, {get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true; }}); }
}
roles.set('sensor-grid', new Element());
window.setTimeout = () => 1; window.clearTimeout = () => {};
vm.runInNewContext(source, {window, document: {createElement: () => new Element()}});
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/refresh-scheduler.js', import.meta.url), 'utf8'), {window});
const scheduler = window.FlitFancyRefresh.create({now: () => 1000});
let finish, calls = 0, restored = 0;
let responder = () => new Promise(resolve => { finish = resolve; });
const overview = window.FlitFancyConsoleOverview.create({
  query: selector => roles.get(selector.match(/"([^"]+)"/)[1]), scheduler,
  request: url => { calls++; return responder(url); }, sensorMeta: {CH0: {name: '温湿度'}, CH1: {name: '气压'}},
  math: {}, getRows: () => [], renderRows: () => { restored++; },
});
scheduler.start(); await flush(); assert.equal(calls, 0);
overview.open('CH0'); await flush(); assert.equal(calls, 1);
const obsolete = scheduler.refresh('sensor-history'); overview.clearPrivate();
finish({ok: false}); await obsolete;
assert.equal(calls, 1, 'closing must not send the pending local request onward to the public fallback');
assert.equal(restored, 1); assert.equal(overview.isOpen(), false);

overview.open('CH0'); await flush();
const firstRequest = scheduler.refresh('sensor-history');
overview.open('CH1'); assert.equal(calls, 2, 'changing channel queues behind the pending request');
finish({ok: true, buckets: []}); await firstRequest; await flush(); assert.equal(calls, 3);
finish({ok: true, buckets: []}); await flush();
assert.match(roles.get('overview-status').textContent, /24 小时总览/);
scheduler.reconcile({hidden: true}); assert.equal(scheduler.snapshot()[0].state, 'paused');
responder = async () => { const error = new Error('private server diagnostics'); error.status = 503; throw error; };
scheduler.reconcile({hidden: false}); await flush();
assert.equal(scheduler.snapshot()[0].failures, 1);
assert.match(roles.get('overview-status').textContent, /暂时拿不到/);
assert.doesNotMatch(roles.get('overview-status').textContent, /private server/);
overview.dispose(); scheduler.dispose(); assert.equal(scheduler.snapshot().length, 0);
assert.doesNotMatch(source, /setInterval\(|setTimeout\(/);

console.log("console overview module test ok");
