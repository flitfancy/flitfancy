import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/console-chat.js", import.meta.url), "utf8"
);

class FakeElement {
  constructor() {
    this.children = [];
    this.handlers = {};
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.removed = false;
    this.focused = false;
    this.scrollHeight = 0;
    this.scrollTop = 0;
  }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  closest() { return null; }
}

const elements = {
  '[data-role="chat-log"]': new FakeElement(),
  '[data-role="chat-empty"]': new FakeElement(),
  '[data-role="chat-input"]': new FakeElement(),
  '[data-role="chat-send"]': new FakeElement(),
  '[data-role="chat-status"]': new FakeElement(),
};
const saved = new Map();
const storage = {
  getItem: (key) => saved.get(key) || null,
  setItem: (key, value) => saved.set(key, value),
};
let local = false;
const sent = [];
const window = {
  matchMedia: () => ({ matches: true }),
  setTimeout,
  sessionStorage: storage,
  fetch: async () => ({ ok: true, async json() { return { chat_enabled: true }; } }),
};
vm.runInNewContext(source, {
  window,
  document: { createElement: () => new FakeElement() },
  setTimeout,
});

const chat = window.FlitFancyConsoleChat.create({
  query: (selector) => elements[selector],
  storage,
  publicBase: "https://api.example",
  isServerOnline: () => local,
  sendRequest: async (url, body) => {
    sent.push({ url, body: JSON.parse(JSON.stringify(body)) });
    return { reply: "收到" };
  },
});
chat.start();

elements['[data-role="chat-input"]'].value = "公网消息";
await chat.send();
assert.equal(sent[0].url, "https://api.example/chat");
assert.equal(sent.length, 1, "一次发送只允许命中一个后端");

local = true;
elements['[data-role="chat-input"]'].value = "本地消息";
await chat.send();
assert.equal(sent[1].url, "/api/chat");
assert.equal(sent.length, 2);
assert.equal(JSON.parse(saved.get("flitfancy.chat.v1")).length, 4,
  "两轮用户和 AI 消息应保存在会话存储中");

chat.setEnabled(false);
assert.equal(elements['[data-role="chat-input"]'].disabled, true);
assert.equal(elements['[data-role="chat-send"]'].disabled, true);
assert.match(elements['[data-role="chat-status"]'].textContent, /暂未对游客开放/);

console.log("console chat module test ok");
