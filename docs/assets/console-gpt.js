/* 模型直聊：不复用小流萤会话，不在浏览器持久化消息。 */
(function (global) {
  "use strict";

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const modes = query('[data-role="dialogue-modes"]');
    const fireflyPanel = query('[data-role="firefly-chat-panel"]');
    const gptPanel = query('[data-role="gpt-chat-panel"]');
    const fireflyMode = query('[data-role="mode-firefly"]');
    const gptMode = query('[data-role="mode-gpt"]');
    const log = query('[data-role="gpt-log"]');
    const input = query('[data-role="gpt-input"]');
    const sendButton = query('[data-role="gpt-send"]');
    const clearButton = query('[data-role="gpt-clear"]');
    const status = query('[data-role="gpt-status"]');
    const settings = query('[data-role="gpt-settings"]');
    const publicMode = opts.publicMode === true;
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    let authenticated = false, started = false, mode = "firefly", ready = false;
    let sending = false, epoch = 0, configRevision = 0, profileId = "", modelLabel = "模型";
    let history = [];

    function gate() {
      input.disabled = !authenticated || !ready || sending;
      sendButton.disabled = input.disabled;
      clearButton.disabled = !authenticated || sending;
    }

    function addMessage(role, text) {
      const row = document.createElement("div");
      row.className = "chat-msg " + (role === "user" ? "user" : "ai");
      const who = document.createElement("span");
      who.className = "chat-who";
      who.textContent = role === "user" ? "你" : modelLabel;
      const body = document.createElement("p");
      body.textContent = text;
      row.appendChild(who); row.appendChild(body); log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }

    function render() {
      log.replaceChildren();
      if (!history.length) {
        const empty = document.createElement("p");
        empty.className = "chat-empty"; empty.textContent = "从这里开始和模型对话。";
        log.appendChild(empty);
      } else {
        history.forEach(function (item) { addMessage(item.role, item.content); });
      }
    }

    function publicContext(items) {
      const selected = [];
      let total = 0;
      for (let index = items.length - 1; index >= 0 && selected.length < 6; index--) {
        const item = items[index];
        const limit = item.role === "user" ? 1000 : 4000;
        const text = item.content.slice(0, limit);
        if (total + text.length > 6000) break;
        selected.unshift({role: item.role, content: text});
        total += text.length;
      }
      return selected;
    }

    function selectMode(next) {
      if (!authenticated || (publicMode && next === "gpt" && !ready)) return;
      mode = next === "gpt" ? "gpt" : "firefly";
      fireflyPanel.hidden = mode !== "firefly";
      gptPanel.hidden = mode !== "gpt";
      fireflyMode.setAttribute("aria-pressed", String(mode === "firefly"));
      gptMode.setAttribute("aria-pressed", String(mode === "gpt"));
      if (mode === "gpt") { render(); void refreshStatus(); }
      gate();
    }

    async function refreshStatus() {
      if (!authenticated) return;
      const current = epoch, revision = ++configRevision;
      try {
        const data = await opts.request(publicMode ? publicBase + "/gpt/status" : "/api/model-gateway/status",
          publicMode ? {authMode: "none"} : undefined);
        if (current !== epoch || revision !== configRevision) return;
        const nextProfile = data.profile_id || "";
        const changed = Boolean(profileId && nextProfile && nextProfile !== profileId);
        if (changed) {
          epoch++; history = []; sending = false; render();
          status.textContent = "模型配置已改变，已开始新对话。";
        }
        if (nextProfile) profileId = nextProfile;
        modelLabel = data.provider_label || "模型";
        if (publicMode) {
          ready = data.enabled === true;
          modes.hidden = !authenticated || !ready;
          if (!ready && mode === "gpt") {
            mode = "firefly"; fireflyPanel.hidden = false; gptPanel.hidden = true;
            fireflyMode.setAttribute("aria-pressed", "true"); gptMode.setAttribute("aria-pressed", "false");
          }
          gate();
          return {ok: true};
        }
        ready = data.configured === true && data.access !== "off";
        if (!sending && !ready) status.textContent = data.access === "off"
          ? "网页模型直聊已关闭，可在控制台设置访问范围。" : "请先在控制台配置模型接口和密钥。";
        else if (!sending && !changed) status.textContent = "";
      } catch (error) {
        if (current !== epoch || revision !== configRevision) return;
        ready = false;
        if (publicMode) {
          modes.hidden = true;
          if (mode === "gpt") { mode = "firefly"; fireflyPanel.hidden = false; gptPanel.hidden = true; }
          gate();
          return {ok: false, status: error.status || 0};
        }
        status.textContent = error.message || "请检查本机服务。";
      }
      gate();
      return {ok: true};
    }

    async function send() {
      const text = input.value.trim();
      if (!authenticated || !ready || sending || !text) return;
      const maxLength = publicMode ? 1000 : 4000;
      if (text.length > maxLength) { status.textContent = "每条消息最多 " + maxLength + " 字。"; return; }
      history.push({role: "user", content: text});
      history = history.slice(publicMode ? -6 : -20);
      input.value = "";
      render();
      const current = epoch;
      sending = true; status.textContent = "模型正在思考…"; gate();
      try {
        const data = await opts.request(publicMode ? publicBase + "/gpt/chat" : "/api/model-gateway/chat", {
          method: "POST", body: JSON.stringify({messages: publicMode ? publicContext(history) : history, profile_id: profileId}), timeoutMs: 110000,
          authMode: publicMode ? "none" : "relative",
        });
        if (current !== epoch) return;
        if (!data.reply) throw new Error("模型没有返回内容。");
        history.push({role: "assistant", content: data.reply});
        render(); status.textContent = "";
      } catch (error) {
        if (current !== epoch) return;
        if (error.status === 409) {
          history = []; profileId = ""; sending = false; render();
          await refreshStatus();
          status.textContent = "模型配置已改变，请重新发送。";
        } else {
          status.textContent = error.message || "对话暂时不可用，请稍后重试。";
        }
      } finally {
        if (current === epoch) { sending = false; gate(); }
      }
    }

    function clearPrivate() {
      epoch++; configRevision++; authenticated = false; ready = false; sending = false;
      mode = "firefly"; history = []; profileId = ""; modelLabel = "模型"; input.value = "";
      status.textContent = "";
      modes.hidden = true; fireflyPanel.hidden = false; gptPanel.hidden = true;
      fireflyMode.setAttribute("aria-pressed", "true"); gptMode.setAttribute("aria-pressed", "false");
      render(); gate();
    }

    function setAuthenticated(value) {
      if (!value) { if (authenticated) clearPrivate(); return; }
      authenticated = true;
      modes.hidden = publicMode && !ready;
      gate();
    }

    function start() {
      if (started) return;
      started = true;
      if (publicMode) { settings.hidden = true; fireflyMode.textContent = "访客对话"; input.maxLength = 1000; }
      fireflyMode.addEventListener("click", function () { selectMode("firefly"); });
      gptMode.addEventListener("click", function () { selectMode("gpt"); });
      sendButton.addEventListener("click", send);
      clearButton.addEventListener("click", function () { if (!sending) { history = []; status.textContent = ""; render(); } });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
      });
      modes.hidden = !authenticated || (publicMode && !ready);
      if (publicMode && authenticated) void refreshStatus();
      gate();
    }

    return {start: start, setAuthenticated: setAuthenticated, clearPrivate: clearPrivate, dispose: clearPrivate,
      selectMode: selectMode, refreshStatus: refreshStatus, send: send};
  }

  global.FlitFancyConsoleGPT = {create: create};
})(window);
