import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/console-gpt-settings.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../docs/console.html", import.meta.url), "utf8");
for (const role of ["gpt-admin-settings", "gpt-admin-state", "gpt-admin-message", "gpt-admin-key", "gpt-admin-model", "gpt-admin-base", "gpt-admin-access", "gpt-admin-daily", "cfg-model", "cfg-save", "gpt-cloudflare-token", "gpt-cloudflare-save", "gpt-cloudflare-message"]) {
  assert.equal(html.split('data-role="' + role + '"').length - 1, 1, role + " must be present exactly once");
}
assert.match(html, /<h3>模型服务<\/h3>/);
assert.match(html, /<option value="__openai__">OpenAI<\/option>/);
class Element {
  constructor() { this.value = ""; this.textContent = ""; this.disabled = false; this.handlers = {}; this.children = []; this.hidden = false; this.checked = false; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  appendChild(node) { this.children.push(node); }
  replaceChildren() { this.children = []; }
}
const nodes = new Map();
const query = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
const get = role => query('[data-role="' + role + '"]');
const window = {};
vm.runInNewContext(source, {window, document: {createElement: () => new Element()}});
const requests = [], fixtureKey = "sk-test-fixture-not-a-real-secret";
let pending = null, allUnknown = false;
const settings = window.FlitFancyGPTSettings.create({query, request: async (url, opts = {}) => {
  requests.push({url, opts});
  if (pending) return await new Promise(resolve => { pending.resolve = resolve; });
  if (url === '/api/model-gateway/usage') return {from_ms: 1, today: allUnknown ? {requests: 1, unknown_usage: 1, unknown_cost: 1} : {requests: 2, input_tokens: 30, output_tokens: 10, estimated_usd: 0.001, unknown_cost: 1}, month: {requests: 2}, recent: []};
  if (url.startsWith("/api/model-gateway/status")) {
    const provider = url.includes("provider=openai") ? "openai" : url.includes("provider=legacy") ? "legacy" : "deepseek";
    return {storage: "cloudflare", local_model_ui_version: 2, model_ui_version: 2, configured: false, provider, selected_provider: "deepseek", provider_label: provider === "openai" ? "OpenAI" : "DeepSeek",
      model: provider === "openai" ? "gpt-6.1-sol" : "deepseek-flash",
      base_url: provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com", access: "admin", public_daily_limit: 20};
  }
  if (url.includes("/gpt/status")) return {enabled: false};
  return {configured: true, provider: "openai", provider_label: "OpenAI", model: "gpt-6.1-sol", access: "all", public_daily_limit: 30};
}});
settings.start();
assert.equal(get("cfg-save").disabled, true);
await settings.save();
assert.equal(requests.length, 0, "signed-out users cannot configure models");
settings.setAuthenticated(true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(get("cfg-model").value, "deepseek-chat", "existing selection is preserved");
assert.equal(get("gpt-admin-model").value, "deepseek-flash");
assert.match(get("gpt-usage-summary").children[0].textContent, /另 1 次无法估算/);
allUnknown = true; get("gpt-usage-refresh").handlers.click(); await new Promise(resolve => setImmediate(resolve));
assert.match(get("gpt-usage-summary").children[0].textContent, /用量未知.*费用暂无法估算/);
assert.doesNotMatch(get("gpt-usage-summary").children[0].textContent, /\$0\.0000/);
get("gpt-cloudflare-token").value = "fixture-cf-token-never-shown";
await get("gpt-cloudflare-save").handlers.click();
assert.equal(get("gpt-cloudflare-token").value, "", "Cloudflare token clears after submission");
assert.equal(requests.find(item => item.url === "/api/model-gateway/cloudflare-token").opts.method, "POST");
assert.doesNotMatch(get("gpt-cloudflare-message").textContent, /fixture-cf-token/);
await settings.refresh("legacy");
assert.equal(get("cfg-model").value, "__legacy__");
assert.equal(get("gpt-admin-model").disabled, false, "the previous Cloudflare API can select a current model");
assert.equal(get("gpt-admin-base").disabled, true, "the previous key remains bound to its original endpoint");
assert.equal(get("gpt-admin-key").disabled, true, "the previous secret is not overwritten");
get("gpt-admin-key").value = "old-unsaved-secret";
get("cfg-model").value = "__openai__";
get("cfg-model").handlers.change();
await new Promise(resolve => setImmediate(resolve));
assert.equal(get("gpt-admin-key").value, "", "switching providers clears an unsaved key");
assert.equal(get("gpt-admin-base").value, "https://api.openai.com/v1");
get("gpt-admin-key").value = fixtureKey;
get("gpt-admin-access").value = "all";
get("gpt-admin-daily").value = "30";
await settings.save();
assert.equal(get("gpt-admin-key").value, "");
const configRequest = requests.find(item => item.url === "/api/model-gateway/config");
assert.deepEqual(JSON.parse(configRequest.opts.body), {provider: "openai", model: "gpt-6.1-sol", models: ["gpt-6.1-sol"], default_effort: "auto", base_url: "https://api.openai.com/v1", access: "all", public_daily_limit: 30, set_default: false, public_enabled: false, api_key: fixtureKey});
assert.equal(get("gpt-key-status").textContent, "已保存");
assert.equal(get("gpt-key-wrap").hidden, true, "stored keys are shown as saved rather than as a blank form");
assert.equal(requests.at(-1).opts.authMode, "none");
assert.match(get("gpt-admin-message").textContent, /公网组件/);
pending = {};
get("gpt-admin-key").value = "sk-test-another-fixture-key";
const save = settings.save();
settings.clearPrivate();
pending.resolve({configured: true, model: "gpt-6.1-sol", access: "all", public_daily_limit: 30});
await save;
assert.equal(get("gpt-admin-key").value, "");
assert.equal(get("cfg-save").disabled, true);
assert.equal(get("gpt-admin-message").textContent, "");
assert.doesNotMatch(source, /sessionStorage|localStorage|innerHTML/);
const oldNodes = new Map();
const oldQuery = selector => { if (!oldNodes.has(selector)) oldNodes.set(selector, new Element()); return oldNodes.get(selector); };
const oldGet = role => oldQuery('[data-role="' + role + '"]');
const oldBackend = window.FlitFancyGPTSettings.create({query: oldQuery, request: async () => ({configured: true, provider: "openai", model: "old-local-model"})});
oldBackend.start(); oldBackend.setAuthenticated(true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(oldGet("cfg-save").disabled, true, "an old local-key backend must never accept a new key");
assert.equal(oldGet("gpt-cloudflare-save").disabled, true);
assert.match(oldGet("gpt-admin-state").textContent, /重启本机后端/);
const splitNodes = new Map(), splitQuery = selector => { if (!splitNodes.has(selector)) splitNodes.set(selector, new Element()); return splitNodes.get(selector); };
const splitGet = role => splitQuery('[data-role="' + role + '"]');
const splitBackend = window.FlitFancyGPTSettings.create({query: splitQuery, request: async () => ({storage:'cloudflare',model_ui_version:2,configured:true,provider:'openai'})});
splitBackend.start();splitBackend.setAuthenticated(true);await new Promise(resolve => setImmediate(resolve));
assert.equal(splitGet('cfg-save').disabled,true,'new cloud code with an old backend must not silently discard settings');
assert.match(splitGet('gpt-admin-state').textContent,/重启本机后端/);
console.log("model settings: existing selector, provider-specific keys, access scope and logout race passed");
