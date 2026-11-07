/* 小流萤的私有咨询记录：显示实际发出的问题与模型原始答复。 */
(function (global) {
  "use strict";

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const panel = query('[data-role="consultation-panel"]');
    const list = query('[data-role="consultation-list"]');
    const status = query('[data-role="consultation-status"]');
    const records = new Map();
    let signedIn = false, cursor = 0, epoch = 0, busy = false;

    function addText(parent, label, text) {
      const heading = document.createElement("p"); heading.textContent = label;
      const body = document.createElement("pre"); body.textContent = text;
      parent.appendChild(heading); parent.appendChild(body);
    }

    function render() {
      list.replaceChildren();
      const rows = Array.from(records.values()).slice(-20).reverse();
      status.textContent = rows.length ? "显示最近的咨询；点开可查看原文。" : "外部模型的提问与答复会显示在这里。";
      rows.forEach(function (row, index) {
        const card = document.createElement("details");
        card.open = index === 0;
        const summary = document.createElement("summary");
        const time = row.at ? new Date(row.at).toLocaleString() : "";
        const model = [row.provider, row.model].filter(Boolean).join(" / ") || "外部模型";
        const phase = row.error ? "未完成" : row.answer ? "已回复" : "正在咨询";
        summary.textContent = [time, model, phase].filter(Boolean).join(" · ");
        card.appendChild(summary);
        if (row.question) addText(card, "发送的问题", row.question);
        if (row.answer) addText(card, "模型原始答复", row.answer);
        if (row.error) addText(card, "咨询状态", row.error);
        list.appendChild(card);
      });
    }

    function consume(events) {
      let changed = false;
      (Array.isArray(events) ? events : []).forEach(function (event) {
        const seq = Number(event && event.seq);
        if (!Number.isSafeInteger(seq) || seq <= cursor || !event.consultation_id) return;
        const id = String(event.consultation_id);
        const row = records.get(id) || {at: event.at || "", provider: event.provider || "", model: event.model || ""};
        if (event.phase === "question") row.question = String(event.content || "");
        else if (event.phase === "answer") row.answer = String(event.content || "");
        else if (event.phase === "error") row.error = String(event.content || "");
        records.set(id, row); cursor = seq; changed = true;
      });
      while (records.size > 40) records.delete(records.keys().next().value);
      if (changed) render();
    }

    async function refresh() {
      if (!signedIn || busy) return {skipped: true};
      const current = epoch;
      busy = true;
      try {
        const data = await opts.request("/api/consultations?after=" + cursor);
        if (current !== epoch) return {skipped: true};
        consume(data.events);
        return {ok: true};
      } catch (error) {
        if (current !== epoch) return {skipped: true};
        status.textContent = "咨询记录暂时无法读取。";
        return {ok: false, status: error.status || 0};
      } finally {
        if (current === epoch) busy = false;
      }
    }

    function clearPrivate() {
      epoch++; signedIn = false; cursor = 0; busy = false; records.clear();
      list.replaceChildren(); panel.hidden = true;
      status.textContent = "外部模型的提问与答复会显示在这里。";
    }

    function setAuthenticated(value) {
      if (!value) { if (signedIn) clearPrivate(); return; }
      signedIn = true; panel.hidden = false;
    }

    return {start: function () {}, setAuthenticated: setAuthenticated, refresh: refresh,
      clearPrivate: clearPrivate, dispose: clearPrivate};
  }

  global.FlitFancyConsultations = {create: create};
})(window);
