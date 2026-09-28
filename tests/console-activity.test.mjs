import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/console-activity.js", import.meta.url), "utf8");
const schedulerSource = fs.readFileSync(new URL("../docs/assets/refresh-scheduler.js", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const INITIAL = Date.parse("2026-09-25T17:00:00Z"); // Already 26 September in the archive timezone.
function summary(overrides = {}) {
  const day = (date, active, status = "recorded", apps = []) => ({date, active_seconds: active, observed_seconds: active, idle_seconds: 0, unknown_seconds: 0, status, apps});
  return {
    ok: true, timezone: "Asia/Shanghai", generated_at: INITIAL / 1000,
    source: {available: true, status: "online", stale: false, last_success_at: INITIAL / 1000, window_updated_at: INITIAL / 1000 - 3, afk_updated_at: INITIAL / 1000 - 24},
    archive: {retention: "indefinite", first_date: "2026-09-20", recorded_days: 3, backfill_pending_days: 2},
    today: day("2026-09-26", 3600),
    range: {start: "2026-09-20", end: "2026-09-26", days: 7, active_seconds: 5400, recorded_days: 3},
    daily: [day("2026-09-20", null, "not_archived"), day("2026-09-21", null, "no_data"), day("2026-09-22", 0), day("2026-09-25", 1800, "partial", [{app: "Editor", seconds: 1800}]), day("2026-09-26", 3600, "recorded", [{app: "Browser", seconds: 3600}])],
    apps: [{app: "Browser", seconds: 3600}, {app: "Editor", seconds: 1800}], ...overrides,
  };
}
function fixture({admin = false, adminHost = true} = {}) {
  let signedIn = admin, online = adminHost, now = INITIAL, responder = async () => summary(), exporter = async () => ({ok: true, blob: async () => new Blob(['{"usage":1}'])});
  const requests = [], exports = [], downloads = [], urls = [], revoked = [], intervals = new Map(), timeouts = new Map();
  let timerId = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.style = {}; this.dataset = {}; this.value = ""; this.hidden = false; this.disabled = false; this.ownerDocument = document; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(""); }
    append(...items) { this.children.push(...items); items.forEach(item => { item.parent = this; }); }
    replaceChildren(...items) { this.text = ""; this.children = []; this.append(...items); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, []); this.listeners.get(event).push(fn); }
    removeEventListener(event, fn) { this.listeners.set(event, (this.listeners.get(event) || []).filter(item => item !== fn)); }
    async fire(event) { for (const fn of this.listeners.get(event) || []) await fn({target: this}); }
    click() { if (this.tagName === "a") downloads.push({href: this.href, download: this.download}); else return this.fire("click"); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  }
  const document = {createElement: tag => new Element(tag)};
  document.body = new Element("body");
  const nodes = new Map();
  const get = name => { if (!nodes.has(name)) nodes.set(name, new Element("div")); return nodes.get(name); };
  const root = new Element("section"); root.querySelector = selector => get(selector.match(/"([^"]+)"/)[1]);
  const window = {
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, {fn, ms}); return id; }, clearInterval: id => intervals.delete(id),
    setTimeout(fn, ms) { const id = ++timerId; timeouts.set(id, {fn, ms, at: now + ms}); return id; }, clearTimeout: id => timeouts.delete(id),
    URL: {createObjectURL(blob) { const url = "blob:fixture-" + urls.length; urls.push({url, blob}); return url; }, revokeObjectURL: url => revoked.push(url)},
  };
  vm.runInNewContext(source, {window});
  vm.runInNewContext(schedulerSource, {window});
  const scheduler = window.FlitFancyRefresh.create({now: () => now});
  scheduler.reconcile({authenticated: signedIn});
  const module = window.FlitFancyConsoleActivity.create({query: () => root, scheduler, isAdmin: () => signedIn, isServerOnline: () => online, now: () => now,
    request: url => { requests.push(url); return responder(url); }, fetchRaw: url => { exports.push(url); return exporter(url); }});
  module.start();
  scheduler.start();
  return {module, scheduler, get, root, requests, exports, downloads, urls, revoked, intervals, timeouts,
    login() { signedIn = true; scheduler.reconcile({authenticated: true}); }, logout() { signedIn = false; module.clearPrivate(); scheduler.reconcile({authenticated: false}); },
    setHost(value) { online = value; scheduler.reconcile(); }, advance(ms) { now += ms; },
    async tick(ms) { now += ms; for (const [id, timer] of [...timeouts]) if (timer.at <= now) { timeouts.delete(id); timer.fn(); } await flush(); },
    respond(fn) { responder = fn; }, exportRespond(fn) { exporter = fn; }};
}

