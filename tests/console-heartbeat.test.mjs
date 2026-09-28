import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/console-heartbeat.js", import.meta.url), "utf8");
const schedulerSource = fs.readFileSync(new URL("../docs/assets/refresh-scheduler.js", import.meta.url), "utf8");
const INITIAL = Date.parse("2026-09-27T01:00:00Z"), CLIENT_SKEW = 36000000;
const flush = () => new Promise(resolve => setImmediate(resolve));
const task = (id = "activity", extra = {}) => ({id, state: "success", lastStartedAt: INITIAL - 1050, lastFinishedAt: INITIAL - 1000, lastSuccessAt: INITIAL - 1000, durationMs: 50, runs: 1, failures: 0, active: 0, lastStatus: 200, ...extra});
const metadata = (rows = [task()], extra = {}) => ({schema: 1, startedAt: INITIAL - 60000, generatedAt: INITIAL, rows, ...extra});
function environment({admin = true, server = true, panel = true} = {}) {
  let now = INITIAL + CLIENT_SKEW, timerId = 0, signedIn = admin, available = server, next = metadata();
  const timers = new Map(), calls = [], pending = [], registered = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.ownerDocument = document; this.hidden = true; this.className = ""; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(""); }
    append(...items) { this.children.push(...items); items.forEach(item => { item.parentNode = this; }); }
    replaceChildren(...items) { this.children = []; this.text = ""; this.append(...items); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(event, fn) { this.listeners.set(event, fn); }
    click() { this.listeners.get("click")?.(); }
    focus() { document.activeElement = this; }
  }
  const document = {createElement: tag => new Element(tag), activeElement: null}, fields = new Map();
  const get = name => { if (!fields.has(name)) fields.set(name, new Element(name === "refresh" ? "button" : "div")); return fields.get(name); };
  const root = new Element("section"); root.querySelector = selector => get(selector.match(/"([^"]+)"/)[1]);
  const window = {
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, {fn, due: now + delay}); return id; }, clearTimeout: id => timers.delete(id),
    get BroadcastChannel() { throw new Error("No browser channel should be accessed"); },
    setInterval() { throw new Error("Only the shared scheduler may schedule reads"); },
  };
  vm.runInNewContext(schedulerSource, {window}); vm.runInNewContext(source, {window});
  const scheduler = window.FlitFancyRefresh.create({now: () => now});
  const register = scheduler.register;
  scheduler.register = spec => { registered.push(spec); return register(spec); };
  const module = window.FlitFancyHeartbeats.create({
    query: () => panel ? root : null, scheduler, isAdmin: () => signedIn, isServerOnline: () => available, now: () => now,
    async request(url) { calls.push(url); if (pending.length) return pending.shift()(); if (next instanceof Error) throw next; return next; },
  });
  module.start(); scheduler.reconcile({authenticated: signedIn}); scheduler.start();
  return {
    module, root, get, timers, calls, scheduler, registered,
    data(value) { next = value; },
    row(label) { return get("rows").children.find(item => item.children[1].textContent === label); },
    async read() { await scheduler.refresh("refresh-heartbeats"); await flush(); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) break;
        const [id, timer] = entry; timers.delete(id); now = timer.due; timer.fn(); await flush();
      }
      now = target;
    },
    defer() { let resolve, reject; const value = new Promise((yes, no) => { resolve = yes; reject = no; }); pending.push(() => value); return {resolve, reject}; },
    logout() { signedIn = false; module.clearPrivate(); scheduler.reconcile({authenticated: false}); },
    login() { signedIn = true; scheduler.reconcile({authenticated: true}); module.refresh(); },
    pause(changes) { scheduler.reconcile(changes); module.refresh(); },
    hideAndRestore() { scheduler.reconcile({hidden: true, online: false}); module.clearPrivate(); scheduler.reconcile({hidden: false, online: true, runNow: true}); module.refresh(); },
    dispose() { module.dispose(); scheduler.dispose(); assert.equal(timers.size, 0); },
  };
}
const error = status => Object.assign(new Error("PRIVATE_FAILURE_MESSAGE"), {status});

