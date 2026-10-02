import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

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
    snapshotAgeMs: () => 0,
    dewPointC: () => 0,
    heatIndexC: () => 0,
    luxEstimate: () => 0,
    uviEstimate: () => 0,
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
  document: { createElement: () => new FakeElement() },
});

assert.equal(window.FlitFancyConsoleSensors.formatValue(null, 1), "—");
assert.equal(window.FlitFancyConsoleSensors.formatValue("12.34", 1), "12.3");
assert.deepEqual(Object.keys(window.FlitFancyConsoleSensors.meta),
  ["CH0", "CH1", "CH2", "CH3", "CH4", "CH5", "CH6"]);

const sensors = window.FlitFancyConsoleSensors.create({
  query: (selector) => selector.includes("sensor-grid") ? grid : updated,
  request: async () => ({}),
});
sensors.render([]);
assert.equal(grid.children.length, 6, "初始状态必须渲染六张占位卡片");
grid.textContent = "";
overviewOptions.renderRows([]);
assert.equal(grid.children.length, 6,
  "关闭 24 小时总览后必须绕过旧指纹并重建六张卡片");

let signedIn = true;
const privateSensors = window.FlitFancyConsoleSensors.create({
  query: (selector) => selector.includes("sensor-grid") ? grid : updated,
  request: async () => ({}), isAdminReady: () => signedIn,
});
window.FlitFancySensorState.isOnline = (row) => row && row.channel === "CH6" && row.ok === 1;
const heart = {channel: "CH6", ok: 1, heart_rate_bpm: 78, hr_connected: 1, hr_state: "streaming"};
privateSensors.render([heart]);
assert.equal(grid.children.length, 7);
assert.equal(grid.children[6].children[1].textContent, "78 bpm");
window.FlitFancySensorState.isOnline = () => false;
privateSensors.render([heart]);
assert.equal(grid.children[6].children[1].textContent, "—", "过期心率即使快照未变也必须清除显示");
signedIn = false;
privateSensors.clearPrivate();
assert.equal(grid.children.length, 6, "退出登录移除私人心率卡片");
privateSensors.render([heart]);
assert.equal(grid.children.length, 6, "匿名渲染过滤迟到的心率快照");

console.log("console sensors module test ok");
