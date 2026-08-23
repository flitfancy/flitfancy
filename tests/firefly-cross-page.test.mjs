import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/firefly.js", import.meta.url), "utf8"
).replace(
  "  window.flitfancy = {",
  "  window.__fireflyTest = { get flies() { return flies; }, get burst() { return { forcedFlyUntil: forcedFlyUntil, flyBurstUntil: flyBurstUntil }; }, get level() { return flyLevel; } };\n  window.flitfancy = {"
);

// 跨"页面"共享的 sessionStorage：同一标签页内导航的模型。
const store = new Map();
const storage = {
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(key, String(value)); },
};

function makePage(width, height) {
  const windowHandlers = {};
  let visibilityHandler = null;
  const animationFrames = [];
  const timeouts = [];
  const gradient = { addColorStop() {} };
  const context2d = {
    setTransform() {}, clearRect() {}, createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; }, beginPath() {}, moveTo() {},
    lineTo() {}, stroke() {}, arc() {}, fill() {},
  };
  const canvas = {
    clientWidth: width, clientHeight: height, style: {},
    getContext() { return context2d; },
  };
  const windowMock = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    matchMedia() { return { matches: false }; },
    addEventListener(type, fn) { windowHandlers[type] = fn; },
    __pointerFx: { x: 0, y: 0, active: false },
    __cursorFx: null,
  };
  const sandbox = {
    window: windowMock,
    document: {
      addEventListener(type, fn) { if (type === "visibilitychange") visibilityHandler = fn; },
      getElementById(id) {
        if (id === "sky") return canvas;
        return { textContent: "" };
      },
      visibilityState: "visible",
    },
    sessionStorage: storage,
    Math, Date, console,
    performance: { now: () => 0 },
    requestAnimationFrame(cb) { animationFrames.push(cb); },
    setInterval() { return 1; },
    setTimeout(fn, ms) { timeouts.push(ms); },
    clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: "firefly.js" });
  return {
    flies: windowMock.__fireflyTest.flies,
    test: windowMock.__fireflyTest,
    flitfancy: windowMock.flitfancy,
    timeouts,
    navigateAway() {
      if (visibilityHandler) visibilityHandler();
      if (windowHandlers.pagehide) windowHandlers.pagehide();
    },
  };
}

// ---- 第 1 页：正常生成，把萤火虫摆到确定位置后离开 ----
const pageA = makePage(900, 600);
assert.equal(pageA.flies.length, 10, "900×600 应生成 10 只萤火虫");
for (const f of pageA.flies) {
  f.x = 90;
  f.y = 300;
  f.vx = 0.123;
}
pageA.navigateAway();

const saved = JSON.parse(store.get("flitfancy.fireflies.v1"));
assert.equal(saved.flies.length, 10, "pagehide 必须写入萤火虫快照");
assert.ok(Math.abs(saved.flies[0].nx - 0.1) < 1e-9, "坐标必须按视口归一化保存");
assert.ok(saved.t > 0, "快照必须带时间戳用于新鲜度判断");

// ---- 第 2 页：同标签页导航，应恢复位置与速度而不是重新随机 ----
const pageB = makePage(900, 600);
assert.equal(pageB.flies.length, 10, "恢复后数量仍应为公式目标值");
for (const f of pageB.flies) {
  assert.equal(f.x, 90, "跨页后萤火虫横坐标必须延续");
  assert.equal(f.y, 300, "跨页后萤火虫纵坐标必须延续");
  assert.equal(f.vx, 0.123, "漂游速度必须一并延续");
  assert.equal(f.meetCd, 0, "相遇冷却等瞬时状态不得跨页");
}

// ---- 第 3 页：快照过期（>30 分钟）→ 放弃恢复，重新随机出生 ----
const stale = JSON.parse(store.get("flitfancy.fireflies.v1"));
stale.t = Date.now() - 31 * 60 * 1000;
for (const f of stale.flies) f.r = 9.99; // 新生成的 r 最大约 2.6，用作哨兵
store.set("flitfancy.fireflies.v1", JSON.stringify(stale));
const pageC = makePage(900, 600);
assert.ok(pageC.flies.every((f) => f.r < 3), "过期快照必须放弃恢复并重新出生");

// ---- 第 4 页：视口宽高比变化过大（竖屏 ↔ 横屏）→ 同样重新出生 ----
const rotated = JSON.parse(store.get("flitfancy.fireflies.v1"));
rotated.t = Date.now();
rotated.w = 900;
rotated.h = 600; // ratio 1.5
for (const f of rotated.flies) f.r = 9.99;
store.set("flitfancy.fireflies.v1", JSON.stringify(rotated));
const pageD = makePage(400, 900); // ratio ≈ 0.44，偏差远超 35%
assert.ok(pageD.flies.every((f) => f.r < 3), "宽高比差异过大时必须放弃恢复");

// ---- 第 5/6 页：召唤的萤火爆发与亮度档位必须跨页延续 ----
const pageE = makePage(900, 600);
pageE.flitfancy.fireflyBurst();   // 彩蛋召唤爆发（performance.now 时基）
pageE.flitfancy.fireflyBright();  // 亮度档位 +1
assert.equal(pageE.flies.length, 20, "召唤爆发后应涌入到 20 只（基础 10 + 涌入 10）");
pageE.navigateAway();

// 快照必须包含全部爆发人口，而不是只存公式数量的基础个体
const savedBurst = JSON.parse(store.get("flitfancy.fireflies.v1"));
assert.equal(savedBurst.flies.length, 20, "快照必须保存全部爆发人口");
assert.ok(savedBurst.burst.flyForcedEndWall > Date.now(),
  "召唤爆发的结束时刻必须换算成墙钟保存");
assert.equal(savedBurst.burst.level, 1, "亮度档位必须写入快照");

const pageF = makePage(900, 600);
assert.ok(pageF.test.burst.forcedFlyUntil > 500,
  "翻页后召唤爆发必须继续（剩余时长换算回 perf 时基）");
assert.ok(pageF.test.burst.forcedFlyUntil <= 45000,
  "恢复的剩余时长必须被钳制在 CFG 上限内");
assert.equal(pageF.test.level, 1, "亮度档位必须跨页保留");
assert.equal(pageF.flies.length, 20,
  "爆发人口必须原编队恢复：既不能被公式数量裁掉，也不能重复涌入");
assert.ok(pageF.timeouts.includes(6000),
  "超额人口必须安排 postBurstSettleMs 延迟无声结算");

// ---- 第 7 页：爆发已结束的快照（超额人口残留）→ 同样全量恢复 + 延迟结算 ----
const ended = JSON.parse(store.get("flitfancy.fireflies.v1"));
ended.burst.flyForcedEndWall = 0;
ended.burst.flyGlobalEndWall = 0;
store.set("flitfancy.fireflies.v1", JSON.stringify(ended));
const pageG = makePage(900, 600);
assert.equal(pageG.flies.length, 20,
  "爆发已结束的残留人口同样原编队恢复，不按公式数量裁剪");
assert.ok(pageG.timeouts.includes(6000),
  "残留人口同样安排延迟结算");
assert.ok(pageG.test.burst.forcedFlyUntil === 0,
  "已结束的爆发不得被误判为进行中");

console.log("firefly cross-page persistence test ok");