// A console alone reads actual backend metadata. No BroadcastChannel or second tab exists.
{
  const env = environment(); await flush();
  assert.equal(env.root.hidden, false); assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls, ["/api/refresh/status"]);
  assert.equal(env.registered.length, 1); assert.equal(env.registered[0].id, "refresh-heartbeats");
  assert.equal(env.registered[0].interval, 5000); assert.equal(env.registered[0].requiresAuth, true); assert.equal(env.registered[0].hidden, "pause");
  assert.equal(env.get("rows").children.length, 9);
  assert.equal(env.row("电脑使用").textContent, "电脑使用");
  assert.match(env.row("电脑使用").attributes['aria-description'], /上次读取成功.*1 秒前.*50 毫秒.*已完成 1 次/);
  assert.doesNotMatch(env.row("电脑使用").className, /completed/, "first observed data is not a new completion");
  assert.match(env.row("感知历史").attributes['aria-description'], /按需读取 · 尚未请求/);
  assert.equal(env.row("电脑使用").attributes.title, undefined);
  assert.equal(env.get("state").hidden, true, 'healthy refresh does not add a permanent status paragraph');
  assert.match(env.get("scope").textContent, /无需同时打开存在页/);
  assert.doesNotMatch(env.get("rows").textContent, /标签页|下次刷新|未打开/);
  assert.equal(env.timers.size, 1);
  env.dispose();
}

// Compact items enter one in-place detail view, retain live updates, and return keyboard focus.
{
  const env = environment(); await flush();
  const item = env.row("电脑使用"), count = env.calls.length;
  item.click();
  assert.equal(env.get("rows").hidden, true); assert.equal(env.get("detail").hidden, false);
  assert.equal(env.get("detail-name").textContent, "电脑使用");
  assert.equal(env.get("detail-runs").textContent, "1 次");
  assert.equal(env.get("back").ownerDocument.activeElement, env.get("back"));
  assert.equal(env.calls.length, count, 'opening details uses the existing snapshot');
  env.data(metadata([task("activity", {state: "error", lastStatus: 503, failures: 1, runs: 2})]));
  await env.read();
  assert.match(env.get("detail-status").textContent, /读取失败.*503/);
  assert.equal(item.dataset.problem, 'true'); assert.equal(env.get("detail").dataset.problem, 'true');
  env.get("back").click();
  assert.equal(env.get("rows").hidden, false); assert.equal(env.get("detail").hidden, true);
  assert.equal(item.ownerDocument.activeElement, item);
  env.row("感知历史").click();
  assert.match(env.get("detail-note").textContent, /点开感知卡片.*不代表故障/);
  env.get("detail").listeners.get("keydown")({key: 'Escape', preventDefault() {}});
  assert.equal(env.get("rows").hidden, false);
  item.click(); env.logout();
  assert.equal(env.get("detail").hidden, true); assert.equal(env.get("detail-name").textContent, '');
  assert.equal(env.get("detail-runs").textContent, '');
  env.dispose();
}

// Only new successful completions pulse. Identical snapshots, failures, and process restarts do not.
{
  const env = environment(); await flush();
  const row = env.row("电脑使用"), button = env.get("refresh"); button.focus();
  env.data(metadata([task("activity", {lastSuccessAt: INITIAL, runs: 2})]));
  await env.read(); assert.match(row.className, /completed/); const first = row.className;
  env.module.refresh(); await env.read(); assert.equal(row.className, first);
  assert.equal(env.row("电脑使用"), row); assert.equal(button.ownerDocument.activeElement, button);
  env.data(metadata([task("activity", {lastSuccessAt: INITIAL, runs: 3})]));
  await env.read(); assert.notEqual(row.className, first, "two completions with one timestamp can still pulse"); const second = row.className;
  env.data(metadata([task("activity", {state: "error", lastSuccessAt: INITIAL, runs: 4, failures: 1, lastStatus: 503})]));
  await env.read(); assert.equal(row.className, second); assert.equal(row.dataset.state, "error");
  assert.match(row.attributes['aria-description'], /上次读取失败 · HTTP 503.*连续失败 1/);
  env.data(metadata([task("activity", {lastSuccessAt: INITIAL, runs: 1})], {startedAt: INITIAL - 100}));
  await env.read(); assert.doesNotMatch(row.className, /completed/, "backend restart establishes a new baseline");
  env.dispose();
}

// Manual refresh and periodic refresh use one shared task, including in-flight deduplication.
{
  const env = environment(); await flush();
  const deferred = env.defer(), button = env.get("refresh");
  button.click(); await flush(); const count = env.calls.length;
  assert.equal(button.attributes["aria-disabled"], "true");
  for (let i = 0; i < 10; i++) button.click();
  await env.advance(20000); assert.equal(env.calls.length, count);
  deferred.resolve(metadata()); await flush(); assert.equal(button.attributes["aria-disabled"], "false");
  await env.advance(5000); assert.equal(env.calls.length, count + 1);
  assert.ok(env.calls.every(url => url === "/api/refresh/status"), "never reread business endpoints for the heartbeat");
  env.dispose();
}

