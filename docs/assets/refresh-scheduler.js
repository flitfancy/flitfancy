/* 页面读取统一调度；采集、归档和传输任务不属于此调度器。 */
(function (global) {
  "use strict";
  function create(options) {
    const opts = options || {};
    const now = opts.now || Date.now;
    const setTimer = opts.setTimeout || global.setTimeout.bind(global);
    const clearTimer = opts.clearTimeout || global.clearTimeout.bind(global);
    const limit = Math.max(1, Math.floor(Number(opts.concurrency) || 3));
    const tasks = new Map(), listeners = new Set();
    const context = { authenticated: false, hidden: false, online: true };
    let started = false, disposed = false, timer = null, active = 0, order = 0, pumping = false;
    let emitting = false, emitAgain = false;
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const text = value => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100) : null;
    const skipped = reason => ({ skipped: true, reason: reason || "暂未刷新" });
    function interval(task) {
      let value;
      try { value = typeof task.spec.interval === "function" ? task.spec.interval() : task.spec.interval; } catch (_) { value = 5000; }
      const normal = Number.isFinite(Number(value)) ? Math.max(50, Number(value)) : 5000;
      const hidden = Number(task.spec.hiddenInterval);
      return context.hidden && task.spec.hidden === "slow" ? Math.max(normal, Number.isFinite(hidden) && hidden > 0 ? hidden : 30000) : normal;
    }
    function gate(task) {
      if (task.spec.requiresAuth && !context.authenticated) return { state: "disabled", reason: "登录后刷新" };
      let enabled = true;
      try { enabled = !task.spec.enabled || task.spec.enabled(); } catch (_) { enabled = false; }
      if (!enabled) {
        let reason;
        try { reason = task.spec.disabledReason && task.spec.disabledReason(); } catch (_) { /* A broken label must not block scheduling. */ }
        return { state: "disabled", reason: text(reason) || "当前无需刷新" };
      }
      if (!context.online) return { state: "paused", reason: "网络离线" };
      if (context.hidden && task.spec.hidden !== "slow") return { state: "paused", reason: "页面在后台" };
      if (task.authBlocked) return { state: "auth", reason: "需要重新登录" };
      return null;
    }
    function snapshot() {
      return Array.from(tasks.values(), task => ({
        id: task.id, label: task.label, page: task.page,
        state: task.gate ? task.gate.state : task.running ? "running" : task.phase,
        reason: task.gate ? task.gate.reason : task.reason,
        intervalMs: interval(task), nextAt: task.gate || task.running ? null : task.nextAt,
        lastStartedAt: task.lastStartedAt, lastFinishedAt: task.lastFinishedAt,
        lastSuccessAt: task.lastSuccessAt, durationMs: task.durationMs,
        failures: task.failures, runs: task.runs,
      }));
    }
    function emit() {
      if (emitting) { emitAgain = true; return; }
      emitting = true;
      // A listener may reconcile state, but must not create recursive snapshots.
      do {
        emitAgain = false;
        const rows = snapshot();
        for (const listener of listeners) {
          try { listener(rows); } catch (_) { /* Diagnostics cannot stop polling. */ }
        }
      } while (emitAgain);
      emitting = false;
    }
    function cancelQueued(task, reason) {
      if (!task.queued) return;
      task.queued.resolve(skipped(reason));
      task.queued = null;
    }
    function sync(task, force) {
      const previous = task.gate;
      task.gate = gate(task);
      if (task.gate) {
        if (!previous) task.generation++;
        cancelQueued(task, task.gate.reason);
      } else if (previous || force) {
        task.nextAt = now();
        task.schedule = "due";
      } else if (task.schedule === "interval") {
        task.nextAt = task.anchorAt + interval(task);
      }
    }
    function stopTimer() {
      if (timer !== null) { clearTimer(timer); timer = null; }
    }
    function scheduleTimer() {
      stopTimer();
      if (disposed || active >= limit) return;
      let earliest = Infinity;
      for (const task of tasks.values()) {
        if (task.gate || task.running || (!started && !task.queued)) continue;
        if (task.nextAt !== null) earliest = Math.min(earliest, task.nextAt);
      }
      if (earliest !== Infinity) timer = setTimer(() => { timer = null; pump(); }, Math.max(0, earliest - now()));
    }
    function outcome(value, failed) {
      if (!failed && value && value.skipped) return skipped(text(value.reason));
      if (failed || value && value.ok === false) {
        const status = Number(value && value.status);
        return Number.isInteger(status) && status >= 100 && status <= 599 ? { ok: false, status } : { ok: false };
      }
      return { ok: true };
    }
    function failureReason(status) {
      if (status === 401) return "需要重新登录";
      if (status === 429) return "请求过于频繁";
      if (status >= 500) return "服务暂不可用";
      return status ? "请求未完成" : "连接暂不可用";
    }
    function finish(task, running, result) {
      active--;
      task.running = null;
      const attached = !disposed && tasks.get(task.id) === task;
      if (attached) sync(task, false);
      if (attached && running.generation === task.generation && !task.gate) {
        const finished = now();
        task.anchorAt = finished;
        task.schedule = "interval";
        task.nextAt = finished + interval(task);
        if (result.skipped) {
          task.lastStartedAt = running.previousStartedAt;
          task.reason = text(result.reason);
          task.phase = running.previousPhase;
        } else {
          task.lastFinishedAt = finished;
          task.durationMs = Math.max(0, finished - running.startedAt);
          task.runs++;
          if (result.ok) {
            task.lastSuccessAt = finished;
            task.failures = 0;
            task.phase = "success";
            task.reason = null;
          } else {
            task.failures++;
            task.reason = failureReason(result.status);
            if (result.status === 401) {
              task.authBlocked = true;
              task.phase = "auth";
              task.nextAt = null;
              sync(task, false);
            } else {
              task.phase = "retrying";
              task.schedule = "backoff";
              task.nextAt = finished + Math.min(60000, Math.max(1000, interval(task)) * Math.pow(2, Math.min(16, task.failures - 1)));
            }
          }
        }
      }
      if (attached && task.queued && !task.gate) { task.nextAt = now(); task.schedule = "due"; }
      running.resolve(result);
      if (attached) emit();
      pump();
    }
    function launch(task) {
      const pending = task.queued || deferred();
      task.queued = null;
      const running = {
        promise: pending.promise, resolve: pending.resolve, generation: task.generation,
        startedAt: now(), previousStartedAt: task.lastStartedAt, previousPhase: task.phase,
      };
      task.running = running;
      task.lastStartedAt = running.startedAt;
      task.nextAt = null;
      task.reason = null;
      active++;
      Promise.resolve().then(() => {
        if (disposed || tasks.get(task.id) !== task || running.generation !== task.generation || gate(task)) return skipped("刷新已暂停");
        return task.spec.run();
      }).then(value => finish(task, running, outcome(value, false)), error => finish(task, running, outcome(error, true)));
    }
    function pump() {
      if (disposed || pumping) return;
      pumping = true;
      stopTimer();
      for (const task of tasks.values()) sync(task, false);
      const due = Array.from(tasks.values()).filter(task => !task.gate && !task.running && (started || task.queued) && task.nextAt !== null && task.nextAt <= now());
      due.sort((a, b) => a.nextAt - b.nextAt || b.priority - a.priority || a.order - b.order);
      let launched = false;
      for (const task of due) {
        if (active >= limit) break;
        sync(task, false);
        if (!task.gate) { launch(task); launched = true; }
      }
      pumping = false;
      scheduleTimer();
      if (launched) emit();
    }
    function register(spec) {
      if (disposed) throw new Error("Refresh scheduler is disposed");
      if (!spec || typeof spec.id !== "string" || !spec.id || spec.id.length > 100 || typeof spec.run !== "function") throw new Error("Invalid refresh task");
      if (tasks.has(spec.id)) throw new Error("Duplicate refresh task");
      const task = {
        spec, id: spec.id, label: text(spec.label) || spec.id, page: text(spec.page) || "",
        priority: Number(spec.priority) || 0, order: order++, generation: 0,
        phase: "waiting", reason: null, gate: null, authBlocked: false,
        running: null, queued: null, schedule: "due", anchorAt: null, nextAt: now(),
        lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null,
        durationMs: null, failures: 0, runs: 0,
      };
      tasks.set(task.id, task);
      sync(task, false);
      emit();
      pump();
      const handle = {
        refresh(settings) {
          if (disposed || tasks.get(task.id) !== task) return Promise.resolve(skipped("刷新已停止"));
          task.authBlocked = false;
          sync(task, false);
          if (task.gate) return Promise.resolve(skipped(task.gate.reason));
          if (task.running && !(settings && settings.rerun)) return task.running.promise;
          if (!task.queued) task.queued = deferred();
          const promise = task.queued.promise;
          task.nextAt = now();
          task.schedule = "due";
          pump();
          return promise;
        },
        unregister() {
          if (tasks.get(task.id) !== task) return;
          task.generation++;
          cancelQueued(task, "刷新已停止");
          tasks.delete(task.id);
          emit();
          pump();
        },
      };
      task.handle = handle;
      return handle;
    }
    function reconcile(changes) {
      if (disposed) return;
      const update = changes || {};
      const authChanged = typeof update.authenticated === "boolean" && update.authenticated !== context.authenticated;
      const recovering = update.online === true && !context.online || update.hidden === false && context.hidden || authChanged;
      let changed = Boolean(update.runNow);
      for (const key of ["authenticated", "hidden", "online"]) {
        if (typeof update[key] === "boolean" && update[key] !== context[key]) { context[key] = update[key]; changed = true; }
      }
      for (const task of tasks.values()) {
        const beforeGate = task.gate, beforeNext = task.nextAt;
        if (authChanged) { task.generation++; task.authBlocked = false; }
        sync(task, Boolean(recovering || update.runNow));
        if (Boolean(beforeGate) !== Boolean(task.gate) || beforeGate && task.gate && (beforeGate.state !== task.gate.state || beforeGate.reason !== task.gate.reason) || beforeNext !== task.nextAt) changed = true;
      }
      pump();
      if (changed) emit();
    }
    const api = {
      register, reconcile, snapshot,
      refresh(id, settings) {
        const task = tasks.get(id);
        return task && task.handle ? task.handle.refresh(settings) : Promise.resolve(skipped("刷新任务不存在"));
      },
      start() { if (!disposed && !started) { started = true; pump(); } },
      refreshAll() {
        if (disposed) return Promise.resolve([]);
        const jobs = [];
        for (const task of tasks.values()) {
          task.authBlocked = false;
          sync(task, false);
          if (task.gate) { jobs.push(Promise.resolve(skipped(task.gate.reason))); continue; }
          if (task.running) { jobs.push(task.running.promise); continue; }
          if (!task.queued) task.queued = deferred();
          jobs.push(task.queued.promise);
          task.nextAt = now();
          task.schedule = "due";
        }
        pump();
        return Promise.all(jobs);
      },
      subscribe(listener) {
        if (typeof listener !== "function" || disposed) return function () {};
        listeners.add(listener);
        try { listener(snapshot()); } catch (_) { /* A diagnostic subscriber is optional. */ }
        return () => listeners.delete(listener);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        stopTimer();
        for (const task of tasks.values()) {
          task.generation++;
          task.gate = { state: "disabled", reason: "刷新已停止" };
          cancelQueued(task, "刷新已停止");
        }
        emit();
        listeners.clear();
      },
    };
    if (typeof opts.onChange === "function") api.subscribe(opts.onChange);
    return api;
  }
  global.FlitFancyRefresh = { create };
})(window);
