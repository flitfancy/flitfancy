/* 控制台传感器卡片：最新值、在线状态、衍生量与气压短趋势。 */
(function (global) {
  "use strict";

  const SENSOR_META = {
    CH0: { name: "温湿度", sensor: "SHT41" },
    CH1: { name: "气压", sensor: "BMP580" },
    CH2: { name: "光谱", sensor: "AS7341" },
    CH3: { name: "环境光与紫外", sensor: "LTR390" },
    CH4: { name: "空气质量", sensor: "SGP41" },
    CH5: { name: "二氧化碳", sensor: "SCD40" },
  };

  function formatValue(value, digits) {
    if (value == null || isNaN(Number(value))) return "—";
    return Number(value).toFixed(digits == null ? 1 : digits);
  }

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const state = global.FlitFancySensorState;
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    const refreshMs = opts.overviewRefreshMs || 60000;
    const request = opts.request;
    let pressureRing = [];
    let lastRows = [];
    let lastFingerprint = "";
    let cardParts = {};
    let overview = null;

    function rowValues(channel, row) {
      if (!row || Number(row.ok) !== 1) return [];
      if (channel === "CH0") {
        return [formatValue(row.temp_c, 1) + " °C", formatValue(row.rh_pct, 0) + " %RH"];
      }
      if (channel === "CH1") {
        return [formatValue(Number(row.pressure_pa) / 100, 1) + " hPa",
          formatValue(row.temp_c, 1) + " °C"];
      }
      if (channel === "CH2") {
        return ["CLEAR " + formatValue(row.clear_raw, 0),
          "NIR " + formatValue(row.nir_raw, 0)];
      }
      if (channel === "CH3") {
        return ["ALS " + formatValue(row.als_raw, 0), "UV " + formatValue(row.uv_raw, 0)];
      }
      if (channel === "CH4") {
        return ["VOC " + formatValue(row.voc_index, 0),
          "NOx " + formatValue(row.nox_index, 0)];
      }
      if (channel === "CH5") {
        return [formatValue(row.co2_ppm, 0) + " ppm", formatValue(row.temp_c, 1) + " °C"];
      }
      return [];
    }

    function sampleAgeText(row) {
      const ageMs = state.effectiveSampleAgeMs(row, Date.now());
      if (ageMs == null) return "";
      const seconds = Math.max(0, Math.round(ageMs / 1000));
      return seconds < 1 ? "刚刚" : seconds + " 秒前";
    }

    function notePressure(row) {
      if (!row || row.channel !== "CH1") return;
      const pressure = Number(row.pressure_pa);
      const time = new Date(row.ts || "").getTime();
      if (!isFinite(pressure) || isNaN(time)) return;
      const last = pressureRing[pressureRing.length - 1];
      if (last && time <= last.t) return;
      pressureRing.push({ t: time, p: pressure });
      const cutoff = Date.now() - 40 * 60000;
      while (pressureRing.length && pressureRing[0].t < cutoff) pressureRing.shift();
    }

    function pressureTrendShort() {
      const now = Date.now();
      const recent = pressureRing.filter(function (sample) {
        return sample.t >= now - 5 * 60000;
      });
      const earlier = pressureRing.filter(function (sample) {
        return sample.t >= now - 15 * 60000 && sample.t < now - 10 * 60000;
      });
      if (recent.length < 2 || earlier.length < 2) return "气压趋势：积累中";
      const average = function (samples) {
        return samples.reduce(function (sum, sample) { return sum + sample.p; }, 0) /
          samples.length;
      };
      const delta = (average(recent) - average(earlier)) / 100;
      if (Math.abs(delta) < 0.3) return "气压 10 分钟：平稳";
      return "气压 10 分钟：" + (delta > 0 ? "↑ +" : "↓ ") +
        delta.toFixed(1) + " hPa";
    }

    function derivedLine(channel, row) {
      if (!row || Number(row.ok) !== 1) return "";
      if (channel === "CH0") {
        const temperature = Number(row.temp_c);
        const humidity = Number(row.rh_pct);
        if (isNaN(temperature) || isNaN(humidity)) return "";
        const parts = ["露点 " + state.dewPointC(temperature, humidity).toFixed(1) + " °C"];
        if (temperature >= 27) {
          parts.push("体感 " + state.heatIndexC(temperature, humidity).toFixed(1) + " °C");
        }
        return parts.join(" · ");
      }
      if (channel === "CH1") return pressureTrendShort();
      if (channel === "CH2") {
        const bands = [Number(row.f1_415), Number(row.f2_445), Number(row.f3_480),
          Number(row.f4_515), Number(row.f5_555), Number(row.f6_590),
          Number(row.f7_630), Number(row.f8_680)];
        const sum = bands.reduce(function (total, value) {
          return total + (isFinite(value) ? value : 0);
        }, 0);
        const flicker = state.flickerText(row.flicker_hz);
        if (!sum) return flicker;
        const blue = (bands[0] + bands[1] + bands[2]) / sum;
        const red = (bands[6] + bands[7]) / sum;
        let tone = "色调均衡";
        if (blue > red * 1.4) tone = "色调偏冷";
        else if (red > blue * 1.4) tone = "色调偏暖";
        return tone + " · " + flicker;
      }
      if (channel === "CH3") {
        const ambient = Number(row.als_raw);
        const ultraviolet = Number(row.uv_raw);
        if (isNaN(ambient) || isNaN(ultraviolet)) return "";
        return "≈" + Math.round(state.luxEstimate(ambient)) + " lux · UV 指数 ≈" +
          state.uviEstimate(ultraviolet).toFixed(1);
      }
      if (channel === "CH4") {
        return "VOC " + state.vocLevel(row.voc_index) + " · NOx " +
          state.noxLevel(row.nox_index);
      }
      if (channel === "CH5") return "CO₂ " + state.co2Level(row.co2_ppm);
      return "";
    }

    function sensorStateText(row) {
      if (!row) return "等待";
      const online = state.isOnline(row, Date.now());
      const age = sampleAgeText(row);
      return online ? "在线" + (age ? " · " + age : "") :
        (Number(row.ok) === 1 ? "离线 · 快照已停止更新" : "暂无读数");
    }

    function render(rows) {
      const grid = query('[data-role="sensor-grid"]');
      const updated = query('[data-role="sensor-updated"]');
      lastRows = rows || [];
      if (overview.isOpen()) return;
      const fingerprint = state.fingerprint(rows);
      if (fingerprint === lastFingerprint && Object.keys(cardParts).length) {
        const byChannel = {};
        (rows || []).forEach(function (row) { byChannel[row.channel] = row; });
        Object.keys(SENSOR_META).forEach(function (channel) {
          const parts = cardParts[channel];
          if (!parts) return;
          const row = byChannel[channel];
          parts.state.textContent = sensorStateText(row);
          parts.derived.textContent = derivedLine(channel, row);
        });
        return;
      }
      lastFingerprint = fingerprint;
      cardParts = {};
      const byChannel = {};
      (rows || []).forEach(function (row) { byChannel[row.channel] = row; });
      grid.textContent = "";
      Object.keys(SENSOR_META).forEach(function (channel) {
        const meta = SENSOR_META[channel];
        const row = byChannel[channel];
        const online = state.isOnline(row, Date.now());
        const card = document.createElement("div");
        card.className = "sensor-card" + (online ? "" : " is-offline");
        const top = document.createElement("div");
        top.className = "sensor-card-top";
        const label = document.createElement("span");
        label.textContent = channel + " · " + meta.sensor + " · " + meta.name;
        const status = document.createElement("span");
        status.className = "sensor-state";
        status.textContent = sensorStateText(row);
        top.appendChild(label);
        top.appendChild(status);
        const values = document.createElement("div");
        values.className = "sensor-values";
        const items = rowValues(channel, row);
        values.textContent = items.length ? items.join("  ·  ") : "—";
        const derived = document.createElement("div");
        derived.className = "sensor-derived";
        derived.textContent = derivedLine(channel, row);
        card.appendChild(top);
        card.appendChild(values);
        card.appendChild(derived);
        cardParts[channel] = { state: status, derived: derived };
        card.addEventListener("click", function () { overview.toggle(channel); });
        grid.appendChild(card);
      });
      const times = (rows || []).map(function (row) {
        return new Date(row.ts || "").getTime();
      }).filter(function (value) { return !isNaN(value); });
      if (times.length) {
        const latest = new Date(Math.max.apply(Math, times));
        const versionRow = (rows || []).find(function (row) { return row.firmware_version; });
        updated.textContent = "快照更新于 " +
          latest.toLocaleTimeString("zh-CN", { hour12: false }) +
          (versionRow ? " · FFS " + versionRow.firmware_version : "");
      } else {
        updated.textContent = "等待第一组数据";
      }
    }

    overview = global.FlitFancyConsoleOverview.create({
      query: query,
      request: request,
      publicBase: publicBase,
      refreshMs: refreshMs,
      sensorMeta: SENSOR_META,
      format: formatValue,
      math: {
        dewPointC: state.dewPointC,
        heatIndexC: state.heatIndexC,
        luxEstimate: state.luxEstimate,
        uviEstimate: state.uviEstimate,
      },
      getRows: function () { return lastRows; },
      renderRows: function (rows) {
        /* 总览打开时卡片 DOM 已被移除；返回时必须强制重建，不能命中旧指纹快路径。 */
        lastFingerprint = "";
        cardParts = {};
        render(rows);
      },
    });

    return {
      render: render,
      notePressure: notePressure,
      overview: overview,
    };
  }

  global.FlitFancyConsoleSensors = {
    create: create,
    formatValue: formatValue,
    meta: SENSOR_META,
  };
})(window);
