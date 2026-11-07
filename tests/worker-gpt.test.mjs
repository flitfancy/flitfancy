import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const worker = (await import(new URL("../cloudflare/worker.js", import.meta.url))).default;
const token = "fixture-admin-token-0123456789abcdef";
const manager = "fixture-cf-manager-token-0123456789";
const apiKey = "sk-fixture-provider-key-0123456789";
const values = new Map();
const limiter = { limit: async () => ({ success: true }) };
let daily = 0;
let storedConfig = "";
let providerStatus = 200;
const env = { ADMIN_TOKEN: token, CF_SECRET_MANAGER_TOKEN: manager, AI_API_KEY: "old-deepseek-secret-fixture",
  GPT_RATE_LIMITER: limiter, TRACK_RATE_LIMITER: limiter,
  CONFIG: { get: async key => values.get(key) || null, put: async (key, value) => { values.set(key, value); } },
  DB: { prepare(sql) { return {
    run: async () => ({}),
    first: async () => storedConfig ? { data: storedConfig } : null,
    bind(...args) { return {
      first: async () => daily < args[1] ? { requests: ++daily } : null,
      run: async () => { storedConfig = args[0]; return {}; },
    }; },
  }; } },
};
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  assert.equal(options.redirect, "error", "credentials must never follow a redirect");
  if (String(url).startsWith("https://api.cloudflare.com/")) {
    assert.equal(options.headers.Authorization, "Bearer " + manager);
    const secret = JSON.parse(options.body);
    assert.equal(secret.type, "secret_text");
    env[secret.name] = secret.text;
    return Response.json({ success: true });
  }
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(options.headers.Authorization, "Bearer " + apiKey);
  if (providerStatus !== 200) return Response.json({error: {message: "secret upstream details"}}, {status: providerStatus});
  return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "云端回复" }] }] });
};
function req(path, body, admin = false) {
  const headers = { Origin: "https://console.flitfancy.com" };
  if (admin) headers.Authorization = "Bearer " + token;
  if (body) headers["Content-Type"] = "application/json";
  return new Request("https://api.flitfancy.com" + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
}
try {
  let response = await worker.fetch(req("/admin/model/status"), env);
  assert.equal(response.status, 401, "configuration requires administrator authentication");
  response = await worker.fetch(req("/admin/model/status", null, true), env);
  const legacy = await response.json();
  assert.equal(legacy.provider, "legacy");
  assert.equal(legacy.configured, true);
  assert(!JSON.stringify(legacy).includes(env.AI_API_KEY));
  assert.equal((await (await worker.fetch(req("/gpt/status"), env)).json()).enabled, false);

  const config = { provider: "openai", model: "gpt-fixture", base_url: "https://api.openai.com/v1", api_key: apiKey, access: "all", public_daily_limit: 1 };
  assert.equal((await worker.fetch(req("/admin/model/config", config, true), { ...env, CF_SECRET_MANAGER_TOKEN: "" })).status, 503,
    "new keys require scoped Cloudflare authorization");
  assert.equal(env.MODEL_OPENAI_SECRET, undefined);
  response = await worker.fetch(req("/admin/model/config", config, true), env);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.pending, true);
  assert(!JSON.stringify(saved).includes(apiKey));
  assert(!JSON.stringify([...values]).includes(apiKey) && !storedConfig.includes(apiKey), "KV and D1 must never hold a provider key");
  assert.equal(env.AI_API_KEY, "old-deepseek-secret-fixture", "legacy secret is unchanged");
  const secretWrite = calls.find(call => String(call.url).startsWith("https://api.cloudflare.com/"));
  assert.equal(JSON.parse(secretWrite.options.body).name, "MODEL_OPENAI_SECRET");
  assert.equal(JSON.parse(JSON.parse(secretWrite.options.body).text).base_url, "https://api.openai.com/v1");

  const status = await (await worker.fetch(req("/gpt/status"), env)).json();
  assert.equal(status.enabled, true);
  assert.equal(status.model, "gpt-fixture");
  const msg = { messages: [{ role: "user", content: "合成测试" }], profile_id: status.profile_id };
  response = await worker.fetch(req("/gpt/chat", msg), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reply: "云端回复" });
  assert.equal((await worker.fetch(req("/gpt/chat", msg), env)).status, 429, "daily budget is enforced");
  assert.equal((await worker.fetch(req("/gpt/chat", { ...msg, profile_id: "0000000000000000" }), env)).status, 409);
  assert.equal((await worker.fetch(req("/gpt/chat", { messages: [{ role: "system", content: "x" }] }), env)).status, 400);
  assert.equal((await worker.fetch(req("/gpt/chat", msg), { ...env, GPT_RATE_LIMITER: undefined })).status, 503);
  const selectedConfig = JSON.parse(storedConfig);
  storedConfig = JSON.stringify({ ...selectedConfig, access: "off" });
  assert.equal((await worker.fetch(req("/admin/model/chat", { ...msg, purpose: "chat" }, true), env)).status, 403);
  assert.equal((await worker.fetch(req("/admin/model/chat", { ...msg, purpose: "consult" }, true), env)).status, 200,
    "closing web chat must not disable Firefly consultations");
  storedConfig = JSON.stringify(selectedConfig);
  providerStatus = 402;
  const failed = await worker.fetch(req("/admin/model/chat", { ...msg, purpose: "chat" }, true), env);
  assert.equal(failed.status, 502);
  const failedBody = await failed.json();
  assert.equal(failedBody.code, "insufficient_balance");
  assert(!JSON.stringify(failedBody).includes("secret upstream details"));
  providerStatus = 200;
  assert.equal((await worker.fetch(req("/admin/model/config", { ...config, base_url: "https://attacker.example", api_key: undefined }, true), env)).status, 400,
    "old secret must not be sent to a changed endpoint");
  assert.equal((await worker.fetch(req("/admin/model/config", { ...config, base_url: "http://127.0.0.1", api_key: undefined }, true), env)).status, 400);
  const before = calls.length;
  storedConfig = JSON.stringify({ selected: "openai", profiles: { openai: { model: "gpt-fixture", base_url: "https://attacker.example" } }, access: "all", public_daily_limit: 10 });
  assert.equal((await worker.fetch(req("/gpt/chat", msg), env)).status, 503, "changed metadata cannot redirect the secret");
  assert.equal(calls.length, before);
  assert.equal((await worker.fetch(new Request("https://api.flitfancy.com/gpt/chat", { method: "OPTIONS", headers: { Origin: "https://flitfancy.com" } }), env)).status, 204);
} finally { globalThis.fetch = originalFetch; }
console.log("model gateway: CF secret storage, legacy preservation, authorization, endpoint binding and visitor limits passed");
