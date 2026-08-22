/* 旅途页：锚点 / 日记视图切换、锚点分类筛选与公开记录渲染。 */
(function () {
  "use strict";
  const $ = function (selector) { return document.querySelector(selector); };
  const tabs = document.querySelectorAll('[data-role="view-tab"]');
  const projectNames = {
    firefly: "Firefly · 天心",
    skywork: "SkyWork · 天工",
    flitfancy: "FlitFancy · 流明",
    pending: "待归类"
  };
  const horizonNames = { now: "现在", future: "未来" };
  const filters = { project: "all", horizon: "all" };
  let rows = [];

  function showView(name) {
    document.querySelectorAll("[data-view-pane]").forEach(function (pane) {
      pane.hidden = pane.getAttribute("data-view-pane") !== name;
    });
    tabs.forEach(function (button) {
      button.classList.toggle("active", button.getAttribute("data-view") === name);
    });
    try { history.replaceState(null, "", "#" + name); } catch (error) { /* ignore */ }
  }

  tabs.forEach(function (button) {
    button.addEventListener("click", function () {
      showView(button.getAttribute("data-view"));
    });
  });
  showView((window.location.hash || "").indexOf("anchors") === 1 ? "anchors" : "flow");

  const list = $('[data-role="anchor-list"]');
  if (!list) return;
  const count = $('[data-role="anchor-count"]');
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const API = local ? "/api/anchors" : "https://api.flitfancy.com/anchors";

  function normalize(anchor) {
    return Object.assign({}, anchor, {
      horizon: anchor.horizon === "future" ? "future" : "now",
      project: projectNames[anchor.project] ? anchor.project : "pending"
    });
  }

  function badge(text, kind) {
    const span = document.createElement("span");
    span.className = "anchor-badge anchor-badge-" + kind;
    span.textContent = text;
    return span;
  }

  function render() {
    list.textContent = "";
    const visible = rows.filter(function (anchor) {
      return (filters.project === "all" || anchor.project === filters.project)
        && (filters.horizon === "all" || anchor.horizon === filters.horizon);
    });
    if (count) count.textContent = "锚点 · 显示 " + visible.length + " / " + rows.length + " 条";
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "hint anchor-empty";
      empty.textContent = rows.length ? "这个分类里还没有锚点。" : "还没有建立锚点。";
      list.appendChild(empty);
      return;
    }
    visible.forEach(function (anchor) {
      const art = document.createElement("article");
      art.className = "anchor";
      art.dataset.project = anchor.project;
      art.dataset.horizon = anchor.horizon;
      const meta = document.createElement("div");
      meta.className = "anchor-meta";
      const time = document.createElement("time");
      time.textContent = window.FlitFancyAdmin.formatDate(anchor.time);
      meta.appendChild(time);
      meta.appendChild(badge(projectNames[anchor.project], "project"));
      meta.appendChild(badge(horizonNames[anchor.horizon], "horizon"));
      const title = document.createElement("h3");
      title.textContent = anchor.title || "";
      const body = document.createElement("p");
      body.textContent = anchor.content || "";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "anchor-edit";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", function () {
        document.dispatchEvent(new CustomEvent("flitfancy:edit-anchor", { detail: anchor }));
      });
      art.appendChild(meta);
      art.appendChild(title);
      art.appendChild(body);
      art.appendChild(editBtn);
      list.appendChild(art);
    });
  }

  document.querySelectorAll('[data-filter="project"], [data-filter="horizon"]').forEach(function (button) {
    button.addEventListener("click", function () {
      const type = button.getAttribute("data-filter");
      filters[type] = button.getAttribute("data-value") || "all";
      document.querySelectorAll('[data-filter="' + type + '"]').forEach(function (peer) {
        peer.classList.toggle("active", peer === button);
      });
      render();
    });
  });

  function refresh() {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, window.FlitFancyAdmin.TIMEOUT_MS);
    fetch(API, { headers: { "Accept": "application/json" }, signal: ctrl.signal })
      .then(function (response) {
        clearTimeout(timer);
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        rows = (data.rows || []).map(normalize);
        render();
      })
      .catch(function () { /* 数据源不可达时保持现状 */ });
  }

  document.addEventListener("flitfancy:anchor-saved", refresh);
  refresh();
})();
