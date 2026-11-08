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
let providerThrows = "";
let managerStatus = 200;
let cleanupDbFails = false;
const env = { ADMIN_TOKEN: token, CF_SECRET_MANAGER_TOKEN: manager, AI_API_KEY: "old-deepseek-secret-fixture",
  GPT_RATE_LIMITER: limiter, TRACK_RATE_LIMITER: limiter,
  CONFIG: { get: async key => values.get(key) || null, put: async (key, value) => { values.set(key, value); } },
  DB: { prepare(sql) { return {
    run: async () => {
      if (sql.includes("json_remove")) {
        if (cleanupDbFails) throw new Error("fixture D1 failure");
        const data = JSON.parse(storedConfig);
        if (data.selected !== "openai") return {meta: {changes: 0}};
        for (const name of ["legacy", "deepseek", "mimo", "custom"]) delete (data.profiles || {})[name];
        storedConfig = JSON.stringify(data);
        return {meta: {changes: 1}};
      }
      return {};
    },
    first: async () => storedConfig ? { data: storedConfig } : null,
    bind(...args) { return {
      first: async () => daily < args[1] ? { requests: ++daily } : null,
      run: async () => { if (sql.includes("INSERT INTO model_gateway_config")) storedConfig = args[0]; return {}; },
    }; },
  }; } },
};
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  assert.equal(options.redirect, "manual", "Workers supports manual redirects; credentials must never follow them");
  if (String(url).startsWith("https://api.cloudflare.com/")) {
    assert.equal(options.headers.Authorization, "Bearer " + manager);
    if (managerStatus !== 200) return new Response(null, {status: managerStatus, headers: {Location: "https://attacker.example/"}});
    const secret = JSON.parse(options.body);
    if (String(url).endsWith("/secrets-bulk")) {
      assert.equal(options.method, "PATCH");
      assert.deepEqual(secret.secrets, {AI_API_KEY: null, MODEL_DEEPSEEK_SECRET: null, MODEL_MIMO_SECRET: null, MODEL_CUSTOM_SECRET: null});
      for (const name of Object.keys(secret.secrets)) delete env[name];
      return Response.json({success: true});
    }
    assert.equal(secret.type, "secret_text");
    env[secret.name] = secret.text;
    return Response.json({ success: true });
  }
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(options.headers.Authorization, "Bearer " + apiKey);
  if (providerThrows) throw new Error(providerThrows);
  if (providerStatus !== 200) return Response.json({error: {message: "secret upstream details"}},
    {status: providerStatus, headers: {Location: "https://attacker.example/"}});
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
  assert.equal(legacy.model, "deepseek-flash", "retired DeepSeek default migrates only inside the new gateway");
  assert(!JSON.stringify(legacy).includes(env.AI_API_KEY));
  assert.equal((await (await worker.fetch(req("/gpt/status"), env)).json()).enabled, false);
  const legacyConfig = {provider: "legacy", model: "deepseek-v4-pro", base_url: "https://api.deepseek.com", access: "admin", public_daily_limit: 20};
  response = await worker.fetch(req("/admin/model/config", legacyConfig, true), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "deepseek-v4-pro", "legacy model can change without replacing its secret");
  assert.equal(env.AI_API_KEY, "old-deepseek-secret-fixture");
  assert.equal(calls.length, 0, "changing legacy model must not invoke secret management");
  assert.equal((await worker.fetch(req("/admin/model/config", { ...legacyConfig, base_url: "https://elsewhere.example" }, true), env)).status, 400);

  const config = { provider: "openai", model: "gpt-fixture", base_url: "https://api.openai.com/v1", api_key: apiKey, access: "all", public_daily_limit: 1 };
  assert.equal((await worker.fetch(req("/admin/model/config", config, true), { ...env, CF_SECRET_MANAGER_TOKEN: "" })).status, 503,
    "new keys require scoped Cloudflare authorization");
  assert.equal(env.MODEL_OPENAI_SECRET, undefined);
  managerStatus = 302;
  const beforeRedirect = calls.length;
  assert.equal((await worker.fetch(req("/admin/model/config", config, true), env)).status, 502);
  assert.equal(calls.length, beforeRedirect + 1, "manager token must not follow redirects");
  assert.equal(env.MODEL_OPENAI_SECRET, undefined);
  managerStatus = 200;
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
  assert.equal((await worker.fetch(req("/admin/model/chat", { ...msg, purpose: "unexpected" }, true), env)).status, 400);
  response = await worker.fetch(req("/gpt/chat", msg), env);
  assert.equal(response.status, 200);
  const publicReply = await response.json();
  assert.equal(publicReply.ok, true); assert.equal(publicReply.reply, "云端回复");
  assert.equal((await worker.fetch(req("/gpt/chat", msg), env)).status, 429, "daily budget is enforced");
  assert.equal((await worker.fetch(req("/gpt/chat", { ...msg, profile_id: "0000000000000000" }), env)).status, 409);
  assert.equal((await worker.fetch(req("/gpt/chat", { messages: [{ role: "system", content: "x" }] }), env)).status, 400);
  assert.equal((await worker.fetch(req("/gpt/chat", msg), { ...env, GPT_RATE_LIMITER: undefined })).status, 503);
  const beforeOpenAI = env.MODEL_OPENAI_SECRET;
  response = await worker.fetch(req("/admin/model/config", {provider:"custom2", model:"compatible-model", base_url:"https://custom.example/v1",
    api_key:"fixture-custom-key-012345", access:"all", public_daily_limit:10, set_default:false, public_enabled:false}, true), env);
  assert.equal(response.status,200);
  assert.equal(JSON.parse(env.MODEL_CUSTOM2_SECRET).base_url,"https://custom.example/v1");
  assert.equal(env.MODEL_OPENAI_SECRET,beforeOpenAI,"adding another AI never overwrites the existing OpenAI secret");
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
  providerStatus = 302;
  const beforeProviderRedirect = calls.length;
  const providerRedirect = await worker.fetch(req("/admin/model/chat", { ...msg, purpose: "chat" }, true), env);
  assert.equal((await providerRedirect.json()).code, "provider_redirect");
  assert.equal(calls.length, beforeProviderRedirect + 1, "provider key must not follow redirects");
  providerStatus = 200;
  providerThrows = "redirect blocked; secret transport details";
  const connectionFailure = await worker.fetch(req("/admin/model/chat", { ...msg, purpose: "chat" }, true), env);
  const connectionBody = await connectionFailure.json();
  assert.equal(connectionBody.code, "provider_connection");
  assert.equal(connectionBody.diagnostic, "redirect");
  assert(!JSON.stringify(connectionBody).includes("secret transport details"));
  providerThrows = "";
  assert.equal((await worker.fetch(req("/admin/model/config", { ...config, base_url: "https://attacker.example", api_key: undefined }, true), env)).status, 400,
    "old secret must not be sent to a changed endpoint");
  assert.equal((await worker.fetch(req("/admin/model/config", { ...config, base_url: "http://127.0.0.1", api_key: undefined }, true), env)).status, 400);
  const before = calls.length;
  storedConfig = JSON.stringify({ selected: "openai", profiles: { openai: { model: "gpt-fixture", base_url: "https://attacker.example" } }, access: "all", public_daily_limit: 10 });
  assert.equal((await worker.fetch(req("/gpt/chat", msg), env)).status, 503, "changed metadata cannot redirect the secret");
  assert.equal(calls.length, before);
  storedConfig = JSON.stringify({...selectedConfig, access: "admin", profiles: {...selectedConfig.profiles,
    legacy: {model: "old"}, deepseek: {model: "old"}, custom: {model: "old"}}});
  const current = await (await worker.fetch(req("/admin/model/status?provider=openai", null, true), env)).json();
  const cleanup = {confirm: "remove-old-models", profile_id: current.profile_id};
  assert.equal((await worker.fetch(req("/admin/model/cleanup-old", cleanup), env)).status, 401,
    "cleanup requires administrator authentication");
  assert.equal((await worker.fetch(req("/admin/model/cleanup-old", cleanup, true), env)).status, 409,
    "cleanup cannot remove an old secret while public legacy chat is enabled");
  values.set("chat_enabled", "false");
  assert.equal((await worker.fetch(req("/admin/model/cleanup-old", {...cleanup, profile_id: "stale"}, true), env)).status, 409,
    "cleanup must not proceed if the chosen model changed");
  managerStatus = 500;
  response = await worker.fetch(req("/admin/model/cleanup-old", cleanup, true), env);
  assert.equal((await response.json()).code, "cleanup_uncertain");
  assert.equal(env.AI_API_KEY, "old-deepseek-secret-fixture", "failed cleanup does not pretend the old key was deleted");
  managerStatus = 200;
  cleanupDbFails = true;
  response = await worker.fetch(req("/admin/model/cleanup-old", cleanup, true), env);
  assert.equal((await response.json()).code, "cleanup_partial", "a D1 failure after secret removal is reported accurately");
  assert.equal(env.AI_API_KEY, undefined);
  assert.equal(JSON.parse(env.MODEL_OPENAI_SECRET).api_key, apiKey);
  assert(Object.hasOwn(JSON.parse(storedConfig).profiles, "legacy"), "failed D1 cleanup leaves the configuration for later recovery");
  cleanupDbFails = false;
  response = await worker.fetch(req("/admin/model/cleanup-old", cleanup, true), env);
  assert.equal(response.status, 200);
  assert.equal(env.AI_API_KEY, undefined);
  assert.equal(JSON.parse(env.MODEL_OPENAI_SECRET).api_key, apiKey, "cleanup preserves the active OpenAI key");
  assert.equal(env.CF_SECRET_MANAGER_TOKEN, manager, "cleanup preserves Cloudflare management authorization");
  const afterCleanup = JSON.parse(storedConfig);
  assert.deepEqual(Object.keys(afterCleanup.profiles), ["openai", "custom2"]);
  assert(env.MODEL_CUSTOM2_SECRET, "cleanup of old slots cannot remove subsequently added custom services");
  assert.equal(afterCleanup.access, "admin");
  assert.equal((await (await worker.fetch(req("/admin/model/status", null, true), env)).json()).configured, true);
  assert.equal((await worker.fetch(new Request("https://api.flitfancy.com/gpt/chat", { method: "OPTIONS", headers: { Origin: "https://flitfancy.com" } }), env)).status, 204);
} finally { globalThis.fetch = originalFetch; }
console.log("model gateway: CF secret storage, legacy preservation, authorization, endpoint binding and visitor limits passed");
