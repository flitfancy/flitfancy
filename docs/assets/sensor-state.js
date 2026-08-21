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

  /* ---------- 衍生量（全部由原始值实时推导，不落库、可随时标定） ----------
     LTR390 估算系数：数据表典型灵敏度（18bit、100ms、1x）为
     ALS 0.6 counts/lux、UV 2300 counts/UVI；固件增益为 3x。
     标定方法：板子与参考照度计并排，在多个光照档位记录 als_raw 与
     参考 lux 做线性拟合得到真实斜率；UV 对照气象 App 的实时 UVI。
     标定结果只需改这里两个系数（从 console.js 迁入，单一出处）。 */
  const calibration = {
    ltrAlsPerLux: 0.6 * 3,
    ltrUvPerUvi: 2300 * 3,
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
