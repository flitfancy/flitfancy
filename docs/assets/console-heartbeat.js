/* 后端统一记录真实读取结果；本页仅展示记录，不触发其他业务读取。 */
(function (global) {
  "use strict";
  const CATALOG = {
    "site-status": "服务状态", "sensors-latest": "现实感知", "sensor-history": "感知历史",
    "audio-state": "音频状态", "audio-history": "音频历史", activity: "电脑使用",
    "bridge-status": "全界之桥", "launcher-status": "本机启动", memories: "本地日记读取",
  };
  const STATES = {idle: "按需读取 · 尚未请求", running: "正在读取", success: "上次读取成功", error: "上次读取失败"};
  const bounded = (value, max, fallback = null) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.floor(value) : fallback;
  function cleanSnapshot(data) {
    if (!data || data.schema !== 1 || !Array.isArray(data.rows)) return null;
    const generatedAt = bounded(data.generatedAt, 8640000000000000), startedAt = bounded(data.startedAt, generatedAt);
    if (!generatedAt || !startedAt || data.rows.length > 50) return null;
    const known = new Map();
    for (const row of data.rows) {
      if (!row || !Object.hasOwn(CATALOG, row.id) || known.has(row.id)) continue;
      known.set(row.id, {
        id: row.id, state: Object.hasOwn(STATES, row.state) ? row.state : "idle",
        lastStartedAt: bounded(row.lastStartedAt, generatedAt), lastFinishedAt: bounded(row.lastFinishedAt, generatedAt),
        lastSuccessAt: bounded(row.lastSuccessAt, generatedAt), durationMs: bounded(row.durationMs, 7 * 86400000),
        runs: bounded(row.runs, 1e12, 0), failures: bounded(row.failures, 1e12, 0), active: bounded(row.active, 1e6, 0),
        lastStatus: bounded(row.lastStatus, 599),
      });
    }
    return {startedAt, generatedAt, rows: Object.keys(CATALOG).map(id => known.get(id) || {id, state: "idle", lastSuccessAt: null, durationMs: null, runs: 0, failures: 0, active: 0, lastStatus: null})};
  }
  const duration = ms => ms < 1000 ? ms + " 毫秒" : ms < 60000 ? Math.round(ms / 100) / 10 + " 秒" : Math.round(ms / 6000) / 10 + " 分钟";
  function create(opts) {
    const panel = opts.query('[data-role="heartbeat-panel"]');
    const field = name => panel && panel.querySelector('[data-heartbeat="' + name + '"]');
    const document = panel && panel.ownerDocument, now = opts.now || Date.now;
    const views = new Map(), successes = new Map();
    let started = false, disposed = false, visible = false, epoch = 0, snapshot = null, receivedAt = 0;
    let loading = false, failure = null, job = null, unsubscribe = null, task = null, selectedId = null;
    const permitted = () => !disposed && opts.isAdmin() && opts.isServerOnline();
    const valid = revision => revision === epoch && permitted();
    function node(tag, className, text) {
      const item = document.createElement(tag);
      if (className) item.className = className;
      if (text !== undefined) item.textContent = text;
      return item;
    }
    function createRow(id) {
      const item = node("button", "heartbeat-row"), signal = node("span", "heartbeat-signal");
      signal.setAttribute("aria-hidden", "true");
      item.type = "button";
      item.setAttribute("aria-controls", "heartbeat-detail");
      item.addEventListener("click", () => {
        if (!permitted() || !visible || !snapshot) return;
        selectedId = id; render(); field("back").focus();
      });
      item.append(signal, node("span", "heartbeat-name", CATALOG[id]));
      field("rows").append(item);
      return {item, pulse: false};
    }
    function render() {
      if (!panel) return;
      panel.hidden = !started || !visible || !permitted();
      if (panel.hidden) return;
      let message = snapshot ? "记录已更新" : "等待读取后端记录";
      if (loading) message = "正在更新后端记录…";
      else if (failure === 404) message = "后端尚未提供刷新记录，请重启网页后端。";
      else if (failure === 401 || task && task.state === "auth") message = "登录已失效，请重新登录后更新记录。";
      else if (failure) message = snapshot ? "记录读取失败，显示的是上次记录，尚未更新。" : "读取后端记录失败，尚未获取记录。";
      if (task && ["paused", "disabled"].includes(task.state)) {
        message = task.reason === "页面在后台" ? "记录更新已暂停：页面在后台。" : task.reason === "网络离线" ? "网络离线，记录尚未更新。" : "记录更新已暂停。";
      }
      field("state").textContent = message;
      const stale = Boolean(failure || task && ["paused", "disabled", "auth"].includes(task.state));
      field("state").dataset.stale = String(stale);
      field("state").hidden = Boolean(snapshot && !stale);
      panel.dataset.stale = String(stale);
      field("refresh").setAttribute("aria-disabled", String(loading || Boolean(task && ["paused", "disabled"].includes(task.state))));
      field("summary").textContent = snapshot ? snapshot.rows.length + " 项读取 · " + snapshot.rows.reduce((sum, row) => sum + row.active, 0) + " 个请求进行中" : "";
      field("scope").textContent = "统一汇总到达本机后端的读取结果，无需同时打开存在页。";
      field("rows").hidden = selectedId !== null;
      field("detail").hidden = selectedId === null;
      if (!snapshot) return;
      const serverNow = snapshot.generatedAt + Math.max(0, now() - receivedAt);
      for (const row of snapshot.rows) {
        let view = views.get(row.id);
        if (!view) { view = createRow(row.id); views.set(row.id, view); }
        view.item.dataset.state = row.state;
        view.item.dataset.problem = String(row.state === "error" || row.failures > 0);
        const status = STATES[row.state] + (row.lastStatus >= 400 ? " · HTTP " + row.lastStatus : "");
        const finished = row.lastFinishedAt ? duration(Math.max(0, serverNow - row.lastFinishedAt)) + "前" : "尚未完成";
        const success = row.lastSuccessAt ? duration(Math.max(0, serverNow - row.lastSuccessAt)) + "前" : "尚无成功记录";
        const elapsed = row.durationMs === null ? "—" : duration(row.durationMs);
        view.item.setAttribute("aria-label", CATALOG[row.id] + "，" + status + "，查看详情");
        view.item.setAttribute("aria-description", [status, "最近完成：" + finished, "最近成功：" + success,
          "耗时 " + elapsed, "进行中 " + row.active, "已完成 " + row.runs + " 次", "连续失败 " + row.failures].join(" · "));
        view.item.setAttribute("aria-expanded", String(selectedId === row.id));
        if (selectedId === row.id) {
          field("detail").dataset.problem = view.item.dataset.problem;
          for (const [name, value] of Object.entries({name: CATALOG[row.id], status, finished, success,
            duration: elapsed, active: String(row.active), runs: row.runs + " 次", failures: String(row.failures)})) field("detail-" + name).textContent = value;
          field("detail-note").textContent = row.id === "sensor-history" ? "在存在页点开感知卡片后读取历史；尚未请求不代表故障。"
            : row.id === "audio-history" ? "在存在页展开音频历史后读取；尚未请求不代表故障。"
            : "这里记录后端读取结果，成功不代表设备在线或采集正常。";
        }
      }
    }
    async function poll() {
      if (!started || !permitted()) return {skipped: true, reason: "auth"};
      const revision = epoch; loading = true; visible = true; render();
      try {
        const data = await opts.request("/api/refresh/status");
        if (!valid(revision)) return {skipped: true};
        const next = cleanSnapshot(data);
        if (!next) throw new Error("Invalid refresh metadata");
        const restarted = !snapshot || snapshot.startedAt !== next.startedAt;
        if (restarted) successes.clear();
        snapshot = next; receivedAt = now(); failure = null;
        render();
        for (const row of next.rows) {
          const previous = successes.get(row.id), view = views.get(row.id);
          const completed = previous && row.lastSuccessAt && (row.lastSuccessAt > previous.time || row.state === "success" && row.lastSuccessAt === previous.time && row.runs > previous.runs);
          if (completed) view.pulse = !view.pulse;
          if (completed || restarted) view.item.className = "heartbeat-row" + (completed ? view.pulse ? " heartbeat-completed" : " heartbeat-completed-again" : "");
          successes.set(row.id, {time: row.lastSuccessAt || 0, runs: row.runs});
        }
        return {ok: true};
      } catch (error) {
        if (!valid(revision)) return {skipped: true};
        const status = bounded(error && error.status, 599);
        // A 401 revokes the display even if the caller has not cleared its token yet.
        if (status === 401) { clearPrivate(); visible = true; failure = 401; render(); }
        else failure = status || "request";
        return {ok: false, ...(status ? {status} : {})};
      } finally {
        if (valid(revision)) { loading = false; render(); }
      }
    }
    function clearPrivate() {
      epoch++; visible = false; snapshot = null; task = null; loading = false; failure = null; selectedId = null;
      successes.clear(); views.clear();
      if (panel) {
        panel.hidden = true; field("rows").replaceChildren(); field("rows").hidden = false; field("detail").hidden = true;
        for (const name of ["summary", "scope", "state", "detail-name", "detail-status", "detail-finished", "detail-success", "detail-duration", "detail-active", "detail-runs", "detail-failures", "detail-note"]) field(name).textContent = "";
      }
    }
    function refresh() {
      if (!started || !permitted()) { clearPrivate(); return; }
      visible = true; render();
    }
    function start() {
      if (started || disposed || !panel) return;
      started = true;
      job = opts.scheduler.register({id: "refresh-heartbeats", label: "刷新记录", page: "console", interval: 5000, requiresAuth: true, hidden: "pause", enabled: permitted, run: poll});
      unsubscribe = opts.scheduler.subscribe(rows => { task = rows.find(row => row.id === "refresh-heartbeats") || null; if (!permitted()) clearPrivate(); else render(); });
      field("rows").setAttribute("role", "group"); field("rows").setAttribute("aria-label", "后端读取心跳，点击查看详情");
      function back() {
        const previous = selectedId; selectedId = null; render();
        if (previous && permitted()) views.get(previous)?.item.focus();
      }
      field("back").addEventListener("click", back);
      field("detail").addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); back(); } });
      field("refresh").addEventListener("click", () => {
        if (!permitted() || !visible || loading || task && ["paused", "disabled"].includes(task.state)) return;
        job.refresh();
      });
      refresh();
    }
    function dispose() {
      if (disposed) return;
      clearPrivate(); disposed = true;
      if (unsubscribe) unsubscribe();
      if (job) job.unregister();
    }
    return {start, refresh, clearPrivate, dispose};
  }
  global.FlitFancyHeartbeats = {create};
})(window);
