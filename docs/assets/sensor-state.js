(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FlitFancySensorState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SNAPSHOT_TIMEOUT_MS = 30000;

  function snapshotAgeMs(row, nowMs) {
    if (!row || !row.ts) return Infinity;
    const timestamp = Date.parse(row.ts);
    if (isNaN(timestamp)) return Infinity;
    const now = nowMs == null ? Date.now() : Number(nowMs);
    return Math.max(0, now - timestamp);
  }

  function effectiveSampleAgeMs(row, nowMs) {
    if (!row || row.sample_age_ms == null || isNaN(Number(row.sample_age_ms))) return null;
    const transportAge = snapshotAgeMs(row, nowMs);
    if (!isFinite(transportAge)) return null;
    return Math.max(0, Number(row.sample_age_ms)) + transportAge;
  }

  function isOnline(row, nowMs) {
    if (row && row.channel === "CH6") {
      const age = effectiveSampleAgeMs(row, nowMs);
      if (Number(row.hr_connected) !== 1 || row.heart_rate_bpm == null || !(Number(row.heart_rate_bpm) > 0) ||
          age == null || age > 15000) return false;
    }
    return !!row && Number(row.ok) === 1 &&
      snapshotAgeMs(row, nowMs) <= SNAPSHOT_TIMEOUT_MS;
  }

  /* 传感器快照指纹：channel:ts:ok 串接。控制台据此判断数据是否变化——
     未变化时只刷"会随秒走"的文案，不重建整张卡片（轻量刷新路径）。
     与单测保持一致：改动此函数必须同步跑 tests/sensor-state.test.js。 */
  function fingerprint(rows) {
    return (rows || []).map(function (r) {
      return r.channel + ":" + r.ts + ":" + r.ok;
    }).join("|");
  }

  /* ---------- 衍生量（由原始值推导，不落库） ----------
     LTR-390UV-01 数据表 v1.2，§4.5/§7：
     https://download.kamami.pl/p587054-1_LTR-390UV_Final_DS_V1_2.pdf
     现有 FFS/FFT 固件固定 3x、18bit（100ms）；窗口补偿暂按 1。
     Lux = 0.6 * ALS / (GAIN * (integration_ms / 100))。
     UV 的 1400 counts/UVI 是 18x、20bit/400ms 的典型值，须按增益与
     积分时间缩放；旧版 v1.1 为 2300，不能直接乘当前增益。
     这些是数据表估算，仍需与同位置、同时段的参考仪器实测标定。 */
  const calibration = {
    ltrAlsPerLux: 3 / 0.6,
    ltrUvPerUvi: 1400 * (3 / 18) * (100 / 400),
  };

  function dewPointC(tempC, rhPct) {
    const a = 17.27, b = 237.7;   // Magnus 公式（水面）
    const g = a * tempC / (b + tempC) + Math.log(rhPct / 100);
    return b * g / (a - g);
  }

  function heatIndexC(tempC, rhPct) {
    // NWS Rothfusz 回归（°F 计算后转回 °C）；仅当 ≥27°C 才有意义
    const tF = tempC * 9 / 5 + 32;
    const hiF = -42.379 + 2.04901523 * tF + 10.14333127 * rhPct
      - 0.22475541 * tF * rhPct - 0.00683783 * tF * tF
      - 0.05481717 * rhPct * rhPct + 0.00122874 * tF * tF * rhPct
      + 0.00085282 * tF * rhPct * rhPct - 0.00000199 * tF * tF * rhPct * rhPct;
    return (hiF - 32) * 5 / 9;
  }

  function luxEstimate(alsRaw) {
    return Number(alsRaw) / calibration.ltrAlsPerLux;
  }

  function uviEstimate(uvRaw) {
    return Number(uvRaw) / calibration.ltrUvPerUvi;
  }

  function co2Level(ppm) {
    if (ppm == null || isNaN(Number(ppm))) return "";
    if (ppm < 800) return "优 · 通风好";
    if (ppm < 1000) return "良";
    if (ppm < 1500) return "一般 · 偏闷";
    if (ppm < 2000) return "差 · 建议通风";
    return "很差 · 尽快通风";
  }

  function vocLevel(idx) {
    if (idx == null || isNaN(Number(idx))) return "";
    if (idx < 80) return "清新";
    if (idx < 150) return "正常";
    return "偏高 · 可能有异味/挥发源";
  }

  function noxLevel(idx) {
    if (idx == null || isNaN(Number(idx))) return "";
    return Number(idx) <= 1 ? "未检出" : "检出 · 注意污染源";
  }

  function flickerText(hz) {
    const v = Number(hz);
    if (!isFinite(v) || v === 0) return "无频闪";
    if (v === 100) return "100Hz 频闪";
    if (v === 120) return "120Hz 频闪";
    return "有频闪 · 频率未知";
  }

  return {
    SNAPSHOT_TIMEOUT_MS: SNAPSHOT_TIMEOUT_MS,
    snapshotAgeMs: snapshotAgeMs,
    effectiveSampleAgeMs: effectiveSampleAgeMs,
    isOnline: isOnline,
    fingerprint: fingerprint,
    calibration: calibration,
    dewPointC: dewPointC,
    heatIndexC: heatIndexC,
    luxEstimate: luxEstimate,
    uviEstimate: uviEstimate,
    co2Level: co2Level,
    vocLevel: vocLevel,
    noxLevel: noxLevel,
    flickerText: flickerText,
  };
});
