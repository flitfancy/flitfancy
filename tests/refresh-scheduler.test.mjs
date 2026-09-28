import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/refresh-scheduler.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  let time = 1000, serial = 0, peakTimers = 0;
  const timers = new Map();
  const setTimeout = (callback, delay) => {
    const id = ++serial;
    timers.set(id, { callback, at: time + delay });
    peakTimers = Math.max(peakTimers, timers.size);
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  const window = { setTimeout, clearTimeout };
  vm.runInNewContext(source, { window });
  const scheduler = window.FlitFancyRefresh.create({ now: () => time, setTimeout, clearTimeout, ...options });
  return {
    scheduler, timers, now: () => time, peakTimers: () => peakTimers,
    async advance(ms) {
      const target = time + ms;
      let count = 0;
      while (true) {
        await flush();
        const item = Array.from(timers.entries()).filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) break;
        assert.ok(count++ < 1000, "scheduler must not spin or accumulate immediate timers");
        time = item[1].at;
        timers.delete(item[0]);
        item[1].callback();
      }
      time = target;
      await flush();
    },
    row(id) { return scheduler.snapshot().find(item => item.id === id); },
  };
}

// Different cadences share one timer, and completion determines the next due time.
{
  const f = fixture(), calls = [];
  f.scheduler.register({ id: "quick", interval: 100, run: () => { calls.push(["quick", f.now()]); } });
  f.scheduler.register({ id: "slow", interval: 250, run: () => { calls.push(["slow", f.now()]); } });
  f.scheduler.reconcile({ authenticated: true });
  await f.advance(1000);
  assert.equal(calls.length, 0, "registration and reconciliation are lazy until start");
  f.scheduler.start();
  await flush();
  await f.advance(500);
  assert.equal(calls.filter(item => item[0] === "quick").length, 6);
  assert.equal(calls.filter(item => item[0] === "slow").length, 3);
  assert.equal(f.peakTimers(), 1);
  assert.equal(f.row("quick").state, "success");
  assert.equal(f.row("quick").lastSuccessAt, 2500);
  f.scheduler.dispose();
  assert.equal(f.timers.size, 0);
}

// Auth, predicates and missing tasks never send requests. Auth restoration runs promptly.
{
  const f = fixture();
  let calls = 0, enabled = true;
  const handle = f.scheduler.register({ id: "private", label: "电脑使用", page: "存在", interval: 1000, requiresAuth: true,
    enabled: () => enabled, disabledReason: () => "服务尚未连接", run: () => { calls++; } });
  f.scheduler.start();
  await f.advance(10000);
  assert.equal(calls, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.row("private").state, "disabled");
  assert.equal((await handle.refresh()).skipped, true);
  assert.equal((await f.scheduler.refresh("missing")).skipped, true);
  f.scheduler.reconcile({ authenticated: true });
  await flush();
  assert.equal(calls, 1);
  enabled = false;
  f.scheduler.reconcile();
  assert.equal(f.row("private").reason, "服务尚未连接");
  await f.advance(5000);
  assert.equal(calls, 1);
  enabled = true;
  f.scheduler.reconcile();
  await flush();
  assert.equal(calls, 2);
  f.scheduler.dispose();
}

// Background pauses ordinary jobs and slows explicit status probes; offline pauses both.
{
  const f = fixture(), calls = { foreground: 0, status: 0 };
  f.scheduler.register({ id: "foreground", interval: 100, run: () => { calls.foreground++; } });
  f.scheduler.register({ id: "status", interval: 100, hidden: "slow", hiddenInterval: 500, run: () => { calls.status++; } });
  f.scheduler.start();
  await flush();
  f.scheduler.reconcile({ hidden: true });
  assert.equal(f.row("foreground").state, "paused");
  assert.equal(f.row("status").intervalMs, 500);
  await f.advance(1000);
  assert.equal(calls.foreground, 1);
  assert.equal(calls.status, 3);
  assert.equal((await f.scheduler.refresh("foreground")).skipped, true);
  f.scheduler.reconcile({ online: false });
  assert.equal(f.timers.size, 0);
  await f.advance(10000);
  assert.equal(calls.status, 3);
  f.scheduler.reconcile({ hidden: false, online: true });
  await flush();
  assert.equal(calls.foreground, 2);
  assert.equal(calls.status, 4);
  f.scheduler.dispose();
}

// Dynamic intervals change pending deadlines without a separate component timer.
{
  const f = fixture();
  let cadence = 1000, calls = 0;
  f.scheduler.register({ id: "dynamic", interval: () => cadence, run: () => { calls++; } });
  f.scheduler.start();
  await flush();
  await f.advance(200);
  cadence = 3000;
  f.scheduler.reconcile();
  await f.advance(2800);
  assert.equal(calls, 2);
  cadence = 100;
  f.scheduler.reconcile();
  await f.advance(100);
  assert.equal(calls, 3);
  f.scheduler.dispose();
}

