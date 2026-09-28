import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/* 记忆时间线的 inFlight 防重入守卫：
   interval / visibilitychange / flitfancy:memory-saved 三路并发触发时，
   同一时刻最多只允许一个 fetch 在途，杜绝重复渲染与请求风暴。 */

const source = fs.readFileSync(
  new URL("../docs/assets/memory.js", import.meta.url), "utf8"
);
assert.doesNotMatch(source, /memory\.(?:date|title)/,
  "公开日记渲染不得重新引入旧 date/title 字段兜底");

let fetchCalls = 0, nextTimer = 0;
const pending = [], handlers = {}, lifecycle = {}, timers = new Map();
const streamEl = { children: [], querySelectorAll() { return []; }, appendChild() {} };
const document = {
  hidden: false,
  querySelector(selector) {
    if (selector === '[data-role="memory-sync"]') return {textContent:""};
    if (selector === '[data-role="memory-stream"]') return streamEl;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener(name, fn) { handlers[name] = fn; },
};
const window = {
  setTimeout(fn, ms) { const id=++nextTimer; timers.set(id,{fn,ms}); return id; },
  clearTimeout(id) { timers.delete(id); },
  addEventListener(name, fn) { lifecycle[name] = fn; },
  FlitFancyAdmin: {
    token: () => '', isAdminHost: () => false,
    fetchRaw(url, options) {
      assert.equal(url, 'https://api.flitfancy.com/memories');
      assert.equal(options.authMode, 'none', 'public diary must not receive administrator credentials');
      fetchCalls++;
      return new Promise(resolve => pending.push(resolve));
    },
    formatDateTime: (value, precision) => precision === 'date'
      ? String(value || '').slice(0,10) : String(value || '').slice(0,19).replace('T',' '),
  },
};
vm.runInNewContext(fs.readFileSync(new URL('../docs/assets/refresh-scheduler.js',import.meta.url),'utf8'),{window});
vm.runInNewContext(source,{window,document});
const settle = () => new Promise(resolve => setImmediate(resolve));
const complete = () => pending.shift()({ok:true,json:async()=>({ok:true,rows:[]})});
await settle();
assert.equal(fetchCalls,1,'initial load fetches once');
handlers.visibilitychange(); handlers.visibilitychange();
handlers['flitfancy:memory-saved'](); handlers['flitfancy:memory-saved']();
await settle();
assert.equal(fetchCalls,1,'one in-flight request despite multiple triggers');
complete(); await settle();
assert.equal(fetchCalls,2,'saved events coalesce into one fresh read after the old request');
complete(); await settle();
assert.equal(fetchCalls,2);
document.hidden=true; handlers.visibilitychange(); await settle();
assert.equal(timers.size,0,'hidden diary suspends its data timer');
document.hidden=false; handlers.visibilitychange(); await settle();
assert.equal(fetchCalls,3,'visible again refreshes immediately');
complete(); await settle();
lifecycle.pagehide({persisted:true});
assert.equal(timers.size,0,'back-forward cached page pauses polling');
lifecycle.pageshow({persisted:true}); await settle();
assert.equal(fetchCalls,4,'restored cached page resumes polling');
complete(); await settle();
lifecycle.pagehide({persisted:false});
assert.equal(timers.size,0,'leaving diary disposes scheduler');
console.log('memory shared refresh: overlap, coalesced writes, visibility and back-forward restore passed');
