/* 电脑使用统计：仅在管理会话内读取本机汇总，不保存浏览器缓存。 */
(function (global) {
  "use strict";
  const POLL_MS = 10000;
  const MIN_APP_SECONDS = 180;
  const hasRecord = day => day && ["recorded", "partial"].includes(day.status);
  const duration = seconds => {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
    const minutes = Math.floor(Math.max(0, Number(seconds)) / 60);
    if (!minutes && Number(seconds) > 0) return "不足 1 分钟";
    return minutes >= 60 ? Math.floor(minutes / 60) + " 小时 " + minutes % 60 + " 分钟" : minutes + " 分钟";
  };
  function dateAt(timestamp, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(new Date(timestamp));
    const pick = name => parts.find(part => part.type === name).value;
    return pick("year") + "-" + pick("month") + "-" + pick("day");
  }
  function create(opts) {
    const root = opts.query('[data-role="activity-panel"]');
    if (!root) return {start() {}, refresh() {}, clearPrivate() {}, dispose() {}};
    const field = name => root.querySelector('[data-activity="' + name + '"]');
    const document = root.ownerDocument;
    const now = opts.now || Date.now;
    const permitted = () => !disposed && opts.isServerOnline() && opts.isAdmin();
    let disposed = false, started = false, generation = 0, serial = 0, pending = null;
    let snapshot = null, selectedDay = "", timezone = "Asia/Shanghai", followToday = true, updateFailed = false;
    let refreshJob = null, exportUrl = null, exportTimer = null, exporting = false;
    const listeners = [];
    const valid = epoch => epoch === generation && permitted();
    const dayNow = () => dateAt(now(), timezone);
    const selection = () => {
      const days = ["7", "30", "90"].includes(field("days").value) ? field("days").value : "7";
      const end = /^\d{4}-\d{2}-\d{2}$/.test(field("end").value) ? field("end").value : dayNow();
      return "days=" + days + "&end=" + end;
    };
    const note = message => { field("message").textContent = message; };
    function node(tag, className, text) {
      const item = document.createElement(tag);
      if (className) item.className = className;
      if (text !== undefined) item.textContent = text;
      return item;
    }
    function revokeExport() {
      if (exportTimer !== null) { global.clearTimeout(exportTimer); exportTimer = null; }
      if (exportUrl) { global.URL.revokeObjectURL(exportUrl); exportUrl = null; }
    }
    function clearPrivate() {
      generation++; serial++; snapshot = null; selectedDay = "";
      exporting = false; followToday = true; updateFailed = false;
      revokeExport(); root.hidden = true; root.removeAttribute("aria-busy");
      for (const name of ["today", "today-detail", "source", "collected", "range-total", "range-detail", "message", "apps-date", "apps-note"]) field(name).textContent = "";
      field("trend").replaceChildren(); field("apps").replaceChildren();
      field("details").open = false;
      field("days").value = "7"; field("end").value = dayNow(); field("end").max = dayNow();
      field("export").disabled = true; field("all-days").hidden = true;
    }
    function timeLabel(timestamp) {
      if (!timestamp) return "暂无";
      return new Intl.DateTimeFormat("zh-CN", {timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}).format(new Date(timestamp * 1000));
    }
    function freshness() {
      if (!snapshot) return;
      const source = snapshot.source || {};
      const timestamps = [source.window_updated_at, source.afk_updated_at].filter(value => Number.isFinite(value) && value > 0);
      const oldest = timestamps.length === 2 ? Math.min(...timestamps) : null;
      const age = oldest ? Math.max(0, Math.floor(now() / 1000 - oldest)) : null;
      const stale = source.stale || (age !== null && age > 120);
      const names = {offline: "ActivityWatch 暂不可用", missing_watchers: "等待前台应用与离开状态记录", loading: "正在整理使用记录", disabled: "使用统计尚未启用"};
      const state = source.status === "online" && source.available
        ? stale ? "采集记录已较久未更新" : "采集正常 · 约每 10 秒刷新"
        : (names[source.status] || "正在等待采集记录");
      field("source").textContent = updateFailed ? "页面更新暂时中断 · 显示上次归档" : state;
      field("source").dataset.state = !updateFailed && source.status === "online" && !stale && source.available ? "online" : "waiting";
      field("collected").textContent = "最近归档 " + timeLabel(source.last_success_at) + (age === null ? " · 等待完整采集时间" : " · 采集延迟约 " + (age < 60 ? age + " 秒" : Math.floor(age / 60) + " 分钟"));
    }
    function renderApps() {
      if (!snapshot) return;
      const day = selectedDay ? snapshot.daily.find(item => item.date === selectedDay) : null;
      const apps = (day ? day.apps : snapshot.apps) || [];
      const visibleApps = apps.filter(app => Number.isFinite(Number(app.seconds)) && Number(app.seconds) >= MIN_APP_SECONDS);
      const total = apps.reduce((sum, app) => sum + Math.max(0, Number(app.seconds) || 0), 0);
      field("apps-date").textContent = day ? day.date : "";
      field("all-days").hidden = !day;
      field("apps-note").textContent = day && !hasRecord(day)
        ? day.status === "not_archived" ? "这一天尚未归档，不能视为使用了 0 小时。" : "这一天没有采集记录，不能视为使用了 0 小时。"
        : visibleApps.length ? "仅统计活跃时的前台应用；不展示窗口标题。" : apps.length ? "这段时间没有满 3 分钟的活跃前台应用。" : "这段时间没有已记录的活跃前台应用。";
      const items = visibleApps.map(app => {
        const item = node("li", "activity-app");
        const description = node("div", "activity-app-label");
        description.append(node("span", "activity-app-name", String(app.app || "未知应用")), node("span", "activity-app-value", duration(app.seconds) + " · " + (total ? Math.round(app.seconds / total * 100) : 0) + "%"));
        const track = node("div", "activity-app-track"); track.setAttribute("aria-hidden", "true");
        const fill = node("span"); fill.style.width = Math.min(100, total ? app.seconds / total * 100 : 0) + "%";
        track.append(fill); item.append(description, track); return item;
      });
      field("apps").replaceChildren(...items);
      for (const button of field("trend").children) button.setAttribute("aria-pressed", String(button.dataset.date === selectedDay));
    }
    function render() {
      const today = snapshot.today || {};
      field("today").textContent = hasRecord(today) ? duration(today.active_seconds) : "暂无记录";
      field("today-detail").textContent = (today.date || dayNow()) + (today.status === "partial" ? " · 部分时段缺少记录" : hasRecord(today) ? " · 今日活跃前台时长" : " · 等待采集与归档");
      field("range-total").textContent = snapshot.range.recorded_days ? duration(snapshot.range.active_seconds) : "暂无记录";
      field("range-detail").textContent = snapshot.range.start + " 至 " + snapshot.range.end + " · " + snapshot.range.recorded_days + " / " + snapshot.range.days + " 天有记录";
      const daily = snapshot.daily || [];
      const maximum = Math.max(1, ...daily.filter(hasRecord).map(day => Number(day.active_seconds) || 0));
      const buttons = daily.map(day => {
        const recorded = hasRecord(day);
        const label = day.date + "：" + (recorded ? duration(day.active_seconds) + (day.status === "partial" ? "，部分记录" : "") : day.status === "not_archived" ? "尚未归档" : "无记录");
        const button = node("button", "activity-day"); button.type = "button";
        button.dataset.date = day.date; button.dataset.status = day.status;
        button.setAttribute("aria-label", label); button.setAttribute("aria-pressed", String(day.date === selectedDay)); button.title = label;
        const plot = node("span", "activity-day-plot"); plot.setAttribute("aria-hidden", "true");
        const bar = node("span", "activity-day-bar");
        if (recorded) bar.style.height = Math.max(2, (Number(day.active_seconds) || 0) / maximum * 88) + "px";
        else bar.textContent = "—";
        plot.append(bar); button.append(plot, node("span", "activity-day-date", day.date.slice(5).replace("-", "/")));
        button.addEventListener("click", () => { if (permitted()) { selectedDay = day.date; field("details").open = true; renderApps(); } });
        return button;
      });
      field("trend").replaceChildren(...buttons);
      if (selectedDay && !daily.some(day => day.date === selectedDay)) selectedDay = "";
      field("export").disabled = exporting;
      renderApps(); freshness();
    }
    async function poll() {
      if (!permitted()) { clearPrivate(); return {skipped: true, reason: "signed-out"}; }
      root.hidden = false;
      if (followToday) field("end").value = dayNow();
      field("end").max = dayNow();
      const key = selection();
      freshness();
      const epoch = generation, requestId = ++serial;
      root.setAttribute("aria-busy", "true");
      if (!snapshot) note("正在读取本机使用记录…");
      try {
        const result = await opts.request("/api/activity/summary?" + key);
        if (!valid(epoch) || requestId !== serial) return {skipped: true, reason: "changed"};
        snapshot = result; timezone = result.timezone || "Asia/Shanghai"; updateFailed = false;
        render(); note(snapshot.source && snapshot.source.message || "");
        return {ok: true};
      } catch (error) {
        if (!valid(epoch) || requestId !== serial) return {skipped: true, reason: "changed"};
        note(error.status === 404 ? "后端尚未加载电脑使用接口，请重启后端后再试。" : "暂时无法更新，稍后会自动重试。" + (snapshot ? " 当前显示上次取得的归档。" : ""));
        updateFailed = true; freshness();
        return {ok: false, status: error.status || 0};
      } finally {
        if (valid(epoch) && requestId === serial) root.removeAttribute("aria-busy");
      }
    }
    function refresh(options) {
      if (refreshJob) return refreshJob.refresh(options);
      if (pending) return options && options.rerun ? pending.then(() => refresh()) : pending;
      pending = poll().finally(() => { pending = null; });
      return pending;
    }
    function selectionChanged() {
      serial++; selectedDay = "";
      return refresh({rerun: true});
    }
    async function exportData() {
      if (!permitted() || exporting || !snapshot) return;
      const epoch = generation, key = selection();
      exporting = true; field("export").disabled = true; revokeExport();
      try {
        const response = await opts.fetchRaw("/api/activity/export?" + key);
        if (!valid(epoch) || selection() !== key) return;
        if (!response.ok) { const error = new Error("export"); error.status = response.status; throw error; }
        const blob = await response.blob();
        if (!valid(epoch) || selection() !== key) return;
        exportUrl = global.URL.createObjectURL(blob);
        const anchor = node("a"); anchor.href = exportUrl; anchor.download = "computer-usage-" + field("end").value + "-" + field("days").value + "days.json";
        document.body.append(anchor); anchor.click(); anchor.remove();
        exportTimer = global.setTimeout(revokeExport, 1000);
        note("已导出所选范围的使用统计，不包含窗口标题。");
      } catch (error) {
        if (valid(epoch)) note(error.status === 404 ? "后端尚未加载导出接口，请重启后端后再试。" : "导出未完成，请稍后重试。");
      } finally {
        if (valid(epoch)) { exporting = false; field("export").disabled = !snapshot; }
      }
    }
    function on(element, event, handler) { element.addEventListener(event, handler); listeners.push([element, event, handler]); }
    function start() {
      if (started || disposed) return;
      started = true; clearPrivate();
      on(field("days"), "change", selectionChanged);
      on(field("end"), "change", () => { followToday = !field("end").value || field("end").value === dayNow(); return selectionChanged(); });
      on(field("all-days"), "click", () => { selectedDay = ""; renderApps(); });
      on(field("export"), "click", exportData);
      if (opts.scheduler) refreshJob = opts.scheduler.register({
        id: "activity", label: "电脑使用", page: "presence", interval: POLL_MS,
        requiresAuth: true, enabled: permitted, disabledReason: () => opts.isAdmin() ? "管理服务未连接" : "登录后刷新", hidden: "pause", run: poll,
      });
      else void refresh();
    }
    function dispose() {
      clearPrivate(); disposed = true;
      if (refreshJob) { refreshJob.unregister(); refreshJob = null; }
      listeners.forEach(([element, event, handler]) => element.removeEventListener(event, handler));
      listeners.length = 0;
    }
    return {start, refresh, clearPrivate, dispose};
  }
  global.FlitFancyConsoleActivity = {create};
})(window);
