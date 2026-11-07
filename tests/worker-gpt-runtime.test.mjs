/* Exercise the gateway inside workerd, with isolated D1/KV and mocked egress. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const cloudflareRequire = createRequire(new URL("../cloudflare/package.json", import.meta.url));
const wranglerRequire = createRequire(cloudflareRequire.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const adminToken = "fixture-admin-token-0123456789abcdef";
const legacyKey = "fixture-legacy-key-0123456789";
const managerToken = "fixture-cloudflare-token-0123456789";
const calls = [];
let providerRedirect = false, managerRedirect = false;
const workerDirectory = fileURLToPath(new URL("../cloudflare/", import.meta.url));
const moduleNames = ["worker.js", ...fs.readdirSync(workerDirectory).filter(name => /^worker-.+\.js$/.test(name))];
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: moduleNames.map(name => ({type: "ESModule", path: path.join(workerDirectory, name)})),
  modulesRoot: workerDirectory,
  compatibilityDate: "2026-08-08",
  bindings: { ADMIN_TOKEN: adminToken, AI_API_KEY: legacyKey, CF_SECRET_MANAGER_TOKEN: managerToken },
  kvNamespaces: ["CONFIG"], d1Databases: ["DB"],
  ratelimits: {
    ADMIN_FAILED_AUTH_LIMITER: {namespace_id: "1001", simple: {limit: 5, period: 60}},
    GPT_RATE_LIMITER: {namespace_id: "1004", simple: {limit: 5, period: 60}},
    TRACK_RATE_LIMITER: {namespace_id: "1003", simple: {limit: 120, period: 60}},
  },
  outboundService: async request => {
    const url = new URL(request.url);
    calls.push(url.origin);
    if (url.hostname === "api.deepseek.com") {
      assert.equal(request.headers.get("authorization"), "Bearer " + legacyKey);
      const payload = await request.json();
      assert.equal(payload.model, "deepseek-flash");
      if (providerRedirect) return new Response(null, {status: 302, headers: {Location: "https://attacker.example/"}});
      return Response.json({choices: [{finish_reason: "stop", message: {content: "合成答复"}}]});
    }
    if (url.hostname === "api.cloudflare.com") {
      assert.equal(request.headers.get("authorization"), "Bearer " + managerToken);
      const payload = await request.json();
      assert.equal(payload.name, "MODEL_OPENAI_SECRET");
      assert.equal(JSON.parse(payload.text).base_url, "https://api.openai.com/v1");
      if (managerRedirect) return new Response(null, {status: 302, headers: {Location: "https://attacker.example/"}});
      return Response.json({success: true});
    }
    throw new Error("unexpected outbound origin");
  },
}));
const headers = {Authorization: "Bearer " + adminToken, "Content-Type": "application/json"};
const post = (path, data) => mf.dispatchFetch("https://api.flitfancy.com" + path, {method: "POST", headers, body: JSON.stringify(data)});
try {
  let response = await mf.dispatchFetch("https://api.flitfancy.com/admin/model/status", {headers});
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.configured, true);
  assert.equal(status.model, "deepseek-flash");
  const body = {messages: [{role: "user", content: "合成测试"}], profile_id: status.profile_id};
  response = await post("/admin/model/chat", body);
  assert.equal(response.status, 200, "actual Worker runtime must send the provider request");
  assert.equal((await response.json()).reply, "合成答复");
  providerRedirect = true;
  const before = calls.length;
  response = await post("/admin/model/chat", body);
  assert.equal((await response.json()).code, "provider_redirect");
  assert.equal(calls.length, before + 1, "provider credentials never follow a redirect");
  providerRedirect = false;
  const config = {provider: "openai", model: "gpt-fixture", base_url: "https://api.openai.com/v1",
    api_key: "sk-fixture-provider-key-0123456789", access: "admin", public_daily_limit: 20};
  managerRedirect = true;
  const beforeManager = calls.length;
  response = await post("/admin/model/config", config);
  assert.equal(response.status, 502);
  assert.equal(calls.length, beforeManager + 1, "manager credential never follows a redirect");
  managerRedirect = false;
  response = await post("/admin/model/config", config);
  assert.equal(response.status, 200, "actual Worker runtime must reach the Cloudflare secret API");
  assert.equal((await response.json()).pending, true);
  assert(!calls.includes("https://attacker.example"));
} finally {
  await mf.dispose();
}
console.log("workerd model gateway: provider and secret calls work; redirects do not forward credentials");
