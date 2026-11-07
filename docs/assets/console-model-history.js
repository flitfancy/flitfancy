/* 管理员历史在本机后端；访客历史只在当前浏览器。 */
(function (global) {
  "use strict";

  const BASE = "/api/model-gateway/conversations";
  const DB_NAME = "flitfancy-model-history-v1";
  const PENDING_MS = 120000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function problem(message, status, code) {
    const error = new Error(message); error.status = status || 0; error.code = code || "history_error"; return error;
  }

  function create(options) {
    const opts = options || {};
    const publicMode = opts.publicMode === true;
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    const selectionKey = publicMode ? "flitfancy-model-visitor-active" : "flitfancy-model-admin-active";
    let database = null;

    function remember(id) {
      try { global.sessionStorage.setItem(selectionKey, id || "new"); } catch (error) { /* optional per-tab selection */ }
    }
    function recalled() {
      try { const value = global.sessionStorage.getItem(selectionKey); return value === "new" ? "" : value; }
      catch (error) { return null; }
    }
    function forgetSelection() { try { global.sessionStorage.removeItem(selectionKey); } catch (error) { /* optional */ } }

    function openDatabase() {
      if (database) return database;
      database = new Promise(function (resolve, reject) {
        if (!global.indexedDB) { reject(problem("浏览器不支持保存对话历史。")); return; }
        const request = global.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = function () {
          const db = request.result;
          if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", {keyPath: "id"});
          if (!db.objectStoreNames.contains("histories")) db.createObjectStore("histories", {keyPath: "id"});
        };
        request.onerror = function () { reject(problem("无法打开浏览器对话历史。")); };
        request.onblocked = function () { reject(problem("浏览器对话历史被其他页面占用。")); };
        request.onsuccess = function () {
          request.result.onversionchange = function () { request.result.close(); database = null; };
          resolve(request.result);
        };
      }).catch(function (error) { database = null; throw error; });
      return database;
    }

    async function transaction(names, mode, work) {
      const db = await openDatabase();
      return new Promise(function (resolve, reject) {
        let result, failure;
        const tx = db.transaction(names, mode);
        function fail(error) {
          failure = error;
          try { tx.abort(); } catch (ignored) { reject(error); }
        }
        tx.oncomplete = function () { resolve(result); };
        tx.onabort = tx.onerror = function () { reject(failure || problem("浏览器对话历史保存失败。")); };
        try { work(tx, function (value) { result = value; }, fail); } catch (error) { fail(error); }
      });
    }

    function pair(tx, id, complete, fail) {
      const metaRequest = tx.objectStore("sessions").get(id);
      const historyRequest = tx.objectStore("histories").get(id);
      let meta, history, count = 0;
      function loaded() {
        if (++count !== 2) return;
        try {
          if (!meta || !history || !Array.isArray(history.turns)) throw problem("未找到该对话。", 404, "not_found");
          complete(meta, history);
        } catch (error) { fail(error); }
      }
      metaRequest.onsuccess = function () { meta = metaRequest.result; loaded(); };
      historyRequest.onsuccess = function () { history = historyRequest.result; loaded(); };
      metaRequest.onerror = historyRequest.onerror = function () { fail(problem("读取浏览器对话历史失败。")); };
    }

    function recover(meta, history) {
      let changed = false;
      history.turns.forEach(function (turn) {
        const stamp = Date.parse(turn.updated_at || turn.created_at);
        if (turn.status === "pending" && (!Number.isFinite(stamp) || Date.now() - stamp > PENDING_MS)) {
          turn.status = "interrupted"; turn.error = "上次请求结果未知，请确认后再重试。";
          turn.updated_at = new Date().toISOString(); changed = true;
        }
      });
      if (changed) meta.updated_at = new Date().toISOString();
      return changed;
    }

    function clip(text, limit) {
      let value = String(text || "").slice(0, limit);
      if (value && /[\uD800-\uDBFF]/.test(value[value.length - 1])) value = value.slice(0, -1);
      return value;
    }

    function context(turns, text) {
      const messages = [{role: "user", content: text}];
      let size = text.length;
      for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index];
        if (turn.status !== "complete" || !turn.reply) continue;
        const question = clip(turn.text, 1000), answer = clip(turn.reply, 4000);
        if (messages.length + 2 > 6 || size + question.length + answer.length > 6000) break;
        messages.unshift({role: "user", content: question}, {role: "assistant", content: answer});
        size += question.length + answer.length;
      }
      return messages;
    }

    async function guestCreate(id) {
      if (typeof id !== "string" || !UUID.test(id)) throw problem("对话编号无效。", 400, "invalid_id");
      return transaction(["sessions", "histories"], "readwrite", function (tx, done, fail) {
        const sessions = tx.objectStore("sessions"), histories = tx.objectStore("histories");
        const request = sessions.get(id);
        request.onsuccess = function () {
          try {
            if (request.result) { done(request.result); return; }
            const now = new Date().toISOString();
            const meta = {id: id, title: "新对话", profile_id: "", provider_label: "", model: "", created_at: now, updated_at: now, next_seq: 1};
            sessions.add(meta); histories.add({id: id, turns: []}); done(meta);
          } catch (error) { fail(error); }
        };
        request.onerror = function () { fail(problem("创建浏览器对话失败。")); };
      });
    }

    async function guestList(offset, limit) {
      return transaction(["sessions"], "readonly", function (tx, done, fail) {
        const request = tx.objectStore("sessions").getAll();
        request.onsuccess = function () {
          try {
            const rows = request.result.sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
            done({conversations: rows.slice(offset, offset + limit), has_more: rows.length > offset + limit,
              next_offset: rows.length > offset + limit ? offset + limit : null});
          } catch (error) { fail(error); }
        };
        request.onerror = function () { fail(problem("读取浏览器对话列表失败。")); };
      });
    }

    async function guestLoad(id, before, limit) {
      return transaction(["sessions", "histories"], "readwrite", function (tx, done, fail) {
        pair(tx, id, function (meta, history) {
          if (recover(meta, history)) { tx.objectStore("sessions").put(meta); tx.objectStore("histories").put(history); }
          const rows = before == null ? history.turns : history.turns.filter(function (turn) { return turn.seq < before; });
          const page = rows.slice(-limit);
          done({conversation: meta, turns: page, has_more: rows.length > page.length,
            next_before: rows.length > page.length && page.length ? page[0].seq : null});
        }, fail);
      });
    }

    async function guestBegin(id, payload) {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text || text.length > 1000) throw problem("访客每条消息需为 1–1000 字。", 400, "invalid_text");
      if (!/^[0-9a-f]{16}$/.test(payload.profile_id || "")) throw problem("模型配置已改变，请重新选择。", 409, "profile_changed");
      if (typeof payload.request_id !== "string" || !UUID.test(payload.request_id)) throw problem("请求编号无效。", 400, "invalid_id");
      return transaction(["sessions", "histories"], "readwrite", function (tx, done, fail) {
        pair(tx, id, function (meta, history) {
          const recovered = recover(meta, history);
          const existing = history.turns.find(function (turn) { return turn.request_id === payload.request_id; });
          if (existing) {
            if (existing.text !== text || meta.profile_id !== payload.profile_id) throw problem("请求编号已用于其他消息。", 409, "request_conflict");
            if (recovered) { tx.objectStore("sessions").put(meta); tx.objectStore("histories").put(history); }
            done({created: false, turn: existing}); return;
          }
          if (meta.profile_id && meta.profile_id !== payload.profile_id) throw problem("当前模型与此会话不同，请切回原模型或新建对话。", 409, "profile_changed");
          if (history.turns.some(function (turn) { return turn.status === "pending"; })) throw problem("请等待当前回复完成。", 409, "busy");
          const messages = context(history.turns, text), now = new Date().toISOString();
          if (!meta.profile_id) { meta.title = text.replace(/\s+/g, " ").slice(0, 40); meta.profile_id = payload.profile_id; }
          meta.updated_at = now;
          const turn = {seq: meta.next_seq++, conversation_id: id, request_id: payload.request_id, text: text,
            reply: "", status: "pending", error: "", created_at: now, updated_at: now};
          history.turns.push(turn);
          tx.objectStore("sessions").put(meta); tx.objectStore("histories").put(history);
          done({created: true, turn: turn, messages: messages});
        }, fail);
      });
    }

    async function guestFinish(id, payload, state, reply, note) {
      return transaction(["sessions", "histories"], "readwrite", function (tx, done, fail) {
        pair(tx, id, function (meta, history) {
          const turn = history.turns.find(function (item) { return item.request_id === payload.request_id; });
          if (!turn) throw problem("未找到该消息。", 404, "not_found");
          if (turn.status === "pending") {
            turn.status = state; turn.reply = reply || ""; turn.error = clip(note, 240); turn.updated_at = new Date().toISOString();
            if (state === "complete") {
              meta.model = clip(payload.model || meta.model, 160); meta.provider_label = clip(payload.provider_label || meta.provider_label, 60);
            }
            meta.updated_at = turn.updated_at;
            tx.objectStore("sessions").put(meta); tx.objectStore("histories").put(history);
          }
          done(turn);
        }, fail);
      });
    }

    async function guestSend(id, payload) {
      const begun = await guestBegin(id, payload);
      if (!begun.created) return {state: begun.turn.status, turn: begun.turn, replayed: true};
      let response;
      try {
        response = await opts.request(publicBase + "/gpt/chat", {method: "POST", authMode: "none", timeoutMs: 110000,
          body: JSON.stringify({messages: begun.messages, profile_id: payload.profile_id})});
        if (!response || typeof response.reply !== "string" || !response.reply.trim()) throw problem("模型没有返回文字。", 502, "empty_response");
      } catch (error) {
        try { await guestFinish(id, payload, "failed", "", error.message || "模型服务暂不可用。"); } catch (ignored) { /* pending remains visible */ }
        throw error;
      }
      try {
        const turn = await guestFinish(id, payload, "complete", response.reply, "");
        return {state: turn.status, turn: turn, replayed: false};
      } catch (error) {
        return {state: "unsaved", reply: response.reply, error: "模型已回复，但浏览器未能保存历史；请先复制答复。"};
      }
    }

    function api(path, options) { return opts.request(path, options); }
    return {
      create: function (id) { return publicMode ? guestCreate(id) : api(BASE, {method: "POST", body: JSON.stringify({id: id})}).then(data => data.conversation); },
      list: function (offset, limit) { offset = offset || 0; limit = limit || 50; return publicMode ? guestList(offset, limit) : api(BASE + "?offset=" + offset + "&limit=" + limit); },
      load: function (id, before, limit) { limit = limit || 50; return publicMode ? guestLoad(id, before, limit) :
        api(BASE + "/" + encodeURIComponent(id) + "?limit=" + limit + (before == null ? "" : "&before=" + before)); },
      send: function (id, payload) { return publicMode ? guestSend(id, payload) : api(BASE + "/" + encodeURIComponent(id) + "/turns",
        {method: "POST", timeoutMs: 110000, body: JSON.stringify({request_id: payload.request_id, text: payload.text, profile_id: payload.profile_id})}); },
      remember: remember, recalled: recalled, forgetSelection: forgetSelection,
    };
  }

  global.FlitFancyModelHistory = {create: create};
})(window);
