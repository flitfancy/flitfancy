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
    button.addEventListener("click", function (event) {
      event.preventDefault();
      showView(button.getAttribute("data-view"));
    });
  });
  showView((window.location.hash || "").indexOf("anchors") === 1 ? "anchors" : "flow");

  const list = $('[data-role="anchor-list"]');
  if (!list) return;
  const count = $('[data-role="anchor-count"]');
  const publicAPI = "https://api.flitfancy.com/anchors";
  const cards = new Map();
  const columns = { firefly: "tianxin", skywork: "skywork", flitfancy: "flitfancy" };
  let refreshRevision = 0;
  let displayed = null;

  // 原三栏卡片继续作为默认内容；保存记录按稳定 uid 覆盖同一张卡片。
  document.querySelectorAll('[data-anchor-uid]').forEach(function (node) {
    const status = node.querySelector(".badge");
    const record = {
      uid: node.dataset.anchorUid, project: node.dataset.project, horizon: node.dataset.horizon,
      title: node.querySelector("h3").textContent, content: node.querySelector("p").textContent,
      time: "", precision: "none", badge: status.textContent,
      badge_kind: ["done", "doing", "dream"].find(function (kind) { return status.classList.contains(kind); }),
      card: true,
    };
    cards.set(record.uid, { node: node, record: record });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "anchor-edit";
    edit.textContent = "编辑";
    edit.addEventListener("click", function () {
      document.dispatchEvent(new CustomEvent("flitfancy:edit-anchor", { detail: cards.get(record.uid).record }));
    });
    node.appendChild(edit);
  });

  function updateCard(anchor) {
    const entry = cards.get(anchor.uid);
    if (!entry) return;
    const record = Object.assign({}, entry.record, normalize(anchor), { card: true });
    const node = entry.node;
    node.querySelector("h3").textContent = record.title || "";
    node.querySelector("p").textContent = record.content || "";
    if (record.badge && ["done", "doing", "dream"].includes(record.badge_kind)) {
      const status = node.querySelector(".badge");
      status.textContent = record.badge;
      status.className = "badge " + record.badge_kind;
    }
    const column = $("#" + columns[record.project] + " .mini-grid");
    if (column && node.parentNode !== column) column.appendChild(node);
    node.dataset.project = record.project;
    node.dataset.horizon = record.horizon;
    entry.record = record;
  }

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

  async function refresh() {
    const revision = ++refreshRevision;
    try {
      const data = await window.FlitFancyAdmin.request(publicAPI, { authMode: "none", cache: "no-store" });
      if (revision !== refreshRevision) return { skipped: true };
      const records = Array.isArray(data.rows) ? data.rows : [];
      const signature = JSON.stringify(records);
      if (signature !== displayed) {
        records.forEach(updateCard);
        rows = records.filter(function (anchor) { return !cards.has(anchor.uid); }).map(normalize);
        render();
        displayed = signature;
      }
      return { ok: true };
    } catch (error) { return { ok: false, status: error.status }; }
  }

  const job = window.FlitFancyPublicRefresh && window.FlitFancyPublicRefresh.register({
    id: "anchors", label: "锚点", page: "journal", interval: 15000, run: refresh,
  });
  document.addEventListener("flitfancy:anchor-saved", function () {
    return job ? job.refresh({ rerun: true }) : refresh();
  });
  if (!job) void refresh();
})();
