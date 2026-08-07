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
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function fmt(v, d) {
    if (v == null || isNaN(Number(v))) return "—";
    return Number(v).toFixed(d == null ? 1 : d);
  }

  function setStatus(text, ok) {
    $('[data-role="status"]').textContent = text;
    $('[data-role="dot"]').style.background = ok ? "" : "#8b94a8";
  }

  function renderSensors(rows) {
    const byChannel = {};
    (rows || []).forEach(function (r) {
      byChannel[r.channel] = r;
    });

    const ch0 = byChannel["CH0"];
    const el0 = document.querySelector('[data-ch="CH0"]');
    if (ch0 && ch0.temp_c != null) {
      el0.innerHTML = fmt(ch0.temp_c, 1) + '<span class="unit">°C</span> · ' + fmt(ch0.rh_pct, 0) + '<span class="unit">%RH</span>';
      document.querySelector('[data-extra="CH0"]').textContent = "更新于 " + (ch0.ts || "").slice(5, 19);
    }

    const ch1 = byChannel["CH1"];
    if (ch1 && ch1.pressure_pa != null) {
      document.querySelector('[data-ch="CH1"]').innerHTML = fmt(ch1.pressure_pa / 100, 1) + '<span class="unit">hPa</span>';
      document.querySelector('[data-extra="CH1"]').textContent = "更新于 " + (ch1.ts || "").slice(5, 19);
    }

    const ch2 = byChannel["CH2"];
    if (ch2 && ch2.als_raw != null) {
      document.querySelector('[data-ch="CH2"]').innerHTML = fmt(ch2.als_raw, 0) + '<span class="unit">raw</span>';
      document.querySelector('[data-extra="CH2"]').textContent = "CLEAR " + fmt(ch2.als_raw, 0);
    }

    const ch3 = byChannel["CH3"];
    if (ch3 && ch3.als_raw != null) {
      document.querySelector('[data-ch="CH3"]').innerHTML = fmt(ch3.als_raw, 0) + '<span class="unit">ALS</span>';
      document.querySelector('[data-extra="CH3"]').textContent = "UV " + fmt(ch3.uv_raw, 0);
    }

    const ch4 = byChannel["CH4"];
    if (ch4 && ch4.voc_index != null) {
      document.querySelector('[data-ch="CH4"]').innerHTML = fmt(ch4.voc_index, 0) + '<span class="unit">VOC</span>';
      document.querySelector('[data-extra="CH4"]').textContent = "NOx " + fmt(ch4.nox_index, 0);
    }

    const ch5 = byChannel["CH5"];
    if (ch5 && ch5.co2_ppm != null) {
      document.querySelector('[data-ch="CH5"]').innerHTML = fmt(ch5.co2_ppm, 0) + '<span class="unit">ppm</span>';
      document.querySelector('[data-extra="CH5"]').textContent = "CO₂ · " + (ch5.ts || "").slice(5, 19);
    }
  }

  function renderNotes(notes) {
    const ul = document.querySelector('[data-role="notes"]');
    ul.innerHTML = "";
    (notes || []).forEach(function (n) {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = (n.ts || "").slice(0, 16);
      li.appendChild(time);
      li.appendChild(document.createTextNode(n.content));
      ul.appendChild(li);
    });
  }

  async function refresh() {
    try {
      const status = await getJSON("/api/status");
      setStatus(status.msg, true);
      const latest = await getJSON("/api/sensors/latest");
      renderSensors(latest.rows);
      const notes = await getJSON("/api/notes");
      renderNotes(notes.rows);
    } catch (e) {
      setStatus("控制台服务未连接——请运行 python server.py", false);
    }
  }

  document.querySelectorAll("[data-cmd]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const out = document.querySelector('[data-role="cmd-result"]');
      out.textContent = "发送 " + btn.dataset.cmd + " …";
      try {
        const r = await postJSON("/api/command", { command: btn.dataset.cmd });
        out.textContent = r.note || "已记录";
      } catch (e) {
        out.textContent = "服务未连接";
      }
    });
  });

  document.querySelector('[data-role="note-save"]').addEventListener("click", async function () {
    const input = document.querySelector('[data-role="note-input"]');
    const text = input.value.trim();
    if (!text) return;
    try {
      await postJSON("/api/notes", { author: "console", content: text });
      input.value = "";
      await refresh();
    } catch (e) {
      alert("服务未连接，无法保存");
    }
  });

  refresh();
  setInterval(refresh, 5000);
})();
