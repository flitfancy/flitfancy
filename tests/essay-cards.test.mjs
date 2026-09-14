import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import worker from "../cloudflare/worker.js";

const stored = new Map();
const env = {
  ADMIN_TOKEN: "test-only-featured-essay-token-123456789",
  CONFIG: { get: async (key) => stored.get(key) || null, put: async (key, value) => stored.set(key, value) },
};
const chosen = { uid: "chosen-essay-0001", title: "第一篇", content: "第一段\n\n第二段", updated_at: "2026-09-09" };
const getFeatured = () => worker.fetch(new Request("https://api.flitfancy.com/essays/featured"), env);
async function publish(value, authorized = true) {
  return worker.fetch(new Request("https://api.flitfancy.com/admin/toggle", {
    method: "POST", headers: authorized ? { Authorization: "Bearer " + env.ADMIN_TOKEN } : {},
    body: JSON.stringify({ featured_essay: value }),
  }), env);
}
assert.equal((await (await getFeatured()).json()).essay, null);
assert.notEqual((await publish(chosen, false)).status, 200);
assert.equal(stored.has("featured_essay"), false);
assert.equal((await publish({ ...chosen, unwanted: "must not be public" })).status, 200);
assert.deepEqual((await (await getFeatured()).json()).essay, chosen);
assert.equal(stored.has("chat_enabled"), false, "选卡不修改 AI 配置");
assert.equal(stored.has("reflections"), false, "选卡不修改页脚随笔");
for (const invalid of [null, [], { ...chosen, uid: "bad" }, { ...chosen, title: " " },
  { ...chosen, content: "x".repeat(12001) }, { ...chosen, content: {} }]) {
  assert.equal((await publish(invalid)).status, 400);
  assert.deepEqual((await (await getFeatured()).json()).essay, chosen);
}
const cors = await worker.fetch(new Request("https://api.flitfancy.com/essays/featured", {
  headers: { Origin: "https://flitfancy.com" },
}), env);
assert.equal(cors.headers.get("Access-Control-Allow-Origin"), "*");

// Minimal DOM for user actions; scroll positions model cards of equal width.
function element(tag = "div") {
  let text = "";
  const node = {
    tag, children: [], listeners: new Map(), dataset: {}, hidden: false, value: "", disabled: false,
    scrollLeft: 0, classList: { add() {}, remove() {} },
    get textContent() { return text; },
    set textContent(value) { text = value; this.children = []; },
    get lastElementChild() { return this.children.at(-1); },
    get offsetLeft() { return this.parentNode ? this.parentNode.children.indexOf(this) * 300 : 0; },
    appendChild(child) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((n) => n !== child);
      child.parentNode = this; this.children.push(child); return child;
    },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    async fire(type, props = {}) { return this.listeners.get(type)?.({ target: this, preventDefault() {}, ...props }); },
    setAttribute() {}, focus() {},
    scrollTo({ left }) { this.scrollLeft = left; },
  };
  return node;
}
const nodes = new Map();
const query = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, element());
  return nodes.get(selector);
};
const role = (name) => query('[data-role="' + name + '"]');
const original = role("essay-prologue");
original.querySelector = () => ({ textContent: "序章" });
original.querySelectorAll = () => [{ textContent: "原来的文章。" }];
let rows = [{ ...chosen, status: "draft", display_order: 100 }];
let featured = null;
let allowDiscard = false;
const writes = [];
let savedEvents = 0;
const document = {
  querySelector: query, createElement: element, body: element(),
  dispatchEvent() { savedEvents += 1; },
};
const context = {
  document, CustomEvent: class {},
  window: {
    location: { hash: "" }, addEventListener() {}, confirm: () => allowDiscard,
    FlitFancyPanelShell: { init: () => ({ show() {}, hide() {}, clearCollapsed() {} }) },
    FlitFancyAdmin: {
      isAdminHost: () => true, token: () => "test-token", setToken() {},
      installErrorHandler() {}, isUnauthorized: () => false,
      async request(path, options) {
        if (options.method === "GET") return { rows: rows.map((r) => ({ ...r })), featured_essay: featured };
        const body = JSON.parse(options.body || "{}");
        writes.push({ path, body });
        if (path === "/api/essays") {
          const row = { ...body, uid: body.uid || "new-essay-000001" };
          rows = rows.filter((r) => r.uid !== row.uid).concat(row);
          return { essay: row, public_sync: true };
        }
        if (path === "/api/essays/featured") {
          featured = { ...rows.find((r) => r.uid === body.uid) };
          return { essay: featured, public_sync: true };
        }
        return { ok: true };
      },
    },
  },
};
vm.runInNewContext(fs.readFileSync(new URL("../docs/assets/about-admin.js", import.meta.url), "utf8"), context);
await role("essay-reload").fire("click");
// Reload handler intentionally does not return the load promise.
await new Promise((resolve) => setImmediate(resolve));
const deck = role("essay-admin-list");
assert.equal(deck.children.length, 3, "序章、保存的短文与新建卡各占一张");
assert.equal(deck.children[0].dataset.featured, "true");
await role("essay-next").fire("click");
await deck.fire("keydown", { key: "ArrowRight" });
assert.equal(writes.length, 0, "翻卡不得发出写入请求");
const button = (card, label) => card.children.flatMap((child) => [child, ...child.children])
  .find((child) => child.textContent === label);
