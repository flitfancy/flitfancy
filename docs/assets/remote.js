/* 远程总闸（remote.html）逻辑：只开关公网 AI 聊天。
   与 console.js 的 saveChatToggle 是两条不同路径：
   - 本页：浏览器直连 api.flitfancy.com/admin/toggle，持公网管理令牌
     （不依赖本地后端，任何设备可用）；
   - 控制台：本地后端 /api/admin/config 中转，由后端持 worker_admin_token 同步云端。
   两者共用同一个 Worker 开关位，勿在两条路径上做不同语义。 */
(function () {
  "use strict";
  const API = "https://api.flitfancy.com/";
  const KEY = "flitfancy.remote.token";
  const $ = (sel) => document.querySelector(sel);
  let token = "";
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { /* ignore */ }
  if (token) $('[data-role="token"]').value = token;

  function msg(text, isError) {
    const el = $('[data-role="msg"]');
    el.textContent = text || "";
    el.style.color = isError ? "#ff9a9a" : "";
  }

  async function api(path, options, withToken) {
    /* 只有 /admin/* 操作才携带管理令牌；公开读（/config）不携带，
       避免令牌出现在不必要的公开请求上。 */
    return window.FlitFancyAdmin.request(API + path, Object.assign({}, options, {
      tokenKey: KEY,
      authMode: withToken ? "always" : "none"
    }));
  }

  function renderState(enabled) {
    const el = $('[data-role="status"]');
    el.textContent = "公网聊天当前：";
    const span = document.createElement("span");
    span.className = "state";
    span.textContent = enabled ? "开启" : "已关闭";
    el.appendChild(span);
  }

  async function refresh() {
    try {
      const d = await api("config", {}, false);   // 公开读，不带令牌
      renderState(d.chat_enabled !== false);
      msg("");
    } catch (e) {
      $('[data-role="status"]').textContent = "无法读取公网状态";
      msg((e && e.message) || "网络异常", true);
    }
  }

  async function toggle(enabled) {
    if (!token) {
      msg("请先输入管理令牌", true);
      return;
    }
    msg("正在操作…");
    try {
      const d = await api("admin/toggle", {
        method: "POST",
        body: JSON.stringify({ chat_enabled: enabled })
      }, true);   // 管理操作，携带令牌
      renderState(d.chat_enabled);
      msg(enabled ? "公网聊天已开启" : "公网聊天已关闭");
    } catch (e) {
      if (e && e.status === 401) {
        token = "";
        $('[data-role="token"]').value = "";
        msg("令牌无效或已轮换，请重新输入", true);
        return;
      }
      msg((e && e.message) || "操作失败", true);
    }
  }

  $('[data-role="off"]').addEventListener("click", function () { toggle(false); });
  $('[data-role="on"]').addEventListener("click", function () { toggle(true); });
  $('[data-role="save"]').addEventListener("click", function () {
    token = $('[data-role="token"]').value.trim();
    if (!token) {
      msg("请输入令牌", true);
      return;
    }
    try { sessionStorage.setItem(KEY, token); } catch (e) { /* ignore */ }
    msg("令牌已记住（本次会话有效）");
  });

  refresh();
})();