// No private requests or visible private card on the public origin, even with a stray token.
const publicPage = fixture({admin: true, adminHost: false});
await publicPage.module.refresh();
assert.equal(publicPage.requests.length, 0); assert.equal(publicPage.root.hidden, true); assert.equal(publicPage.intervals.size, 0);
const page = fixture(); await page.module.refresh();
assert.equal(page.requests.length, 0); assert.equal(page.root.hidden, true);
page.login(); await page.module.refresh();
assert.equal(page.root.hidden, false);
assert.equal(page.get("end").value, "2026-09-26", "date must use Asia/Shanghai, not the UTC day");
assert.equal(page.requests[0], "/api/activity/summary?days=7&end=2026-09-26");
assert.equal(page.get("today").textContent, "1 小时 0 分钟");
assert.match(page.get("range-detail").textContent, /3 \/ 7 天有记录/);
assert.equal(page.get("details").open, false, "app details start collapsed");
assert.match(page.get("collected").textContent, /24 秒/);
assert.equal(page.get("apps").children.length, 2);
assert.equal(page.intervals.size, 0, "activity must not create its own polling timer");
assert.equal(page.scheduler.snapshot()[0].intervalMs, 10000);

// Missing days, days not yet archived, zero-active days and partial days remain distinct.
const days = page.get("trend").children;
assert.match(days[0].attributes["aria-label"], /尚未归档/);
assert.match(days[1].attributes["aria-label"], /无记录/);
assert.match(days[2].attributes["aria-label"], /0 分钟/);
assert.match(days[3].attributes["aria-label"], /部分记录/);
await days[0].click(); assert.match(page.get("apps-note").textContent, /尚未归档.*不能视为/);
await days[1].click(); assert.match(page.get("apps-note").textContent, /没有采集记录/);
await days[3].click(); assert.equal(page.get("apps").children.length, 1);
assert.equal(page.get("details").open, true, "selecting a date opens its details");
assert.match(page.get("apps-date").textContent, /2026-09-25/);
assert.match(page.get("apps").textContent, /Editor.*100%/);
await page.get("all-days").click(); assert.equal(page.get("apps").children.length, 2);

// One shared clock schedules polling, and a pending request cannot overlap.
await page.tick(5000); assert.equal(page.requests.length, 1);
await page.tick(5000); assert.equal(page.requests.length, 2);
assert.equal(page.get("details").open, true, "polling preserves the open details");
const slow = deferred(); page.respond(() => slow.promise); await page.tick(10000);
const loading = page.module.refresh(); await page.tick(20000); const alsoLoading = page.module.refresh();
assert.equal(page.requests.length, 3, "overlapping polls must be deduplicated"); slow.resolve(summary()); await Promise.all([loading, alsoLoading]);

// Later selections win when an earlier range response arrives late.
const range30 = deferred(), range90 = deferred();
page.respond(url => url.includes("days=30") ? range30.promise : range90.promise);
page.get("days").value = "30"; const request30 = page.get("days").fire("change");
await flush();
page.get("days").value = "90"; const request90 = page.get("days").fire("change");
assert.equal(page.requests.at(-1).includes("days=30"), true, "new range must wait for the running request");
range30.resolve(summary()); await request30; await flush();
assert.doesNotMatch(page.get("range-detail").textContent, /4 \/ 90/);
range90.resolve(summary({range: {start: "2026-06-29", end: "2026-09-26", days: 90, active_seconds: 7200, recorded_days: 4}}));
await request90; assert.match(page.get("range-detail").textContent, /4 \/ 90/);

// Background pages pause this job; returning to the page refreshes promptly.
const beforeHidden = page.requests.length;
page.scheduler.reconcile({hidden: true}); await page.tick(30000);
assert.equal(page.requests.length, beforeHidden); assert.equal(page.scheduler.snapshot()[0].state, "paused");
page.scheduler.reconcile({hidden: false}); await flush();
assert.equal(page.requests.length, beforeHidden + 1);

