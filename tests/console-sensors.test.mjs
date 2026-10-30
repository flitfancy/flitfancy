import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const realSensorState = createRequire(import.meta.url)("../docs/assets/sensor-state.js");
let clockNow = Date.parse("2026-10-30T10:03:52+08:00");
class TestDate extends Date { static now() { return clockNow; } }

const source = fs.readFileSync(
  new URL("../docs/assets/console-sensors.js", import.meta.url), "utf8"
);
class FakeElement {
  constructor() {
    this.children = [];
    this.handlers = {};
    this.className = "";
    this.dataset = {};
    this._textContent = "";
    this.classList = { toggle() {} };
  }
  set textContent(value) {
    this._textContent = value;
    if (value === "") this.children = [];
  }
  get textContent() { return this._textContent; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
}

const grid = new FakeElement();
const updated = new FakeElement();
let overviewOptions = null;
const window = {
  FlitFancySensorState: {
    fingerprint: (rows) => JSON.stringify(rows || []),
    isOnline: () => false,
    effectiveSampleAgeMs: () => null,
    snapshotAgeMs: realSensorState.snapshotAgeMs,
    dewPointC: () => 0,
    heatIndexC: () => 0,
    luxEstimate: realSensorState.luxEstimate,
    uviEstimate: realSensorState.uviEstimate,
    flickerText: () => "",
    vocLevel: () => "",
    noxLevel: () => "",
    co2Level: () => "",
  },
  FlitFancyConsoleOverview: {
    create(options) {
      overviewOptions = options;
      return { isOpen: () => false, toggle() {}, clearPrivate() {} };
    },
  },
};
vm.runInNewContext(source, {
  window,
  Date: TestDate,
  document: { createElement: () => new FakeElement() },
});

assert.equal(window.FlitFancyConsoleSensors.formatValue(null, 1), "—");
assert.equal(window.FlitFancyConsoleSensors.formatValue("12.34", 1), "12.3");
assert.deepEqual(Object.keys(window.FlitFancyConsoleSensors.meta),
  ["CH0", "CH1", "CH2", "CH3", "CH4", "CH5", "CH6", "CH7"]);

const sensors = window.FlitFancyConsoleSensors.create({
  query: (selector) => selector.includes("sensor-grid") ? grid : updated,
  request: async () => ({}),
});
sensors.render([]);
assert.equal(grid.children.length, 8, "公开页初始状态渲染心率与按压力占位卡片");
grid.textContent = "";
overviewOptions.renderRows([]);
assert.equal(grid.children.length, 8,
  "关闭 24 小时总览后必须绕过旧指纹并重建八张卡片");

let signedIn = true;
const privateSensors = window.FlitFancyConsoleSensors.create({
  query: (selector) => selector.includes("sensor-grid") ? grid : updated,
  request: async () => ({}), isAdminReady: () => signedIn,
});
window.FlitFancySensorState.isOnline = (row) => row && row.channel === "CH6" && row.ok === 1;
const heart = {channel: "CH6", ok: 1, heart_rate_bpm: 78, hr_connected: 1, hr_state: "streaming"};
privateSensors.render([heart]);
assert.equal(grid.children.length, 8);
assert.equal(grid.children[6].children[1].textContent, "78 bpm");
window.FlitFancySensorState.isOnline = () => false;
privateSensors.render([heart]);
assert.equal(grid.children[6].children[1].textContent, "—", "过期心率即使快照未变也必须清除显示");
signedIn = false;
privateSensors.clearPrivate();
assert.equal(grid.children.length, 8, "退出登录保留公开心率与按压力卡片");
privateSensors.render([heart]);
assert.equal(grid.children.length, 8, "匿名页面也渲染心率快照");
window.FlitFancySensorState.isOnline = (row) => row && row.channel === "CH6" && row.ok === 1;
privateSensors.render([heart]);
assert.equal(grid.children[6].children[1].textContent, "78 bpm", "匿名页面显示新鲜心率");
privateSensors.render([{channel:"CH7",ok:1,force_raw:0,force_mv:0,force_saturated:0}]);
assert.match(grid.children[7].children[1].textContent, /^0 原始码\s+·\s+0\.0000 mV$/, "零原始码是有效测量");
assert.match(grid.children[7].children[2].textContent, /尚未标定力值/);
privateSensors.render([{channel:"CH7",ok:1,force_raw:-950,force_mv:-7.421875,force_saturated:1}]);
assert.match(grid.children[7].children[1].textContent, /^-950 原始码\s+·\s+-7\.4219 mV$/);
assert.match(grid.children[7].children[2].textContent, /接近满量程/);

const optical = {channel:"CH3",ok:1,als_raw:160045,uv_raw:12,
  ts:new Date(clockNow).toISOString(),firmware_version:"0.3.2",rssi_dbm:-65};
privateSensors.render([optical]);
assert.match(grid.children[3].children[2].textContent, /≈32009 lux · UV 指数 ≈0\.2$/,
  "截图中的 UV12 用真实换算函数渲染成 0.2，而非 0.0");
privateSensors.render([{...optical,uv_raw:1}]);
assert.match(grid.children[3].children[2].textContent, /UV 指数 <0\.1$/,
  "微小非零读数不能四舍五入成零");
privateSensors.render([{...optical,uv_raw:0}]);
assert.match(grid.children[3].children[2].textContent, /UV 指数 ≈0\.0$/);
privateSensors.render([{...optical,uv_raw:null}]);
assert.equal(grid.children[3].children[2].textContent, "", "缺失 UV 不能被当成测得零值");

window.FlitFancySensorState.fingerprint = realSensorState.fingerprint;
const oldSignal = {...optical,channel:"CH0",ts:new Date(clockNow-10000).toISOString(),rssi_dbm:-45};
privateSensors.render([oldSignal,optical]);
assert.match(updated.textContent, /FFS 0\.3\.2 · Wi-Fi -65 dBm$/,
  "板级 RSSI 使用最新有效快照，沿用侧耳倾听的 dBm 单位");
const originalCard = grid.children[3];
privateSensors.render([oldSignal,{...optical,rssi_dbm:-68}]);
assert.equal(grid.children[3],originalCard,"同指纹刷新不重建卡片");
assert.match(updated.textContent,/Wi-Fi -68 dBm$/,"轻量刷新也更新信号强度");
clockNow += 31000;
privateSensors.render([oldSignal,{...optical,rssi_dbm:-68}]);
assert.match(updated.textContent,/上次 Wi-Fi -68 dBm$/,"旧快照只显示上次信号，不声称当前连接");
for(const rssi of [null,"",0,"bad",Infinity]) {
  privateSensors.render([{...optical,rssi_dbm:rssi}]);
  assert.doesNotMatch(updated.textContent,/dBm/,"缺失或无效信号不伪造读数");
}
privateSensors.render([]);
assert.equal(updated.textContent,"等待第一组数据");

console.log("console sensors module test ok");
