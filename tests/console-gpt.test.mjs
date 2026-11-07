import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

const source = fs.readFileSync(new URL("../docs/assets/console-gpt.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../docs/presence.html", import.meta.url), "utf8");
for (const role of ["dialogue-modes", "firefly-chat-panel", "gpt-chat-panel", "mode-firefly", "mode-gpt", "gpt-log", "gpt-input", "gpt-send", "gpt-clear", "gpt-status", "gpt-settings", "gpt-history", "gpt-history-more", "gpt-history-older", "gpt-history-note"]) {
  assert.equal(html.split('data-role="' + role + '"').length - 1, 1, role + " must be present exactly once");
}
assert.match(html, /data-role="dialogue-modes"[^>]*hidden/);
assert.match(html, /data-role="gpt-chat-panel"[^>]*hidden/);
assert.match(html, /模型直聊/);
class Element {
  constructor() { this.children = []; this.handlers = {}; this.attributes = {}; this.value = ""; this.hidden = false; this.disabled = false; this.textContent = ""; this.scrollHeight = 20; this.scrollTop = 0; }
  appendChild(item) { this.children.push(item); }
  replaceChildren() { this.children = []; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
class MemoryHistory {
  constructor() { this.rows = new Map(); this.selection = null; this.sent = []; this.failNext = false; this.deferred = null; }
  async create(id) {
    const conversation = {id, title: "新对话", profile_id: "", provider_label: ""};
    this.rows.set(id, {conversation, turns: []}); return {...conversation};
  }
  async list() { return {conversations: Array.from(this.rows.values()).reverse().map(row => ({...row.conversation})), has_more: false}; }
  async load(id) {
    const row = this.rows.get(id); if (!row) throw Object.assign(new Error("未找到"), {status: 404});
    return {conversation: {...row.conversation}, turns: row.turns.map(turn => ({...turn})), has_more: false};
  }
  async send(id, payload) {
    this.sent.push({id, ...payload});
    const row = this.rows.get(id);
    if (row.conversation.profile_id && row.conversation.profile_id !== payload.profile_id) throw Object.assign(new Error("模型变化"), {status: 409});
    row.conversation.profile_id = payload.profile_id;
    row.conversation.title = payload.text;
    row.conversation.provider_label = payload.provider_label;
    const turn = {seq: row.turns.length + 1, request_id: payload.request_id, text: payload.text, reply: "", status: "pending", error: ""};
    row.turns.push(turn);
    if (this.deferred) await new Promise(resolve => { this.deferred.resolve = resolve; });
    if (this.failNext) { this.failNext = false; turn.status = "failed"; turn.error = "模拟网络故障"; throw Object.assign(new Error(turn.error), {status: 0}); }
    turn.status = "complete"; turn.reply = "<script>只是文字</script>";
    return {state: "complete", turn: {...turn}};
  }
  remember(id) { this.selection = id; }
  recalled() { return this.selection; }
  forgetSelection() { this.selection = null; }
}
const window = {crypto: {randomUUID}, setTimeout, clearTimeout};
vm.runInNewContext(source, {window, document: {createElement: () => new Element()}, Map, Set});
const wait = () => new Promise(resolve => setImmediate(resolve));
function mount(historyStore, request, publicMode = false) {
  const elements = new Map();
  const query = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
  const get = role => query('[data-role="' + role + '"]');
  return {get, chat: window.FlitFancyConsoleGPT.create({query, request, historyStore, publicMode, publicBase: "https://api.example"})};
}
let configured = false, profile = "1111111111111111", publicEnabled = false;
const requests = [];
const request = async (url, opts = {}) => {
  requests.push({url, opts});
  return url.startsWith("https://") ? {enabled: publicEnabled, provider_label: "DeepSeek", model: "fixture", profile_id: profile}
    : {configured, access: "admin", provider_label: "DeepSeek", model: "fixture", profile_id: profile};
};
const archive = new MemoryHistory();
const mounted = mount(archive, request), {chat, get} = mounted;
chat.start(); chat.selectMode("gpt");
assert.equal(requests.length, 0, "signed-out users cannot open model chat");
chat.setAuthenticated(true); chat.selectMode("gpt"); await wait(); await wait();
assert.equal(get("gpt-send").disabled, true, "unconfigured models cannot send");
configured = true; await chat.refreshStatus();
assert.equal(get("gpt-send").disabled, false);
get("gpt-input").value = "第一段对话"; await chat.send();
const firstId = archive.selection;
assert.equal(archive.sent[0].text, "第一段对话");
assert.equal(get("gpt-log").children[1].children[1].textContent, "<script>只是文字</script>");
await chat.selectSession("");
assert.equal(get("gpt-log").children.length, 1, "new conversation starts empty");
get("gpt-input").value = "第二段对话"; await chat.send();
const secondId = archive.selection;
assert.notEqual(firstId, secondId);
await chat.selectSession(firstId);
assert.equal(get("gpt-log").children[0].children[1].textContent, "第一段对话");
chat.dispose();
assert.equal(archive.selection, firstId, "page unload retains the selected conversation id");
const restored = mount(archive, request);
restored.chat.start(); restored.chat.setAuthenticated(true); await wait(); await wait();
assert.equal(restored.get("gpt-log").children[0].children[1].textContent, "第一段对话", "refresh restores the selected session");
profile = "2222222222222222"; await restored.chat.refreshStatus();
assert.equal(restored.get("gpt-send").disabled, true, "old history is never sent to a newly selected provider");
assert.equal(restored.get("gpt-log").children[0].children[1].textContent, "第一段对话");
await restored.chat.selectSession("");
assert.equal(restored.get("gpt-send").disabled, false);
archive.failNext = true;
restored.get("gpt-input").value = "失败的问题"; await restored.chat.send();
assert.equal(restored.get("gpt-input").value, "失败的问题", "failed text is restored for an explicit retry");
restored.get("gpt-input").value = "新的问题"; await restored.chat.send();
assert.equal(archive.sent.at(-1).text, "新的问题");
archive.deferred = {};
restored.get("gpt-input").value = "退出前的请求";
const pending = restored.chat.send(); await wait();
restored.chat.clearPrivate(); archive.deferred.resolve(); await pending;
assert.equal(restored.get("dialogue-modes").hidden, true);
assert.doesNotMatch(JSON.stringify(restored.get("gpt-log").children), /退出前的请求/);
assert.equal(archive.selection, null, "sign out clears the per-tab selection");

const visitorArchive = new MemoryHistory(), visitor = mount(visitorArchive, request, true);
visitor.chat.setAuthenticated(true); visitor.chat.start(); await wait(); await wait();
assert.equal(visitor.get("dialogue-modes").hidden, true);
assert.equal(visitor.get("gpt-settings").hidden, true);
publicEnabled = true; await visitor.chat.refreshStatus();
visitor.chat.selectMode("gpt"); await wait();
visitor.get("gpt-input").value = "访客测试"; await visitor.chat.send();
assert.equal(visitorArchive.sent.at(-1).text, "访客测试");
publicEnabled = false; await visitor.chat.refreshStatus();
assert.equal(visitor.get("dialogue-modes").hidden, true);
assert.equal(visitor.get("gpt-chat-panel").hidden, true);
assert.doesNotMatch(source, /localStorage|innerHTML/);
console.log("model chat UI: saved sessions, resume, provider isolation, failures and logout passed");
