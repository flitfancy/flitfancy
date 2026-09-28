import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
const source = fs.readFileSync(new URL('../docs/assets/console-audio-history.js', import.meta.url), 'utf8');
vm.runInNewContext(source, { window });
const segment = window.FlitFancyAudioHistory.seriesSegments;
const rows = [
  { time: 0, first: 0, last: 59, left: -30, gains: [4] },
  { time: 60, first: 60, last: 119, left: -40, gains: [4] },
  { time: 300, first: 300, last: 359, left: -40, gains: [4] },
  { time: 360, first: 360, last: 419, left: -20, gains: [8] },
];
assert.deepEqual(Array.from(segment(rows, 'left', 60), s => s.length), [2, 1, 1]);
assert.equal(segment([], 'left', 60).length, 0);
assert.equal(segment([{ ...rows[0], left: null }], 'left', 60).length, 0);
assert.ok(source.includes('/api/audio/history?'), 'must use same-origin authenticated proxy');

// A hidden history pane owns no timer; the shared scheduler starts it only when opened.
const flush = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor() { this.hidden = false; this.value = ''; this.textContent = ''; this.handlers = new Map(); this.classList = {add() {}, remove() {}}; }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  removeEventListener(type) { this.handlers.delete(type); }
  setAttribute() {} removeAttribute() {} focus() {}
}
const front = new Element(), flip = new Element(), panel = new Element(); panel.hidden = true;
const fields = new Map();
panel.querySelector = key => { if (!fields.has(key)) fields.set(key, new Element()); return fields.get(key); };
const canvas = panel.querySelector('canvas');
canvas.getContext = () => new Proxy({}, {get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true; }});
let timerCount = 0;
window.setTimeout = () => ++timerCount; window.clearTimeout = () => {};
vm.runInNewContext(source, {window, getComputedStyle: () => ({getPropertyValue: () => ''})});
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/refresh-scheduler.js', import.meta.url), 'utf8'), {window});
const scheduler = window.FlitFancyRefresh.create({now: () => 1000});
let allowed = true, finish, calls = 0;
const history = window.FlitFancyAudioHistory.create({
  query: selector => ({'[data-role="audio-history"]': panel, '[data-role="audio-history-front"]': front, '[data-role="audio-history-flip"]': flip})[selector],
  scheduler, isServerOnline: () => allowed,
  request: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
});
scheduler.reconcile({authenticated: true}); history.start(); scheduler.start(); await flush();
assert.equal(calls, 0); assert.equal(timerCount, 0);
front.handlers.get('click')(); await flush(); assert.equal(calls, 1);
const range = panel.querySelector('select');
range.value = '7d'; const rangeRequest = range.handlers.get('change')();
range.value = '30d'; const finalRangeRequest = range.handlers.get('change')();
assert.equal(calls, 1, 'range changes cannot overlap a history fetch');
finish({rows: [], start: 0, end: 1000, step: 60, first_recorded: 1}); await flush();
assert.equal(calls, 2, 'rapid range changes produce one followup');
finish({rows: [], start: 0, end: 1000, step: 60, first_recorded: 2}); await Promise.all([rangeRequest, finalRangeRequest]);
const beforeClose = panel.querySelector('[data-role="audio-history-note"]').textContent;
const loading = scheduler.refresh('audio-history'); await flush();
panel.querySelector('[data-role="audio-history-back"]').handlers.get('click')();
finish({rows: [], start: 0, end: 1000, step: 60, error: 'obsolete response'}); await loading;
assert.equal(panel.querySelector('[data-role="audio-history-note"]').textContent, beforeClose, 'closing must discard the pending history response');
scheduler.reconcile(); assert.equal(scheduler.snapshot()[0].state, 'disabled');
front.handlers.get('click')(); await flush();
allowed = false; history.clearPrivate(); scheduler.reconcile({authenticated: false});
finish({rows: [], start: 0, end: 1000, step: 60, first_recorded: 3}); await flush();
assert.match(panel.querySelector('[data-role="audio-history-note"]').textContent, /请登录/);
history.dispose(); scheduler.dispose(); assert.equal(scheduler.snapshot().length, 0);
assert.doesNotMatch(source, /setTimeout\(|setInterval\(/, 'history polling must be owned by the shared scheduler');
console.log('audio history: gaps and gain changes break curves; empty periods stay empty');
