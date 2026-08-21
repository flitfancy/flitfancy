"use strict";

const assert = require("assert");
const sensorState = require("../docs/assets/sensor-state.js");

const now = Date.parse("2026-08-14T10:00:40+08:00");
const stale = {
  ok: 1,
  ts: "2026-08-14T10:00:00+08:00",
  sample_age_ms: 2000,
};
const fresh = {
  ok: 1,
  ts: "2026-08-14T10:00:25+08:00",
  sample_age_ms: 2000,
};

assert.strictEqual(sensorState.isOnline(stale, now), false,
  "停止上报 40 秒的旧快照必须显示离线");
assert.strictEqual(sensorState.isOnline(fresh, now), true,
  "15 秒内更新且 ok=1 的快照应显示在线");
assert.strictEqual(sensorState.effectiveSampleAgeMs(stale, now), 42000,
  "实采年龄必须包含快照从本地传到网页后继续流逝的时间");

/* 指纹 = 轻量刷新路径的决策核心：数据未变时不重建卡片。 */
const rowsA = [
  { channel: "CH0", ts: "t1", ok: 1 },
  { channel: "CH1", ts: "t2", ok: 0 },
];
const cloneA = JSON.parse(JSON.stringify(rowsA));
assert.strictEqual(sensorState.fingerprint(rowsA), sensorState.fingerprint(cloneA),
  "同数据必须得到同指纹");
assert.notStrictEqual(
  sensorState.fingerprint(rowsA),
  sensorState.fingerprint([{ channel: "CH0", ts: "t1", ok: 0 }, { channel: "CH1", ts: "t2", ok: 0 }]),
  "ok 变化必须换指纹");
assert.notStrictEqual(
  sensorState.fingerprint(rowsA),
  sensorState.fingerprint([{ channel: "CH0", ts: "t1-new", ok: 1 }, { channel: "CH1", ts: "t2", ok: 0 }]),
  "ts 变化必须换指纹");
assert.notStrictEqual(
  sensorState.fingerprint(rowsA),
  sensorState.fingerprint([rowsA[1], rowsA[0]]),
  "顺序变化必须换指纹（依赖 API 的稳定排序）");
assert.strictEqual(sensorState.fingerprint([]), "");
assert.strictEqual(sensorState.fingerprint(null), "");

/* 衍生量（从 console.js 迁入的纯计算）：物理公式与分级带。 */
assert.ok(Math.abs(sensorState.dewPointC(28.5, 41.2) - 14.0) < 0.5,
  "28.5°C/41.2% 的露点应约为 14°C（Magnus 公式）");
assert.ok(Math.abs(sensorState.heatIndexC(30, 60) - 33.5) < 1.0,
  "30°C/60% 的体感应约为 33.5°C（NWS Rothfusz）");
assert.ok(Math.abs(sensorState.luxEstimate(1800) - 1000) < 1e-9,
  "1800 counts / 1.8 counts-per-lux = 1000 lux");
assert.ok(Math.abs(sensorState.uviEstimate(6900) - 1) < 1e-9,
  "6900 counts / 6900 counts-per-UVI = 1");
assert.strictEqual(sensorState.co2Level(500), "优 · 通风好");
assert.strictEqual(sensorState.co2Level(900), "良");
assert.strictEqual(sensorState.co2Level(1200), "一般 · 偏闷");
assert.strictEqual(sensorState.co2Level(1800), "差 · 建议通风");
assert.strictEqual(sensorState.co2Level(2500), "很差 · 尽快通风");
assert.strictEqual(sensorState.co2Level(null), "");
assert.strictEqual(sensorState.vocLevel(50), "清新");
assert.strictEqual(sensorState.vocLevel(100), "正常");
assert.strictEqual(sensorState.vocLevel(200), "偏高 · 可能有异味/挥发源");
assert.strictEqual(sensorState.noxLevel(1), "未检出");
assert.strictEqual(sensorState.noxLevel(2), "检出 · 注意污染源");
assert.strictEqual(sensorState.flickerText(0), "无频闪");
assert.strictEqual(sensorState.flickerText(100), "100Hz 频闪");
assert.strictEqual(sensorState.flickerText(120), "120Hz 频闪");
assert.strictEqual(sensorState.flickerText(75), "有频闪 · 频率未知");

console.log("sensor state freshness test ok");
