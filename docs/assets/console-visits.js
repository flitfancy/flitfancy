/* 控制台访问统计：数据加载、连续 IP 折叠与表格渲染集中在这里。
   console.js 只负责提供管理鉴权和状态显示依赖。 */
(function (global) {
  "use strict";

  function hostOf(url) {
    try {
      return new URL(url).host || "—";
    } catch (e) {
      return "—";
    }
  }

  function groupConsecutive(rows) {
    const groups = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      const ip = (row && row.ip) || "—";
      const last = groups[groups.length - 1];
      if (last && last.ip === ip) {
        last.rows.push(row);
      } else {
        groups.push({ ip: ip, rows: [row] });
      }
    });
    return groups;
  }

  function renderIpCell(cell, address, metaText) {
    const content = document.createElement("span");
    content.className = "visit-ip-content";
    content.textContent = (address || "—") + (metaText ? " · " + metaText : "");
    cell.replaceChildren(content);
  }

  function createCell(label, text, className) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function create(options) {
    const opts = options || {};
    const query = opts.query;
    const request = opts.request;
    const authFailed = opts.authFailed;
    const setStatus = opts.setStatus;
    const formatTime = opts.formatTime;
    if (![query, request, authFailed, setStatus, formatTime].every(function (fn) {
      return typeof fn === "function";
    })) {
      throw new Error("FlitFancyVisits.create 缺少必要依赖");
    }

    let groupByIp = false;
    const expanded = Object.create(null);
    let lastData = null;

    function buildVisitRow(visit) {
      const row = visit || {};
      const tr = document.createElement("tr");

      const tdTime = createCell("时间", formatTime(row.ts));

      const tdIp = createCell("IP", "", "visit-ip");
      renderIpCell(tdIp, row.ip || "—");

      const tdPage = createCell("页面", row.page || "/");

      const tdRef = createCell("来源", row.ref ? hostOf(row.ref) : "—", "ref");
      tdRef.title = row.ref || "";

      const tdDev = createCell(
        "设备", (row.w && row.h) ? row.w + "×" + row.h : "—"
      );

      tr.appendChild(tdTime);
      tr.appendChild(tdIp);
      tr.appendChild(tdPage);
      tr.appendChild(tdRef);
      tr.appendChild(tdDev);
      return tr;
    }

    function render(data) {
      const current = data || {};
      const stats = current.stats || {};
      const statsEl = query('[data-role="visits-stats"]');
      statsEl.replaceChildren();
      [
        ["累计访问", stats.total || 0],
        ["今日", stats.today || 0],
        ["独立 IP", stats.uniq || 0]
      ].forEach(function (item) {
        const div = document.createElement("div");
        div.className = "visits-stat";
        const value = document.createElement("b");
        value.textContent = item[1];
        const label = document.createElement("span");
        label.textContent = item[0];
        div.appendChild(value);
        div.appendChild(label);
        statsEl.appendChild(div);
      });

      const tbody = query('[data-role="visits-list"]');
      tbody.replaceChildren();
      const rows = Array.isArray(current.recent) ? current.recent : [];
      query('[data-role="visits-empty"]').hidden = rows.length > 0;
      lastData = current;

      if (!groupByIp) {
        rows.forEach(function (row) { tbody.appendChild(buildVisitRow(row)); });
        return;
      }

      groupConsecutive(rows).forEach(function (group) {
        if (group.rows.length === 1) {
          tbody.appendChild(buildVisitRow(group.rows[0]));
          return;
        }

        const head = buildVisitRow(group.rows[0]);
        head.classList.add("visit-collapsed-row");
        if (expanded[group.ip]) {
          renderIpCell(
            head.querySelector(".visit-ip"), group.ip,
            "共 " + group.rows.length + " 次 ▾"
          );
          head.title = "点击折叠该 IP 的全部访问记录";
          head.addEventListener("click", function () {
            expanded[group.ip] = false;
            render(lastData);
          });
          tbody.appendChild(head);
          group.rows.slice(1).forEach(function (row) {
            tbody.appendChild(buildVisitRow(row));
          });
          return;
        }

        renderIpCell(
          head.querySelector(".visit-ip"), group.ip,
          "共 " + group.rows.length + " 次 ▸"
        );
        head.title = "点击展开该 IP 的全部访问记录";
        head.addEventListener("click", function () {
          expanded[group.ip] = true;
          render(lastData);
        });
        tbody.appendChild(head);
      });
    }

    async function load() {
      const status = query('[data-role="visits-status"]');
      setStatus(status, "加载中…");
      try {
        const response = await request("/api/visits", { method: "GET" });
        const data = await response.json();
        if (authFailed(response)) {
          setStatus(status, "登录已过期，请重新登录");
          return;
        }
        if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
        render(data);
        setStatus(status, "共 " + ((data.stats && data.stats.total) || 0) + " 条记录");
      } catch (error) {
        setStatus(status, (error && error.message) || "访问记录加载失败");
      }
    }

    function toggleGrouping(button) {
      groupByIp = !groupByIp;
      if (button) button.textContent = groupByIp ? "展开全部" : "折叠同 IP";
      if (lastData) render(lastData);
      return groupByIp;
    }

    return {
      load: load,
      render: render,
      toggleGrouping: toggleGrouping,
    };
  }

  global.FlitFancyVisits = {
    create: create,
    groupConsecutive: groupConsecutive,
    hostOf: hostOf,
  };
})(window);
