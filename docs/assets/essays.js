/* 关于页：只读取并展示已公开的独立短文，不触碰页脚随笔。 */
(function () {
  "use strict";
  const library = document.querySelector('[data-role="essay-library"]');
  const list = document.querySelector('[data-role="essay-list"]');
  if (!library || !list) return;
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const API = local ? "/api/essays" : "https://api.flitfancy.com/essays";

  function dateText(row) {
    if (row.updated_at) return String(row.updated_at).slice(0, 10);
    if (row.updated_ts) return new Date(Number(row.updated_ts) * 1000).toISOString().slice(0, 10);
    return "";
  }

  function render(rows) {
    list.textContent = "";
    library.hidden = !rows.length;
    rows.forEach(function (row) {
      const article = document.createElement("article");
      article.className = "about-essay-card";
      const title = document.createElement("h3");
      title.textContent = row.title || "未命名短文";
      const time = document.createElement("time");
      time.textContent = dateText(row);
      const content = document.createElement("p");
      content.textContent = row.content || "";
      article.appendChild(title);
      if (time.textContent) article.appendChild(time);
      article.appendChild(content);
      list.appendChild(article);
    });
  }

  function refresh() {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    fetch(API, { headers: { "Accept": "application/json" }, signal: ctrl.signal })
      .then(function (response) {
        clearTimeout(timer);
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) { render(data.rows || []); })
      .catch(function () { library.hidden = true; });
  }

  document.addEventListener("flitfancy:essay-saved", refresh);
  refresh();
})();
