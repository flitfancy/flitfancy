/* 控制台启动与刷新编排。具体 UI 职责分别位于 console-*.js 模块。 */
(async function () {
  "use strict";

  const PUBLIC_BASE = "https://api.flitfancy.com";
  const SENSOR_REFRESH_MS = 5000;
  const CONFIG_REFRESH_MS = 60000;
  const query = function (selector) { return document.querySelector(selector); };
  const failures = new Set();

  function reportFailure(name) {
    failures.add(name);
    query('[data-role="module-error-text"]').textContent =
      Array.from(failures).join("、") + "暂不可用，可刷新页面重试。";
    query('[data-role="module-error"]').hidden = false;
  }

  query('[data-role="module-reload"]').addEventListener("click", function () {
    window.location.reload();
  });

  // Only retry missing exports; successful scripts and running modules are never reinitialized.
  async function recoverScript(original) {
    const exportName = original.dataset.consoleModule;
    for (let attempt = 1; !window[exportName] && attempt <= 2; attempt++) {
      await new Promise(function (resolve) {
        const script = document.createElement("script");
        let timer;
        function finish() {
          clearTimeout(timer);
          script.onload = script.onerror = null;
          script.remove();
          resolve();
        }
        script.src = original.src + "&console_retry=" + attempt;
        script.onload = script.onerror = finish;
        timer = setTimeout(finish, 3000);
        document.head.appendChild(script);
      });
    }
  }

  await Promise.all(Array.from(document.querySelectorAll("script[data-console-module]")).map(recoverScript));
  if (!window.FlitFancyAdmin) {
    reportFailure("登录组件");
    return; // Never initialize private controls without the authentication core.
  }
  const serverOnline = window.FlitFancyAdmin.isAdminHost();

  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');

  function createModule(name, factory, options, dependencies) {
    try {
      if (!factory || (dependencies || []).some(function (value) { return !value; })) {
        throw new Error("Module unavailable");
      }
      return { name: name, instance: factory.create(options) };
    } catch (e) {
      reportFailure(name);
      return null;
    }
  }

  // Keep UI failures outside the network/authentication error path.
  function call(module, method, ...args) {
    if (!module || typeof module.instance[method] !== "function") return;
    try {
      const result = module.instance[method](...args);
      if (result && typeof result.catch === "function") {
        return result.catch(function () { reportFailure(module.name); });
      }
      return result;
    } catch (e) {
      reportFailure(module.name);
    }
  }

  function setStatus(ok, message) {
    query('[data-role="status"]').textContent = message || "";
    query('[data-role="dot"]').classList.toggle("offline", !ok);
  }

  async function request(url, options) {
    return window.FlitFancyAdmin.request(url, options);
  }

  async function sendRequest(url, body) {
    return window.FlitFancyAdmin.request(url, {
      method: "POST",
      body: JSON.stringify(body || {}),
    });
  }

  async function readPublicSensors() {
    try {
      const response = await fetch(PUBLIC_BASE + "/sensors/latest", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      call(sensors, "render", data.rows || []);
    } catch (e) {
      call(sensors, "render", []);
    }
  }

  const services = createModule("服务状态", window.FlitFancyConsoleServices);
  const sensors = createModule("环境数据", window.FlitFancyConsoleSensors, {
    query: query,
    request: request,
    publicBase: PUBLIC_BASE,
    overviewRefreshMs: CONFIG_REFRESH_MS,
  }, [window.FlitFancySensorState, window.FlitFancyConsoleOverview]);
  const admin = createModule("管理面板", window.FlitFancyConsoleAdmin, {
    query: query,
    isServerOnline: function () { return serverOnline; },
    onAuthenticated: refresh,
    onSignedOut: function () { call(launcher, "clearPrivate"); },
  }, [window.FlitFancyPanelShell, window.FlitFancyVisits]);
  const chat = createModule("对话", serverOnline ? window.FlitFancyConsoleDialogue : window.FlitFancyConsoleChat, {
    query: query,
    sendRequest: sendRequest,
    publicBase: PUBLIC_BASE,
    isServerOnline: function () { return serverOnline; },
    isAdmin: function () { return !!call(admin, "token"); },
    setStatus: function (text) {
      query('[data-role="chat-status"]').textContent = text || "";
    },
  });
  const audio = createModule("音频面板", window.FlitFancyConsoleAudio, {
    query: query,
    request: request,
    isServerOnline: function () { return serverOnline; },
    onState: function (state) { call(chat, "updateState", state); },
  });

  const launcher = createModule("本机启动", window.FlitFancyConsoleLauncher, {
    query: query, request: request,
    isServerOnline: function () { return serverOnline; },
    isAdmin: function () { return !!call(admin, "token"); },
  });

  async function refresh() {
    call(launcher, "refresh");
    if (!serverOnline) {
      await readPublicSensors();
      return;
    }
    try {
      const status = await request("/api/status");
      setStatus(true);
      call(admin, "setLoginRequired", false);
      call(chat, "setEnabled", status.dialogue_enabled !== false);
      call(services, "setProtocolName", status.protocol_name);
      call(services, "update", status.services);
      const latest = await request("/api/sensors/latest");
      (latest.rows || []).forEach(function (row) { call(sensors, "notePressure", row); });
      call(sensors, "render", latest.rows || []);
    } catch (e) {
      const needsLogin = window.FlitFancyAdmin.isUnauthorized(e);
      setStatus(false, needsLogin ? "需要登录" : "");
      if (needsLogin) call(admin, "setLoginRequired", true);
      call(services, "update", null);
      await readPublicSensors();
    }
  }

  call(sensors, "render", []);
  call(services, "update", null);
  call(admin, "start");
  call(chat, "start");
  call(audio, "start");
  call(launcher, "start");
  refresh();
  call(chat, "refreshPublicConfig");
  setInterval(refresh, SENSOR_REFRESH_MS);
  if (chat) setInterval(function () { call(chat, "refreshPublicConfig"); }, CONFIG_REFRESH_MS);
})();
