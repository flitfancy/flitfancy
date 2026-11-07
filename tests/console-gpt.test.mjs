import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/console-gpt.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../docs/presence.html", import.meta.url), "utf8");
for (const role of ["dialogue-modes", "firefly-chat-panel", "gpt-chat-panel", "mode-firefly", "mode-gpt", "gpt-log", "gpt-input", "gpt-send", "gpt-clear", "gpt-status", "gpt-settings"]) {
  assert.equal(html.split('data-role="' + role + '"').length - 1, 1, role + " must be present exactly once");
}
assert.match(html, /data-role="dialogue-modes"[^>]*hidden/);
assert.match(html, /data-role="gpt-chat-panel"[^>]*hidden/);
assert.match(html, /模型直聊/);
class Element {
  constructor() { this.children = []; this.handlers = {}; this.attributes = {}; this.value = ""; this.hidden = false; this.disabled = false; this.textContent = ""; this.scrollHeight = 20; }
  appendChild(item) { this.children.push(item); }
  replaceChildren() { this.children = []; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const elements = new Map();
const query = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
const window = {};
vm.runInNewContext(source, {window, document: {createElement: () => new Element()}});
let configured = false, deferred = null, localAccess = "admin", profile = "1111111111111111";
const requests = [];
const chat = window.FlitFancyConsoleGPT.create({query, request: async (url, opts = {}) => {
  requests.push({url, opts});
  if (url.endsWith("/status")) return {configured, model: "deepseek-flash", provider_label: "DeepSeek", access: localAccess, profile_id: profile};
  if (url.endsWith("/chat") && deferred) return await new Promise(resolve => { deferred.resolve = resolve; });
  return {reply: "<script>只是文字</script>"};
}});
const get = name => query('[data-role="' + name + '"]');
chat.start();
assert.equal(get("dialogue-modes").hidden, true);
chat.selectMode("gpt");
assert.equal(requests.length, 0, "signed-out users cannot open or send model requests");
chat.setAuthenticated(true); chat.selectMode("gpt");
await new Promise(resolve => setImmediate(resolve));
assert.equal(get("firefly-chat-panel").hidden, true);
assert.equal(get("gpt-send").disabled, true, "unconfigured model cannot send");
configured = true; await chat.refreshStatus();
assert.equal(get("gpt-send").disabled, false);
get("gpt-input").value = "你好";
await chat.send();
assert.equal(requests.at(-1).url, "/api/model-gateway/chat");
assert.deepEqual(JSON.parse(requests.at(-1).opts.body), {messages: [{role: "user", content: "你好"}], profile_id: profile});
assert.equal(get("gpt-log").children[1].children[0].textContent, "DeepSeek");
assert.equal(get("gpt-log").children[1].children[1].textContent, "<script>只是文字</script>");
chat.selectMode("firefly"); chat.selectMode("gpt");
await new Promise(resolve => setImmediate(resolve));
assert.equal(get("gpt-log").children.length, 2, "switching tabs preserves separate model history");
profile = "2222222222222222"; await chat.refreshStatus();
assert.equal(get("gpt-log").children.length, 1, "changing providers clears old conversation before sending to another service");
assert.match(get("gpt-status").textContent, /模型配置已改变/);

deferred = {};
get("gpt-input").value = "退出前的请求";
const pending = chat.send();
chat.clearPrivate();
deferred.resolve({reply: "不应出现在退出后的界面"});
await pending;
assert.equal(get("dialogue-modes").hidden, true);
assert.doesNotMatch(JSON.stringify(get("gpt-log").children), /不应出现在/);

const visitorNodes = new Map(), visitorRequests = [];
const visitorQuery = selector => { if (!visitorNodes.has(selector)) visitorNodes.set(selector, new Element()); return visitorNodes.get(selector); };
const visitorGet = role => visitorQuery('[data-role="' + role + '"]');
let visitorEnabled = false;
const visitor = window.FlitFancyConsoleGPT.create({query: visitorQuery, publicMode: true,
  publicBase: "https://api.example", request: async (url, opts = {}) => {
    visitorRequests.push({url, opts});
    return url.endsWith("/status") ? {enabled: visitorEnabled, provider_label: "MiMo", profile_id: "3333333333333333"} : {reply: "访客答复"};
  }});
visitor.setAuthenticated(true); visitor.start();
await new Promise(resolve => setImmediate(resolve));
assert.equal(visitorGet("dialogue-modes").hidden, true, "visitor model chat is hidden until enabled");
assert.equal(visitorGet("gpt-settings").hidden, true, "visitors cannot access private settings");
visitorEnabled = true; await visitor.refreshStatus();
visitor.selectMode("gpt"); await new Promise(resolve => setImmediate(resolve));
visitorGet("gpt-input").value = "你好"; await visitor.send();
assert.equal(visitorRequests.at(-1).url, "https://api.example/gpt/chat");
assert.equal(visitorRequests.at(-1).opts.authMode, "none");
assert.deepEqual(JSON.parse(visitorRequests.at(-1).opts.body), {messages: [{role: "user", content: "你好"}], profile_id: "3333333333333333"});
visitorEnabled = false; await visitor.refreshStatus();
assert.equal(visitorGet("dialogue-modes").hidden, true);
assert.equal(visitorGet("gpt-chat-panel").hidden, true);
assert.doesNotMatch(source, /sessionStorage|localStorage|innerHTML/);
console.log("model chat: private auth, public scope, provider isolation and logout race passed");
