/* 资源页管理：上传（两段式一键发布）、版本列表、删除；
   同时负责把 manifest 里的上传资源渲染到页面各栏目（公开访问者也可见）。 */
(function () {
  "use strict";

  const $ = function (selector) { return document.querySelector(selector); };
  const ADMIN_KEY = "flitfancy.admin.token";
  const MANIFEST_URL = "resources/manifest.json";
  const GROUPS = ["firefly", "naturecraft", "flitfancy"];
  const UPLOAD_TIMEOUT_MS = 30 * 60000;
  const adminSurface = window.FlitFancyAdmin.isAdminHost();

  function token() { return window.FlitFancyAdmin.token(ADMIN_KEY); }
  function setToken(value) { window.FlitFancyAdmin.setToken(ADMIN_KEY, value); }
  function api(path, options) {
    return window.FlitFancyAdmin.request(path, Object.assign({ authMode: "always" }, options));
  }
  function setStatus(selector, text) {
    const target = $(selector);
    if (target) target.textContent = text || "";
  }

  const panelShell = window.FlitFancyPanelShell.init({
    panel: $('[data-role="res-manager"]'),
    grab: $('[data-role="res-editor-grab"]'),
    collapseBtn: $('[data-role="res-collapse"]'),
    expandTab: $('[data-role="res-expand-tab"]'),
    storageKey: "flitfancy.resources.panelW",
    openClass: "editor-open",
    min: 320,
    max: 900
  });

  function openPanel() {
    panelShell.show();
    $('[data-role="res-login-overlay"]').hidden = true;
  }

  function showLogin(message) {
    $('[data-role="res-login-overlay"]').hidden = false;
    $('[data-role="res-password"]').value = "";
    setStatus('[data-role="res-login-status"]', message || "");
    ($('[data-role="res-username"]').value
      ? $('[data-role="res-password"]')
      : $('[data-role="res-username"]')).focus();
  }

  async function loadResourcesWithStatus() {
    setStatus('[data-role="res-list-status"]', "正在加载资源列表…");
    try {
      const data = await api("/api/resources");
      renderAdminList(data.resources || []);
      fillResourceSelect(data.resources || []);
      setStatus('[data-role="res-list-status"]', "资源列表已加载");
      return true;
    } catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error)) {
        setToken("");
        panelShell.hide();
        showLogin("登录已过期，请重新登录");
        return false;
      }
      setStatus('[data-role="res-list-status"]', "加载失败，可重试：" + (error.message || "未知错误"));
      return false;
    }
  }

  function openManager() {
    if (!adminSurface) {
      window.location.href = "https://console.flitfancy.com/resources.html#manage";
      return;
    }
    if (!token()) {
      showLogin("");
      return;
    }
    openPanel();
    loadResourcesWithStatus();
  }

  async function login() {
    const username = $('[data-role="res-username"]').value.trim();
    const password = $('[data-role="res-password"]').value;
    const button = $('[data-role="res-login"]');
    if (!username || !password) {
      setStatus('[data-role="res-login-status"]', "请输入用户名和密码");
      return;
    }
    button.disabled = true;
    setStatus('[data-role="res-login-status"]', "正在验证…");
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        authMode: "none",
        body: JSON.stringify({ username: username, password: password }),
      });
      setToken(data.token);
      openPanel();
      loadResourcesWithStatus();
    } catch (error) {
      setStatus('[data-role="res-login-status"]', "登录失败：" + (error.message || "未知错误"));
    } finally {
      button.disabled = false;
    }
  }

  function logout() {
    try { api("/api/admin/logout", { method: "POST" }); } catch (error) { /* ignore */ }
    setToken("");
    $('[data-role="res-manager"]').hidden = true;
    document.body.classList.remove("editor-open");
    panelShell.clearCollapsed();
  }

  /* ---------- 公开卡片渲染（所有访问者可见） ---------- */
  async function renderPublicCards() {
    let entries = [];
    try {
      entries = await fetch(MANIFEST_URL).then(function (r) { return r.json(); });
    } catch (error) { entries = []; }
    GROUPS.forEach(function (group) {
      const box = document.querySelector('[data-column="' + group + '"]');
      if (!box) return;
      box.textContent = "";
      const cards = entries.filter(function (e) { return e.group === group; });
      if (!cards.length) return;
      cards.forEach(function (entry) { box.appendChild(renderCard(entry)); });
    });
  }

  function renderCard(entry) {
    const card = document.createElement("article");
    card.className = "mini-card";
    const latest = (entry.versions || [])[0] || {};
    const h3 = document.createElement("h3");
    h3.textContent = entry.title + (latest.label ? " · " + latest.label : "");
    card.appendChild(h3);
    if (entry.desc) {
      const p = document.createElement("p");
      p.textContent = entry.desc;
      card.appendChild(p);
    }
    if (entry.details) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "详情";
      det.appendChild(sum);
      const body = document.createElement("p");
      body.textContent = entry.details;
      det.appendChild(body);
      card.appendChild(det);
    }
    const meta = document.createElement("p");
    meta.className = "mini-meta";
    meta.textContent = latest.date ? String(latest.date).slice(0, 10) : "";
    if (latest.sha256) meta.textContent += " · SHA-256 " + String(latest.sha256).slice(0, 16) + "…";
    card.appendChild(meta);
    if (latest.file) {
      const link = document.createElement("a");
      link.className = "back-link";
      link.href = "resources/" + latest.file;
      link.textContent = "下载最新版";
      link.setAttribute("download", "");
      card.appendChild(link);
    }
    if ((entry.versions || []).length > 1) {
      const hist = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "历史版本 (" + (entry.versions.length - 1) + ")";
      hist.appendChild(sum);
      const histList = document.createElement("ul");
      (entry.versions || []).slice(1).forEach(function (v) {
        const li = document.createElement("li");
        li.textContent = String(v.date || "").slice(0, 10) +
          (v.label ? " · " + v.label : "") + (v.file ? " · ⬇" : " · 文字更新");
        histList.appendChild(li);
      });
      hist.appendChild(histList);
      card.appendChild(hist);
    }
    return card;
  }

  /* ---------- 管理面板（登录后） ---------- */
  function renderAdminList(entries) {
    const list = $('[data-role="res-admin-list"]');
    if (!list) return;
    if (!entries.length) { list.textContent = "暂无上传资源"; return; }
    list.textContent = "";
    entries.forEach(function (entry) {
      const card = document.createElement("div");
      card.className = "res-entry";
      const head = document.createElement("div");
      head.className = "res-entry-head";
      const name = document.createElement("b");
      name.textContent = entry.title + "（" + entry.group + " · " + entry.id + "）";
      head.appendChild(name);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost";
      del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!window.confirm("删除「" + entry.title + "」及其全部版本文件？")) return;
        api("/api/resources/delete", { method: "POST", body: JSON.stringify({ id: entry.id }) })
          .then(function () { loadResourcesWithStatus(); renderPublicCards(); })
          .catch(function (e2) {
            setStatus('[data-role="res-list-status"]', "删除失败：" + (e2.message || "未知错误"));
          });
      });
      head.appendChild(del);
      card.appendChild(head);
      const meta = document.createElement("div");
      meta.className = "res-entry-meta";
      const parts = (entry.versions || []).map(function (v) {
        return (v.label ? v.label + " · " : "") + String(v.date || "").slice(0, 10) +
          (v.file ? " · 文件" : " · 文字");
      });
      meta.textContent = "版本： " + parts.join(" ｜ ");
      card.appendChild(meta);
      list.appendChild(card);
    });
  }

  function fillResourceSelect(entries) {
    const sel = $('[data-role="res-target"]');
    if (!sel) return;
    const keep = sel.value;
    sel.textContent = "";
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "＋ 新建资源";
    sel.appendChild(newOpt);
    entries.forEach(function (e) {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = e.title + "（" + e.group + "）";
      sel.appendChild(o);
    });
    sel.value = entries.some(function (e) { return e.id === keep; }) ? keep : "__new__";
    syncNewFields();
  }

  function syncNewFields() {
    const isNew = $('[data-role="res-target"]').value === "__new__";
    ["res-title", "res-group", "res-desc", "res-details"].forEach(function (role) {
      const field = $(role === "res-title" || role === "res-desc" || role === "res-details"
        ? '[data-role="' + role + '"]'
        : null);
      if (role === "res-title" || role === "res-desc" || role === "res-details") {
        const wrap = field ? field.closest("label") : null;
        if (wrap) wrap.hidden = !isNew;
      }
    });
    const groupWrap = $('[data-role="res-group"]').closest("label");
    if (groupWrap) groupWrap.hidden = !isNew;
  }

  /* ---------- 上传（两段式 + 一键发布） ---------- */
  function readFields() {
    const isNew = $('[data-role="res-target"]').value === "__new__";
    const fileInput = $('[data-role="res-file"]');
    const file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    return {
      isNew: isNew,
      id: isNew ? "" : $('[data-role="res-target"]').value,
      group: $('[data-role="res-group"]').value,
      title: $('[data-role="res-title"]').value.trim(),
      desc: $('[data-role="res-desc"]').value.trim(),
      details: $('[data-role="res-details"]').value.trim(),
      label: $('[data-role="res-label"]').value.trim(),
      note: $('[data-role="res-note"]').value.trim(),
      file: file,
      filename: file ? file.name : "",
    };
  }

  function uploadBytes(uploadToken, file) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/resources/upload?token=" + encodeURIComponent(uploadToken));
      xhr.setRequestHeader("Authorization", "Bearer " + token());
      xhr.timeout = 30 * 60000;
      xhr.upload.onprogress = function (ev) {
        if (ev.lengthComputable) {
          setStatus('[data-role="res-status"]', "上传中… " + Math.round(ev.loaded / ev.total * 100) + "%");
        }
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
        let msg = "HTTP " + xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e2) { }
        reject(new Error(msg));
      };
      xhr.onerror = function () { reject(new Error("网络错误")); };
      if (file) { xhr.send(file); } else { xhr.send(new Blob([])); }
    });
  }

  async function save() {
    const fields = readFields();
    if (!fields.isNew && !fields.id) { setStatus('[data-role="res-status"]', "请选择目标资源"); return; }
    if (fields.isNew && !fields.title && !fields.filename) {
      setStatus('[data-role="res-status"]', "新建资源至少需要标题或文件"); return;
    }
    if (!fields.file && !fields.title && !fields.label && !fields.note && !fields.desc && !fields.details) {
      setStatus('[data-role="res-status"]', "整条提交都是空的"); return;
    }
    const meta = {
      id: fields.id || undefined,
      group: fields.group || undefined,
      title: fields.title || undefined,
      desc: fields.desc || undefined,
      details: fields.details || undefined,
      label: fields.label || undefined,
      note: fields.note || undefined,
      filename: fields.filename || undefined,
      size: fields.file ? fields.file.size : 0,
    };
    setStatus('[data-role="res-status"]', "准备上传…");
    let prep;
    try {
      prep = await api("/api/resources/prepare", { method: "POST", body: JSON.stringify(meta) });
    } catch (error) {
      setStatus('[data-role="res-status"]', "准备失败：" + (error.message || "未知错误")); return;
    }
    try {
      await uploadBytes(prep.token, fields.file);
    } catch (error) {
      setStatus('[data-role="res-status"]', "上传失败：" + (error.message || "未知错误")); return;
    }
    setStatus('[data-role="res-status"]', "上传完成，发布中…");
    let publishNote = "";
    try {
      const pub = await api("/api/resources/publish", { method: "POST", body: "{}" });
      publishNote = pub.note || "";
    } catch (error) {
      publishNote = "推送失败（本地已保存，稍后重试发布）";
    }
    setStatus('[data-role="res-status"]', "已发布：" + publishNote + "（Pages 约 10 分钟生效）");
    $('[data-role="res-file"]').value = "";
    loadResourcesWithStatus();
    renderPublicCards();
  }

  /* ---------- 启动 ---------- */
  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');
  $('[data-role="res-login"]').addEventListener("click", login);
  $('[data-role="res-login-cancel"]').addEventListener("click", function () {
    $('[data-role="res-login-overlay"]').hidden = true;
  });
  $('[data-role="res-password"]').addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); login(); }
  });
  $('[data-role="res-save"]').addEventListener("click", save);
  $('[data-role="res-reload"]').addEventListener("click", loadResourcesWithStatus);
  $('[data-role="res-logout"]').addEventListener("click", logout);
  $('.nav nav a[href="resources.html"]').addEventListener("click", function (event) {
    event.preventDefault();
    openManager();
  });
  if (window.location.hash === "#manage") openManager();

  renderPublicCards();
})();
