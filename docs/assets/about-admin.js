/* 关于页短文记录库：本地草稿、公开排序和归档管理。 */
(function () {
  "use strict";
  const $ = function (selector) { return document.querySelector(selector); };
  const ADMIN_KEY = "flitfancy.admin.token";
  const adminSurface = window.FlitFancyAdmin.isAdminHost();
  const statusNames = { draft: "草稿", public: "公开", archived: "归档" };
  let rows = [];

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
    panel: $('[data-role="essay-editor"]'),
    grab: $('[data-role="essay-editor-grab"]'),
    collapseBtn: $('[data-role="essay-collapse"]'),
    expandTab: $('[data-role="essay-expand-tab"]'),
    storageKey: "flitfancy.essay.panelW",
    openClass: "editor-open",
    min: 320,
    max: 900
  });

  function clearForm(message) {
    $('[data-role="essay-uid"]').value = "";
    $('[data-role="essay-title"]').value = "";
    $('[data-role="essay-content"]').value = "";
    $('[data-role="essay-status"]').value = "draft";
    $('[data-role="essay-order"]').value = "100";
    setStatus('[data-role="essay-write-status"]', message || "正在写一篇新短文");
    $('[data-role="essay-title"]').focus();
  }

  function fillForm(row) {
    $('[data-role="essay-uid"]').value = row.uid || "";
    $('[data-role="essay-title"]').value = row.title || "";
    $('[data-role="essay-content"]').value = row.content || "";
    $('[data-role="essay-status"]').value = statusNames[row.status] ? row.status : "draft";
    $('[data-role="essay-order"]').value = String(row.display_order == null ? 100 : row.display_order);
    setStatus('[data-role="essay-write-status"]', "正在编辑既有短文，保存后原地更新");
    $('[data-role="essay-title"]').focus();
  }

  function rowActions(row) {
    const actions = document.createElement("div");
    actions.className = "essay-admin-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn btn-ghost";
    edit.textContent = "编辑";
    edit.addEventListener("click", function () { fillForm(row); });
    actions.appendChild(edit);
    if (row.status !== "archived") {
      const archive = document.createElement("button");
      archive.type = "button";
      archive.className = "btn btn-ghost";
      archive.textContent = "归档";
      archive.addEventListener("click", function () {
        if (!window.confirm("归档后不会删除，仍可从记录库重新编辑。确定归档吗？")) return;
        savePayload(Object.assign({}, row, { status: "archived" })).catch(function (error) {
          setStatus('[data-role="essay-write-status"]', error.message || "归档失败");
        });
      });
      actions.appendChild(archive);
    }
    return actions;
  }

  function renderRows() {
    const list = $('[data-role="essay-admin-list"]');
    list.textContent = "";
    rows.forEach(function (row) {
      const item = document.createElement("div");
      item.className = "essay-admin-row";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = row.title || "未命名短文";
      const meta = document.createElement("span");
      meta.className = "essay-admin-meta";
      meta.textContent = (statusNames[row.status] || row.status) + " · 顺序 " + row.display_order;
      info.appendChild(title);
      info.appendChild(meta);
      item.appendChild(info);
      item.appendChild(rowActions(row));
      list.appendChild(item);
    });
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "记录库还是空的。";
      list.appendChild(empty);
    }
  }

  async function loadRows() {
    const data = await api("/api/admin/essays", { method: "GET" });
    rows = data.rows || [];
    renderRows();
  }

  function openPanel() {
    panelShell.show();
    $('[data-role="essay-login-overlay"]').hidden = true;
  }

  async function loadRowsWithStatus() {
    setStatus('[data-role="essay-library-status"]', "正在加载短文库…");
    try {
      await loadRows();
      setStatus('[data-role="essay-library-status"]', "短文库已加载");
      return true;
    } catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error)) {
        setToken("");
        panelShell.hide();
        showLogin("登录已过期，请重新登录");
        return false;
      }
      const message = error && error.status === 0
        ? "短文库加载超时，可重试"
        : "短文库加载失败，可重试：" + ((error && error.message) || "未知错误");
      setStatus('[data-role="essay-library-status"]', message);
      return false;
    }
  }

  function showLogin(message) {
    $('[data-role="essay-login-overlay"]').hidden = false;
    $('[data-role="essay-password"]').value = "";
    setStatus('[data-role="essay-login-status"]', message || "");
    ($('[data-role="essay-username"]').value
      ? $('[data-role="essay-password"]')
      : $('[data-role="essay-username"]')).focus();
  }

  async function openManager() {
    if (!adminSurface) {
      window.location.href = "https://console.flitfancy.com/about.html#write";
      return;
    }
    if (!token()) {
      showLogin("");
      return;
    }
    openPanel();
    await loadRowsWithStatus();
  }

  async function login() {
    const username = $('[data-role="essay-username"]').value.trim();
    const password = $('[data-role="essay-password"]').value;
    const button = $('[data-role="essay-login"]');
    if (!username || !password) {
      setStatus('[data-role="essay-login-status"]', "请输入用户名和密码");
      return;
    }
    button.disabled = true;
    setStatus('[data-role="essay-login-status"]', "正在验证…");
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        authMode: "none",
        body: JSON.stringify({ username: username, password: password })
      });
      setToken(data.token);
      openPanel();
      await loadRowsWithStatus();
    } catch (error) {
      setStatus('[data-role="essay-login-status"]', error.message || "登录失败");
    }
    button.disabled = false;
  }

  async function savePayload(payload) {
    setStatus('[data-role="essay-write-status"]', "正在保存到本机并更新公网…");
    const data = await api("/api/essays", {
      method: "POST",
      body: JSON.stringify({
        uid: payload.uid || "",
        title: String(payload.title || "").trim(),
        content: String(payload.content || "").trim(),
        status: payload.status || "draft",
        display_order: Number.parseInt(payload.display_order, 10) || 0
      })
    });
    await loadRowsWithStatus();
    document.dispatchEvent(new CustomEvent("flitfancy:essay-saved"));
    setStatus('[data-role="essay-write-status"]', data.public_sync
      ? "短文已保存，公开列表正在更新"
      : "已保存在本机，公网稍后自动补传");
    return data;
  }

  async function save() {
    const button = $('[data-role="essay-save"]');
    const payload = {
      uid: $('[data-role="essay-uid"]').value.trim(),
      title: $('[data-role="essay-title"]').value.trim(),
      content: $('[data-role="essay-content"]').value.trim(),
      status: $('[data-role="essay-status"]').value,
      display_order: $('[data-role="essay-order"]').value
    };
    if (!payload.title || !payload.content) {
      setStatus('[data-role="essay-write-status"]', "标题和正文都要填写");
      return;
    }
    button.disabled = true;
    try {
      const data = await savePayload(payload);
      clearForm(data.public_sync
        ? "短文已保存，公开列表正在更新"
        : "已保存在本机，公网稍后自动补传");
    } catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error)) setToken("");
      setStatus('[data-role="essay-write-status"]', error.message || "保存失败");
    }
    button.disabled = false;
  }

  async function logout() {
    try { await api("/api/admin/logout", { method: "POST" }); } catch (error) { /* ignore */ }
    setToken("");
    $('[data-role="essay-editor"]').hidden = true;
    document.body.classList.remove("editor-open");
    panelShell.clearCollapsed();
  }

  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');
  $('.nav nav a[href="about.html"]').addEventListener("click", function (event) {
    event.preventDefault();
    openManager();
  });
  $('[data-role="essay-login"]').addEventListener("click", login);
  $('[data-role="essay-login-cancel"]').addEventListener("click", function () {
    $('[data-role="essay-login-overlay"]').hidden = true;
  });
  $('[data-role="essay-password"]').addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); login(); }
  });
  $('[data-role="essay-save"]').addEventListener("click", save);
  $('[data-role="essay-new"]').addEventListener("click", clearForm);
  $('[data-role="essay-reload"]').addEventListener("click", loadRowsWithStatus);
  $('[data-role="essay-logout"]').addEventListener("click", logout);
  if (window.location.hash === "#write") openManager();
})();
