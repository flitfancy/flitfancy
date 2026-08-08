(function () {
  const $ = (sel) => document.querySelector(sel);

  /* 页面级错误提示：任何脚本错误都会显示在左下角红条 */
  window.addEventListener("error", function (e) {
    const el = $('[data-role="js-error"]');
    if (el) {
      el.textContent = "脚本错误：" + (e.message || "unknown") +
        (e.filename ? " @" + e.filename.split("/").pop() + ":" + e.lineno : "");
      el.hidden = false;
    }
  });

  /* ---------- 请求工具 ---------- */
  async function getJSON(url) {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || ("HTTP " + r.status));
      err.data = data;
      throw err;
    }
    return data || {};
  }

  /* ---------- 状态与数据行 ---------- */
  function setStatus(text, ok) {
    $('[data-role="status"]').textContent = text;
    $('[data-role="dot"]').style.background = ok ? "" : "#8b94a8";
  }

  function setChatStatus(text) {
    $('[data-role="chat-status"]').textContent = text || "";
  }

  function fmt(v, d) {
    if (v == null || isNaN(Number(v))) return "—";
    return Number(v).toFixed(d == null ? 1 : d);
  }

  function renderLiveStrip(rows) {
    const el = $('[data-role="live-strip"]');
    const byChannel = {};
    (rows || []).forEach(function (r) { byChannel[r.channel] = r; });
    const parts = [];

    const ch0 = byChannel["CH0"];
    if (ch0 && ch0.temp_c != null) {
      parts.push("CH0 " + fmt(ch0.temp_c, 1) + "°C " + fmt(ch0.rh_pct, 0) + "%RH");
    }
    const ch1 = byChannel["CH1"];
    if (ch1 && ch1.pressure_pa != null) {
      parts.push("CH1 " + fmt(ch1.pressure_pa / 100, 1) + "hPa");
    }
    const ch2 = byChannel["CH2"];
    if (ch2 && ch2.als_raw != null) {
      parts.push("CH2 " + fmt(ch2.als_raw, 0) + " raw");
    }
    const ch3 = byChannel["CH3"];
    if (ch3 && ch3.uv_raw != null) {
      parts.push("CH3 UV " + fmt(ch3.uv_raw, 0));
    } else if (ch3 && ch3.als_raw != null) {
      parts.push("CH3 ALS " + fmt(ch3.als_raw, 0));
    }
    const ch4 = byChannel["CH4"];
    if (ch4 && ch4.voc_index != null) {
      parts.push("CH4 VOC " + fmt(ch4.voc_index, 0) + " NOx " + fmt(ch4.nox_index, 0));
    }
    const ch5 = byChannel["CH5"];
    if (ch5 && ch5.co2_ppm != null) {
      parts.push("CH5 " + fmt(ch5.co2_ppm, 0) + " ppm");
    }

    el.textContent = parts.length ? parts.join("  ·  ") : "暂无感知数据";
  }

  /* ---------- 对话 ---------- */
  const CHAT_KEY = "flitfancy.chat.v1";
  const PUBLIC_API = "https://api.flitfancy.com/";
  const PUBLIC_BASE = PUBLIC_API.replace(/\/+$/, "");

  let chatHistory = loadChat();
  let chatBusy = false;
  let chatEnabled = true;

  function loadChat() {
    try {
      const raw = sessionStorage.getItem(CHAT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(-40) : [];
    } catch (e) {
      return [];
    }
  }

  function saveChat() {
    try {
      sessionStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-40)));
    } catch (e) { /* 忽略存储失败 */ }
  }

  function addChatMsg(role, text) {
    const log = $('[data-role="chat-log"]');
    const empty = $('[data-role="chat-empty"]');
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = "chat-msg " + (role === "user" ? "user" : "ai");
    const who = document.createElement("span");
    who.className = "chat-who";
    who.textContent = role === "user" ? "你" : "AI";
    const p = document.createElement("p");
    p.textContent = text;
    div.appendChild(who);
    div.appendChild(p);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return p;
  }

  function typewriter(el, text, done) {
    const reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      el.textContent = text;
      if (done) done();
      return;
    }
    let i = 0;
    (function tick() {
      i += 2;
      el.textContent = text.slice(0, i);
      const log = el.closest(".chat-log");
      if (log) log.scrollTop = log.scrollHeight;
      if (i < text.length) {
        setTimeout(tick, 16);
      } else if (done) {
        done();
      }
    })();
  }

  function applyChatGate() {
    const locked = !chatEnabled || chatBusy;
    $('[data-role="chat-input"]').disabled = locked;
    $('[data-role="chat-send"]').disabled = locked;
    if (!chatEnabled) {
      setChatStatus("AI 对话已由管理员关闭（可在管理层开启）");
    }
  }

  async function refresh() {
    try {
      const status = await getJSON("/api/status");
      setStatus(status.msg, true);
      chatEnabled = status.chat_enabled !== false;
      applyChatGate();
      const latest = await getJSON("/api/sensors/latest");
      renderLiveStrip(latest.rows);
    } catch (e) {
      setStatus("控制台服务未连接——请运行 python server.py", false);
      try {
        const r = await fetch(PUBLIC_BASE + "/config");
        const data = await r.json();
        if (data && data.chat_enabled === false) {
          chatEnabled = false;
          applyChatGate();
        }
      } catch (e2) { /* 公网配置不可达则保持默认 */ }
    }
  }

  async function sendChat() {
    const input = $('[data-role="chat-input"]');
    const text = input.value.trim();
    if (!text || chatBusy) return;
    if (!chatEnabled) {
      setChatStatus("AI 对话已由管理员关闭");
      return;
    }
    chatBusy = true;
    applyChatGate();
    setChatStatus("正在思考…");
    chatHistory.push({ role: "user", content: text });
    input.value = "";
    saveChat();
    addChatMsg("user", text);
    try {
      const urls = ["/api/chat", PUBLIC_API];
      let r = null;
      let lastErr = null;
      for (const url of urls) {
        try {
          r = await postJSON(url, { messages: chatHistory.slice(-20) });
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!r) throw lastErr || new Error("无法连接服务");
      const reply = (r.reply || "").trim();
      if (!reply) throw new Error("AI 没有返回内容");
      chatHistory.push({ role: "assistant", content: reply });
      saveChat();
      const p = addChatMsg("ai", "");
      await new Promise(function (resolve) {
        typewriter(p, reply, resolve);
      });
      setChatStatus("");
    } catch (e) {
      setChatStatus((e && e.message) || "出错了，稍后再试试。");
    } finally {
      chatBusy = false;
      applyChatGate();
      input.focus();
    }
  }

  /* ---------- 管理层 ---------- */
  const ADMIN_KEY = "flitfancy.admin.token";

  function adminToken() {
    try { return sessionStorage.getItem(ADMIN_KEY) || ""; } catch (e) { return ""; }
  }
  function setAdminToken(t) {
    try { sessionStorage.setItem(ADMIN_KEY, t); } catch (e) { /* ignore */ }
  }
  function clearAdminToken() {
    try { sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ }
  }

  async function adminFetch(url, options) {
    const headers = Object.assign({}, (options && options.headers) || {});
    const token = adminToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    if (options && options.body) headers["Content-Type"] = "application/json";
    return fetch(url, Object.assign({}, options, { headers }));
  }

  function adminStatus(el, text) {
    if (el) el.textContent = text || "";
  }

  function openLogin() {
    const uname = $('[data-role="admin-username"]');
    const input = $('[data-role="admin-password"]');
    adminStatus($('[data-role="admin-login-status"]'), "");
    $('[data-role="admin-overlay"]').hidden = false;
    input.value = "";
    if (!uname.value) {
      uname.focus();
    } else {
      input.focus();
    }
  }

  function closeLogin() {
    $('[data-role="admin-overlay"]').hidden = true;
  }

  function showAdminPanel(show) {
    $('[data-role="admin-panel"]').hidden = !show;
  }

  let quickLinks = [];
  let quickLinkEditing = -1;

  function modelSelectValue() {
    const sel = $('[data-role="cfg-model"]');
    return sel.value === "__custom__"
      ? $('[data-role="cfg-model-custom"]').value.trim()
      : sel.value;
  }

  function setModelSelect(model) {
    const sel = $('[data-role="cfg-model"]');
    const custom = $('[data-role="cfg-model-custom"]');
    const known = Array.prototype.some.call(sel.options, function (o) {
      return o.value === model;
    });
    if (known && model) {
      sel.value = model;
      custom.hidden = true;
      custom.value = "";
    } else {
      sel.value = "__custom__";
      custom.hidden = false;
      custom.value = model || "";
    }
  }

  function openPopup(name, url) {
    const w = window.open(url, name, "width=980,height=680");
    if (!w) window.open(url, "_blank");
  }

  function renderQuickLinks() {
    const ul = $('[data-role="quick-links"]');
    ul.innerHTML = "";
    quickLinks.forEach(function (link, idx) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = link.url;
      a.textContent = link.name;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        openPopup(link.name, link.url);
      });
      const edit = document.createElement("button");
      edit.className = "link-del";
      edit.textContent = "编辑";
      edit.addEventListener("click", function () { editQuickLink(idx); });
      const del = document.createElement("button");
      del.className = "link-del";
      del.textContent = "删除";
      del.addEventListener("click", function () { removeQuickLink(idx); });
      li.appendChild(a);
      li.appendChild(edit);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  async function loadAdminConfig() {
    try {
      const r = await adminFetch("/api/admin/config", { method: "GET" });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) {
          clearAdminToken();
          showAdminPanel(false);
        }
        return;
      }
      setModelSelect(data.model || "");
      $('[data-role="cfg-chat-toggle"]').checked = !!data.chat_enabled;
      quickLinks = Array.isArray(data.quick_links) ? data.quick_links : [];
      quickLinkEditing = -1;
      $('[data-role="ql-add"]').textContent = "添加";
      renderQuickLinks();
      showAdminPanel(true);
    } catch (e) {
      clearAdminToken();
      showAdminPanel(false);
    }
  }

  async function doLogin() {
    const uname = $('[data-role="admin-username"]');
    const input = $('[data-role="admin-password"]');
    const status = $('[data-role="admin-login-status"]');
    const btn = $('[data-role="admin-login"]');
    const username = uname.value.trim();
    const password = input.value;
    if (!username || !password) {
      adminStatus(status, "请输入用户名和密码");
      return;
    }
    adminStatus(status, "正在验证…");
    btn.textContent = "验证中…";
    btn.disabled = true;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 8000);
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, password: password }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      setAdminToken(data.token);
      closeLogin();
      await loadAdminConfig();
    } catch (e) {
      adminStatus(status, (e && e.message) || "登录失败");
    }
    btn.textContent = "登录";
    btn.disabled = false;
  }

  async function saveModelConfig() {
    const status = $('[data-role="cfg-status"]');
    const model = modelSelectValue();
    if (!model) {
      adminStatus(status, "请选择或输入模型");
      return;
    }
    adminStatus(status, "保存中…");
    try {
      const r = await adminFetch("/api/admin/config", {
        method: "POST",
        body: JSON.stringify({ model: model })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      setModelSelect(data.model || model);
      adminStatus(status, "已保存");
    } catch (e) {
      if (e && e.message === "未登录或登录已过期") {
        clearAdminToken();
        showAdminPanel(false);
      }
      adminStatus(status, (e && e.message) || "保存失败");
    }
  }

  async function saveChatToggle() {
    const status = $('[data-role="chat-toggle-status"]');
    const on = $('[data-role="cfg-chat-toggle"]').checked;
    adminStatus(status, "保存中…");
    try {
      const r = await adminFetch("/api/admin/config", {
        method: "POST",
        body: JSON.stringify({ chat_enabled: on })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      const syncNote = data.public_sync === false
        ? "（公网同步失败：" + (data.public_sync_note || "未知") + "）"
        : "（已同步公网）";
      adminStatus(status, (on ? "已开启" : "已关闭") + syncNote);
    } catch (e) {
      adminStatus(status, (e && e.message) || "保存失败");
    }
  }

  async function saveQuickLinks() {
    const r = await adminFetch("/api/admin/config", {
      method: "POST",
      body: JSON.stringify({ quick_links: quickLinks })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    quickLinks = Array.isArray(data.quick_links) ? data.quick_links : [];
    renderQuickLinks();
  }

  async function saveQuickLink() {
    const status = $('[data-role="ql-status"]');
    const name = $('[data-role="ql-name"]').value.trim();
    const url = $('[data-role="ql-url"]').value.trim();
    if (!name || !url) {
      adminStatus(status, "名称和地址都要填");
      return;
    }
    try {
      if (quickLinkEditing >= 0) {
        quickLinks[quickLinkEditing] = { name: name, url: url };
      } else {
        quickLinks = quickLinks.concat([{ name: name, url: url }]);
      }
      await saveQuickLinks();
      $('[data-role="ql-name"]').value = "";
      $('[data-role="ql-url"]').value = "";
      quickLinkEditing = -1;
      $('[data-role="ql-add"]').textContent = "添加";
      adminStatus(status, "已保存");
    } catch (e) {
      adminStatus(status, (e && e.message) || "保存失败");
    }
  }

  function editQuickLink(idx) {
    const link = quickLinks[idx];
    if (!link) return;
    $('[data-role="ql-name"]').value = link.name;
    $('[data-role="ql-url"]').value = link.url;
    quickLinkEditing = idx;
    $('[data-role="ql-add"]').textContent = "保存修改";
    adminStatus($('[data-role="ql-status"]'), "");
    $('[data-role="ql-name"]').focus();
  }

  async function removeQuickLink(idx) {
    const status = $('[data-role="ql-status"]');
    try {
      quickLinks = quickLinks.filter(function (_, i) { return i !== idx; });
      await saveQuickLinks();
      quickLinkEditing = -1;
      $('[data-role="ql-add"]').textContent = "添加";
      adminStatus(status, "已删除");
    } catch (e) {
      adminStatus(status, (e && e.message) || "删除失败");
    }
  }

  async function doLogout() {
    try {
      await adminFetch("/api/admin/logout", { method: "POST" });
    } catch (e) { /* ignore */ }
    clearAdminToken();
    showAdminPanel(false);
  }

  /* ---------- 事件绑定 ---------- */
  $('.nav nav a[href="console.html"]').addEventListener("click", function (e) {
    e.preventDefault();
    if (adminToken()) {
      showAdminPanel(true);
      $('[data-role="admin-panel"]').scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      openLogin();
    }
  });

  $('[data-role="chat-send"]').addEventListener("click", sendChat);
  $('[data-role="chat-input"]').addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  $('[data-role="admin-login"]').addEventListener("click", doLogin);
  $('[data-role="admin-cancel"]').addEventListener("click", closeLogin);
  $('[data-role="admin-password"]').addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doLogin();
    }
  });
  $('[data-role="cfg-save"]').addEventListener("click", saveModelConfig);
  $('[data-role="cfg-model"]').addEventListener("change", function () {
    const sel = $('[data-role="cfg-model"]');
    const custom = $('[data-role="cfg-model-custom"]');
    custom.hidden = sel.value !== "__custom__";
    if (sel.value !== "__custom__") custom.value = "";
  });
  $('[data-role="cfg-chat-toggle"]').addEventListener("change", saveChatToggle);
  $('[data-role="ql-add"]').addEventListener("click", saveQuickLink);
  $('[data-role="admin-logout"]').addEventListener("click", doLogout);

  /* ---------- 启动 ---------- */
  chatHistory.forEach(function (m) {
    addChatMsg(m.role, m.content);
  });
  if (adminToken()) loadAdminConfig();
  refresh();
  setInterval(refresh, 5000);
})();
