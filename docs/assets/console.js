/* 控制台启动与刷新编排。具体 UI 职责分别位于 console-*.js 模块。 */
(function () {
  "use strict";

  const PUBLIC_BASE = "https://api.flitfancy.com";
  const SENSOR_REFRESH_MS = 5000;
  const CONFIG_REFRESH_MS = 60000;
  const query = function (selector) { return document.querySelector(selector); };
  const serverOnline = window.FlitFancyAdmin.isAdminHost();

  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');

  function setStatus(ok) {
    query('[data-role="status"]').textContent = "";
    query('[data-role="dot"]').classList.toggle("offline", !ok);
  }

  async function request(url) {
    return window.FlitFancyAdmin.request(url);
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
      sensors.render(data.rows || []);
    } catch (e) {
      sensors.render([]);
    }
  }

  const services = window.FlitFancyConsoleServices.create();
  const sensors = window.FlitFancyConsoleSensors.create({
    query: query,
    request: request,
    publicBase: PUBLIC_BASE,
    overviewRefreshMs: CONFIG_REFRESH_MS,
  });
  const admin = window.FlitFancyConsoleAdmin.create({
    query: query,
    isServerOnline: function () { return serverOnline; },
    onAuthenticated: refresh,
  });
  const chat = window.FlitFancyConsoleChat.create({
    query: query,
    sendRequest: sendRequest,
    publicBase: PUBLIC_BASE,
    isServerOnline: function () { return serverOnline; },
    isAdmin: function () { return !!admin.token(); },
    setStatus: function (text) {
      query('[data-role="chat-status"]').textContent = text || "";
    },
  });

  async function refresh() {
    if (!serverOnline) {
      await readPublicSensors();
      return;
    }
    try {
      const status = await request("/api/status");
      setStatus(true);
      chat.setEnabled(status.chat_enabled !== false);
      services.setProtocolName(status.protocol_name);
      services.update(status.services);
      const latest = await request("/api/sensors/latest");
      (latest.rows || []).forEach(sensors.notePressure);
      sensors.render(latest.rows || []);
    } catch (e) {
      setStatus(false);
      services.update(null);
      await readPublicSensors();
    }
  }

  sensors.render([]);
  services.update(null);
  admin.start();
  chat.start();
  refresh();
  chat.refreshPublicConfig();
  setInterval(refresh, SENSOR_REFRESH_MS);
  setInterval(chat.refreshPublicConfig, CONFIG_REFRESH_MS);
})();
