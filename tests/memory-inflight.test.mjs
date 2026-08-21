import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/* 记忆时间线的 inFlight 防重入守卫：
   interval / visibilitychange / flitfancy:memory-saved 三路并发触发时，
   同一时刻最多只允许一个 fetch 在途，杜绝重复渲染与请求风暴。 */

const source = fs.readFileSync(
  new URL("../docs/assets/memory.js", import.meta.url), "utf8"
);

let fetchCalls = 0;
const pending = [];
const handlers = {};

const streamEl = {
  querySelectorAll() { return []; },
  appendChild() {},
};

vm.runInNewContext(source, {
  document: {
    hidden: false,
    querySelector(selector) {
      if (selector === '[data-role="memory-sync"]') return { textContent: "" };
      if (selector === '[data-role="memory-stream"]') return streamEl;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(name, fn) { handlers[name] = fn; },
  },
  fetch: () => {
    fetchCalls += 1;
    return new Promise((resolve) => pending.push(resolve));
  },
  window: {
    setInterval: () => 0,
    FlitFancyAdmin: {
      TIMEOUT_MS: 8000,
      formatDateTime: (value, precision) => precision === "date"
        ? String(value || "").slice(0, 10)
        : String(value || "").slice(0, 19).replace("T", " "),
    },
  },
  setInterval: () => 0,
  setTimeout: () => 0,
  clearTimeout: () => {},
  AbortController: AbortController,
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

// 脚本加载即触发首次 refresh（fetch 在途，挂起不返回）
await settle();
assert.equal(fetchCalls, 1, "加载时应发起第一次同步请求");

// 请求挂起期间，连续三路触发：只允许一个在途请求，其余全部被守卫拦下
handlers["visibilitychange"]();
handlers["visibilitychange"]();
handlers["flitfancy:memory-saved"]();
await settle();
assert.equal(fetchCalls, 1, "在途请求未完成时，并发触发必须被防重入守卫拦截");

// 完成第一次请求后再触发，应允许发起新请求
pending.shift()({ ok: true, json: async () => ({ ok: true, rows: [] }) });
await settle();
assert.equal(fetchCalls, 1);
handlers["visibilitychange"]();
await settle();
assert.equal(fetchCalls, 2, "在途请求完成后，新触发应正常发起请求");

console.log("memory inFlight guard test ok");
