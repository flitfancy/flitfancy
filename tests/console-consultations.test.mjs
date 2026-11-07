import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/console-consultations.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../docs/presence.html", import.meta.url), "utf8");
for (const role of ["consultation-panel", "consultation-status", "consultation-list"]) {
  assert.equal(html.split('data-role="' + role + '"').length - 1, 1, role + " appears once");
}
assert.match(html, /data-role="consultation-panel"[^>]*hidden/);
class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.textContent = ""; this.hidden = true; this.open = false; }
  appendChild(item) { this.children.push(item); }
  replaceChildren() { this.children = []; }
}
const nodes = new Map();
const query = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
const get = role => query('[data-role="' + role + '"]');
const window = {};
vm.runInNewContext(source, {window, document: {createElement: tag => new Element(tag)}, Date, Map, Number});
let pending = null;
const requests = [];
const view = window.FlitFancyConsultations.create({query, request: async url => {
  requests.push(url);
  if (pending) return await new Promise(resolve => { pending.resolve = resolve; });
  return {events: [
    {seq: 1, consultation_id: "turn-1", phase: "question", at: "2026-11-07T00:00:00Z", provider: "DeepSeek", model: "deepseek-flash", content: "她实际问了什么？"},
    {seq: 2, consultation_id: "turn-1", phase: "answer", at: "2026-11-07T00:00:01Z", provider: "DeepSeek", model: "deepseek-flash", content: "<script>模型原文</script>"},
  ]};
}});
assert.equal((await view.refresh()).skipped, true);
assert.equal(requests.length, 0, "signed-out users never request private consultations");
view.setAuthenticated(true);
assert.equal(get("consultation-panel").hidden, false);
await view.refresh();
assert.equal(requests[0], "/api/consultations?after=0");
const card = get("consultation-list").children[0];
assert.equal(card.open, true);
assert.match(card.children[0].textContent, /DeepSeek \/ deepseek-flash/);
assert.equal(card.children[2].textContent, "她实际问了什么？");
assert.equal(card.children[4].textContent, "<script>模型原文</script>");
pending = {};
const refresh = view.refresh();
assert.equal(requests.at(-1), "/api/consultations?after=2");
view.clearPrivate();
pending.resolve({events: [{seq: 3, consultation_id: "turn-2", phase: "question", content: "退出后不得出现"}]});
await refresh;
assert.equal(get("consultation-panel").hidden, true);
assert.equal(get("consultation-list").children.length, 0);
assert.doesNotMatch(source, /sessionStorage|localStorage|innerHTML/);
console.log("consultation view: private auth, exact question and answer, cursor and logout race passed");
