import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function element() {
  let text = "";
  return {
    value: "", hidden: false, children: [], listeners: new Map(), attrs: new Map(),
    get textContent() { return text; },
    set textContent(value) { text = value; this.children = []; },
    get options() { return this.children; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    async fire(type) { return this.listeners.get(type)?.call(this, { preventDefault() {} }); },
    setAttribute(name, value) { this.attrs.set(name, value); },
    getAttribute(name) { return this.attrs.get(name); },
    focus() {},
  };
}
const nodes = new Map();
const query = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, element());
  return nodes.get(selector);
};
const role = (name) => query('[data-role="observation-' + name + '"]');
const kinds = ["事", "理", "物", "人", "地"].map((name) => {
  const node = element(); node.setAttribute("data-observation-kind", name); return node;
});
const tab = element(); tab.setAttribute("data-tab", "observations");
let rows = [
  { uid: "legacy-observation-001", title: "旧星球", category: "宇宙与自然", tags: ["天文"], content: "旧正文", summary: "单独写的旧摘要", status: "public", discovered_at: "2026-08-01", source_name: "原来源", source_url: "https://example.com" },
  { uid: "other-observation-002", title: "另一颗星球", category: "物", tags: [], content: "另一段正文", summary: "另一段正文", status: "draft", discovered_at: "2026-09-01" },
];
let links = [];
let failSave = false;
let allowDiscard = false;
const writes = [];
const context = {
  document: {
    querySelector: query, createElement: element,
    querySelectorAll: (selector) => selector === "[data-observation-kind]" ? kinds : [tab],
  },
  window: {
    addEventListener() {}, confirm: () => allowDiscard,
    FlitFancyAdmin: {
      nowForInput: () => "2026-09-09T12:00:00", token: () => "test-token", setToken() {}, isUnauthorized: () => false,
      async request(path, options) {
        if (options.method === "GET") return { rows: path.endsWith("observation-links") ? links : rows };
        const body = JSON.parse(options.body); writes.push({ path, body });
        if (failSave) throw new Error("网络失败");
        if (path === "/api/observations") {
          const observation = { ...body, uid: body.uid || "new-observation-0003" };
          rows = rows.filter((row) => row.uid !== observation.uid).concat(observation);
          return { observation, public_sync: true };
        }
        const link = { ...body, uid: body.uid || "new-observation-link-0001" };
        links = [link]; return { link, public_sync: true };
      },
    },
  },
};
vm.runInNewContext(fs.readFileSync(new URL("../docs/assets/observations-admin.js", import.meta.url), "utf8"), context);
assert.equal(role("category").value, "事");
assert.equal(role("more").open, false);
assert.equal(role("connect").hidden, true);
assert.equal(role("link-editor").hidden, true);
assert.equal(role("discovered").value, "2026-09-09");
await role("reload").fire("click");

const rowActions = (row) => row.children.at(-1).children;
await rowActions(role("admin-list").children[0])[0].fire("click");
assert.equal(role("category").value, "宇宙与自然", "编辑旧记录不得猜测或覆盖类型");
assert.equal(role("legacy-category").hidden, false);
assert.equal(role("summary").value, "单独写的旧摘要");
await role("save").fire("click");
assert.equal(writes.at(-1).body.category, "宇宙与自然");
assert.equal(writes.at(-1).body.source_url, "https://example.com");
assert.equal(writes.at(-1).body.status, "public", "保存公开记录不会意外撤回为草稿");

await role("new").fire("click");
await kinds[1].fire("click");
role("title").value = "新的原理";
role("content").value = "第一段。\n\n第二段。";
await role("save").fire("click");
assert.equal(writes.at(-1).body.category, "理");
assert.equal(writes.at(-1).body.status, "draft");
assert.equal(writes.at(-1).body.summary, "第一段。 第二段。");
assert.equal(role("summary").value, "", "自动摘要回填后仍继续跟随正文");
assert.equal(role("connect").hidden, false);
assert.equal(role("link-editor").hidden, true, "保存完成后不强制进入连弦");
role("content").value = "修改后的正文。";
await role("publish").fire("click");
assert.equal(writes.at(-1).body.uid, "new-observation-0003", "公开已有草稿不重复创建星球");
assert.equal(writes.at(-1).body.status, "public");
assert.equal(writes.at(-1).body.summary, "修改后的正文。");
role("summary").value = "手动摘要";
role("content").value = "再改一次正文。";
await role("save").fire("click");
assert.equal(writes.at(-1).body.summary, "手动摘要");

await role("connect").fire("click");
assert.equal(role("link-source").value, "new-observation-0003");
assert.equal(role("link-editor").hidden, false);
assert.equal(role("link-strength").value, "medium");
assert.ok(!role("link-target").options.some((option) => option.value === "new-observation-0003"));
assert.equal(role("link-target").value, "", "目标需要用户主动选择");
const count = writes.length;
await role("link-save").fire("click");
assert.equal(writes.length, count, "未选目标不能写入弦");
role("link-target").value = "other-observation-002";
role("link-relation").value = "custom";
role("link-custom").value = "启发";
role("link-strength").value = "weak";
await role("link-save").fire("click");
assert.equal(writes.at(-1).body.source_uid, "new-observation-0003");
assert.equal(writes.at(-1).body.relation, "启发");
assert.equal(writes.at(-1).body.strength, "weak");
assert.equal(role("link-strength").value, "weak", "回填保留刚保存的强度");
role("link-strength").value = "strong";
await role("link-new").fire("click");
assert.equal(role("link-strength").value, "strong", "仅修改强度也应提示未保存，取消后保留");
await role("link-save").fire("click");
assert.equal(writes.at(-1).body.uid, "new-observation-link-0001", "再次保存同一条弦应更新原条目");
assert.equal(writes.at(-1).body.strength, "strong");

role("content").value = "尚未保存的修改";
await role("new").fire("click");
assert.equal(role("content").value, "尚未保存的修改", "拒绝丢弃时保留文字");
failSave = true;
await role("save").fire("click");
assert.equal(role("content").value, "尚未保存的修改");
assert.equal(role("compose").inert, false);
assert.match(role("status-text").textContent, /网络失败/);
allowDiscard = true;
await role("new").fire("click");
assert.equal(role("content").value, "");
console.log("observations entry: kinds, legacy preservation, auto/custom summary, draft/public, contextual links and failed saves ok");
