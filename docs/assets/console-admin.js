/* 控制台管理层：本地登录、配置、快捷链接、访问统计与面板交互。 */
(function (global) {
  "use strict";

  const ADMIN_KEY = "flitfancy.admin.token";

  /* 只允许 http/https 的快捷入口，拒绝 javascript: 等危险 scheme。 */
  function safeLinkUrl(url) {
    const text = String(url || "").trim();
    return /^https?:\/\//i.test(text) ? text : "";
  }

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const isServerOnline = opts.isServerOnline || function () { return false; };
    const onAuthenticated = opts.onAuthenticated || function () {};
    const adminCore = global.FlitFancyAdmin;
    let panelShell = null;
    let visitsPanel = null;
    let quickLinks = [];
    let quickLinkEditing = -1;
    let started = false;

    function token() {
      return adminCore.token(ADMIN_KEY);
    }

    function setToken(value) {
      adminCore.setToken(ADMIN_KEY, value);
    }

    function clearToken() {
      adminCore.setToken(ADMIN_KEY, "");
    }

    async function adminFetch(url, options) {
      return adminCore.fetchRaw(url, Object.assign({ tokenKey: ADMIN_KEY }, options || {}));
    }

    function setStatus(element, text) {
      if (element) element.textContent = text || "";
    }

    function showPanel(show) {
      if (show) {
        panelShell.show();
      } else {
        panelShell.hide();
        panelShell.clearCollapsed();
      }
      query(".ffs-actions").hidden = !show;
      query('[data-role="admin-logout"]').hidden = !show;
    }

    function authFailed(response) {
      if (response.status !== 401) return false;
      clearToken();
      showPanel(false);
      return true;
    }

    function openLogin() {
      const username = query('[data-role="admin-username"]');
      const password = query('[data-role="admin-password"]');
      setStatus(query('[data-role="admin-login-status"]'), "");
      query('[data-role="admin-overlay"]').hidden = false;
      password.value = "";
      if (!username.value) username.focus();
      else password.focus();
    }

    function closeLogin() {
      query('[data-role="admin-overlay"]').hidden = true;
    }

    function modelSelectValue() {
      const select = query('[data-role="cfg-model"]');
      return select.value === "__custom__"
        ? query('[data-role="cfg-model-custom"]').value.trim()
        : select.value;
    }

    function setModelSelect(model) {
      const select = query('[data-role="cfg-model"]');
      const custom = query('[data-role="cfg-model-custom"]');
      const known = Array.prototype.some.call(select.options, function (option) {
        return option.value === model;
      });
      if (known && model) {
        select.value = model;
        custom.hidden = true;
        custom.value = "";
      } else {
        select.value = "__custom__";
        custom.hidden = false;
        custom.value = model || "";
      }
    }

    function openPopup(url) {
      const safe = safeLinkUrl(url);
      if (!safe) return;
      global.open(safe, "_blank", "noopener,noreferrer,width=980,height=680");
    }

    function renderQuickLinks() {
      const list = query('[data-role="quick-links"]');
      list.replaceChildren();
      quickLinks.forEach(function (link, index) {
        const item = document.createElement("li");
        const anchor = document.createElement("a");
        const safe = safeLinkUrl(link.url);
        anchor.href = safe || "#";
        anchor.textContent = link.name;
        anchor.addEventListener("click", function (event) {
          event.preventDefault();
          openPopup(link.url);
        });
        const edit = document.createElement("button");
        edit.className = "link-del";
        edit.textContent = "编辑";
        edit.addEventListener("click", function () { editQuickLink(index); });
        const remove = document.createElement("button");
        remove.className = "link-del";
        remove.textContent = "删除";
        remove.addEventListener("click", function () { removeQuickLink(index); });
        item.appendChild(anchor);
        item.appendChild(edit);
        item.appendChild(remove);
        list.appendChild(item);
      });
    }

    async function loadConfig() {
      try {
        const response = await adminFetch("/api/admin/config", { method: "GET" });
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 401) {
            clearToken();
            showPanel(false);
          }
          return;
        }
        setModelSelect(data.model || "");
        query('[data-role="cfg-chat-toggle"]').checked = !!data.chat_enabled;
        quickLinks = Array.isArray(data.quick_links) ? data.quick_links : [];
        quickLinkEditing = -1;
        query('[data-role="ql-add"]').textContent = "添加";
        renderQuickLinks();
        showPanel(true);
        visitsPanel.load();
      } catch (e) {
        if (adminCore.isUnauthorized(e)) {
          clearToken();
          showPanel(false);
          return;
        }
        showPanel(true);
        setStatus(query('[data-role="cfg-model-status"]'),
          (e && e.status === 0) ? "管理配置加载超时，登录状态已保留" : ((e && e.message) || "管理配置加载失败"));
      }
    }

    async function login() {
      const usernameInput = query('[data-role="admin-username"]');
      const passwordInput = query('[data-role="admin-password"]');
      const status = query('[data-role="admin-login-status"]');
      const button = query('[data-role="admin-login"]');
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      if (!username || !password) {
        setStatus(status, "请输入用户名和密码");
        return;
      }
      setStatus(status, "正在验证…");
      button.textContent = "验证中…";
      button.disabled = true;
      try {
        const response = await adminCore.fetchRaw("/api/admin/login", {
          method: "POST",
          authMode: "none",
          tokenKey: ADMIN_KEY,
          body: JSON.stringify({ username: username, password: password }),
        });
        let data = null;
        try {
          data = await response.json();
        } catch (e) { /* 非 JSON 响应（如公网静态页的 404） */ }
        if (!response.ok) {
          throw new Error(
            (data && data.error) ||
            "管理功能需要本地服务——请在本机运行 python server.py 后打开控制台"
          );
        }
        setToken(data.token);
        closeLogin();
        await loadConfig();
        onAuthenticated();
      } catch (e) {
        setStatus(status, (e && e.message) || "登录失败");
      } finally {
        button.textContent = "登录";
        button.disabled = false;
      }
    }

    async function saveModelConfig() {
      const status = query('[data-role="cfg-status"]');
      const model = modelSelectValue();
      if (!model) {
        setStatus(status, "请选择或输入模型");
        return;
      }
      setStatus(status, "保存中…");
      try {
        const response = await adminFetch("/api/admin/config", {
          method: "POST",
          body: JSON.stringify({ model: model }),
        });
        const data = await response.json();
        if (authFailed(response)) {
          setStatus(status, "登录已过期，请重新登录");
          return;
        }
        if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
        setModelSelect(data.model || model);
        setStatus(status, "已保存");
      } catch (e) {
        setStatus(status, (e && e.message) || "保存失败");
      }
    }

    async function saveChatToggle() {
      const status = query('[data-role="chat-toggle-status"]');
      const enabled = query('[data-role="cfg-chat-toggle"]').checked;
      setStatus(status, "保存中…");
      try {
        const response = await adminFetch("/api/admin/config", {
          method: "POST",
          body: JSON.stringify({ chat_enabled: enabled }),
        });
        const data = await response.json();
        if (authFailed(response)) {
          setStatus(status, "登录已过期，请重新登录");
          return;
        }
        if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
        const syncNote = data.public_sync === false
          ? "（公网同步失败：" + (data.public_sync_note || "未知") + "）"
          : "（已同步公网）";
        setStatus(status, (enabled ? "已开启" : "已关闭") + syncNote);
      } catch (e) {
        setStatus(status, (e && e.message) || "保存失败");
      }
    }

    async function saveQuickLinks() {
      const response = await adminFetch("/api/admin/config", {
        method: "POST",
        body: JSON.stringify({ quick_links: quickLinks }),
      });
      const data = await response.json();
      if (authFailed(response)) throw new Error("登录已过期，请重新登录");
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      quickLinks = Array.isArray(data.quick_links) ? data.quick_links : [];
      renderQuickLinks();
    }

    async function saveQuickLink() {
      const status = query('[data-role="ql-status"]');
      const name = query('[data-role="ql-name"]').value.trim();
      const url = query('[data-role="ql-url"]').value.trim();
      if (!name || !url) {
        setStatus(status, "名称和地址都要填");
        return;
      }
      if (!safeLinkUrl(url)) {
        setStatus(status, "地址必须以 http:// 或 https:// 开头");
        return;
      }
      try {
        if (quickLinkEditing >= 0) {
          quickLinks[quickLinkEditing] = { name: name, url: url };
        } else {
          quickLinks = quickLinks.concat([{ name: name, url: url }]);
        }
        await saveQuickLinks();
        query('[data-role="ql-name"]').value = "";
        query('[data-role="ql-url"]').value = "";
        quickLinkEditing = -1;
        query('[data-role="ql-add"]').textContent = "添加";
        setStatus(status, "已保存");
      } catch (e) {
        setStatus(status, (e && e.message) || "保存失败");
      }
    }

    function editQuickLink(index) {
      const link = quickLinks[index];
      if (!link) return;
      query('[data-role="ql-name"]').value = link.name;
      query('[data-role="ql-url"]').value = link.url;
      quickLinkEditing = index;
      query('[data-role="ql-add"]').textContent = "保存修改";
      setStatus(query('[data-role="ql-status"]'), "");
      query('[data-role="ql-name"]').focus();
    }

    async function removeQuickLink(index) {
      const status = query('[data-role="ql-status"]');
      try {
        quickLinks = quickLinks.filter(function (_, current) { return current !== index; });
        await saveQuickLinks();
        quickLinkEditing = -1;
        query('[data-role="ql-add"]').textContent = "添加";
        setStatus(status, "已删除");
      } catch (e) {
        setStatus(status, (e && e.message) || "删除失败");
      }
    }

    async function logout() {
      try {
        await adminFetch("/api/admin/logout", { method: "POST" });
      } catch (e) { /* ignore */ }
      clearToken();
      showPanel(false);
    }

    function bindEvents() {
      query('[data-role="admin-mode"]').addEventListener("click", function () {
        const bottom = document.body.classList.toggle("admin-mode-bottom");
        this.textContent = bottom ? "侧边模式" : "底部模式";
      });

      query('.nav nav a[href="console.html"]').addEventListener("click", function (event) {
        event.preventDefault();
        if (token()) {
          showPanel(true);
          visitsPanel.load();
          query('[data-role="admin-panel"]').scrollIntoView({
            behavior: "smooth", block: "start",
          });
          return;
        }
        if (isServerOnline()) {
          openLogin();
        } else {
          global.location.href = "https://console.flitfancy.com/console.html";
        }
      });

      query('[data-role="admin-login"]').addEventListener("click", login);
      query('[data-role="admin-cancel"]').addEventListener("click", closeLogin);
      query('[data-role="admin-password"]').addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          login();
        }
      });
      query('[data-role="cfg-save"]').addEventListener("click", saveModelConfig);
      query('[data-role="cfg-model"]').addEventListener("change", function () {
        const select = query('[data-role="cfg-model"]');
        const custom = query('[data-role="cfg-model-custom"]');
        custom.hidden = select.value !== "__custom__";
        if (select.value !== "__custom__") custom.value = "";
      });
      query('[data-role="cfg-chat-toggle"]').addEventListener("change", saveChatToggle);
      query('[data-role="ql-add"]').addEventListener("click", saveQuickLink);
      query('[data-role="admin-logout"]').addEventListener("click", logout);
      query('[data-role="visits-refresh"]').addEventListener("click", visitsPanel.load);
      query('[data-role="visits-group-toggle"]').addEventListener("click", function () {
        visitsPanel.toggleGrouping(this);
      });
    }

    function start() {
      if (started) return;
      started = true;
      panelShell = global.FlitFancyPanelShell.init({
        panel: query('[data-role="admin-panel"]'),
        grab: query('[data-role="admin-grab"]'),
        collapseBtn: query('[data-role="admin-collapse"]'),
        expandTab: query('[data-role="admin-expand-tab"]'),
        storageKey: "flitfancy.console.panelW",
        openClass: "admin-open",
        min: 280,
        max: 900,
      });
      visitsPanel = global.FlitFancyVisits.create({
        query: query,
        request: adminFetch,
        authFailed: authFailed,
        setStatus: setStatus,
        formatTime: adminCore.formatUnixTime,
      });
      bindEvents();
      if (token()) loadConfig();
    }

    return {
      start: start,
      token: token,
      loadConfig: loadConfig,
      showPanel: showPanel,
    };
  }

  global.FlitFancyConsoleAdmin = {
    create: create,
    safeLinkUrl: safeLinkUrl,
  };
})(window);
