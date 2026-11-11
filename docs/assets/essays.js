/* 关于页只展示管理员明确选定的文章；原序章保留为首次访问的默认卡。 */
(function () {
  "use strict";
  const library = document.querySelector('[data-role="essay-library"]');
  const list = document.querySelector('[data-role="essay-list"]');
  const prologue = document.querySelector('[data-role="essay-prologue"]');
  if (!library || !list || !prologue) return;
  const API = "https://api.flitfancy.com/essays/featured";
  let pending = null;
  let displayed = null;

  function render(row) {
    list.textContent = "";
    library.hidden = !row;
    prologue.hidden = !!row;
    if (!row) return;
    const article = document.createElement("article");
    article.className = "about-reading-card";
    const header = document.createElement("header");
    header.className = "about-essay-head";
    const kicker = document.createElement("p");
    kicker.className = "kicker";
    kicker.textContent = "ESSAY";
    const title = document.createElement("h2");
    title.textContent = row.title || "未命名短文";
    header.appendChild(kicker);
    header.appendChild(title);
    article.appendChild(header);
    if (row.updated_at) {
      const time = document.createElement("time");
      time.textContent = String(row.updated_at).slice(0, 10);
      article.appendChild(time);
    }
    const content = document.createElement("p");
    content.className = "about-reading-body";
    content.textContent = row.content || "";
    article.appendChild(content);
    list.appendChild(article);
  }

  async function refresh() {
    if (pending) pending.abort();
    const ctrl = new AbortController();
    pending = ctrl;
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    try {
      const response = await fetch(API, { headers: { "Accept": "application/json" }, cache: "no-store", signal: ctrl.signal });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (pending === ctrl && !ctrl.signal.aborted) {
        const signature = JSON.stringify(data.essay || null);
        if (signature !== displayed) { render(data.essay || null); displayed = signature; }
      }
      return { ok: true };
    } catch (error) { return { ok: false }; /* 保留已显示的文章。 */ }
    finally { clearTimeout(timer); }
  }

  const job = window.FlitFancyPublicRefresh && window.FlitFancyPublicRefresh.register({
    id: "featured-essay", label: "展示短文", page: "about", interval: 15000, run: refresh,
  });
  document.addEventListener("flitfancy:essay-saved", function () {
    return job ? job.refresh({ rerun: true }) : refresh();
  });
  if (!job) void refresh();
})();
