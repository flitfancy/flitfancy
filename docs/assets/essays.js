/* 关于页只展示管理员明确选定的文章；原序章保留为首次访问的默认卡。 */
(function () {
  "use strict";
  const library = document.querySelector('[data-role="essay-library"]');
  const list = document.querySelector('[data-role="essay-list"]');
  const prologue = document.querySelector('[data-role="essay-prologue"]');
  if (!library || !list || !prologue) return;
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const API = local ? "/api/essays/featured" : "https://api.flitfancy.com/essays/featured";
  let pending = null;

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
      const response = await fetch(API, { headers: { "Accept": "application/json" }, signal: ctrl.signal });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (pending === ctrl && !ctrl.signal.aborted) render(data.essay || null);
    } catch (error) { /* 网络失败时保留已显示的文章。 */ }
    finally { clearTimeout(timer); }
  }

  document.addEventListener("flitfancy:essay-saved", refresh);
  refresh();
})();