await button(deck.children[1], "编辑卡牌").fire("click");
role("essay-content").value = "编辑后的文章 <script>test</script>";
await role("essay-new").fire("click");
assert.equal(role("essay-content").value, "编辑后的文章 <script>test</script>", "拒绝丢弃后保留文字");
await role("essay-save").fire("click");
assert.equal(writes.length, 1);
assert.equal(writes[0].path, "/api/essays");
assert.equal(writes[0].body.status, "draft");
assert.equal(savedEvents, 0, "保存草稿不会刷新公开文章");
await button(deck.children[1], "设为展示").fire("click");
assert.equal(writes.at(-1).path, "/api/essays/featured");
assert.equal(featured.uid, chosen.uid);
assert.equal(savedEvents, 1);
assert.equal(deck.children[1].dataset.featured, "true");
await role("essay-new").fire("click");
assert.equal(role("essay-compose").parentNode, deck.lastElementChild, "新短文在新卡内编辑");
role("essay-title").value = "新卡";
role("essay-content").value = "新卡正文";
await role("essay-save").fire("click");
assert.equal(deck.children.length, 4);
assert.equal(featured.uid, chosen.uid, "新建和保存不得替换已选文章");

// Public reader renders exactly one snapshot using text nodes and keeps it on fetch failure.
const readers = new Map();
const readerQuery = (selector) => {
  if (!readers.has(selector)) readers.set(selector, element());
  return readers.get(selector);
};
let readerRefresh;
let responseEssay = { ...chosen, content: "<img src=x onerror=alert(1)>\n第二段" };
const readerContext = {
  location: { hostname: "flitfancy.com" }, AbortController, setTimeout, clearTimeout,
  document: {
    querySelector: readerQuery, createElement: element,
    addEventListener(_event, callback) { readerRefresh = callback; },
  },
  fetch: async () => ({ ok: true, json: async () => ({ essay: responseEssay }) }),
};
vm.runInNewContext(fs.readFileSync(new URL("../docs/assets/essays.js", import.meta.url), "utf8"), readerContext);
await new Promise((resolve) => setImmediate(resolve));
const publicList = readerQuery('[data-role="essay-list"]');
assert.equal(publicList.children.length, 1);
assert.equal(readerQuery('[data-role="essay-prologue"]').hidden, true);
assert.equal(publicList.children[0].children.at(-1).textContent, responseEssay.content);
readerContext.fetch = async () => { throw new Error("offline"); };
await readerRefresh();
assert.equal(publicList.children.length, 1, "断网时保留已展示文章");
readerContext.fetch = async () => ({ ok: true, json: async () => ({ essay: null }) });
await readerRefresh();
assert.equal(readerQuery('[data-role="essay-prologue"]').hidden, false);
assert.equal(publicList.children.length, 0);
console.log("essay cards: explicit publication, browsing, editing, original, public reader and auth ok");
