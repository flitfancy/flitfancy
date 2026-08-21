(function () {
  const $ = (sel) => document.querySelector(sel);

  /* 页面级错误提示：任何脚本错误都会显示在左下角红条（共享实现） */
  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');

  /* ---------- 请求工具（统一 8s 超时/鉴权头/状态码错误，见 assets/admin-core.js） ---------- */
  async function getJSON(url) {
    return window.FlitFancyAdmin.request(url);
  }

  async function postJSON(url, body) {
    return window.FlitFancyAdmin.request(url, {
      method: "POST",
      body: JSON.stringify(body || {})
    });
  }

  /* ---------- 状态与数据行 ---------- */
  /* 状态文案恒定空串，仅用圆点表示在线/离线（颜色走 CSS 变量，不在 JS 里硬编码） */
  function setStatus(ok) {
    $('[data-role="status"]').textContent = "";
    $('[data-role="dot"]').classList.toggle("offline", !ok);
  }

  function setChatStatus(text) {
    $('[data-role="chat-status"]').textContent = text || "";
  }

  function fmt(v, d) {
    if (v == null || isNaN(Number(v))) return "—";
    return Number(v).toFixed(d == null ? 1 : d);
  }

  const SENSOR_META = {
    CH0: { name: "温湿度", sensor: "SHT41", metric: { key: "temp_c", label: "温度", unit: "°C", digits: 1 } },
    CH1: { name: "气压", sensor: "BMP580", metric: { key: "pressure_pa", label: "气压", unit: "hPa", digits: 1, scale: 0.01 } },
    CH2: { name: "光谱", sensor: "AS7341", metric: { key: "clear_raw", label: "全光谱", unit: "counts", digits: 0 } },
    CH3: { name: "环境光与紫外", sensor: "LTR390", metric: { key: "als_raw", label: "环境光", unit: "counts", digits: 0 } },
    CH4: { name: "空气质量", sensor: "SGP41", metric: { key: "voc_index", label: "VOC", unit: "index", digits: 0 } },
    CH5: { name: "二氧化碳", sensor: "SCD40", metric: { key: "co2_ppm", label: "CO₂", unit: "ppm", digits: 0 } }
  };

  function rowValues(channel, row) {
    if (!row || Number(row.ok) !== 1) return [];
    if (channel === "CH0") return [fmt(row.temp_c, 1) + " °C", fmt(row.rh_pct, 0) + " %RH"];
    if (channel === "CH1") return [fmt(Number(row.pressure_pa) / 100, 1) + " hPa", fmt(row.temp_c, 1) + " °C"];
    if (channel === "CH2") return ["CLEAR " + fmt(row.clear_raw, 0), "NIR " + fmt(row.nir_raw, 0)];
    if (channel === "CH3") return ["ALS " + fmt(row.als_raw, 0), "UV " + fmt(row.uv_raw, 0)];
    if (channel === "CH4") return ["VOC " + fmt(row.voc_index, 0), "NOx " + fmt(row.nox_index, 0)];
    if (channel === "CH5") return [fmt(row.co2_ppm, 0) + " ppm", fmt(row.temp_c, 1) + " °C"];
    return [];
  }

  function sampleAgeText(row) {
    const ageMs = window.FlitFancySensorState.effectiveSampleAgeMs(row, Date.now());
    if (ageMs == null) return "";
    const seconds = Math.max(0, Math.round(ageMs / 1000));
    return seconds < 1 ? "刚刚" : (seconds + " 秒前");
  }

  /* ---------- 衍生量 ----------
     全部迁至共享模块 sensor-state.js（FlitFancySensorState），与单测同一实现；
     页面只做委托调用，不各持一份。 */
  const dewPointC = window.FlitFancySensorState.dewPointC;
  const heatIndexC = window.FlitFancySensorState.heatIndexC;
  const luxEstimate = window.FlitFancySensorState.luxEstimate;
  const uviEstimate = window.FlitFancySensorState.uviEstimate;
  const co2Level = window.FlitFancySensorState.co2Level;
  const vocLevel = window.FlitFancySensorState.vocLevel;
  const noxLevel = window.FlitFancySensorState.noxLevel;
  const flickerText = window.FlitFancySensorState.flickerText;

  /* CH1 气压环缓冲（40 分钟，5 秒刷新时更新）：卡片上的短趋势评价 */
  let pressureRing = [];
  function notePressure(row) {
    if (!row || row.channel !== "CH1") return;
    const p = Number(row.pressure_pa);
    const t = new Date(row.ts || "").getTime();
    if (!isFinite(p) || isNaN(t)) return;
    const last = pressureRing[pressureRing.length - 1];
    if (last && t <= last.t) return;   // 去重/乱序防护
    pressureRing.push({ t: t, p: p });
    const cutoff = Date.now() - 40 * 60000;
    while (pressureRing.length && pressureRing[0].t < cutoff) pressureRing.shift();
  }
  function pressureTrendShort() {
    const now = Date.now();
    const recent = pressureRing.filter(function (s) { return s.t >= now - 5 * 60000; });
    const earlier = pressureRing.filter(function (s) { return s.t >= now - 15 * 60000 && s.t < now - 10 * 60000; });
    if (recent.length < 2 || earlier.length < 2) return "气压趋势：积累中";
    const avg = function (arr) { return arr.reduce(function (s, x) { return s + x.p; }, 0) / arr.length; };
    const delta = (avg(recent) - avg(earlier)) / 100;
    if (Math.abs(delta) < 0.3) return "气压 10 分钟：平稳";
    return "气压 10 分钟：" + (delta > 0 ? "↑ +" : "↓ ") + delta.toFixed(1) + " hPa";
  }

  function derivedLine(channel, row) {
    if (!row || Number(row.ok) !== 1) return "";
    if (channel === "CH0") {
      const t = Number(row.temp_c), rh = Number(row.rh_pct);
      if (isNaN(t) || isNaN(rh)) return "";
      const parts = ["露点 " + dewPointC(t, rh).toFixed(1) + " °C"];
      if (t >= 27) parts.push("体感 " + heatIndexC(t, rh).toFixed(1) + " °C");
      return parts.join(" · ");
    }
    if (channel === "CH1") {
      return pressureTrendShort();
    }
    if (channel === "CH2") {
      const f = [Number(row.f1_415), Number(row.f2_445), Number(row.f3_480),
        Number(row.f4_515), Number(row.f5_555), Number(row.f6_590),
        Number(row.f7_630), Number(row.f8_680)];
      const sum = f.reduce(function (s, v) { return s + (isFinite(v) ? v : 0); }, 0);
      const fl = flickerText(row.flicker_hz);
      if (!sum) return fl;
      const blue = (f[0] + f[1] + f[2]) / sum;
      const red = (f[6] + f[7]) / sum;
      let tone = "色调均衡";
      if (blue > red * 1.4) tone = "色调偏冷";
      else if (red > blue * 1.4) tone = "色调偏暖";
      return tone + " · " + fl;
    }
    if (channel === "CH3") {
      const als = Number(row.als_raw), uv = Number(row.uv_raw);
      if (isNaN(als) || isNaN(uv)) return "";
      return "≈" + Math.round(luxEstimate(als)) + " lux · UV 指数 ≈" + uviEstimate(uv).toFixed(1);
    }
    if (channel === "CH4") {
      return "VOC " + vocLevel(row.voc_index) + " · NOx " + noxLevel(row.nox_index);
    }
    if (channel === "CH5") {
      return "CO₂ " + co2Level(row.co2_ppm);
    }
    return "";
  }

  function pressureTrendText(buckets) {
    if (!buckets || buckets.length < 7) return "";
    const avg = function (rows) {
      if (!rows.length) return null;
      let s = 0, n = 0;
      rows.forEach(function (b) {
        const v = Number(b.pressure_pa);
        if (isFinite(v)) { s += v; n += 1; }
      });
      return n ? s / n : null;
    };
    const recent = avg(buckets.slice(-3));          // 最近 30 分钟
    const earlier = avg(buckets.slice(-21, -18));   // 约 3 小时前
    if (recent == null || earlier == null) return "";
    const delta = recent - earlier;
    if (Math.abs(delta) < 30) return "气压 3h 趋势：平稳";
    return "气压 3h 趋势：" + (delta > 0 ? "↑ +" : "↓ ") +
      (delta / 100).toFixed(1) + " hPa（" + (delta > 0 ? "天气趋向稳定/转晴" : "天气可能转差") + "）";
  }

  let lastSensorRows = [];
  let lastSensorFingerprint = "";
  let sensorCardParts = {};   // channel -> {state, derived}，供数据未变时的轻量刷新
  let overviewChannel = null;
  let overviewTimer = null;
  let overviewSpectralMode = false;   // CH2 总览的"8 波段"模式
  const overviewBandsOn = {};         // 各波段开关（缺省视为开）
  /* 波段按钮只显示波长（单位 nm，图例行同样标注） */
  const SPECTRAL_BANDS = [
    { key: "f1_415", label: "415" },
    { key: "f2_445", label: "445" },
    { key: "f3_480", label: "480" },
    { key: "f4_515", label: "515" },
    { key: "f5_555", label: "555" },
    { key: "f6_590", label: "590" },
    { key: "f7_630", label: "630" },
    { key: "f8_680", label: "680" },
  ];
  const SPECTRAL_COLORS = ["#8b5cf6", "#6366f1", "#3b82f6", "#22d3ee",
    "#34d399", "#a3e635", "#fbbf24", "#fb7185"];

  /* 各通道 24h 总览的多曲线配置：按钮即图例（同 CH2 波段按钮风格）。
     get 用于衍生量（露点/体感/照度/UVI），scale 用于单位换算。 */
  const OVERVIEW_SERIES = {
    CH0: [
      { key: "temp_c", label: "温度", unit: "°C", digits: 1, color: "#f5b84b" },
      { key: "rh_pct", label: "湿度", unit: "%RH", digits: 0, color: "#38bdf8" },
      { key: "dew", label: "露点", unit: "°C", digits: 1, color: "#34d399",
        get: function (b) { return dewPointC(Number(b.temp_c), Number(b.rh_pct)); } },
      { key: "heat", label: "体感", unit: "°C", digits: 1, color: "#fb7185",
        get: function (b) { return heatIndexC(Number(b.temp_c), Number(b.rh_pct)); } },
    ],
    CH1: [
      { key: "pressure_pa", label: "气压", unit: "hPa", digits: 1, scale: 0.01, color: "#f5b84b" },
      { key: "temp_c", label: "温度", unit: "°C", digits: 1, color: "#38bdf8" },
    ],
    CH2: [
      { key: "clear_raw", label: "全光谱", unit: "counts", digits: 0, color: "#f5b84b" },
      { key: "nir_raw", label: "近红外", unit: "counts", digits: 0, color: "#a78bfa" },
    ],
    CH3: [
      { key: "als_raw", label: "环境光", unit: "counts", digits: 0, color: "#f5b84b" },
      { key: "uv_raw", label: "紫外", unit: "counts", digits: 0, color: "#a78bfa" },
      { key: "lux", label: "照度", unit: "lux", digits: 0, color: "#fbbf24",
        get: function (b) { return luxEstimate(Number(b.als_raw)); } },
      { key: "uvi", label: "UVI", unit: "", digits: 1, color: "#fb7185",
        get: function (b) { return uviEstimate(Number(b.uv_raw)); } },
    ],
    CH4: [
      { key: "voc_index", label: "VOC", unit: "index", digits: 0, color: "#f5b84b" },
      { key: "nox_index", label: "NOx", unit: "index", digits: 0, color: "#38bdf8" },
      { key: "sraw_voc", label: "sraw VOC", unit: "raw", digits: 0, color: "#a78bfa" },
      { key: "sraw_nox", label: "sraw NOx", unit: "raw", digits: 0, color: "#34d399" },
    ],
    CH5: [
      { key: "co2_ppm", label: "CO₂", unit: "ppm", digits: 0, color: "#f5b84b" },
      { key: "temp_c", label: "温度", unit: "°C", digits: 1, color: "#38bdf8" },
    ],
  };
  const overviewSeriesOn = {};   // channel -> {key: bool}（缺省视为开）

  /* 图表悬停状态：由 openChannelOverview 的 canvas 事件驱动，drawSeriesChart
     每次绘制时更新几何并携带重绘闭包 */
  const chartState = { canvas: null, buckets: null, padL: 0, plotW: 0, draw: null };
  let chartHoverIndex = null;

  function sensorFingerprint(rows) {
    /* 指纹计算收敛到共享模块 sensor-state.js（FlitFancySensorState.fingerprint），
       保证页面行为与单测行为完全一致，不再各持一份实现。 */
    return window.FlitFancySensorState.fingerprint(rows);
  }

  function sensorStateText(row) {
    if (!row) return "等待";
    const online = window.FlitFancySensorState.isOnline(row, Date.now());
    const age = sampleAgeText(row);
    return online ? ("在线" + (age ? " · " + age : "")) :
      (Number(row.ok) === 1 ? "离线 · 快照已停止更新" : "暂无读数");
  }

  function renderSensors(rows) {
    const grid = $('[data-role="sensor-grid"]');
    const updated = $('[data-role="sensor-updated"]');
    lastSensorRows = rows || [];
    if (overviewChannel) return;   // 24 小时总览打开时不重建网格
    const fingerprint = sensorFingerprint(rows);
    if (fingerprint === lastSensorFingerprint && Object.keys(sensorCardParts).length) {
      // 数据没变：只刷新会随秒走的文案（在线状态/采样龄/派生量）
      const byChannel = {};
      (rows || []).forEach(function (r) { byChannel[r.channel] = r; });
      Object.keys(SENSOR_META).forEach(function (channel) {
        const parts = sensorCardParts[channel];
        if (!parts) return;
        const row = byChannel[channel];
        parts.state.textContent = sensorStateText(row);
        parts.derived.textContent = derivedLine(channel, row);
      });
      return;
    }
    lastSensorFingerprint = fingerprint;
    sensorCardParts = {};
    const byChannel = {};
    (rows || []).forEach(function (r) { byChannel[r.channel] = r; });
    grid.textContent = "";
    Object.keys(SENSOR_META).forEach(function (channel) {
      const meta = SENSOR_META[channel];
      const row = byChannel[channel];
      const online = window.FlitFancySensorState.isOnline(row, Date.now());
      const card = document.createElement("div");
      card.className = "sensor-card" + (online ? "" : " is-offline");
      const top = document.createElement("div");
      top.className = "sensor-card-top";
      const label = document.createElement("span");
      label.textContent = channel + " · " + meta.sensor + " · " + meta.name;
      const state = document.createElement("span");
      state.className = "sensor-state";
      state.textContent = sensorStateText(row);
      top.appendChild(label);
      top.appendChild(state);
      const values = document.createElement("div");
      values.className = "sensor-values";
      const items = rowValues(channel, row);
      values.textContent = items.length ? items.join("  ·  ") : "—";
      card.appendChild(top);
      card.appendChild(values);
      const derivedEl = document.createElement("div");
      derivedEl.className = "sensor-derived";
      derivedEl.textContent = derivedLine(channel, row);
      card.appendChild(derivedEl);
      sensorCardParts[channel] = { state: state, derived: derivedEl };
      card.addEventListener("click", function () { toggleChannelOverview(channel); });
      grid.appendChild(card);
    });
    const times = (rows || []).map(function (row) {
      return new Date(row.ts || "").getTime();
    }).filter(function (value) { return !isNaN(value); });
    if (times.length) {
      const latest = new Date(Math.max.apply(Math, times));
      const versionRow = (rows || []).find(function (row) { return row.firmware_version; });
      updated.textContent = "快照更新于 " + latest.toLocaleTimeString("zh-CN", { hour12: false }) +
        (versionRow ? " · FFS " + versionRow.firmware_version : "");
    } else {
      updated.textContent = "等待第一组数据";
    }
  }

  /* ---------- 24 小时总览 ---------- */
  function toggleChannelOverview(channel) {
    if (overviewChannel === channel) {
      closeChannelOverview();
    } else {
      openChannelOverview(channel);
    }
  }

  function openChannelOverview(channel) {
    overviewChannel = channel;
    const grid = $('[data-role="sensor-grid"]');
    const meta = SENSOR_META[channel];
    grid.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "sensor-overview";
    const head = document.createElement("div");
    head.className = "overview-head";
    const title = document.createElement("span");
    title.textContent = channel + " · " + meta.name + " · 24 小时总览";
    const back = document.createElement("button");
    back.className = "btn btn-ghost";
    back.setAttribute("data-role", "overview-back");
    back.textContent = "返回";
    back.addEventListener("click", closeChannelOverview);
    head.appendChild(title);
    /* 通用系列按钮行：按钮即图例（色字 + 色框），点击开关对应曲线 */
    const mkSeriesRow = function (ch) {
      const row = document.createElement("div");
      row.className = "overview-modes series-row";
      (OVERVIEW_SERIES[ch] || []).forEach(function (s) {
        const b = document.createElement("button");
        b.className = "btn btn-ghost series-btn";
        b.dataset.key = s.key;
        b.textContent = s.label;
        b.style.color = s.color;
        b.style.borderColor = s.color + "66";
        b.addEventListener("click", function () {
          overviewSeriesOn[ch] = overviewSeriesOn[ch] || {};
          overviewSeriesOn[ch][s.key] = overviewSeriesOn[ch][s.key] === false;
          b.classList.toggle("off", overviewSeriesOn[ch][s.key] === false);
          loadChannelOverview(ch);
        });
        row.appendChild(b);
      });
      return row;
    };
    if (channel === "CH2") {
      const modes = document.createElement("div");
      modes.className = "overview-modes";
      const syncModes = function () {
        const main = $('[data-role="ov-mode-main"]');
        const spec = $('[data-role="ov-mode-spectral"]');
        if (main) main.classList.toggle("active", !overviewSpectralMode);
        if (spec) spec.classList.toggle("active", overviewSpectralMode);
        // 波段按钮常驻（大屏位置固定不挪动）：非光谱模式禁用置灰
        modes.querySelectorAll(".band-btn").forEach(function (x) {
          x.disabled = !overviewSpectralMode;
          x.classList.toggle("off",
            !overviewSpectralMode || overviewBandsOn[x.dataset.key] === false);
        });
        // 主通道系列按钮（全光谱/近红外）：光谱模式下禁用置灰
        modes.querySelectorAll(".series-btn").forEach(function (x) {
          x.disabled = overviewSpectralMode;
          const on = overviewSeriesOn.CH2 || {};
          x.classList.toggle("off",
            overviewSpectralMode || on[x.dataset.key] === false);
        });
      };
      const mk = function (label, mode) {
        const b = document.createElement("button");
        b.className = "btn btn-ghost";
        b.dataset.role = mode === "spectral" ? "ov-mode-spectral" : "ov-mode-main";
        b.textContent = label;
        b.addEventListener("click", function () {
          overviewSpectralMode = mode === "spectral";
          syncModes();
          loadChannelOverview(channel);
        });
        return b;
      };
      const mainBtn = mk("主通道", "main");
      const specBtn = mk("8 波段", "spectral");
      modes.appendChild(mainBtn);
      modes.appendChild(specBtn);
      // 主通道系列按钮（全光谱/近红外）
      (OVERVIEW_SERIES.CH2 || []).forEach(function (s) {
        const b = document.createElement("button");
        b.className = "btn btn-ghost series-btn";
        b.dataset.key = s.key;
        b.textContent = s.label;
        b.style.color = s.color;
        b.style.borderColor = s.color + "66";
        b.addEventListener("click", function () {
          overviewSeriesOn.CH2 = overviewSeriesOn.CH2 || {};
          overviewSeriesOn.CH2[s.key] = overviewSeriesOn.CH2[s.key] === false;
          b.classList.toggle("off", overviewSeriesOn.CH2[s.key] === false);
          loadChannelOverview(channel);
        });
        modes.appendChild(b);
      });
      // 8 个波段开关与模式按钮同行：按钮即图例（色字 + 色框）
      SPECTRAL_BANDS.forEach(function (band, bi) {
        const b = document.createElement("button");
        b.className = "btn btn-ghost band-btn";
        b.dataset.key = band.key;
        b.textContent = band.label;
        b.style.color = SPECTRAL_COLORS[bi];
        b.style.borderColor = SPECTRAL_COLORS[bi] + "66";
        b.disabled = !overviewSpectralMode;
        b.classList.toggle("off", overviewBandsOn[band.key] === false);
        b.addEventListener("click", function () {
          overviewBandsOn[band.key] = overviewBandsOn[band.key] === false;
          b.classList.toggle("off", overviewBandsOn[band.key] === false);
          loadChannelOverview(channel);
        });
        modes.appendChild(b);
      });
      head.appendChild(modes);
      syncModes();
    } else {
      head.appendChild(mkSeriesRow(channel));
    }
    head.appendChild(back);
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-role", "overview-chart");
    chartHoverIndex = null;
    canvas.addEventListener("mousemove", function (ev) {
      if (chartState.canvas !== canvas || !chartState.buckets || !chartState.buckets.length) return;
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const n = chartState.buckets.length;
      const i = Math.max(0, Math.min(n - 1,
        Math.round((px - chartState.padL) / chartState.plotW * (n - 1))));
      if (i !== chartHoverIndex) {
        chartHoverIndex = i;
        chartState.draw();
      }
    });
    canvas.addEventListener("mouseleave", function () {
      if (chartState.canvas !== canvas) return;
      chartHoverIndex = null;
      chartState.draw();
    });
    const status = document.createElement("p");
    status.className = "hint";
    status.setAttribute("data-role", "overview-status");
    status.textContent = "正在读取 24 小时数据…";
    wrap.appendChild(head);
    wrap.appendChild(canvas);
    wrap.appendChild(status);
    grid.appendChild(wrap);
    loadChannelOverview(channel);
    clearInterval(overviewTimer);
    overviewTimer = setInterval(function () { loadChannelOverview(overviewChannel); }, CONFIG_REFRESH_MS);
  }

  function closeChannelOverview() {
    overviewChannel = null;
    clearInterval(overviewTimer);
    const grid = $('[data-role="sensor-grid"]');
    grid.textContent = "";
    renderSensors(lastSensorRows);
  }

  async function loadChannelOverview(channel) {
    const status = $('[data-role="overview-status"]');
    const query = "channel=" + encodeURIComponent(channel) + "&hours=24";
    /* 本地优先，公网兜底：历史已上云（Worker D1 分桶），公网页也能看 */
    const urls = ["/api/sensors/history?" + query, PUBLIC_BASE + "/sensors/history?" + query];
    for (const url of urls) {
      try {
        const data = await window.FlitFancyAdmin.request(url);
        if (!data.ok) throw new Error(data.error || "HTTP");
        if (overviewChannel !== channel) return;   // 已切走：丢弃迟到的旧通道响应
        const series = (channel === "CH2" && overviewSpectralMode)
          ? buildSpectralSeries(data.buckets || [])
          : buildSeriesList(channel, data.buckets || []);
        drawSeriesChart($('[data-role="overview-chart"]'), data.buckets || [], series);
        const trend = channel === "CH1" ? (" · " + pressureTrendText(data.buckets || [])) : "";
        status.textContent = "24 小时总览 · " + (data.buckets || []).length + " 个采样点（10 分钟聚合）" + trend;
        return;
      } catch (e) { /* 尝试下一个数据源 */ }
    }
    status.textContent = "暂时拿不到 24 小时数据（需要本地服务或登录后的云端历史）";
  }

  /* 组装当前通道启用的系列（按开关过滤，含衍生量），供多系列渲染 */
  function buildSeriesList(channel, buckets) {
    const on = overviewSeriesOn[channel] || {};
    return (OVERVIEW_SERIES[channel] || []).filter(function (s) {
      return on[s.key] !== false;
    }).map(function (s) {
      const values = buckets.map(function (b) {
        const v = s.get ? s.get(b) : Number(b[s.key]);
        return isFinite(v) ? v * (s.scale || 1) : null;
      });
      return { label: s.label, unit: s.unit, digits: s.digits, color: s.color, values: values };
    });
  }

  /* 统一多系列渲染：左轴（首系列）+ 系列线 + 图例行 + 防遮挡时间标签 +
     悬停竖线与数值浮层。光谱模式与普通模式共用。 */
  function drawSeriesChart(canvas, buckets, seriesList) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 170;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const empty = function (text) {
      ctx.fillStyle = "rgba(139, 148, 168, 0.8)";
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(text, w / 2, h / 2);
    };
    if (!buckets || !buckets.length) { empty("该通道暂无 24 小时数据"); return; }
    const plotted = seriesList.map(function (s) {
      const valid = s.values.filter(function (v) { return v != null; });
      let min = Infinity, max = -Infinity;
      valid.forEach(function (v) { if (v < min) min = v; if (v > max) max = v; });
      if (valid.length && max - min < 1e-6) { min -= 1; max += 1; }
      return { label: s.label, unit: s.unit, digits: s.digits, color: s.color, values: s.values, valid: valid, min: min, max: max };
    }).filter(function (s) { return s.valid.length; });
    if (!plotted.length) { empty("请打开至少一条曲线"); return; }
    const padL = 48, padR = 12, padB = 26;
    const padT = 14 + plotted.length * 14;   // 顶部按图例行数预留
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const x = function (i) { return padL + (i / (buckets.length - 1)) * plotW; };

    // 左轴：首系列的 min..max 五档刻度 + 淡网格线
    const s0 = plotted[0];
    ctx.font = "10px Consolas, monospace";
    ctx.textAlign = "right";
    for (let k = 0; k <= 4; k++) {
      const v = s0.min + (s0.max - s0.min) * k / 4;
      const ty = padT + (1 - k / 4) * plotH;
      ctx.fillStyle = "rgba(139, 148, 168, 0.85)";
      ctx.fillText(fmt(v, s0.digits), padL - 6, ty + 3);
      if (k > 0 && k < 4) {
        ctx.strokeStyle = "rgba(148, 163, 184, 0.10)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, ty);
        ctx.lineTo(w - padR, ty);
        ctx.stroke();
      }
    }

    // 系列线
    plotted.forEach(function (s) {
      const y = function (v) { return padT + (1 - (v - s.min) / (s.max - s.min)) * plotH; };
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < buckets.length; i++) {
        const v = s.values[i];
        if (v == null) { started = false; continue; }
        const px = x(i), py = y(v);
        started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        started = true;
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    });

    // 图例行：每系列一行，颜色即按钮色
    ctx.font = "11px Consolas, monospace";
    ctx.textAlign = "left";
    plotted.forEach(function (s, si) {
      const avg = s.valid.reduce(function (a, b) { return a + b; }, 0) / s.valid.length;
      ctx.fillStyle = s.color;
      ctx.fillText(s.label + " 平均 " + fmt(avg, s.digits) + " " + s.unit +
        " · 最低 " + fmt(s.min, s.digits) + " · 最高 " + fmt(s.max, s.digits), 4, 15 + si * 14);
    });

    // 悬停：竖虚线 + 右上角数值浮层（各系列当前值 + 桶时间）
    if (chartHoverIndex != null) {
      const i = Math.max(0, Math.min(buckets.length - 1, chartHoverIndex));
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x(i), padT);
      ctx.lineTo(x(i), padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "11px Consolas, monospace";
      const lines = plotted.map(function (s) {
        const v = s.values[i];
        return {
          text: s.label + "  " + (v == null ? "—" : fmt(v, s.digits) + " " + s.unit),
          color: s.color,
        };
      });
      const t = String(buckets[i].bucket || "").slice(11, 16);
      let boxW = ctx.measureText(t).width;
      lines.forEach(function (l) { boxW = Math.max(boxW, ctx.measureText(l.text).width); });
      boxW += 20;
      const boxH = lines.length * 14 + 30;
      const bx = w - padR - boxW;
      const by = padT + 2;
      ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
      ctx.strokeStyle = "rgba(245, 184, 75, 0.35)";
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(bx, by, boxW, boxH, 6);
      } else {
        ctx.rect(bx, by, boxW, boxH);
      }
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = "left";
      lines.forEach(function (l, li) {
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, bx + 10, by + 18 + li * 14);
      });
      ctx.fillStyle = "rgba(139, 148, 168, 0.9)";
      ctx.fillText(t, bx + 10, by + 18 + lines.length * 14);
    }

    // 时间标签：两端内缩防遮挡（左对齐/右对齐），中间居中
    ctx.fillStyle = "rgba(139, 148, 168, 0.9)";
    ctx.font = "11px Consolas, monospace";
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p, pi) {
      const i = Math.round(p * (buckets.length - 1));
      const t = String(buckets[i].bucket || "").slice(11, 16);
      if (pi === 0) ctx.textAlign = "left";
      else if (pi === 4) ctx.textAlign = "right";
      else ctx.textAlign = "center";
      ctx.fillText(t, x(i), h - 8);
    });

    // 记录几何与重绘闭包，供 canvas 悬停事件使用
    chartState.canvas = canvas;
    chartState.buckets = buckets;
    chartState.padL = padL;
    chartState.plotW = plotW;
    chartState.draw = function () { drawSeriesChart(canvas, buckets, seriesList); };
  }

  /* CH2 光谱模式：选中波段组装成同一套系列结构 */
  function buildSpectralSeries(buckets) {
    const out = [];
    SPECTRAL_BANDS.forEach(function (band, bi) {
      if (overviewBandsOn[band.key] === false) return;
      out.push({
        label: band.label + " nm",
        unit: "counts",
        digits: 0,
        color: SPECTRAL_COLORS[bi],
        values: buckets.map(function (b) {
          const v = Number(b[band.key]);
          return isFinite(v) ? v : null;
        }),
      });
    });
    return out;
  }

  /* ---------- 对话 ---------- */
  const CHAT_KEY = "flitfancy.chat.v1";
  const PUBLIC_BASE = "https://api.flitfancy.com";
  const SENSOR_REFRESH_MS = 5000;
  const CONFIG_REFRESH_MS = 60000;

  /* ---------- 页面状态（集中声明，改动时先看这里） ---------- */
  let chatHistory = loadChat();
  let chatBusy = false;
  let chatEnabled = true;
  let protocolName = "";   // 仅接受 /api/status 注入的随机协议名，不保留固定名称兜底
  function detectServerOnline() {
    return window.FlitFancyAdmin.isAdminHost();
  }
  let serverOnline = detectServerOnline();

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
    const log = $('[data-role="chat-log"]');
    const empty = $('[data-role="chat-empty"]');
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

  function applyChatGate() {
    const locked = !chatEnabled || chatBusy;
    $('[data-role="chat-input"]').disabled = locked;
    $('[data-role="chat-send"]').disabled = locked;
    if (!chatEnabled) {
      /* 游客看到友好提示；管理员看到管理向提示 */
      setChatStatus(adminToken()
        ? "AI 对话已由管理员关闭（可在管理层开启）"
        : "该项目暂未对游客开放哦~");
    }
  }

  async function refreshPublicConfig() {
    if (serverOnline) return;
    try {
      const r = await fetch(PUBLIC_BASE + "/config");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (data && typeof data.chat_enabled === "boolean") {
        chatEnabled = data.chat_enabled;
        applyChatGate();
      }
    } catch (e) { /* 公网配置不可达则保留最近一次状态 */ }
  }

  async function refresh() {
    /* 公共页（GitHub Pages 域名）没有本地服务：直接走公网快照，
       不再每 5 秒打一次必败的相对 /api/status */
    if (!serverOnline) {
      try {
        const r = await fetch(PUBLIC_BASE + "/sensors/latest", { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        renderSensors(data.rows || []);
      } catch (e2) {
        renderSensors([]);
      }
      return;
    }
    try {
      const status = await getJSON("/api/status");
      setStatus(true);
      chatEnabled = status.chat_enabled !== false;
      applyChatGate();
      if (typeof status.protocol_name === "string" &&
          /^[A-Za-z0-9_-]{1,64}$/.test(status.protocol_name)) {
        protocolName = status.protocol_name;
      }
      updateServiceButtons(status.services);
      const latest = await getJSON("/api/sensors/latest");
      (latest.rows || []).forEach(notePressure);
      renderSensors(latest.rows);
    } catch (e) {
      setStatus(false);
      updateServiceButtons(null);   // 心跳不可达：按钮回到一阶段
      try {
        const r = await fetch(PUBLIC_BASE + "/sensors/latest", { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        renderSensors(data.rows || []);
      } catch (e2) {
        renderSensors([]);
      }
    }
  }

  async function sendChat() {
    const input = $('[data-role="chat-input"]');
    const text = input.value.trim();
    if (!text || chatBusy) return;
    if (!chatEnabled) {
      setChatStatus("AI 对话已由管理员关闭");
      return;
    }
    chatBusy = true;
    applyChatGate();
    setChatStatus("正在思考…");
    chatHistory.push({ role: "user", content: text });
    input.value = "";
    saveChat();
    addChatMsg("user", text);
    try {
      // 本机/隧道控制台只走本地后端；公共静态页只走 Worker 的明确 /chat 路由。
      // 不在两个后端之间重试，避免一次发送把同一段聊天内容传给不同服务。
      const chatUrl = serverOnline ? "/api/chat" : PUBLIC_BASE + "/chat";
      const r = await postJSON(chatUrl, { messages: chatHistory.slice(-20) });
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
      applyChatGate();
      input.focus();
    }
  }

  /* ---------- 管理层（令牌读写委托 assets/admin-core.js） ---------- */
  const ADMIN_KEY = "flitfancy.admin.token";

  function adminToken() {
    return window.FlitFancyAdmin.token(ADMIN_KEY);
  }
  function setAdminToken(t) {
    window.FlitFancyAdmin.setToken(ADMIN_KEY, t);
  }
  function clearAdminToken() {
    window.FlitFancyAdmin.setToken(ADMIN_KEY, "");
  }

  async function adminFetch(url, options) {
    return window.FlitFancyAdmin.fetchRaw(url, options);
  }

  function adminStatus(el, text) {
    if (el) el.textContent = text || "";
  }

  function adminAuthFailed(r) {
    /* 统一处理登录过期：不再依赖后端返回的中文文案。 */
    if (r.status !== 401) return false;
    clearAdminToken();
    showAdminPanel(false);
    return true;
  }

  function openLogin() {
    const uname = $('[data-role="admin-username"]');
    const input = $('[data-role="admin-password"]');
    adminStatus($('[data-role="admin-login-status"]'), "");
    $('[data-role="admin-overlay"]').hidden = false;
    input.value = "";
    if (!uname.value) {
      uname.focus();
    } else {
      input.focus();
    }
  }

  function closeLogin() {
    $('[data-role="admin-overlay"]').hidden = true;
  }

  /* 管理面板外壳：与旅途整理同一实现（拖宽/收起/页脚联动），
     正文让位用 body.admin-open main 的 margin-right（CSS 层）。 */
  const adminPanelShell = window.FlitFancyPanelShell.init({
    panel: $('[data-role="admin-panel"]'),
    grab: $('[data-role="admin-grab"]'),
    collapseBtn: $('[data-role="admin-collapse"]'),
    expandTab: $('[data-role="admin-expand-tab"]'),
    storageKey: "flitfancy.console.panelW",   // 两页各自独立拖宽记忆
    openClass: "admin-open",
    min: 280,
    max: 900,
  });

  /* 布局模式一键切换：侧边面板 ↔ 原本的底部流式（全宽表格），
     选择权交给状态按钮而不是宽度猜谜；仅本次会话生效。 */
  $('[data-role="admin-mode"]').addEventListener("click", function () {
    const bottom = document.body.classList.toggle("admin-mode-bottom");
    this.textContent = bottom ? "侧边模式" : "底部模式";
  });

  function showAdminPanel(show) {
    if (show) {
      adminPanelShell.show();
    } else {
      adminPanelShell.hide();
      adminPanelShell.clearCollapsed();   // 登出/过期 = 彻底关闭，不留展开细条
    }
    /* 服务管理按钮与退出按钮只在登录后可见（游客看不到本机服务入口） */
    $('.ffs-actions').hidden = !show;
    $('[data-role="admin-logout"]').hidden = !show;
  }

  let quickLinks = [];
  let quickLinkEditing = -1;

  function modelSelectValue() {
    const sel = $('[data-role="cfg-model"]');
    return sel.value === "__custom__"
      ? $('[data-role="cfg-model-custom"]').value.trim()
      : sel.value;
  }

  function setModelSelect(model) {
    const sel = $('[data-role="cfg-model"]');
    const custom = $('[data-role="cfg-model-custom"]');
    const known = Array.prototype.some.call(sel.options, function (o) {
      return o.value === model;
    });
    if (known && model) {
      sel.value = model;
      custom.hidden = true;
      custom.value = "";
    } else {
      sel.value = "__custom__";
      custom.hidden = false;
      custom.value = model || "";
    }
  }

  /* 只允许 http/https 的快捷入口，拒绝 javascript: 等危险 scheme */
  function safeLinkUrl(url) {
    const text = String(url || "").trim();
    return /^https?:\/\//i.test(text) ? text : "";
  }

  function openPopup(url) {
    const safe = safeLinkUrl(url);
    if (!safe) return;
    window.open(safe, "_blank", "noopener,noreferrer,width=980,height=680");
  }

  function renderQuickLinks() {
    const ul = $('[data-role="quick-links"]');
    ul.replaceChildren();
    quickLinks.forEach(function (link, idx) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      const safe = safeLinkUrl(link.url);
      a.href = safe || "#";
      a.textContent = link.name;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        openPopup(link.url);
      });
      const edit = document.createElement("button");
      edit.className = "link-del";
      edit.textContent = "编辑";
      edit.addEventListener("click", function () { editQuickLink(idx); });
      const del = document.createElement("button");
      del.className = "link-del";
      del.textContent = "删除";
      del.addEventListener("click", function () { removeQuickLink(idx); });
      li.appendChild(a);
      li.appendChild(edit);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  async function loadAdminConfig() {
    try {
      const r = await adminFetch("/api/admin/config", { method: "GET" });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) {
          clearAdminToken();
          showAdminPanel(false);
        }
        return;
      }
      setModelSelect(data.model || "");
      $('[data-role="cfg-chat-toggle"]').checked = !!data.chat_enabled;
      quickLinks = Array.isArray(data.quick_links) ? data.quick_links : [];
      quickLinkEditing = -1;
      $('[data-role="ql-add"]').textContent = "添加";
      renderQuickLinks();
      showAdminPanel(true);
      loadVisits();
    } catch (e) {
      clearAdminToken();
      showAdminPanel(false);
    }
  }

  async function doLogin() {
    const uname = $('[data-role="admin-username"]');
    const input = $('[data-role="admin-password"]');
    const status = $('[data-role="admin-login-status"]');
    const btn = $('[data-role="admin-login"]');
    const username = uname.value.trim();
    const password = input.value;
    if (!username || !password) {
      adminStatus(status, "请输入用户名和密码");
      return;
    }
    adminStatus(status, "正在验证…");
    btn.textContent = "验证中…";
    btn.disabled = true;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () {
        ctrl.abort();
      }, window.FlitFancyAdmin.TIMEOUT_MS);
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, password: password }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      let data = null;
      try {
        data = await r.json();
      } catch (e) { /* 非 JSON 响应（如公网静态页的 404） */ }
      if (!r.ok) {
        throw new Error(
          (data && data.error) ||
          "管理功能需要本地服务——请在本机运行 python server.py 后打开控制台"
        );
      }
      setAdminToken(data.token);
      closeLogin();
      await loadAdminConfig();
      refresh();
    } catch (e) {
      adminStatus(status, (e && e.message) || "登录失败");
    }
    btn.textContent = "登录";
    btn.disabled = false;
  }

  async function saveModelConfig() {
    const status = $('[data-role="cfg-status"]');
    const model = modelSelectValue();
    if (!model) {
      adminStatus(status, "请选择或输入模型");
      return;
    }
    adminStatus(status, "保存中…");
    try {
      const r = await adminFetch("/api/admin/config", {
        method: "POST",
        body: JSON.stringify({ model: model })
      });
      const data = await r.json();
      if (adminAuthFailed(r)) {
        adminStatus(status, "登录已过期，请重新登录");
        return;
      }
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      setModelSelect(data.model || model);
      adminStatus(status, "已保存");
    } catch (e) {
      adminStatus(status, (e && e.message) || "保存失败");
    }
  }

  async function saveChatToggle() {
    const status = $('[data-role="chat-toggle-status"]');
    const on = $('[data-role="cfg-chat-toggle"]').checked;
    adminStatus(status, "保存中…");
    try {
      const r = await adminFetch("/api/admin/config", {
        method: "POST",
        body: JSON.stringify({ chat_enabled: on })
      });
      const data = await r.json();
      if (adminAuthFailed(r)) {
        adminStatus(status, "登录已过期，请重新登录");
        return;
      }
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      const syncNote = data.public_sync === false
        ? "（公网同步失败：" + (data.public_sync_note || "未知") + "）"
        : "（已同步公网）";
      adminStatus(status, (on ? "已开启" : "已关闭") + syncNote);
    } catch (e) {
      adminStatus(status, (e && e.message) || "保存失败");
    }
  }

  async function saveQuickLinks() {
    const r = await adminFetch("/api/admin/config", {
      method: "POST",
      body: JSON.stringify({ quick_links: quickLinks })
    });
    const data = await r.json();
    if (adminAuthFailed(r)) throw new Error("登录已过期，请重新登录");
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    quickLinks = Array.isArray(data.quick_links) ? data.quick_links : [];
    renderQuickLinks();
  }

  async function saveQuickLink() {
    const status = $('[data-role="ql-status"]');
    const name = $('[data-role="ql-name"]').value.trim();
    const url = $('[data-role="ql-url"]').value.trim();
    if (!name || !url) {
      adminStatus(status, "名称和地址都要填");
      return;
    }
    try {
      if (quickLinkEditing >= 0) {
        quickLinks[quickLinkEditing] = { name: name, url: url };
      } else {
        quickLinks = quickLinks.concat([{ name: name, url: url }]);
      }
      await saveQuickLinks();
      $('[data-role="ql-name"]').value = "";
      $('[data-role="ql-url"]').value = "";
      quickLinkEditing = -1;
      $('[data-role="ql-add"]').textContent = "添加";
      adminStatus(status, "已保存");
    } catch (e) {
      adminStatus(status, (e && e.message) || "保存失败");
    }
  }

  function editQuickLink(idx) {
    const link = quickLinks[idx];
    if (!link) return;
    $('[data-role="ql-name"]').value = link.name;
    $('[data-role="ql-url"]').value = link.url;
    quickLinkEditing = idx;
    $('[data-role="ql-add"]').textContent = "保存修改";
    adminStatus($('[data-role="ql-status"]'), "");
    $('[data-role="ql-name"]').focus();
  }

  async function removeQuickLink(idx) {
    const status = $('[data-role="ql-status"]');
    try {
      quickLinks = quickLinks.filter(function (_, i) { return i !== idx; });
      await saveQuickLinks();
      quickLinkEditing = -1;
      $('[data-role="ql-add"]').textContent = "添加";
      adminStatus(status, "已删除");
    } catch (e) {
      adminStatus(status, (e && e.message) || "删除失败");
    }
  }

  /* ---------- 访问记录 ---------- */
  let visitsGroupByIp = false;
  const visitsExpanded = {};
  let lastVisitsData = null;

  function fmtVisitTime(ts) {
    return window.FlitFancyAdmin.formatUnixTime(ts);
  }

  function hostOf(url) {
    try {
      return new URL(url).host || "—";
    } catch (e) {
      return "—";
    }
  }

  function renderVisits(data) {
    const stats = data.stats || {};
    const statsEl = $('[data-role="visits-stats"]');
    statsEl.replaceChildren();
    [
      ["累计访问", stats.total || 0],
      ["今日", stats.today || 0],
      ["独立 IP", stats.uniq || 0]
    ].forEach(function (item) {
      const div = document.createElement("div");
      div.className = "visits-stat";
      const b = document.createElement("b");
      b.textContent = item[1];
      const span = document.createElement("span");
      span.textContent = item[0];
      div.appendChild(b);
      div.appendChild(span);
      statsEl.appendChild(div);
    });

    const tbody = $('[data-role="visits-list"]');
    tbody.replaceChildren();
    const rows = Array.isArray(data.recent) ? data.recent : [];
    $('[data-role="visits-empty"]').hidden = rows.length > 0;
    lastVisitsData = data;

    function buildVisitRow(v) {
      const tr = document.createElement("tr");

      const tdTime = document.createElement("td");
      tdTime.textContent = fmtVisitTime(v.ts);

      const tdIp = document.createElement("td");
      tdIp.className = "visit-ip";
      tdIp.textContent = v.ip || "—";

      const tdPage = document.createElement("td");
      tdPage.textContent = v.page || "/";

      const tdRef = document.createElement("td");
      tdRef.className = "ref";
      tdRef.textContent = v.ref ? hostOf(v.ref) : "—";
      tdRef.title = v.ref || "";

      const tdDev = document.createElement("td");
      tdDev.textContent = (v.w && v.h) ? v.w + "×" + v.h : "—";

      tr.appendChild(tdTime);
      tr.appendChild(tdIp);
      tr.appendChild(tdPage);
      tr.appendChild(tdRef);
      tr.appendChild(tdDev);
      return tr;
    }

    if (!visitsGroupByIp) {
      rows.forEach(function (v) { tbody.appendChild(buildVisitRow(v)); });
      return;
    }

    // 折叠同 IP：相邻同 IP 合并为一行（最新一条 + 共N次），点击展开/收起
    let i = 0;
    while (i < rows.length) {
      const ip = rows[i].ip || "—";
      let j = i + 1;
      while (j < rows.length && (rows[j].ip || "—") === ip) j += 1;
      const group = rows.slice(i, j);
      if (group.length === 1) {
        tbody.appendChild(buildVisitRow(group[0]));
      } else if (visitsExpanded[ip]) {
        const head = buildVisitRow(group[0]);
        head.classList.add("visit-collapsed-row");
        head.querySelector(".visit-ip").textContent = ip + " · 共 " + group.length + " 次 ▾";
        head.title = "点击折叠该 IP 的全部访问记录";
        head.addEventListener("click", function () {
          visitsExpanded[ip] = false;
          renderVisits(lastVisitsData);
        });
        tbody.appendChild(head);
        group.slice(1).forEach(function (v) { tbody.appendChild(buildVisitRow(v)); });
      } else {
        const tr = buildVisitRow(group[0]);
        tr.classList.add("visit-collapsed-row");
        tr.querySelector(".visit-ip").textContent = ip + " · 共 " + group.length + " 次 ▸";
        tr.title = "点击展开该 IP 的全部访问记录";
        tr.addEventListener("click", function () {
          visitsExpanded[ip] = true;
          renderVisits(lastVisitsData);
        });
        tbody.appendChild(tr);
      }
      i = j;
    }
  }

  async function loadVisits() {
    const status = $('[data-role="visits-status"]');
    adminStatus(status, "加载中…");
    try {
      const r = await adminFetch("/api/visits", { method: "GET" });
      const data = await r.json();
      if (adminAuthFailed(r)) {
        adminStatus(status, "登录已过期，请重新登录");
        return;
      }
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      renderVisits(data);
      adminStatus(status, "共 " + ((data.stats && data.stats.total) || 0) + " 条记录");
    } catch (e) {
      adminStatus(status, (e && e.message) || "访问记录加载失败");
    }
  }

  async function doLogout() {
    try {
      await adminFetch("/api/admin/logout", { method: "POST" });
    } catch (e) { /* ignore */ }
    clearAdminToken();
    showAdminPanel(false);
  }

  /* ---------- 事件绑定 ---------- */
  $('.nav nav a[href="console.html"]').addEventListener("click", async function (e) {
    e.preventDefault();
    if (adminToken()) {
      showAdminPanel(true);
      loadVisits();
      $('[data-role="admin-panel"]').scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (serverOnline) {
      openLogin();
    } else {
      /* 公网静态页连不上本地后端：与旅途页入口一致，直接跳转隧道主机，
         由隧道上的本地管理员登录把关（不再用公网令牌做门铃）。 */
      location.href = "https://console.flitfancy.com/console.html";
    }
  });

  $('[data-role="chat-send"]').addEventListener("click", sendChat);
  $('[data-role="chat-input"]').addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  $('[data-role="admin-login"]').addEventListener("click", doLogin);
  $('[data-role="admin-cancel"]').addEventListener("click", closeLogin);
  $('[data-role="admin-password"]').addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doLogin();
    }
  });
  $('[data-role="cfg-save"]').addEventListener("click", saveModelConfig);
  $('[data-role="cfg-model"]').addEventListener("change", function () {
    const sel = $('[data-role="cfg-model"]');
    const custom = $('[data-role="cfg-model-custom"]');
    custom.hidden = sel.value !== "__custom__";
    if (sel.value !== "__custom__") custom.value = "";
  });
  $('[data-role="cfg-chat-toggle"]').addEventListener("change", saveChatToggle);

  $('[data-role="ql-add"]').addEventListener("click", saveQuickLink);
  $('[data-role="admin-logout"]').addEventListener("click", doLogout);
  $('[data-role="visits-refresh"]').addEventListener("click", loadVisits);
  $('[data-role="visits-group-toggle"]').addEventListener("click", function () {
    visitsGroupByIp = !visitsGroupByIp;
    this.textContent = visitsGroupByIp ? "展开全部" : "折叠同 IP";
    if (lastVisitsData) renderVisits(lastVisitsData);
  });
  /* FFS 服务启动：协议名随机（flitfancy-<8位>，经 /api/status 的 protocol_name
     注入，防任意网页静默触发），点击跳 <protocolName>://start/<动作> 拉起本机服务。
     动作：backend（后端 2671）/ listener（感知板 7777）/ tunnel（隧道）。
     未安装协议时点击无反应，按钮 title 里有安装提示。
     心跳：/api/status 的 services 决定按钮两阶段颜色——
     一阶段 = --small-gradient（金→青，未确认），二阶段 = --flame-gradient（火焰，在线）。 */
  function updateServiceButtons(services) {
    document.querySelectorAll('[data-role="ffs-start"]').forEach(function (btn) {
      const action = btn.dataset.action;
      const alive = services ? (action === "backend" ? true : !!services[action]) : false;
      btn.classList.toggle("alive", alive);
      btn.disabled = !protocolName;
    });
  }

  document.querySelectorAll('[data-role="ffs-start"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!protocolName) return;
      location.href = protocolName + "://start/" + btn.dataset.action;
    });
  });

  /* ---------- 启动 ---------- */
  renderSensors([]);   // 先渲染六个占位卡片，布局从第一秒就稳定（不再"刷新后变宽"）
  updateServiceButtons(null);   // 收到后端随机协议名之前，服务启动按钮保持不可用
  chatHistory.forEach(function (m) {
    addChatMsg(m.role, m.content);
  });
  if (adminToken()) loadAdminConfig();
  refresh();
  refreshPublicConfig();
  setInterval(refresh, SENSOR_REFRESH_MS);
  setInterval(refreshPublicConfig, CONFIG_REFRESH_MS);
})();
