/* 私有控制台对话：AstrBot 是历史来源，浏览器只保存当前页面状态。 */
(function (global) {
  "use strict";

  function displayText(text) {
    return String(text || "")
      .replace(/\[File Attachment: name (.*?), path [^\]\r\n]+\]/g, "[附件：$1]")
      .replace(/\[Image Attachment: path [^\]\r\n]+\]/g, "[图片]")
      .replace(/<\/?(?:attachment|image_caption)>/g, "").trim();
  }

  function presentation(state, now) {
    if (!state || !state.available) return { phase: "offline", label: "对话服务未连接", note: "连接本机服务后继续聊天" };
    const conversation = state.conversation || {};
    const bridge = state.dialogue || {};
    const online = conversation.connected && (now || Date.now()) / 1000 - Number(bridge.last_seen || 0) < 30;
    if (!online) return { phase: "offline", label: "等待 AstrBot", note: "历史保存在本机，服务上线后自动同步" };
    const turn = state.voice_turn;
    if (state.recording && turn) return { phase: "listening", label: turn.phase === "cue" ? "已唤醒" : "正在听你说", note: turn.phase === "cue" ? "提示音后说话" : "说完稍停，会自动提交" };
    if (turn && turn.phase === "processing") return { phase: "recognizing", label: "正在识别", note: "正在整理刚才的话" };
    const pending = (conversation.requests || []).find(function (item) { return item.phase === "queued" || item.phase === "thinking"; });
    if (pending) return { phase: "thinking", label: "正在思考", note: "已收到网页消息，等她回复" };
    if (bridge.phase === "thinking") return { phase: "thinking", label: "正在思考", note: "已收到你的话，等她回复" };
    if (bridge.phase === "text" || bridge.phase === "playing") return { phase: "speaking", label: bridge.phase === "text" ? "正在准备语音" : "正在回答", note: "回复会从板子播放" };
    if (bridge.phase === "error") return { phase: "error", label: "本轮未完成", note: String(bridge.error || "请稍后再试") };
    if (!state.board_connected) return { phase: "ready", label: "可以文字聊天", note: "板子未连接，网页对话仍可使用" };
    if (!state.wakeword || !state.wakeword.enabled) return { phase: "ready", label: "可以文字聊天", note: "语音唤醒已关闭" };
    return { phase: "ready", label: "待唤醒", note: "说“小萤小萤”，或直接在下方输入" };
  }

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const input = query('[data-role="chat-input"]');
    const sendButton = query('[data-role="chat-send"]');
    const log = query('[data-role="chat-log"]');
    const status = query('[data-role="chat-status"]');
    const badge = query('[data-role="dialogue-state"]');
    const note = query('[data-role="dialogue-note"]');
    const reply = query('[data-role="audio-reply"]');
    const sessionSelect = query('[data-role="firefly-history"]');
    const sessionNew = query('[data-role="firefly-new"]');
    let state = null;
    let enabled = true;
    let sending = false;
    let pending = null;
    let revision = null;
    let started = false;
    let sendError = "";
    let privacyRevision = 0;
    let controlPending = null;
    let catalogRevision = "";

    function activeControl(history) {
      return ((history && history.controls) || []).find(function (item) {
        return item.phase === "queued" || item.phase === "running" || item.phase === "uncertain";
      });
    }

    function gate() {
      const history = state && state.conversation;
      const sessions = history && history.session_history;
      const offline = !state || !state.available || !history || !history.connected || !state.dialogue || state.dialogue.protocol !== 2;
      const locked = Boolean(controlPending || activeControl(sessions));
      input.disabled = !enabled || sending || Boolean(pending) || offline || locked || Boolean(opts.isAdmin && !opts.isAdmin());
      sendButton.disabled = input.disabled;
      const controlsDisabled = !enabled || offline || sending || Boolean(pending) || locked || !sessions || !sessions.connected;
      sessionSelect.disabled = controlsDisabled;
      sessionNew.disabled = controlsDisabled;
    }

    function renderSessions(sessions) {
      const rows = (sessions && sessions.conversations) || [];
      const current = (sessions && sessions.current_id) || "";
      const fingerprint = JSON.stringify([current, rows]);
      if (fingerprint === catalogRevision) return;
      catalogRevision = fingerprint;
      sessionSelect.replaceChildren();
      if (!rows.length) {
        const option = document.createElement("option");
        option.value = ""; option.textContent = sessions && sessions.connected ? "暂无旧对话" : "等待会话服务";
        sessionSelect.appendChild(option);
      }
      rows.forEach(function (row) {
        const option = document.createElement("option");
        option.value = row.id;
        option.textContent = row.title || "未命名对话";
        sessionSelect.appendChild(option);
      });
      sessionSelect.value = current;
    }

    function message(role, text) {
      const row = document.createElement("div");
      row.className = "chat-msg " + (role === "user" ? "user" : "ai");
      const who = document.createElement("span");
      who.className = "chat-who";
      who.textContent = role === "user" ? "你" : "她";
      const body = document.createElement("p");
      body.textContent = displayText(text);
      row.appendChild(who); row.appendChild(body); log.appendChild(row);
    }

    function updateState(value) {
      if (opts.isAdmin && !opts.isAdmin()) value = null;
      state = value;
      const view = presentation(state);
      badge.textContent = view.label; badge.dataset.phase = view.phase;
      note.textContent = view.note;
      if (!state || !state.available) {
        privacyRevision++; sending = false;
        if (reply) reply.textContent = "等待回复";
        log.replaceChildren(); revision = null;
        pending = null; sendError = ''; input.value = '';
        controlPending = null; catalogRevision = ""; renderSessions(null);
        status.textContent = opts.isAdmin && !opts.isAdmin() ? "请先登录，再使用有求必应。" : "请连接本机服务。";
        gate(); return;
      }
      const history = state.conversation || {};
      const sessions = history.session_history;
      renderSessions(sessions);
      if (controlPending) {
        const result = ((sessions && sessions.controls) || []).find(function (row) { return row.request_id === controlPending.id; });
        if (result && (result.phase === "complete" || result.phase === "error")) {
          sendError = result.error || ""; controlPending = null;
        } else if (result && result.phase === "uncertain") {
          sendError = result.error || "操作结果不确定，请核对当前会话";
        } else if (!result && Date.now() - controlPending.started > 70000) {
          sendError = "操作结果不确定，请核对当前会话；没有自动重试"; controlPending = null;
        }
      }
      if (history.ready && revision !== history.revision) {
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.replaceChildren();
        (history.messages || []).forEach(function (row) { message(row.role, row.content); });
        if (reply) {
          const latest = (history.messages || []).slice().reverse().find(function (row) { return row.role === "assistant"; });
          reply.textContent = latest ? displayText(latest.content) : "等待回复";
        }
        if (atBottom || revision === null) log.scrollTop = log.scrollHeight;
        revision = history.revision;
      }
      if (pending) {
        const current = (history.requests || []).find(function (item) { return item.session === pending.session; });
        if (current && (current.phase === "complete" || current.phase === "error")) {
          sendError = current.error || "";
          pending = null;
        } else if (Date.now() - pending.started > 250000) {
          sendError = "本轮等待超时，未自动重发。"; pending = null;
        }
      }
      status.textContent = !enabled ? "AI 对话已由管理员关闭" : sendError || (controlPending || activeControl(sessions) ? "正在切换共享会话…" : pending ? "已发送：" + pending.text :
        history.ready ? "网页、QQ 与板子共用对话 · 展示最近 40 条" : "正在同步本机对话…");
      gate();
    }

    async function send() {
      const text = input.value.trim();
      if (!text || input.disabled || sending || pending) return;
      if (text.length > 2000) { status.textContent = "每条消息最多 2000 字"; return; }
      const key = global.crypto.randomUUID();
      const current = privacyRevision;
      sending = true; sendError = ""; gate();
      status.textContent = "正在提交…";
      try {
        const result = await opts.sendRequest("/api/dialogue/messages", { text: text, request_id: key });
        if (current !== privacyRevision) return;
        pending = { session: result.session, text: text, started: Date.now() };
        input.value = "";
        status.textContent = "已发送：" + text;
        badge.textContent = "正在思考";
      } catch (error) {
        if (current !== privacyRevision) return;
        sendError = error.message || "提交失败，请检查本机服务。";
        status.textContent = sendError;
      } finally { if (current === privacyRevision) { sending = false; gate(); } }
    }

    async function changeSession(action, target) {
      if (sessionNew.disabled || controlPending) return;
      if (action === "select" && target === ((state.conversation.session_history || {}).current_id || "")) return;
      const id = global.crypto.randomUUID();
      const current = privacyRevision;
      controlPending = { id: id, started: Date.now() };
      sendError = ""; gate(); status.textContent = "正在切换共享会话…";
      try {
        await opts.sendRequest("/api/dialogue/conversations", { action: action, request_id: id, conversation_id: target || "" });
      } catch (error) {
        if (current !== privacyRevision) return;
        if (error.status >= 400 && error.status < 500) {
          controlPending = null; sendError = error.message || "会话切换失败";
          catalogRevision = ""; renderSessions(state && state.conversation && state.conversation.session_history);
        } else {
          sendError = "正在核对操作结果，请勿重复操作；没有自动重试";
        }
        status.textContent = sendError;
      } finally { if (current === privacyRevision) gate(); }
    }

    function start() {
      if (started) return;
      started = true;
      query('[data-role="dialogue-header"]').hidden = false;
      query('[data-role="chat-title"]').textContent = "有求必应";
      log.replaceChildren();
      input.placeholder = "接着刚才的话聊…";
      input.maxLength = 2000;
      sendButton.addEventListener("click", send);
      sessionNew.addEventListener("click", function () { return changeSession("new", ""); });
      sessionSelect.addEventListener("change", function () { return changeSession("select", sessionSelect.value); });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
      });
      updateState(null);
    }

    return { start: start, send: send, updateState: updateState,
      setEnabled: function (value) { enabled = value !== false; updateState(state); },
      refreshPublicConfig: function () {} };
  }

  global.FlitFancyConsoleDialogue = { create: create, presentation: presentation, displayText: displayText };
})(window);
