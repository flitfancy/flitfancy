(function () {
  const $ = (sel) => document.querySelector(sel);

  async function getJSON(url) {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || ("HTTP " + r.status));
      err.data = data;
      throw err;
    }
    return data || {};
  }

  function fmt(v, d) {
    if (v == null || isNaN(Number(v))) return "—";
    return Number(v).toFixed(d == null ? 1 : d);
  }

  function setStatus(text, ok) {
    $('[data-role="status"]').textContent = text;
    $('[data-role="dot"]').style.background = ok ? "" : "#8b94a8";
  }

  function renderLiveStrip(rows) {
    const el = document.querySelector('[data-role="live-strip"]');
    const byChannel = {};
    (rows || []).forEach(function (r) {
      byChannel[r.channel] = r;
    });
    const parts = [];

    const ch0 = byChannel["CH0"];
    if (ch0 && ch0.temp_c != null) {
      parts.push("CH0 " + fmt(ch0.temp_c, 1) + "°C " + fmt(ch0.rh_pct, 0) + "%RH");
    }
    const ch1 = byChannel["CH1"];
    if (ch1 && ch1.pressure_pa != null) {
      parts.push("CH1 " + fmt(ch1.pressure_pa / 100, 1) + "hPa");
    }
    const ch2 = byChannel["CH2"];
    if (ch2 && ch2.als_raw != null) {
      parts.push("CH2 " + fmt(ch2.als_raw, 0) + " raw");
    }
    const ch3 = byChannel["CH3"];
    if (ch3 && ch3.uv_raw != null) {
      parts.push("CH3 UV " + fmt(ch3.uv_raw, 0));
    } else if (ch3 && ch3.als_raw != null) {
      parts.push("CH3 ALS " + fmt(ch3.als_raw, 0));
    }
    const ch4 = byChannel["CH4"];
    if (ch4 && ch4.voc_index != null) {
      parts.push("CH4 VOC " + fmt(ch4.voc_index, 0) + " NOx " + fmt(ch4.nox_index, 0));
    }
    const ch5 = byChannel["CH5"];
    if (ch5 && ch5.co2_ppm != null) {
      parts.push("CH5 " + fmt(ch5.co2_ppm, 0) + " ppm");
    }

    el.textContent = parts.length ? parts.join("  ·  ") : "暂无感知数据";
  }

  async function refresh() {
    try {
      const status = await getJSON("/api/status");
      setStatus(status.msg, true);
      const latest = await getJSON("/api/sensors/latest");
      renderLiveStrip(latest.rows);
    } catch (e) {
      setStatus("控制台服务未连接——请运行 python server.py", false);
    }
  }

  /* 对话 */
  const CHAT_KEY = "flitfancy.chat.v1";
  // 部署 Cloudflare Worker 后，把公网地址填到这里；留空则只用本地服务
  const PUBLIC_AI_URL = "https://api.flitfancy.com/";
  let chatHistory = loadChat();
  let chatBusy = false;

  function loadChat() {
    try {
      const raw = sessionStorage.getItem(CHAT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(-40) : [];
    } catch (e) {
      return [];
    }
  }

  function saveChat() {
    try {
      sessionStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-40)));
    } catch (e) { /* 忽略存储失败 */ }
  }

  function addChatMsg(role, text) {
    const log = document.querySelector('[data-role="chat-log"]');
    const empty = document.querySelector('[data-role="chat-empty"]');
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = "chat-msg " + (role === "user" ? "user" : "ai");
    const who = document.createElement("span");
    who.className = "chat-who";
    who.textContent = role === "user" ? "你" : "AI";
    const p = document.createElement("p");
    p.textContent = text;
    div.appendChild(who);
    div.appendChild(p);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return p;
  }

  function typewriter(el, text, done) {
    const reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      el.textContent = text;
      if (done) done();
      return;
    }
    let i = 0;
    (function tick() {
      i += 2;
      el.textContent = text.slice(0, i);
      const log = el.closest(".chat-log");
      if (log) log.scrollTop = log.scrollHeight;
      if (i < text.length) {
        setTimeout(tick, 16);
      } else if (done) {
        done();
      }
    })();
  }

  function setChatStatus(text) {
    document.querySelector('[data-role="chat-status"]').textContent = text || "";
  }

  async function sendChat() {
    const input = document.querySelector('[data-role="chat-input"]');
    const sendBtn = document.querySelector('[data-role="chat-send"]');
    const text = input.value.trim();
    if (!text || chatBusy) return;
    chatBusy = true;
    sendBtn.disabled = true;
    input.disabled = true;
    setChatStatus("正在思考…");
    chatHistory.push({ role: "user", content: text });
    input.value = "";
    saveChat();
    addChatMsg("user", text);
    try {
      const urls = ["/api/chat"];
      if (PUBLIC_AI_URL) urls.push(PUBLIC_AI_URL);
      let r = null;
      let lastErr = null;
      for (const url of urls) {
        try {
          r = await postJSON(url, { messages: chatHistory.slice(-20) });
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!r) throw lastErr || new Error("无法连接服务");
      const reply = (r.reply || "").trim();
      if (!reply) throw new Error("AI 没有返回内容");
      chatHistory.push({ role: "assistant", content: reply });
      saveChat();
      const p = addChatMsg("ai", "");
      await new Promise(function (resolve) {
        typewriter(p, reply, resolve);
      });
      setChatStatus("");
    } catch (e) {
      setChatStatus((e && e.message) || "出错了，稍后再试试。");
    } finally {
      chatBusy = false;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  const chatInput = document.querySelector('[data-role="chat-input"]');
  const chatSend = document.querySelector('[data-role="chat-send"]');
  chatSend.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  chatHistory.forEach(function (m) {
    addChatMsg(m.role, m.content);
  });

  refresh();
  setInterval(refresh, 5000);
})();
