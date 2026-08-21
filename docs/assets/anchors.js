/* 日记页：锚点 / 流水账 视图切换（公开）+ 锚点记录渲染 */
(function () {
  "use strict";
  const $ = function (selector) { return document.querySelector(selector); };

  const tabs = document.querySelectorAll('[data-role="view-tab"]');
  function showView(name) {
    document.querySelectorAll("[data-view-pane]").forEach(function (pane) {
      pane.hidden = pane.getAttribute("data-view-pane") !== name;
    });
    tabs.forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === name);
    });
    try { history.replaceState(null, "", "#" + name); } catch (e) { /* ignore */ }
  }
  tabs.forEach(function (b) {
    b.addEventListener("click", function () {
      showView(b.getAttribute("data-view"));
    });
  });
  const initial = (window.location.hash || "").indexOf("anchors") === 1 ? "anchors" : "flow";
  showView(initial);

  const list = $('[data-role="anchor-list"]');
  if (!list) return;
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const API = local ? "/api/anchors" : "https://api.flitfancy.com/anchors";

  function render(rows) {
    list.textContent = "";
    if (!rows || !rows.length) return;
    const head = document.createElement("p");
    head.className = "hint";
    head.textContent = "锚点 · 共 " + rows.length + " 条";
    list.appendChild(head);
    rows.forEach(function (a) {
      const art = document.createElement("article");
      art.className = "anchor";
      const time = document.createElement("time");
      time.textContent = window.FlitFancyAdmin.formatDate(a.time);
      const h3 = document.createElement("h3");
      h3.textContent = a.title || "";
      const p = document.createElement("p");
      p.textContent = a.content || "";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "anchor-edit";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", function () {
        document.dispatchEvent(new CustomEvent("flitfancy:edit-anchor", { detail: a }));
      });
      art.appendChild(time);
      art.appendChild(h3);
      art.appendChild(p);
      art.appendChild(editBtn);
      list.appendChild(art);
    });
  }

  function refresh() {
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, window.FlitFancyAdmin.TIMEOUT_MS);
    fetch(API, { headers: { "Accept": "application/json" }, signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) { render(data.rows || []); })
      .catch(function () { /* 数据源不可达时保持现状 */ });
  }
  document.addEventListener("flitfancy:anchor-saved", refresh);
  refresh();
})();