// Capacity is bounded, due tasks remain fair, and a slow request cannot overlap itself.
{
  const f = fixture({ concurrency: 2 }), waits = new Map(), calls = [];
  let active = 0, peak = 0;
  for (const [id, priority] of [["a", 1], ["b", 3], ["c", 2], ["d", 0]]) {
    f.scheduler.register({ id, priority, interval: 100, run: async () => {
      active++; peak = Math.max(peak, active); calls.push(id);
      const wait = pending(); waits.set(id, wait); await wait.promise; active--;
    } });
  }
  f.scheduler.start();
  await flush();
  assert.deepEqual(calls, ["b", "c"]);
  await f.advance(10000);
  assert.deepEqual(calls, ["b", "c"]);
  assert.equal(f.timers.size, 0, "capacity blockage waits for completion rather than timer-spinning");
  waits.get("b").resolve();
  await flush();
  assert.deepEqual(calls, ["b", "c", "a"]);
  waits.get("c").resolve();
  await flush();
  assert.deepEqual(calls, ["b", "c", "a", "d"]);
  assert.equal(peak, 2);
  f.scheduler.dispose();
  for (const wait of waits.values()) wait.resolve();
  await flush();
  assert.equal(f.timers.size, 0);
}

// Manual requests dedupe; arbitrarily many rerun requests coalesce into exactly one follow-up.
{
  const f = fixture(), waits = [];
  const handle = f.scheduler.register({ id: "manual", interval: 5000, run: () => {
    const wait = pending(); waits.push(wait); return wait.promise;
  } });
  const first = handle.refresh();
  assert.equal(handle.refresh(), first);
  assert.equal(f.scheduler.refresh("manual"), first);
  const followup = handle.refresh({ rerun: true });
  assert.notEqual(followup, first);
  assert.equal(handle.refresh({ rerun: true }), followup);
  assert.equal(handle.refresh(), first);
  await flush();
  assert.equal(waits.length, 1);
  waits[0].resolve();
  await first;
  await flush();
  assert.equal(waits.length, 2);
  waits[1].resolve();
  assert.equal((await followup).ok, true);
  assert.equal(f.row("manual").runs, 2);
  assert.equal(f.timers.size, 0, "explicit refresh before start does not enable automatic polling");
  f.scheduler.dispose();
}

// A queued rerun reads current parameters when it actually runs, and shares total capacity.
{
  const f = fixture({ concurrency: 1 }), initial = pending(), seen = [];
  let selected = "old", calls = 0;
  const handle = f.scheduler.register({ id: "selection", interval: 1000, run: async () => {
    seen.push(selected); if (++calls === 1) await initial.promise;
  } });
  const first = handle.refresh();
  await flush();
  selected = "new";
  const second = handle.refresh({ rerun: true });
  selected = "latest";
  assert.equal(handle.refresh({ rerun: true }), second);
  initial.resolve();
  await first; await second;
  assert.deepEqual(seen, ["old", "latest"]);
  f.scheduler.dispose();
}

// Failure backoff is bounded, successful recovery resets it, and errors never leak details.
{
  const f = fixture();
  let failing = false;
  f.scheduler.register({ id: "failing", interval: 1000, run: () => {
    if (failing) { const error = new Error("password=secret https://private.invalid/user/file"); error.status = 503; throw error; }
  } });
  f.scheduler.start();
  await flush();
  const good = f.row("failing").lastSuccessAt;
  failing = true;
  await f.advance(1000);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    assert.equal(f.row("failing").nextAt - f.now(), delay);
    assert.equal(f.row("failing").lastSuccessAt, good);
    await f.advance(delay);
  }
  assert.equal(f.row("failing").state, "retrying");
  assert.equal(f.row("failing").reason, "服务暂不可用");
  assert.doesNotMatch(JSON.stringify(f.scheduler.snapshot()), /password|secret|private\.invalid/);
  failing = false;
  await f.scheduler.refresh("failing");
  assert.equal(f.row("failing").failures, 0);
  assert.equal(f.row("failing").nextAt - f.now(), 1000);
  f.scheduler.dispose();
}

// An anonymous status probe receiving 401 stops retries until auth changes or manual action.
{
  const f = fixture();
  let calls = 0;
  f.scheduler.register({ id: "probe", interval: 100, run: () => { calls++; return { ok: false, status: 401 }; } });
  f.scheduler.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.row("probe").state, "auth");
  assert.equal(f.row("probe").nextAt, null);
  assert.equal(f.timers.size, 0);
  await f.advance(100000);
  f.scheduler.reconcile({ authenticated: false, hidden: true });
  f.scheduler.reconcile({ hidden: false, online: true, runNow: true });
  await flush();
  assert.equal(calls, 1);
  await f.scheduler.refresh("probe");
  assert.equal(calls, 2);
  f.scheduler.reconcile({ authenticated: true });
  await flush();
  assert.equal(calls, 3);
  f.scheduler.dispose();
}

