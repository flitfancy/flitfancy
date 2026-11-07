import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../docs/assets/console-dialogue.js", import.meta.url), "utf8");
class Element {
  constructor() { this.children = []; this.handlers = {}; this.dataset = {}; this.value = ""; this.textContent = ""; this.scrollHeight = 10; this.clientHeight = 100; this.scrollTop = 0; }
  appendChild(item) { this.children.push(item); }
  replaceChildren() { this.children = []; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
}
const elements = new Map();
const query = (key) => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
const window = { crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" } };
vm.runInNewContext(source, { window, document: { createElement: () => new Element() }, Date });
const module = window.FlitFancyConsoleDialogue;
assert.equal(module.displayText("<attachment>\n[File Attachment: name note.txt, path C:\\private\\note.txt]"), "[附件：note.txt]");
const live = { available: true, board_connected: true, wakeword: { enabled: true },
  dialogue: { protocol: 2, last_seen: Date.now() / 1000, phase: "complete" },
  conversation: { ready: true, connected: true, revision: "r1", messages: [{ role: "assistant", content: "<script>纯文本</script>" }], requests: [] } };
assert.equal(module.presentation(live).label, "待唤醒");
assert.equal(module.presentation({ ...live, dialogue: { ...live.dialogue, last_seen: 0 } }).label, "等待 AstrBot");
assert.equal(module.presentation({ ...live, recording: true, voice_turn: { phase: "listening" } }).label, "正在听你说");
assert.equal(module.presentation({ ...live, dialogue: { ...live.dialogue, phase: "thinking" } }).label, "正在思考");
assert.equal(module.presentation({ ...live, dialogue: { ...live.dialogue, phase: "playing" } }).label, "正在回答");
const sent = [];
const chat = module.create({ query, sendRequest: async (url, data) => { sent.push({ url, data }); return { session: data.request_id }; } });
chat.start(); chat.updateState(live);
assert.equal(query('[data-role="chat-log"]').children[0].children[1].textContent, "<script>纯文本</script>");
query('[data-role="chat-input"]').value = "接着聊";
await chat.send(); await chat.send();
assert.equal(sent.length, 1);
assert.equal(sent[0].url, "/api/dialogue/messages");
assert.deepEqual(Object.keys(sent[0].data).sort(), ["request_id", "text"]);
chat.updateState({ ...live, conversation: { ...live.conversation, requests: [{ session: sent[0].data.request_id, phase: "complete" }] } });
assert.equal(query('[data-role="chat-send"]').disabled, false);
chat.updateState(null);
assert.equal(query('[data-role="chat-log"]').children.length, 0);
assert.equal(query('[data-role="chat-send"]').disabled, true);
let resolveSend;
const delayed = module.create({ query, sendRequest: () => new Promise(resolve => { resolveSend = resolve; }) });
delayed.start(); delayed.updateState(live);
query('[data-role="chat-input"]').value = 'private pending text';
const pendingSend = delayed.send();
delayed.updateState(null);
resolveSend({session:'old-session'});
await pendingSend;
assert.equal(query('[data-role="chat-input"]').value, '');
assert.doesNotMatch(query('[data-role="chat-status"]').textContent, /private pending text/);
assert.equal(query('[data-role="chat-send"]').disabled, true);
assert.doesNotMatch(source, /sessionStorage|localStorage|publicBase|innerHTML/);
const sessionElements = new Map();
const sessionQuery = (key) => { if (!sessionElements.has(key)) sessionElements.set(key, new Element()); return sessionElements.get(key); };
const sessionRequests = [];
const shared = module.create({ query: sessionQuery, sendRequest: async (url, data) => { sessionRequests.push({ url, data }); return {}; } });
const catalog = { connected: true, current_id: 'old', conversations: [{ id: 'old', title: '旧对话' }, { id: 'next', title: '<b>另一个</b>' }], controls: [] };
const sharedLive = { ...live, conversation: { ...live.conversation, session_history: catalog } };
shared.start(); shared.updateState(sharedLive);
assert.equal(sessionQuery('[data-role="firefly-history"]').children[1].textContent, '<b>另一个</b>');
await sessionQuery('[data-role="firefly-new"]').handlers.click();
assert.equal(sessionRequests[0].url, '/api/dialogue/conversations');
assert.equal(sessionRequests[0].data.action, 'new');
assert.equal(sessionQuery('[data-role="chat-send"]').disabled, true);
shared.updateState({ ...sharedLive, conversation: { ...sharedLive.conversation, session_history: {
  ...catalog, current_id: 'next', controls: [{ request_id: sessionRequests[0].data.request_id, phase: 'complete' }] } } });
assert.equal(sessionQuery('[data-role="firefly-history"]').value, 'next');
assert.equal(sessionQuery('[data-role="chat-send"]').disabled, false);
sessionQuery('[data-role="firefly-history"]').value = 'old';
await sessionQuery('[data-role="firefly-history"]').handlers.change();
assert.equal(sessionRequests[1].data.action, 'select');
assert.equal(sessionRequests[1].data.conversation_id, 'old');
shared.updateState(null);
assert.equal(sessionQuery('[data-role="firefly-history"]').disabled, true);
console.log("private dialogue routing, state, text safety and disconnect tests ok");
