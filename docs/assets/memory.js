(function () {
  "use strict";

  const API = "https://api.flitfancy.com/memories";
  const POLL_MS = 10000;
  const status = document.querySelector('[data-role="memory-sync"]');
  /* 目前统一一条时间线（小流萤的日记系统就绪前不分我/她）；
     perspective 仍保留在数据里，将来可再拆。 */
  const stream = document.querySelector('[data-role="memory-stream"]');
  const monthHeadings = new Map();
  const entryRecords = new WeakMap();

  function recordTime(memory) {
    return String(memory.time || "");
  }

  function recordPrecision(memory) {
    if (memory.precision === "second" || memory.precision === "date") {
      return memory.precision;
    }
    return "second";
  }

  function recordContent(memory) {
    return String(memory.content || "").trim();
  }

  function updateEntry(article, memory) {
    const value = recordTime(memory);
    const precision = recordPrecision(memory);
    article.dataset.time = value;
    article.dataset.createdTs = String(memory.created_ts || 0);
    entryRecords.set(article, memory);
    const time = article.querySelector("time");
    const full = window.FlitFancyAdmin.formatDateTime(value, precision);
    time.dateTime = value;
    time.title = full;
    time.setAttribute("aria-label", full);
    time.textContent = /^\d{4}-\d{2}-\d{2}/.test(full)
      ? Number(full.slice(5, 7)) + "月" + Number(full.slice(8, 10)) + "日" +
        (precision !== "date" && full.length >= 16 ? " · " + full.slice(11, 16) : "")
      : full;
    article.querySelector("p").textContent = recordContent(memory);
  }

  function makeEntry(memory) {
    const article = document.createElement("article");
    article.className = "entry entry-live";
    article.dataset.live = "true";
    article.dataset.uid = memory.uid;
    const time = document.createElement("time");
    const content = document.createElement("p");

    /* 管理态才可见的编辑按钮（CSS 按 body.editor-open 控制显示）：
       点击把原始条目派发给 journal-admin.js 回填编辑表单。 */
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "entry-edit";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", function () {
      document.dispatchEvent(new CustomEvent("flitfancy:edit-memory", { detail: entryRecords.get(article) }));
    });

    article.appendChild(time);
    article.appendChild(content);
    article.appendChild(editBtn);
    updateEntry(article, memory);
    return article;
  }

  function sortStream(stream) {
    const entries = Array.from(stream.querySelectorAll(".entry"));
    entries.sort(function (a, b) {
      const byTime = (b.dataset.time || "").localeCompare(a.dataset.time || "");
      if (byTime) return byTime;
      return Number(b.dataset.createdTs || 0) - Number(a.dataset.createdTs || 0);
    });
    const order = [];
    const activeMonths = new Set();
    let position = 0;
    entries.forEach(function (entry) {
      const value = entry.dataset.time || "";
      const month = /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : "undated";
      if (!activeMonths.has(month)) {
        activeMonths.add(month);
        position = 0;
        if (!monthHeadings.has(month)) {
          const heading = document.createElement("h2");
          heading.className = "memory-month";
          heading.setAttribute("aria-label", month === "undated" ? "未注明日期" :
            month.slice(0, 4) + "年" + Number(month.slice(5, 7)) + "月");
          const year = document.createElement("span");
          year.className = "memory-month-year";
          year.textContent = month === "undated" ? "" : month.slice(0, 4);
          const label = document.createElement("span");
          label.textContent = month === "undated" ? "未注明日期" : Number(month.slice(5, 7)) + " 月";
          heading.appendChild(year);
          heading.appendChild(label);
          monthHeadings.set(month, heading);
        }
        order.push(monthHeadings.get(month));
      }
      entry.dataset.side = position++ % 2 ? "right" : "left";
      order.push(entry);
    });
    monthHeadings.forEach(function (heading, month) {
      if (!activeMonths.has(month)) { heading.remove(); monthHeadings.delete(month); }
    });
    // Keep unchanged nodes in place: polling must not replay animations or lose focus.
    order.forEach(function (node, index) {
      if (stream.children[index] !== node) stream.insertBefore(node, stream.children[index] || null);
    });
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
        updateEntry(existing, memory);
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
      if (status) {
        status.hidden = liveEntries.size > 0;
        status.textContent = liveEntries.size ? "" : "还没有留下日记";
      }
    } catch (error) {
      if (status) {
        status.hidden = false;
        status.textContent = liveEntries.size ? "暂时听不到云端，旧日记仍在这里" : "日记暂时未能加载，稍后会自动重试";
      }
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