// Read failures are panel-level freshness warnings; previous business outcomes remain intact.
{
  const env = environment(); await flush(); const row = env.row("电脑使用");
  for (const [status, expected] of [[404, /重启网页后端/], [503, /上次记录.*尚未更新/], [undefined, /尚未更新/]]) {
    env.data(error(status)); await env.read();
    assert.match(env.get("state").textContent, expected);
    assert.equal(env.get("state").dataset.stale, "true"); assert.equal(row.dataset.state, "success");
    assert.doesNotMatch(env.get("state").textContent, /PRIVATE_/);
  }
  env.data(metadata()); await env.read(); assert.equal(env.get("state").dataset.stale, "false");
  env.pause({hidden: true}); assert.match(env.get("state").textContent, /页面在后台/);
  const count = env.calls.length; await env.advance(20000); assert.equal(env.calls.length, count); assert.equal(row.dataset.state, "success");
  env.pause({hidden: false, online: false}); assert.match(env.get("state").textContent, /网络离线.*尚未更新/);
  env.pause({online: true}); await flush(); assert.equal(env.calls.length, count + 1);
  env.dispose();
}

// An unauthorized response clears private records even before the outer session handler reacts.
{
  const env = environment(); await flush();
  assert.equal(env.get("rows").children.length, 9);
  env.data(error(401)); await env.read();
  assert.equal(env.root.hidden, false, "the panel may retain a reauthentication prompt");
  assert.equal(env.get("rows").children.length, 0);
  assert.equal(env.get("summary").textContent, "");
  assert.match(env.get("state").textContent, /重新登录/);
  env.data(metadata()); await env.read();
  assert.equal(env.get("rows").children.length, 9);
  assert.doesNotMatch(env.row("电脑使用").className, /completed/, "reauthentication starts a fresh private display");
  env.dispose();
}

// Private metadata remains gated; logout and late responses never repopulate the cleared UI.
{
  for (const config of [{admin: false}, {server: false}, {panel: false}]) {
    const env = environment(config); await flush(); assert.equal(env.root.hidden, true); assert.equal(env.calls.length, 0); env.dispose();
  }
  const env = environment(); await flush(); const deferred = env.defer();
  env.get("refresh").click(); await flush(); env.logout();
  assert.equal(env.root.hidden, true); assert.equal(env.get("rows").children.length, 0);
  deferred.resolve(metadata([task("activity", {runs: 100})])); await flush();
  assert.equal(env.get("rows").children.length, 0);
  env.login(); await flush(); assert.equal(env.root.hidden, false); assert.match(env.row("电脑使用").attributes['aria-description'], /已完成 1 次/);
  assert.doesNotMatch(env.row("电脑使用").className, /completed/);
  const pending = env.defer(); env.get("refresh").click(); await flush(); env.logout(); env.login();
  pending.resolve(metadata([task("activity", {runs: 100})])); await flush();
  assert.match(env.row("电脑使用").attributes['aria-description'], /已完成 1 次/);
  assert.doesNotMatch(env.row("电脑使用").attributes['aria-description'], /100 次/);
  env.hideAndRestore(); await flush(); assert.equal(env.root.hidden, false); assert.equal(env.registered.length, 1);
  env.dispose();
}

// Only fixed identifiers, states, and bounded metrics render. No arbitrary message or payload is exposed.
{
  const env = environment(); await flush();
  env.data(metadata([
    task("activity", {label: "PRIVATE_LABEL", error: "PRIVATE_ERROR", path: "PRIVATE_PATH", durationMs: Infinity, failures: -1, runs: NaN, active: -1, lastSuccessAt: INITIAL + 1}),
    task("unknown", {label: "PRIVATE_UNKNOWN"}), task("__proto__"), task("activity", {runs: 999}),
  ]));
  await env.read();
  const row = env.row("电脑使用"); assert.doesNotMatch(env.get("rows").textContent, /PRIVATE_|999/);
  assert.match(row.attributes['aria-description'], /尚无成功记录.*耗时 —.*进行中 0.*已完成 0 次.*连续失败 0/);
  assert.doesNotMatch(row.attributes['aria-description'], /PRIVATE_|999/);
  assert.equal(env.get("rows").children.length, 9);
  env.data({schema: 999, rows: [{error: "PRIVATE_INVALID"}]}); await env.read();
  assert.match(env.get("state").textContent, /尚未更新/); assert.equal(env.row("电脑使用"), row);
  env.dispose();
}

console.log("console-heartbeat backend metadata, shared scheduling, pulses, privacy and lifecycle tests passed");
