/* 控制台 AI 对话：会话记录、开关状态、发送路由与逐字显示。 */
(function (global) {
  "use strict";

  const CHAT_KEY = "flitfancy.chat.v1";

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const sendRequest = opts.sendRequest;
    const fetchPublic = opts.fetchPublic || global.fetch.bind(global);
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    const isServerOnline = opts.isServerOnline || function () { return false; };
    const isAdmin = opts.isAdmin || function () { return false; };
    const storage = opts.storage || global.sessionStorage;
    const setStatus = opts.setStatus || function (text) {
      query('[data-role="chat-status"]').textContent = text || "";
    };
    let history = loadHistory();
    let busy = false;
    let enabled = true;
    let started = false;

    function loadHistory() {
      try {
        const raw = storage.getItem(CHAT_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.slice(-40) : [];
      } catch (e) {
        return [];
      }
    }

    function saveHistory() {
      try {
        storage.setItem(CHAT_KEY, JSON.stringify(history.slice(-40)));
      } catch (e) { /* 忽略存储失败 */ }
    }

    function addMessage(role, text) {
      const log = query('[data-role="chat-log"]');
      const empty = query('[data-role="chat-empty"]');
      if (empty) empty.remove();
      const div = document.createElement("div");
      div.className = "chat-msg " + (role === "user" ? "user" : "ai");
      const who = document.createElement("span");
      who.className = "chat-who";
      who.textContent = role === "user" ? "你" : "AI";
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      div.appendChild(who);
      div.appendChild(paragraph);
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return paragraph;
    }

    function typewriter(element, text, done) {
      const reduce = global.matchMedia &&
        global.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        element.textContent = text;
        if (done) done();
        return;
      }
      let index = 0;
      (function tick() {
        index += 2;
        element.textContent = text.slice(0, index);
        const log = element.closest(".chat-log");
        if (log) log.scrollTop = log.scrollHeight;
        if (index < text.length) {
          global.setTimeout(tick, 16);
        } else if (done) {
          done();
        }
      })();
    }

    function applyGate() {
      const locked = !enabled || busy;
      query('[data-role="chat-input"]').disabled = locked;
      query('[data-role="chat-send"]').disabled = locked;
      if (!enabled) {
        setStatus(isAdmin()
          ? "AI 对话已由管理员关闭（可在管理层开启）"
          : "该项目暂未对游客开放哦~");
      }
    }

    function setEnabled(value) {
      enabled = value !== false;
      applyGate();
    }

    async function refreshPublicConfig() {
      if (isServerOnline()) return;
      try {
        const response = await fetchPublic(publicBase + "/config");
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        if (data && typeof data.chat_enabled === "boolean") {
          setEnabled(data.chat_enabled);
        }
      } catch (e) { /* 公网配置不可达则保留最近一次状态 */ }
    }

    async function send() {
      const input = query('[data-role="chat-input"]');
      const text = input.value.trim();
      if (!text || busy) return;
      if (!enabled) {
        setStatus("AI 对话已由管理员关闭");
        return;
      }
      busy = true;
      applyGate();
      setStatus("正在思考…");
      history.push({ role: "user", content: text });
      input.value = "";
      saveHistory();
      addMessage("user", text);
      try {
        // 一次发送只选择一个后端，禁止失败后把同一内容转发给另一个服务。
        const chatUrl = isServerOnline() ? "/api/chat" : publicBase + "/chat";
        const data = await sendRequest(chatUrl, { messages: history.slice(-20) });
        const reply = (data.reply || "").trim();
        if (!reply) throw new Error("AI 没有返回内容");
        history.push({ role: "assistant", content: reply });
        saveHistory();
        const paragraph = addMessage("ai", "");
        await new Promise(function (resolve) {
          typewriter(paragraph, reply, resolve);
        });
        setStatus("");
      } catch (e) {
        setStatus((e && e.message) || "出错了，稍后再试试。");
      } finally {
        busy = false;
        applyGate();
        input.focus();
      }
    }

    function start() {
      if (started) return;
      started = true;
      history.forEach(function (message) {
        addMessage(message.role, message.content);
      });
      query('[data-role="chat-send"]').addEventListener("click", send);
      query('[data-role="chat-input"]').addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      });
      applyGate();
    }

    return {
      start: start,
      send: send,
      setEnabled: setEnabled,
      refreshPublicConfig: refreshPublicConfig,
    };
  }

  global.FlitFancyConsoleChat = { create: create };
})(window);
