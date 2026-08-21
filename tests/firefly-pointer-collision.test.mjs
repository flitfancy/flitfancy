import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/firefly.js", import.meta.url), "utf8")
  .replace(
    "  window.flitfancy = {",
    "  window.__fireflyTest = { get flies() { return flies; } };\n  window.flitfancy = {"
  )
  .replace(
    "      const alpha = Math.min(1, (0.10 + 0.7 * flicker) * brightBoost + mouseBoost * CFG.pointer.startleAlpha);",
    "      const alpha = Math.min(1, (0.10 + 0.7 * flicker) * brightBoost + mouseBoost * CFG.pointer.startleAlpha);\n      f.__testAlpha = alpha;"
  );
const animationFrames = [];
const bursts = [];

const gradient = { addColorStop() {} };
const context2d = {
  setTransform() {},
  clearRect() {},
  createLinearGradient() { return gradient; },
  createRadialGradient() { return gradient; },
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  arc() {},
  fill() {},
};
const canvas = {
  clientWidth: 900,
  clientHeight: 600,
  style: {},
  getContext() { return context2d; },
};

const math = Object.create(Math);
math.random = () => 0.5;

const windowMock = {
  innerWidth: 900,
  innerHeight: 600,
  devicePixelRatio: 1,
  matchMedia() { return { matches: false }; },
  addEventListener() {},
  __pointerFx: { x: 0, y: 0, active: false },
  __cursorFx: {
    burstAt(...args) { bursts.push(args); },
  },
};

const sandbox = {
  window: windowMock,
  document: {
    getElementById(id) {
      if (id === "sky") return canvas;
      return { textContent: "" };
    },
  },
  Math: math,
  Date,
  console,
  performance: { now: () => 0 },
  requestAnimationFrame(callback) { animationFrames.push(callback); },
  setInterval() { return 1; },
};

vm.runInNewContext(source, sandbox, { filename: "firefly.js" });
assert.equal(animationFrames.length, 1, "夜空引擎应注册首帧动画");

const fly = windowMock.__fireflyTest.flies[0];
fly.breathOffset = 0.999;
windowMock.__pointerFx = { x: fly.x, y: fly.y, active: true };
const pointer = { x: fly.x, y: fly.y };

const firstFrame = animationFrames.shift();
firstFrame(100);

assert.equal(bursts.length, 0,
  "萤火虫受惊只应发亮并跑开，不应产生碰撞粒子");
assert.ok(fly.mouseGlowUntil > 100,
  "鼠标靠近时必须进入短暂受惊发亮状态");
assert.ok(fly.__testAlpha >= 0.45,
  "受惊亮度必须独立托起，不能被呼吸暗相位压没");

const firstDistance = Math.hypot(fly.x - pointer.x, fly.y - pointer.y);

const secondFrame = animationFrames.shift();
secondFrame(200);
const secondDistance = Math.hypot(fly.x - pointer.x, fly.y - pointer.y);
assert.ok(secondDistance > firstDistance,
  "受惊后的萤火虫必须继续远离鼠标，而不是停在原处");

console.log("firefly startle interaction test ok");
