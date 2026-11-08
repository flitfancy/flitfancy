/* 模型直聊：管理员历史在本机，访客历史在自己的浏览器。 */
(function (global) {
  "use strict";

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const modes = query('[data-role="dialogue-modes"]');
    const fireflyPanel = query('[data-role="firefly-chat-panel"]');
    const modelPanel = query('[data-role="gpt-chat-panel"]');
    const fireflyMode = query('[data-role="mode-firefly"]');
    const modelMode = query('[data-role="mode-gpt"]');
    const log = query('[data-role="gpt-log"]');
    const input = query('[data-role="gpt-input"]');
    const sendButton = query('[data-role="gpt-send"]');
    const clearButton = query('[data-role="gpt-clear"]');
    const status = query('[data-role="gpt-status"]');
    const settings = query('[data-role="gpt-settings"]');
    const historySelect = query('[data-role="gpt-history"]');
    const historyMore = query('[data-role="gpt-history-more"]');
    const historyOlder = query('[data-role="gpt-history-older"]');
    const historyNote = query('[data-role="gpt-history-note"]');
    const providerSelect = query('[data-role="gpt-provider"]');
    const effortSelect = query('[data-role="gpt-effort"]');
    const switchChoice = query('[data-role="gpt-switch-choice"]');
    const switchMessage = query('[data-role="gpt-switch-message"]');
    const switchCarry = query('[data-role="gpt-switch-carry"]');
    const switchReset = query('[data-role="gpt-switch-reset"]');
    const switchCancel = query('[data-role="gpt-switch-cancel"]');
    const publicMode = opts.publicMode === true;
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    const archive = opts.historyStore || (global.FlitFancyModelHistory && global.FlitFancyModelHistory.create({
      request: opts.request, publicMode: publicMode, publicBase: publicBase,
    }));
    if (!archive) throw new Error("模型历史组件不可用");
    let authenticated = false, started = false, mode = "firefly", ready = false;
    let sending = false, loading = false, historyReady = false, initializing = false;
    let epoch = 0, configRevision = 0, selectionRevision = 0, profileId = "", modelLabel = "模型", modelId = "";
    let active = null, turns = [], sessions = [], nextOffset = null, before = null, pollTimer = null;
    let profiles = [], selectedProfile = null, pendingSwitch = null, contextPolicy = null, defaultProvider = "";
    const drafts = new Map();

    function mismatch() { return Boolean(active && active.profile_id && profileId && active.profile_id !== profileId && !contextPolicy); }
    function pending() { return turns.find(function (turn) { return turn.status === "pending"; }); }
    function unsaved() { return turns.some(function (turn) { return turn.status === "unsaved"; }); }
    function gate() {
      input.disabled = !authenticated || !ready || !historyReady || loading || sending || Boolean(pending()) || unsaved() || mismatch() || Boolean(pendingSwitch);
      sendButton.disabled = input.disabled;
      clearButton.disabled = !authenticated || !historyReady || loading || sending;
      historySelect.disabled = !authenticated || !historyReady || loading || sending;
      historyMore.disabled = historySelect.disabled;
      historyOlder.disabled = historySelect.disabled;
      providerSelect.disabled = !authenticated || !ready || loading || sending || Boolean(pending()) || Boolean(pendingSwitch) || !profiles.length;
      effortSelect.disabled = providerSelect.disabled;
    }

    function chooseProfile(row, effort) {
      if (!row) return;
      selectedProfile = row; profileId = row.profile_id; modelLabel = row.provider_label || "模型"; modelId = row.model || "";
      providerSelect.value = profileId;
      const choices = Array.isArray(row.efforts) && row.efforts.length ? row.efforts : ["auto"];
      const labels = {auto: "自动", none: "关闭思考", low: "快速", medium: "平衡", high: "深入", xhigh: "更深入", max: "最高"};
      effortSelect.replaceChildren();
      choices.forEach(function (value) { const item = document.createElement("option"); item.value = value; item.textContent = labels[value] || value; effortSelect.appendChild(item); });
      const preferred = effort || row.default_effort || "auto";
      effortSelect.value = choices.includes(preferred) ? preferred : "auto";
    }

    function renderProfiles() {
      providerSelect.replaceChildren();
      profiles.forEach(function (row) { const item = document.createElement("option"); item.value = row.profile_id;
        item.textContent = (row.provider_label || "模型") + " · " + row.model; providerSelect.appendChild(item); });
      if (pendingSwitch || selectedProfile) providerSelect.value = (pendingSwitch || selectedProfile).profile_id;
    }

    function showSwitch(row) {
      pendingSwitch = row;
      switchMessage.textContent = "切换到 " + (row.provider_label || "新服务") + " · " + row.model + " 时，是否携带当前会话的近期消息？";
      switchChoice.hidden = false; gate();
    }

    function requestProfile(row) {
      if (!row || sending || loading || pending()) return;
      if (active && active.profile_id && active.profile_id !== row.profile_id) {
        const previous = profiles.find(function (item) { return item.profile_id === active.profile_id; });
        if (previous && previous.provider === row.provider && previous.connection_id && previous.connection_id === row.connection_id) {
          contextPolicy = "carry"; chooseProfile(row, null); gate(); return;
        }
        showSwitch(row); return;
      }
      contextPolicy = null; chooseProfile(row, null); gate();
    }

    function finishSwitch(policy) {
      if (!pendingSwitch) return;
      if (policy) { contextPolicy = policy; chooseProfile(pendingSwitch, null); }
      else if (selectedProfile) providerSelect.value = selectedProfile.profile_id;
      pendingSwitch = null; switchChoice.hidden = true; status.textContent = ""; gate();
    }

    function syncActiveProfile() {
      if (!active || !active.profile_id || contextPolicy || pendingSwitch) return;
      const previous = profiles.find(function (row) { return row.profile_id === active.profile_id; });
      if (previous) chooseProfile(previous, active.current_effort || "auto");
      else if (selectedProfile && selectedProfile.profile_id !== active.profile_id) {
        showSwitch(selectedProfile);
      }
    }

    function stopPoll() {
      if (pollTimer !== null && global.clearTimeout) global.clearTimeout(pollTimer);
      pollTimer = null;
    }

    function addMessage(role, text, label) {
      const row = document.createElement("div");
      row.className = "chat-msg " + (role === "user" ? "user" : "ai");
      const who = document.createElement("span");
      who.className = "chat-who"; who.textContent = label || (role === "user" ? "你" : modelLabel);
      const body = document.createElement("p"); body.textContent = text;
      row.appendChild(who); row.appendChild(body); log.appendChild(row);
    }

    function render(keepScroll) {
      const oldHeight = log.scrollHeight, oldTop = log.scrollTop;
      log.replaceChildren();
      if (!turns.length) {
        const empty = document.createElement("p");
        empty.className = "chat-empty"; empty.textContent = "从这里开始和模型对话。";
        log.appendChild(empty);
      } else {
        turns.forEach(function (turn) {
          if (turn.context_reset) { const boundary = document.createElement("p"); boundary.className = "hint model-context-boundary";
            boundary.textContent = "从这里开始，不携带更早消息"; log.appendChild(boundary); }
          addMessage("user", turn.text || "");
          if (turn.reply) {
            const labels = {none: "关闭思考", low: "快速", medium: "平衡", high: "深入", xhigh: "更深入", max: "最高"};
            const name = turn.model || turn.provider || (active && active.provider_label) || modelLabel;
            addMessage("assistant", turn.reply, name + (labels[turn.effort] ? " · " + labels[turn.effort] : ""));
          }
          if (turn.status !== "complete" && turn.status !== "unsaved") {
            const note = document.createElement("p"); note.className = "hint";
            note.textContent = turn.status === "pending" ? "正在等待回复…" : (turn.error || "本轮未完成，请确认后重试。");
            log.appendChild(note);
          }
        });
      }
      log.scrollTop = keepScroll ? Math.max(0, log.scrollHeight - oldHeight + oldTop) : log.scrollHeight;
      historyOlder.hidden = before == null;
    }

    function renderSessions() {
      historySelect.replaceChildren();
      const fresh = document.createElement("option"); fresh.value = ""; fresh.textContent = "新对话"; historySelect.appendChild(fresh);
      sessions.forEach(function (session) {
        const item = document.createElement("option"); item.value = session.id;
        item.textContent = session.title || "新对话"; historySelect.appendChild(item);
      });
      historySelect.value = active ? active.id : "";
      historyMore.hidden = nextOffset == null;
    }

    function noteAvailability() {
      if (mismatch() || pendingSwitch) status.textContent = "请选择切换服务时是否携带当前会话上下文。";
      else if (pending()) status.textContent = "上一条请求仍在处理，不会自动重复发送。";
      else if (unsaved()) status.textContent = "答复未能保存，请先复制，再新建或重新打开会话。";
      else if (!ready) status.textContent = "请先在控制台配置模型接口和访问范围。";
    }

    async function refreshList(append) {
      const current = epoch;
      const data = await archive.list(append ? nextOffset : 0, 50);
      if (current !== epoch) return;
      const list = Array.isArray(data.conversations) ? data.conversations : [];
      if (append) {
        const known = new Set(sessions.map(function (row) { return row.id; }));
        list.forEach(function (row) { if (!known.has(row.id)) { known.add(row.id); sessions.push(row); } });
      } else {
        sessions = list;
        if (active && !sessions.some(function (row) { return row.id === active.id; })) sessions.push(active);
      }
      nextOffset = data.has_more ? data.next_offset : null;
      renderSessions();
    }

    function schedulePoll(id, revision) {
      stopPoll();
      if (!global.setTimeout) return;
      pollTimer = global.setTimeout(async function () {
        pollTimer = null;
        if (!authenticated || !active || active.id !== id || revision !== selectionRevision) return;
        try { await loadActive(id, revision, false); }
        catch (error) { if (authenticated && active && active.id === id) status.textContent = "暂时无法读取请求状态，请稍后查看历史。"; }
        if (authenticated && active && active.id === id && revision === selectionRevision && pending()) schedulePoll(id, revision);
      }, 2000);
    }

    async function loadActive(id, revision, older) {
      const current = epoch;
      const wasPending = !older && pending();
      const data = await archive.load(id, older ? before : null, 50);
      if (current !== epoch || revision !== selectionRevision) return false;
      active = data.conversation;
      syncActiveProfile();
      const incoming = Array.isArray(data.turns) ? data.turns : [];
      if (older) {
        const known = new Set(turns.map(function (turn) { return turn.seq; }));
        turns = incoming.filter(function (turn) { return !known.has(turn.seq); }).concat(turns);
      } else {
        turns = incoming;
      }
      before = data.has_more ? data.next_before : null;
      if (wasPending) {
        const completed = turns.find(function (turn) { return turn.request_id === wasPending.request_id; });
        if (completed && (completed.status === "failed" || completed.status === "interrupted") && !input.value) input.value = completed.text;
      }
      render(older); renderSessions(); noteAvailability(); gate();
      if (pending()) schedulePoll(id, revision); else stopPoll();
      return true;
    }

    async function selectSession(id) {
      if (!authenticated || sending) return;
      const current = epoch, revision = ++selectionRevision;
      const previousInput = input.value;
      drafts.set(active ? active.id : "", input.value);
      stopPoll(); loading = true; pendingSwitch = null; contextPolicy = null; switchChoice.hidden = true; gate();
      try {
        if (!id) {
          active = null; turns = []; before = null; input.value = drafts.get("") || "";
          chooseProfile(profiles.find(function (row) { return row.provider === defaultProvider; }) || profiles[0], null);
          archive.remember(""); render(); renderSessions(); status.textContent = ""; noteAvailability();
        } else {
          input.value = drafts.get(id) || "";
          if (await loadActive(id, revision, false)) { archive.remember(id); if (!pending() && !mismatch() && ready) status.textContent = ""; }
        }
      } catch (error) {
        if (current === epoch && revision === selectionRevision) { input.value = previousInput; status.textContent = error.message || "无法读取对话历史。"; renderSessions(); }
      } finally {
        if (current === epoch && revision === selectionRevision) { loading = false; gate(); }
      }
    }

    async function initializeHistory() {
      if (!authenticated || historyReady || initializing) return;
      const current = epoch;
      initializing = true; gate();
      try {
        await refreshList(false);
        if (current !== epoch) return;
        historyReady = true;
        const saved = archive.recalled();
        const selected = saved === null ? (sessions[0] && sessions[0].id) || "" : saved;
        await selectSession(selected);
      } catch (error) {
        if (current === epoch) { historyReady = false; status.textContent = error.message || "无法读取对话历史。"; }
      } finally {
        if (current === epoch) { initializing = false; gate(); }
      }
    }

    function selectMode(next) {
      if (!authenticated || (publicMode && next === "gpt" && !ready)) return;
      mode = next === "gpt" ? "gpt" : "firefly";
      fireflyPanel.hidden = mode !== "firefly"; modelPanel.hidden = mode !== "gpt";
      fireflyMode.setAttribute("aria-pressed", String(mode === "firefly")); modelMode.setAttribute("aria-pressed", String(mode === "gpt"));
      if (mode === "gpt") { render(); void refreshStatus(); void initializeHistory(); }
      gate();
    }

    async function refreshStatus() {
      if (!authenticated) return;
      const current = epoch, revision = ++configRevision;
      try {
        const data = await opts.request(publicMode ? publicBase + "/gpt/status" : "/api/model-gateway/status",
          publicMode ? {authMode: "none"} : undefined);
        let list = publicMode ? data.profiles : null;
        if (!publicMode) {
          try { const found = await opts.request("/api/model-gateway/catalog"); list = found.profiles; defaultProvider = found.selected_provider || data.selected_provider || data.provider || ""; }
          catch (ignored) { list = null; }
        }
        if (current !== epoch || revision !== configRevision) return;
        if (publicMode) defaultProvider = data.selected_provider || data.provider || defaultProvider;
        if (!Array.isArray(list) && data.profile_id && (publicMode ? data.enabled : data.configured)) list = [{provider: data.provider || "", provider_label: data.provider_label || "模型",
          model: data.model || "", profile_id: data.profile_id, efforts: data.efforts || ["auto"]}];
        profiles = (Array.isArray(list) ? list : []).filter(function (row) { return row && row.profile_id && row.model; });
        const matching = selectedProfile && profiles.find(function (row) { return row.profile_id === selectedProfile.profile_id; });
        chooseProfile(matching || profiles.find(function (row) { return row.provider === defaultProvider; }) || profiles[0], matching ? effortSelect.value : null);
        renderProfiles(); syncActiveProfile();
        if (publicMode) {
          ready = data.enabled === true; modes.hidden = !authenticated || !ready;
          if (!ready && mode === "gpt") {
            mode = "firefly"; fireflyPanel.hidden = false; modelPanel.hidden = true;
            fireflyMode.setAttribute("aria-pressed", "true"); modelMode.setAttribute("aria-pressed", "false");
          }
        } else {
          ready = profiles.length > 0 && data.access !== "off";
        }
        if (!sending && !loading) {
          if (mismatch() || pending() || unsaved() || !ready) noteAvailability(); else status.textContent = "";
        }
      } catch (error) {
        if (current !== epoch || revision !== configRevision) return;
        ready = false;
        if (publicMode) {
          modes.hidden = true;
          if (mode === "gpt") { mode = "firefly"; fireflyPanel.hidden = false; modelPanel.hidden = true; }
          gate(); return {ok: false, status: error.status || 0};
        }
        status.textContent = error.message || "请检查本机服务。";
      }
      gate(); return {ok: true};
    }

    async function send() {
      const text = input.value.trim();
      if (!authenticated || !ready || !historyReady || loading || sending || pending() || unsaved() || mismatch() || pendingSwitch || !text) return;
      const maxLength = publicMode ? 1000 : 4000;
      if (text.length > maxLength) { status.textContent = "每条消息最多 " + maxLength + " 字。"; return; }
      const current = epoch, revision = selectionRevision;
      const chosen = selectedProfile, chosenEffort = effortSelect.value || "auto", chosenContext = contextPolicy;
      drafts.delete(active ? active.id : "");
      sending = true; input.value = ""; status.textContent = "模型正在思考…"; gate();
      let id = active && active.id, requestId;
      try {
        if (!id) {
          id = global.crypto.randomUUID();
          const created = await archive.create(id);
          if (current !== epoch || revision !== selectionRevision) return;
          active = created; archive.remember(id);
          sessions.unshift(created); renderSessions();
        }
        requestId = global.crypto.randomUUID();
        turns.push({request_id: requestId, text: text, reply: "", status: "pending", error: ""}); render();
        const result = await archive.send(id, {request_id: requestId, text: text, profile_id: profileId,
          provider: chosen && chosen.provider || undefined, effort: chosenEffort, context_policy: chosenContext || undefined,
          provider_label: modelLabel, model: modelId});
        if (current !== epoch || revision !== selectionRevision) return;
        if (result.state === "unsaved") {
          turns = turns.filter(function (turn) { return turn.request_id !== requestId; });
          turns.push({request_id: requestId, text: text, reply: result.reply || "", status: "unsaved", error: result.error || ""});
          render(); status.textContent = result.error || "答复未能保存，请先复制。";
        } else {
          contextPolicy = null; await loadActive(id, revision, false);
          if (current !== epoch || revision !== selectionRevision) return;
          if (result.state === "complete" && !mismatch()) status.textContent = result.usage_recorded === false ? "回复成功，本次用量暂未记入统计。" : "";
          else if (result.state === "failed" || result.state === "interrupted") {
            if (!input.value) input.value = text;
            status.textContent = (result.turn && result.turn.error) || "本轮未完成，请确认后重试。";
          }
        }
        try { await refreshList(false); } catch (ignored) { /* conversation is already available */ }
      } catch (error) {
        if (current !== epoch || revision !== selectionRevision) return;
        let loaded = false;
        if (id) { try { loaded = await loadActive(id, revision, false); } catch (ignored) { /* status remains unknown */ } }
        if (current !== epoch || revision !== selectionRevision) return;
        if (loaded && turns.some(function (turn) { return turn.request_id === requestId; })) { contextPolicy = null; syncActiveProfile(); }
        if (loaded && pending()) {
          status.textContent = "请求状态尚未确认，正在查看历史；不会自动重复发送。";
        } else {
          if (!input.value) input.value = text;
          if (!loaded) { turns = turns.filter(function (turn) { return turn.request_id !== requestId; }); render(); }
          status.textContent = (error.message || "对话暂时不可用。") + " 内容已保留，请确认后重试。";
          if (error.status === 409) void refreshStatus();
        }
      } finally {
        if (current === epoch && revision === selectionRevision) { sending = false; gate(); }
      }
    }

    function clearPrivate(forget) {
      const wasAuthenticated = authenticated;
      epoch++; configRevision++; selectionRevision++; stopPoll();
      authenticated = false; ready = false; sending = false; loading = false; historyReady = false; initializing = false;
      mode = "firefly"; active = null; turns = []; sessions = []; nextOffset = null; before = null;
      profileId = ""; modelLabel = "模型"; modelId = ""; profiles = []; selectedProfile = null; pendingSwitch = null; contextPolicy = null; defaultProvider = "";
      providerSelect.replaceChildren(); effortSelect.replaceChildren(); switchChoice.hidden = true; input.value = ""; drafts.clear();
      if (forget !== false && wasAuthenticated && !publicMode) archive.forgetSelection();
      status.textContent = "";
      modes.hidden = true; fireflyPanel.hidden = false; modelPanel.hidden = true;
      fireflyMode.setAttribute("aria-pressed", "true"); modelMode.setAttribute("aria-pressed", "false");
      renderSessions(); render(); gate();
    }

    function setAuthenticated(value) {
      if (!value) { if (authenticated) clearPrivate(); return; }
      if (!authenticated) { authenticated = true; void initializeHistory(); }
      modes.hidden = publicMode && !ready; gate();
    }

    function start() {
      if (started) return;
      started = true;
      historyNote.textContent = publicMode ? "历史只保存在当前浏览器。" : "历史保存在本机，管理员登录后可继续。";
      if (publicMode) { settings.hidden = true; fireflyMode.textContent = "访客对话"; input.maxLength = 1000; }
      fireflyMode.addEventListener("click", function () { selectMode("firefly"); });
      modelMode.addEventListener("click", function () { selectMode("gpt"); });
      providerSelect.addEventListener("change", function () { requestProfile(profiles.find(function (row) { return row.profile_id === providerSelect.value; })); });
      switchCarry.addEventListener("click", function () { finishSwitch("carry"); });
      switchReset.addEventListener("click", function () { finishSwitch("reset"); });
      switchCancel.addEventListener("click", function () { finishSwitch(null); });
      sendButton.addEventListener("click", send);
      clearButton.addEventListener("click", function () { if (!sending && !loading) void selectSession(""); });
      historySelect.addEventListener("change", function () { void selectSession(historySelect.value); });
      historyMore.addEventListener("click", async function () {
        if (nextOffset == null || loading || sending) return;
        loading = true; gate();
        try { await refreshList(true); } catch (error) { status.textContent = error.message || "无法读取更多会话。"; }
        finally { loading = false; gate(); }
      });
      historyOlder.addEventListener("click", async function () {
        if (!active || before == null || loading || sending) return;
        const current = epoch, revision = selectionRevision, id = active.id;
        loading = true; gate();
        try { await loadActive(id, revision, true); } catch (error) { if (current === epoch) status.textContent = error.message || "无法读取更早消息。"; }
        finally { if (current === epoch && revision === selectionRevision) { loading = false; gate(); } }
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
      });
      modes.hidden = !authenticated || (publicMode && !ready);
      if (authenticated) { void initializeHistory(); if (publicMode) void refreshStatus(); }
      gate();
    }

    return {start: start, setAuthenticated: setAuthenticated, clearPrivate: clearPrivate, dispose: function () { clearPrivate(false); },
      selectMode: selectMode, selectSession: selectSession, refreshStatus: refreshStatus, send: send};
  }

  global.FlitFancyConsoleGPT = {create: create};
})(window);
