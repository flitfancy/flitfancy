import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/firefly.js", import.meta.url), "utf8"
).replace(
  "  window.flitfancy = {",
  "  window.__fireflyTest = { get flies() { return flies; }, get burst() { return { flyBurstUntil, forcedFlyUntil, burstUntil, forcedBurstUntil }; } };\n  window.flitfancy = {"
);

const winResizeHandlers = [];
const gradient = { addColorStop() {} };
const context2d = {
  setTransform() {}, clearRect() {}, createLinearGradient() { return gradient; },
  createRadialGradient() { return gradient; }, beginPath() {}, moveTo() {},
  lineTo() {}, stroke() {}, arc() {}, fill() {},
};
const canvas = {
  clientWidth: 900, clientHeight: 600, style: {},
  getContext() { return context2d; },
};
const animationFrames = [];
const windowMock = {
  innerWidth: 900,
  innerHeight: 600,
  devicePixelRatio: 1,
  matchMedia() { return { matches: false }; },
  addEventListener(type, fn) {
    if (type === "resize") winResizeHandlers.push(fn);
  },
  __pointerFx: { x: 0, y: 0, active: false },
  __cursorFx: null,
};
const sandbox = {
  window: windowMock,
  document: {
    getElementById(id) {
      if (id === "sky") return canvas;
      return { textContent: "" };
    },
  },
  Math, Date, console,
  performance: { now: () => 0 },
  requestAnimationFrame(cb) { animationFrames.push(cb); },
  setInterval() { return 1; },
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(source, sandbox, { filename: "firefly.js" });

const flies = windowMock.__fireflyTest.flies;
assert.equal(flies.length, 10, "900px 宽应生成 10 只萤火虫");
assert.equal(winResizeHandlers.length, 1, "应注册 resize 监听器");

// 召唤一次萤火爆发（彩蛋），再模拟跨屏拖动（900 -> 1600 宽）
windowMock.window = windowMock;
windowMock.flitfancy.fireflyBurst();
const summoned = windowMock.__fireflyTest.burst;
assert.ok(summoned.forcedFlyUntil > 0, "召唤爆发后 forcedFlyUntil 应指向未来");

// 模拟一次自然爆发状态（世界时钟窗口进行中）
const before = windowMock.__fireflyTest.burst;

// 大变化（900→1600，比值 1.78 > 1.35）：立即比例重铺，数量保持爆发值 20
// （10 基础 + 10 涌出，flyBurstMax=20），不按公式裁剪、不做区域补种
windowMock.innerWidth = 1600;
windowMock.innerHeight = 900;
for (const fn of winResizeHandlers) fn();
await new Promise((resolve) => setTimeout(resolve, 650));

const after = windowMock.__fireflyTest.burst;
assert.ok(after.forcedFlyUntil > 0, "跨屏拖动不得清除召唤的萤火爆发");
assert.equal(after.forcedFlyUntil, before.forcedFlyUntil, "爆发结束时刻必须原样保留");
assert.equal(flies.length, 20, "大变化重铺后数量保持爆发值 20 只");

// 换屏拖动（物理面积不变，DPR 补偿）：数量应保持不变
// 1600×900@1x 物理面积 = 1,440,000；600×600@2x 物理面积 = 600×600×4 = 1,440,000
windowMock.innerWidth = 600;
windowMock.innerHeight = 600;
windowMock.devicePixelRatio = 2;
for (const fn of winResizeHandlers) fn();
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(flies.length, 20, "换屏拖动物理面积不变时，数量必须保持 20 只");
assert.ok(windowMock.__fireflyTest.burst.forcedFlyUntil > 0, "连续 resize 后爆发状态仍应保留");

console.log("firefly resize preserves burst test ok");
