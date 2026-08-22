/* 云萤 · flitfancy —— 管理请求共享核心。
   console.js / journal-admin.js / remote.html 三处共用，避免行为再分叉：
   - 令牌读写（key 可配：本地登录令牌 vs 公网管理令牌）
   - 统一 8 秒超时（AbortController）
   - 鉴权头：authMode "relative"（仅相对 /api/ 路径带 Bearer）或 "always"
   - 非 2xx 统一抛带 status 的 Error（401 判定用状态码，不匹配中文文案）
   加载顺序：必须先于上述三个脚本（各 HTML 已放在最前）。 */
(function (global) {
  "use strict";
  const DEFAULT_KEY = "flitfancy.admin.token";

  function readToken(key) {
    try { return sessionStorage.getItem(key || DEFAULT_KEY) || ""; } catch (e) { return ""; }
  }

  function writeToken(key, value) {
    try {
      if (value) sessionStorage.setItem(key || DEFAULT_KEY, value);
      else sessionStorage.removeItem(key || DEFAULT_KEY);
    } catch (e) { /* ignore */ }
  }

  function isAdminHost() {
    const host = global.location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "console.flitfancy.com";
  }

  function isUnauthorized(value) {
    return Boolean(value && Number(value.status) === 401);
  }

  function applyAuth(headers, url, token, authMode) {
    if (!token) return;
    if (authMode === "always" || url.indexOf("/api/") === 0) {
      headers.Authorization = "Bearer " + token;
    }
  }

  const TIMEOUT_MS = 8000;   // 全站统一请求超时：管理请求/登录请求共用这一处

  async function fetchWithTimeout(url, opts, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, opts, { headers: headers, signal: ctrl.signal }));
    } catch (e) {
      if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
        const err = new Error("请求超时，请重试");
        err.status = 0;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 请求并解析 JSON；非 2xx 抛带 status 的 Error；8 秒超时。 */
  async function request(url, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    const authMode = opts.authMode || "relative";
    const token = authMode === "none" ? "" : readToken(opts.tokenKey);
    applyAuth(headers, url, token, authMode);
    if (opts.body) headers["Content-Type"] = "application/json";
    const response = await fetchWithTimeout(url, opts, headers);
    if (response.status === 401 && token) writeToken(opts.tokenKey, "");
    let data = null;
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!response.ok) {
      const err = new Error((data && (data.error || data.msg)) || ("HTTP " + response.status));
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** 返回原始 Response（console 的 adminFetch 风格），同样的超时与鉴权头。 */
  async function fetchRaw(url, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    const authMode = opts.authMode || "always";
    const token = authMode === "none" ? "" : readToken(opts.tokenKey);
    applyAuth(headers, url, token, authMode);
    if (opts.body) headers["Content-Type"] = "application/json";
    const response = await fetchWithTimeout(url, opts, headers);
    if (response.status === 401 && token) writeToken(opts.tokenKey, "");
    return response;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /* 日期格式化三件套（全站唯一实现，memory/anchors/journal-admin 共用）：
     - formatDateTime：ISO 串 → "YYYY-MM-DD HH:MM:SS"（precision="date" 时只到日）
     - formatDate：ISO 串 → "YYYY-MM-DD"（按本地时区，datetime-local 输入用）
     - nowForInput：当前本地时间 → datetime-local 值（YYYY-MM-DDTHH:MM:SS） */
  function formatDateTime(value, precision) {
    const text = String(value || "");
    if (precision === "date") return text.slice(0, 10);
    return text.slice(0, 19).replace("T", " ");
  }

  function formatDate(iso) {
    const d = new Date(String(iso || ""));
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function nowForInput() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function formatUnixTime(ts) {
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return "";
    return (d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  /* 页面级错误提示条：console/journal 共用的统一实现 */
  function installErrorHandler(selector) {
    window.addEventListener("error", function (event) {
      const el = document.querySelector(selector);
      if (!el) return;
      el.textContent = "脚本错误：" + (event.message || "unknown") +
        (event.filename ? " @" + event.filename.split("/").pop() + ":" + event.lineno : "");
      el.hidden = false;
    });
  }

  global.FlitFancyAdmin = {
    TIMEOUT_MS: TIMEOUT_MS,
    token: readToken,
    setToken: writeToken,
    isAdminHost: isAdminHost,
    isUnauthorized: isUnauthorized,
    request: request,
    fetchRaw: fetchRaw,
    pad: pad,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    nowForInput: nowForInput,
    formatUnixTime: formatUnixTime,
    installErrorHandler: installErrorHandler,
  };
})(window);
