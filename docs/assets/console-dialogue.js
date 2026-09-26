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
    let state = null;
    let enabled = true;
    let sending = false;
    let pending = null;
    let revision = null;
    let started = false;
    let sendError = "";
    let privacyRevision = 0;

    function gate() {
      const history = state && state.conversation;
      const offline = !state || !state.available || !history || !history.connected || !state.dialogue || state.dialogue.protocol !== 2;
      input.disabled = !enabled || sending || Boolean(pending) || offline || Boolean(opts.isAdmin && !opts.isAdmin());
      sendButton.disabled = input.disabled;
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
        status.textContent = opts.isAdmin && !opts.isAdmin() ? "请先登录，再使用有求必应。" : "请连接本机服务。";
        gate(); return;
      }
      const history = state.conversation || {};
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
      status.textContent = !enabled ? "AI 对话已由管理员关闭" : sendError || (pending ? "已发送：" + pending.text :
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

    function start() {
      if (started) return;
      started = true;
      query('[data-role="dialogue-header"]').hidden = false;
      query('[data-role="chat-title"]').textContent = "有求必应";
      log.replaceChildren();
      input.placeholder = "接着刚才的话聊…";
      input.maxLength = 2000;
      sendButton.addEventListener("click", send);
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