// The archive remains readable if AW stops or a fetch fails, with explicit stale status.
page.respond(async () => summary({source: {...summary().source, available: false, status: "offline", stale: true}}));
page.advance(10000); await page.module.refresh();
assert.match(page.get("source").textContent, /暂不可用/); assert.equal(page.get("today").textContent, "1 小时 0 分钟");
page.respond(async () => { throw new Error("network"); }); page.advance(10000); await page.module.refresh();
assert.match(page.get("message").textContent, /上次取得的归档/); assert.match(page.get("source").textContent, /暂时中断/);
assert.equal(page.scheduler.snapshot()[0].failures, 1, "heartbeat and backoff must see a swallowed UI error");

// App labels are text nodes; zero active time with observations is a valid recording.
page.respond(async () => summary({today: {date: "2026-09-26", status: "recorded", active_seconds: 0}, apps: [{app: "Short visit", seconds: 179.999}, {app: "<img src=x onerror=alert(1)>", seconds: 180}]}));
page.advance(10000); await page.module.refresh();
assert.equal(page.get("today").textContent, "0 分钟");
assert.equal(page.get("apps").children.length, 1, "hide apps below three minutes while keeping exactly three minutes");
assert.match(page.get("apps").children[0].textContent, /50%/, "display filtering does not inflate the share of all active time");
assert.match(page.get("apps").children[0].children[0].children[0].textContent, /^<img/);
assert.equal(page.get("apps").children[0].children[0].children[0].children.length, 0);

// Export uses the shared authenticated transport, a token-free URL and revoked object URLs.
await page.get("export").click();
assert.equal(page.exports[0], "/api/activity/export?days=90&end=2026-09-26");
assert.equal(page.downloads.length, 1); assert.match(page.downloads[0].download, /90days\.json$/);
page.logout(); assert.deepEqual(page.revoked, ["blob:fixture-0"]);
assert.equal(page.root.hidden, true); assert.equal(page.get("today").textContent, "");
assert.equal(page.get("apps").children.length, 0); assert.equal(page.get("trend").children.length, 0); assert.equal(page.intervals.size, 0);
assert.equal(page.get("details").open, false);

// Logout invalidates pending summaries and pending export blobs before creating a download.
const late = deferred(); page.respond(() => late.promise); page.login(); const pendingSummary = page.module.refresh();
page.logout(); late.resolve(summary()); await pendingSummary;
assert.equal(page.root.hidden, true); assert.equal(page.get("today").textContent, "");
page.respond(async () => summary()); page.login(); await page.module.refresh();
const lateBlob = deferred(); page.exportRespond(async () => ({ok: true, blob: () => lateBlob.promise}));
const pendingExport = page.get("export").click(); await flush(); page.logout(); lateBlob.resolve(new Blob(["private aggregate"])); await pendingExport;
assert.equal(page.downloads.length, 1); assert.equal(page.urls.length, 1);

// An older backend explains the restart requirement without leaking response details.
page.respond(async () => { const error = new Error("private details"); error.status = 404; throw error; });
page.login(); await page.module.refresh(); assert.match(page.get("message").textContent, /重启后端/);
assert.doesNotMatch(page.get("message").textContent, /private details/);
page.module.dispose(); assert.equal(page.root.hidden, true); assert.equal(page.intervals.size, 0);
assert.equal(page.get("days").listeners.get("change").length, 0);
const html = fs.readFileSync(new URL("../docs/presence.html", import.meta.url), "utf8");
assert.match(html, /<details class="activity-details" data-activity="details">\s*<summary>明细/);
assert.doesNotMatch(html + source, /每日活跃时长 · 最高|长期保存在本机|活跃前台时长不等于|所选范围 · 应用分布/);
assert.match(html, /data-role="activity-panel"[^>]*hidden/);
assert(html.indexOf('data-role="activity-panel"') > html.indexOf('class="sensor-board"'));
assert(html.indexOf('data-role="activity-panel"') > html.indexOf('data-role="audio-panel"'));
console.log("activity UI: private access, timezone, gaps, history, freshness, races, export and logout passed");