// Skipped reads preserve the last real attempt, including an outstanding failure.
{
  const f = fixture();
  let response;
  const handle = f.scheduler.register({ id: "skip", interval: 1000, run: () => response });
  await handle.refresh();
  const success = f.row("skip");
  await f.advance(50);
  response = { skipped: true, reason: "正在处理其他操作" };
  await handle.refresh();
  assert.equal(f.row("skip").lastStartedAt, success.lastStartedAt);
  assert.equal(f.row("skip").lastSuccessAt, success.lastSuccessAt);
  assert.equal(f.row("skip").lastFinishedAt, success.lastFinishedAt);
  assert.equal(f.row("skip").runs, 1);
  response = { ok: false, status: 503 };
  await handle.refresh();
  const failure = f.row("skip");
  response = { skipped: true };
  await handle.refresh();
  assert.equal(f.row("skip").state, "retrying");
  assert.equal(f.row("skip").failures, 1);
  assert.equal(f.row("skip").runs, 2);
  assert.equal(f.row("skip").lastStartedAt, failure.lastStartedAt);
  assert.equal(f.row("skip").lastFinishedAt, failure.lastFinishedAt);
  f.scheduler.dispose();
}

// Logout invalidates late completions, including after an immediate login; no duplicate request.
{
  const f = fixture(), waits = [];
  const handle = f.scheduler.register({ id: "private", interval: 1000, requiresAuth: true, run: () => {
    const wait = pending(); waits.push(wait); return wait.promise;
  } });
  f.scheduler.reconcile({ authenticated: true });
  f.scheduler.start();
  await flush();
  const old = handle.refresh();
  const queued = handle.refresh({ rerun: true });
  f.scheduler.reconcile({ authenticated: false });
  assert.equal(f.row("private").state, "disabled");
  assert.equal((await queued).skipped, true);
  f.scheduler.reconcile({ authenticated: true });
  await flush();
  assert.equal(waits.length, 1);
  waits[0].resolve({ ok: false, status: 401 });
  await old; await flush();
  assert.equal(waits.length, 2);
  assert.equal(f.row("private").lastSuccessAt, null);
  assert.equal(f.row("private").failures, 0);
  assert.equal(f.row("private").runs, 0);
  waits[1].resolve();
  await flush();
  assert.equal(f.row("private").state, "success");
  assert.equal(f.row("private").runs, 1);
  f.scheduler.dispose();
}

// Going hidden invalidates a pending foreground result; skips do not invent successful heartbeats.
{
  const f = fixture(), wait = pending();
  let calls = 0;
  const handle = f.scheduler.register({ id: "hidden", interval: 1000, run: () => ++calls === 1 ? wait.promise : { skipped: true, reason: "没有新的读取" } });
  f.scheduler.start();
  await flush();
  f.scheduler.reconcile({ hidden: true });
  wait.resolve();
  await flush();
  assert.equal(f.row("hidden").state, "paused");
  assert.equal(f.row("hidden").runs, 0);
  assert.equal(f.row("hidden").lastSuccessAt, null);
  f.scheduler.reconcile({ hidden: false });
  await flush();
  assert.equal(f.row("hidden").lastFinishedAt, null);
  assert.equal(f.row("hidden").runs, 0);
  assert.equal((await handle.refresh()).skipped, true);
  f.scheduler.dispose();
}

// Unregister/dispose settle queued work, remove timers and ignore late results safely.
{
  for (const action of ["unregister", "dispose"]) {
    const f = fixture(), wait = pending();
    const handle = f.scheduler.register({ id: "cleanup", interval: 1000, run: () => wait.promise });
    let notifications = 0;
    const unsubscribe = f.scheduler.subscribe(() => { notifications++; });
    const current = handle.refresh();
    const queued = handle.refresh({ rerun: true });
    await flush();
    if (action === "unregister") handle.unregister(); else f.scheduler.dispose();
    assert.equal((await queued).skipped, true);
    assert.equal((await handle.refresh()).skipped, true);
    assert.equal(f.timers.size, 0);
    const lastNotifications = notifications;
    wait.resolve();
    await current; await flush();
    assert.equal(notifications, lastNotifications);
    assert.equal(f.timers.size, 0);
    unsubscribe(); f.scheduler.dispose();
  }
}

// Diagnostics remain isolated from request results and subscriber exceptions.
{
  const f = fixture({ onChange: () => { throw new Error("diagnostic consumer failed"); } });
  let snapshots = 0;
  const unsubscribe = f.scheduler.subscribe(() => { snapshots++; f.scheduler.reconcile(); });
  f.scheduler.register({ id: "clean", interval: 1000, run: () => ({ ok: true, payload: { token: "do-not-store" } }) });
  const result = await f.scheduler.refresh("clean");
  assert.equal(result.ok, true);
  assert.ok(snapshots >= 3);
  assert.doesNotMatch(JSON.stringify(f.scheduler.snapshot()), /payload|token|do-not-store/);
  unsubscribe(); f.scheduler.dispose();
}

console.log("refresh scheduler: cadence, gates, concurrency, retry, manual coalescing, stale results and cleanup passed");
