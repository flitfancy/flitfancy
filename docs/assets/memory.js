(function () {
  "use strict";

  const API = "https://api.flitfancy.com/memories";
  const POLL_MS = 10000;
  const status = document.querySelector('[data-role="memory-sync"]');
  /* 目前统一一条时间线（小流萤的日记系统就绪前不分我/她）；
     perspective 仍保留在数据里，将来可再拆。 */
  const stream = document.querySelector('[data-role="memory-stream"]');

  function recordTime(memory) {
    if (memory.time) return memory.time;
    return memory.date ? memory.date + "T00:00:00+08:00" : "";
  }

  function recordPrecision(memory) {
    if (memory.precision === "second" || memory.precision === "date") {
      return memory.precision;
    }
    return memory.time ? "second" : "date";
  }

  function recordContent(memory) {
    const title = String(memory.title || "").trim();
    const content = String(memory.content || "").trim();
    if (title && title !== ".") return title + (content ? " · " + content : "");
    return content;
  }

  function makeEntry(memory) {
    const article = document.createElement("article");
    article.className = "entry entry-live";
    article.dataset.live = "true";
    article.dataset.uid = memory.uid;
    const memoryTime = recordTime(memory);
    const precision = recordPrecision(memory);
    article.dataset.time = memoryTime;
    article.dataset.createdTs = String(memory.created_ts || 0);

    const time = document.createElement("time");
    time.dateTime = memoryTime;
    time.textContent = window.FlitFancyAdmin.formatDateTime(memoryTime, precision);

    const content = document.createElement("p");
    content.textContent = recordContent(memory);

    /* 管理态才可见的编辑按钮（CSS 按 body.editor-open 控制显示）：
       点击把原始条目派发给 journal-admin.js 回填编辑表单。 */
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "entry-edit";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", function () {
      document.dispatchEvent(new CustomEvent("flitfancy:edit-memory", { detail: memory }));
    });

    article.appendChild(time);
    article.appendChild(content);
    article.appendChild(editBtn);
    return article;
  }

  function sortStream(stream) {
    const entries = Array.from(stream.querySelectorAll(".entry"));
    entries.sort(function (a, b) {
      const byTime = (b.dataset.time || "").localeCompare(a.dataset.time || "");
      if (byTime) return byTime;
      return Number(b.dataset.createdTs || 0) - Number(a.dataset.createdTs || 0);
    });
    entries.forEach(function (entry) { stream.appendChild(entry); });
  }

  /* 增量 diff 渲染：uid -> 节点 映射，每 10 秒刷新不重建列表。
     内容变化 → 原地改文字；新条目 → 插入并播入场动画；消失条目 → 移除。
     这样"全列表闪一下"的整页重播动画彻底消失。 */
  const liveEntries = new Map();

  function render(rows) {
    if (!stream) return;
    const list = Array.isArray(rows) ? rows : [];
    const byUid = new Map();
    list.forEach(function (m) { byUid.set(String(m.uid || ""), m); });

    list.forEach(function (memory) {
      const uid = String(memory.uid || "");
      const existing = liveEntries.get(uid);
      if (existing) {
        const memoryTime = recordTime(memory);
        const precision = recordPrecision(memory);
        const timeEl = existing.querySelector("time");
        if (timeEl) {
          timeEl.dateTime = memoryTime;
          timeEl.textContent = window.FlitFancyAdmin.formatDateTime(memoryTime, precision);
        }
        const contentEl = existing.querySelector("p");
        if (contentEl) contentEl.textContent = recordContent(memory);
        return;
      }
      const article = makeEntry(memory);
      article.classList.add("entry-live");   // 只有新条目播入场动画
      stream.appendChild(article);
      liveEntries.set(uid, article);
    });

    liveEntries.forEach(function (article, uid) {
      if (!byUid.has(uid)) {
        article.remove();
        liveEntries.delete(uid);
      }
    });
    sortStream(stream);
  }

  let inFlight = false;
  async function refresh() {
    if (inFlight) return;   // interval/visibilitychange/写入事件 三路并发防重入
    inFlight = true;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () {
        ctrl.abort();
      }, window.FlitFancyAdmin.TIMEOUT_MS);
      const response = await fetch(API, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "HTTP " + response.status);
      render(Array.isArray(data.rows) ? data.rows : []);
      if (status) status.textContent = "与云端同步 · 每 " + (POLL_MS / 1000) + " 秒倾听一次";
    } catch (error) {
      if (status) status.textContent = "暂时听不到云端，旧日记仍在这里";
    } finally {
      inFlight = false;
    }
  }

  if (stream) sortStream(stream);   // 静态条目立即倒叙，不等网络
  refresh();
  window.setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
  document.addEventListener("flitfancy:memory-saved", refresh);
})();