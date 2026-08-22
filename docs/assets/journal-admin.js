(function () {
  "use strict";

  const $ = function (selector) { return document.querySelector(selector); };
  const ADMIN_KEY = "flitfancy.admin.token";
  /* 令牌读写与主机判定委托共享核心（assets/admin-core.js） */
  const adminSurface = window.FlitFancyAdmin.isAdminHost();

  function token() {
    return window.FlitFancyAdmin.token(ADMIN_KEY);
  }

  function setToken(value) {
    window.FlitFancyAdmin.setToken(ADMIN_KEY, value);
  }

  function nowForInput() {
    return window.FlitFancyAdmin.nowForInput();
  }

  /* 日期/时间两个输入框统一回填"现在"：日期必有，时间预填当前时刻 */
  function fillNow() {
    const fresh = nowForInput();   // YYYY-MM-DDTHH:MM:SS
    $('[data-role="memory-date"]').value = fresh.slice(0, 10);
    $('[data-role="memory-time"]').value = fresh.slice(11, 19);
    $('[data-role="anchor-date"]').value = fresh.slice(0, 10);
    $('[data-role="anchor-time"]').value = fresh.slice(11, 19);
  }

  async function api(path, options) {
    return window.FlitFancyAdmin.request(path, Object.assign({}, options, { authMode: "always" }));
  }

  function setStatus(selector, text) {
    const el = $(selector);
    if (el) el.textContent = text || "";
  }

  function showEditor() {
    panelShell.show();
    $('[data-role="memory-login-overlay"]').hidden = true;
    fillNow();
    $('[data-role="memory-content"]').focus();
  }

  function showLogin() {
    $('[data-role="memory-login-overlay"]').hidden = false;
    setStatus('[data-role="memory-login-status"]', "");
    $('[data-role="memory-password"]').value = "";
    ($('[data-role="memory-username"]').value
      ? $('[data-role="memory-password"]')
      : $('[data-role="memory-username"]')).focus();
  }

  async function openWriter() {
    if (!adminSurface) {
      window.location.href = "https://console.flitfancy.com/journal.html#write";
      return;
    }
    if (!token()) {
      showLogin();
      return;
    }
    try {
      await api("/api/admin/config", { method: "GET" });
      showEditor();
    } catch (e) {
      if (window.FlitFancyAdmin.isUnauthorized(e)) {
        setToken("");
        showLogin();
        setStatus('[data-role="memory-login-status"]', "登录已过期，请重新登录");
        return;
      }
      showEditor();
      setStatus('[data-role="memory-write-status"]',
        (e && e.status === 0) ? "管理服务连接超时，登录状态已保留" : ((e && e.message) || "管理服务暂不可用"));
    }
  }

  async function login() {
    const username = $('[data-role="memory-username"]').value.trim();
    const password = $('[data-role="memory-password"]').value;
    const button = $('[data-role="memory-login"]');
    if (!username || !password) {
      setStatus('[data-role="memory-login-status"]', "请输入用户名和密码");
      return;
    }
    button.disabled = true;
    button.textContent = "验证中…";
    setStatus('[data-role="memory-login-status"]', "正在验证…");
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username: username, password: password })
      });
      setToken(data.token);
      showEditor();
    } catch (e) {
      setStatus('[data-role="memory-login-status"]', e.message || "登录失败");
    }
    button.disabled = false;
    button.textContent = "登录";
  }

  function memoryUid() {
    return ($('[data-role="memory-uid"]') || { value: "" }).value.trim();
  }

  async function save() {
    const button = $('[data-role="memory-save"]');
    const editing = !!memoryUid();
    const dateText = $('[data-role="memory-date"]').value.trim();
    const timeText = $('[data-role="memory-time"]').value.trim();
    const payload = {
      uid: memoryUid(),
      perspective: $('[data-role="memory-perspective"]').value,
      // 时间留空 = 只记到日（date 精度）；填了 = 精确到秒
      time: timeText ? dateText + "T" + timeText : dateText,
      content: $('[data-role="memory-content"]').value.trim()
    };
    if (!dateText || !payload.content) {
      setStatus('[data-role="memory-write-status"]', "日期和内容都要填写");
      return;
    }
    button.disabled = true;
    button.textContent = "写入中…";
    setStatus('[data-role="memory-write-status"]', "正在保存到本机并同步云端…");
    try {
      const data = await api("/api/memories", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      $('[data-role="memory-content"]').value = "";
      fillNow();
      if ($('[data-role="memory-uid"]')) $('[data-role="memory-uid"]').value = "";
      setStatus('[data-role="memory-write-status"]', data.public_sync
        ? (editing ? "修改已保存，时间线正在更新" : "已经写进日记，时间线正在更新")
        : "已保存在本机，公网稍后自动补传");
      document.dispatchEvent(new CustomEvent("flitfancy:memory-saved"));
    } catch (e) {
      if (window.FlitFancyAdmin.isUnauthorized(e)) setToken("");
      setStatus('[data-role="memory-write-status"]', e.message || "写入失败");
    }
    button.disabled = false;
    button.textContent = "写入日记";
  }

  function showEditorPane(name) {
    document.querySelectorAll('[data-editor-pane]').forEach(function (pane) {
      pane.hidden = pane.getAttribute("data-editor-pane") !== name;
    });
    document.querySelectorAll('[data-role="editor-tab"]').forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    if (name === "note") loadReflections();
  }

  async function saveAnchor() {
    const button = $('[data-role="anchor-save"]');
    const editing = !!($('[data-role="anchor-uid"]') || { value: "" }).value.trim();
    const anchorDate = $('[data-role="anchor-date"]').value.trim();
    const anchorTime = $('[data-role="anchor-time"]').value.trim();
    const payload = {
      uid: ($('[data-role="anchor-uid"]') || { value: "" }).value.trim(),
      title: $('[data-role="anchor-title"]').value.trim(),
      time: anchorTime ? anchorDate + "T" + anchorTime : anchorDate,
      horizon: $('[data-role="anchor-horizon"]').value,
      project: $('[data-role="anchor-project"]').value,
      content: $('[data-role="anchor-content"]').value.trim()
    };
    if (!payload.title || !anchorDate || !payload.horizon || !payload.project || !payload.content) {
      setStatus('[data-role="anchor-write-status"]', "标题、分类、日期和内容都要填写");
      return;
    }
    button.disabled = true;
    button.textContent = "保存中…";
    setStatus('[data-role="anchor-write-status"]', "正在保存到本机并同步云端…");
    try {
      const data = await api("/api/anchors", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      $('[data-role="anchor-title"]').value = "";
      $('[data-role="anchor-content"]').value = "";
      $('[data-role="anchor-horizon"]').value = "now";
      $('[data-role="anchor-project"]').value = "";
      fillNow();
      if ($('[data-role="anchor-uid"]')) $('[data-role="anchor-uid"]').value = "";
      setStatus('[data-role="anchor-write-status"]', data.public_sync
        ? (editing ? "修改已保存，列表正在更新" : "锚点已建立，列表正在更新")
        : "已保存在本机，公网稍后自动补传");
      document.dispatchEvent(new CustomEvent("flitfancy:anchor-saved"));
    } catch (e) {
      if (window.FlitFancyAdmin.isUnauthorized(e)) setToken("");
      setStatus('[data-role="anchor-write-status"]', e.message || "保存失败");
    }
    button.disabled = false;
    button.textContent = "建立锚点";
  }

  /* 随笔列表：载入全部 -> 行内编辑/删除/新增 -> 整表保存。
     保存走 /api/reflections 的 {"reflections": [...]} 整表替换负载，
     与"追加一条"共用同一个 normalize 源头规则（去空/去重/截 120 字）。 */
  function reflectionRow(text) {
    const row = document.createElement("div");
    row.className = "reflection-row";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 120;
    input.placeholder = "一句话随笔（最长 120 字）";
    input.value = text || "";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost reflection-del";
    del.textContent = "删除";
    del.addEventListener("click", function () { row.remove(); });
    row.appendChild(input);
    row.appendChild(del);
    return row;
  }

  function loadReflections() {
    const list = $('[data-role="reflection-list"]');
    if (!list) return;
    api("/api/reflections", { method: "GET" })
      .then(function (data) {
        list.textContent = "";
        const rows = data.reflections || [];
        rows.forEach(function (text) { list.appendChild(reflectionRow(text)); });
        if (!rows.length) list.appendChild(reflectionRow(""));
      })
      .catch(function () {
        list.textContent = "";
        list.appendChild(reflectionRow(""));
        setStatus('[data-role="reflection-write-status"]', "读取随笔失败，仍可新增并保存");
      });
  }

  async function saveReflectionList() {
    const button = $('[data-role="reflection-save-list"]');
    const newInput = $('[data-role="reflection-new-input"]');
    const newText = newInput ? newInput.value.trim() : "";
    const values = [];
    if (newText) values.push(newText);
    Array.from(document.querySelectorAll('[data-role="reflection-list"] input'))
      .forEach(function (input) {
        const text = input.value.trim();
        if (text) values.push(text);
      });
    button.disabled = true;
    setStatus('[data-role="reflection-write-status"]', "正在保存…");
    try {
      const data = await api("/api/reflections", {
        method: "POST",
        body: JSON.stringify({ reflections: values })
      });
      if (newInput) newInput.value = "";
      loadReflections();
      setStatus('[data-role="reflection-write-status"]', data.public_sync
        ? "随笔已保存，页脚正在更新"
        : "已保存在本机，公网稍后自动补传");
      document.dispatchEvent(new CustomEvent("flitfancy:reflection-saved"));
    } catch (e) {
      if (window.FlitFancyAdmin.isUnauthorized(e)) setToken("");
      setStatus('[data-role="reflection-write-status"]', e.message || "保存失败");
    }
    button.disabled = false;
  }

  async function logout() {
    try { await api("/api/admin/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    setToken("");
    $('[data-role="memory-editor"]').hidden = true;
    document.body.classList.remove("editor-open");
  }

  /* 页面级错误提示（共享实现） */
  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');

  fillNow();
  $('.nav nav a[href="journal.html"]').addEventListener("click", function (event) {
    event.preventDefault();
    openWriter();
  });
  $('[data-role="memory-login"]').addEventListener("click", login);
  $('[data-role="memory-login-cancel"]').addEventListener("click", function () {
    $('[data-role="memory-login-overlay"]').hidden = true;
  });
  $('[data-role="memory-password"]').addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); login(); }
  });
  $('[data-role="memory-save"]').addEventListener("click", save);
  $('[data-role="memory-cancel"]').addEventListener("click", function () {
    $('[data-role="memory-editor"]').hidden = true;
    document.body.classList.remove("editor-open");
  });
  $('[data-role="memory-logout"]').addEventListener("click", logout);
  $('[data-role="anchor-save"]').addEventListener("click", saveAnchor);
  $('[data-role="reflection-save-list"]').addEventListener("click", saveReflectionList);
  document.querySelectorAll('[data-role="editor-tab"]').forEach(function (b) {
    b.addEventListener("click", function () {
      showEditorPane(b.getAttribute("data-tab"));
    });
  });
  showEditorPane("flow");

  /* 右侧面板外壳：页脚高度联动 / 拖拽调宽 / 收起展开全部由
     共享模块 admin-panel-shell.js 提供（与控制台管理面板同一实现）。 */
  const panelShell = window.FlitFancyPanelShell.init({
    panel: $('[data-role="memory-editor"]'),
    grab: $('[data-role="editor-grab"]'),
    collapseBtn: $('[data-role="memory-collapse"]'),
    expandTab: $('[data-role="editor-expand-tab"]'),
    storageKey: "flitfancy.editor.panelW",   // 两页各自独立拖宽记忆
    openClass: "editor-open",
    min: 280,
    max: 900,
    onExpand: function () {
      fillNow();
    },
  });

  /* 布局模式一键切换：侧边面板 ↔ 底部流式卡片（与控制台管理面板同款按钮） */
  $('[data-role="editor-mode"]').addEventListener("click", function () {
    const bottom = document.body.classList.toggle("editor-mode-bottom");
    this.textContent = bottom ? "侧边模式" : "底部模式";
  });

  /* 既有条目编辑：时间线/锚点列表里的"编辑"按钮派发事件，这里回填表单。
     datetime-local 只吃本地时间（YYYY-MM-DDTHH:MM:SS），取 ISO 前 19 位。 */
  document.addEventListener("flitfancy:edit-memory", function (event) {
    const m = event.detail || {};
    if (!m || !m.uid) return;
    showEditor();
    showEditorPane("flow");
    $('[data-role="memory-uid"]').value = m.uid;
    $('[data-role="memory-perspective"]').value = m.perspective === "her" ? "her" : "me";
    const timeText = String(m.time || "");
    $('[data-role="memory-date"]').value = timeText.slice(0, 10);
    // 只到日的旧条目：时间留空，直观表达"date 精度"；否则取 HH:MM:SS
    $('[data-role="memory-time"]').value = m.precision === "date"
      ? ""
      : (timeText.length >= 19 ? timeText.slice(11, 19) : "");
    $('[data-role="memory-content"]').value = String(m.content || "");
    setStatus('[data-role="memory-write-status"]', "正在编辑既有日记，保存后覆盖原条目");
  });
  document.addEventListener("flitfancy:edit-anchor", function (event) {
    const a = event.detail || {};
    if (!a || !a.uid) return;
    showEditor();
    showEditorPane("anchor");
    $('[data-role="anchor-uid"]').value = a.uid;
    $('[data-role="anchor-title"]').value = String(a.title || "");
    $('[data-role="anchor-horizon"]').value = a.horizon === "future" ? "future" : "now";
    $('[data-role="anchor-project"]').value = ["firefly", "skywork", "flitfancy"].includes(a.project)
      ? a.project
      : "";
    const anchorTimeText = String(a.time || "");
    $('[data-role="anchor-date"]').value = anchorTimeText.slice(0, 10);
    $('[data-role="anchor-time"]').value = a.precision === "date"
      ? ""
      : (anchorTimeText.length >= 19 ? anchorTimeText.slice(11, 19) : "");
    $('[data-role="anchor-content"]').value = String(a.content || "");
    setStatus('[data-role="anchor-write-status"]', a.project === "pending"
      ? "旧锚点尚未归类，请选择所属项目后保存"
      : "正在编辑既有锚点，保存后覆盖原条目");
  });

  if (window.location.hash === "#write") openWriter();
})();
