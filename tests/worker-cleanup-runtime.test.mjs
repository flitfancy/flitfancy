/* Exercise the cleanup against real workerd/D1 with fixture secrets only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const directory = fileURLToPath(new URL("../cloudflare/", import.meta.url));
const fromCloudflare = createRequire(path.join(directory, "package.json"));
const fromWrangler = createRequire(fromCloudflare.resolve("wrangler/package.json"));
const {Miniflare, convertV4MiniflareOptions} = fromWrangler("miniflare");
const admin = "fixture-admin-token-0123456789abcdef";
const manager = "fixture-manager-token-0123456789";
const openai = "sk-proj-fixture-not-a-real-api-key";
const calls = [];
const names = ["worker.js", ...fs.readdirSync(directory).filter(name => /^worker-.+\.js$/.test(name))];
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: names.map(name => ({type: "ESModule", path: path.join(directory, name)})),
  modulesRoot: directory, compatibilityDate: "2026-08-08",
  bindings: {ADMIN_TOKEN: admin, CF_SECRET_MANAGER_TOKEN: manager, AI_API_KEY: "fixture-old-key-123456",
    MODEL_OPENAI_SECRET: JSON.stringify({base_url: "https://api.openai.com/v1", api_key: openai})},
  kvNamespaces: ["CONFIG"], d1Databases: ["DB"],
  ratelimits: {ADMIN_FAILED_AUTH_LIMITER: {namespace_id: "1001", simple: {limit: 5, period: 60}}},
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === "api.cloudflare.com") {
      assert.equal(request.method, "PATCH");
      assert(url.pathname.endsWith("/workers/scripts/flitfancy/secrets-bulk"));
      assert.equal(request.headers.get("authorization"), "Bearer " + manager);
      const data = await request.json();
      assert.deepEqual(data.secrets, {AI_API_KEY: null, MODEL_DEEPSEEK_SECRET: null, MODEL_MIMO_SECRET: null, MODEL_CUSTOM_SECRET: null});
      calls.push("cleanup");
      return Response.json({success: true});
    }
    assert.equal(url.hostname, "api.openai.com");
    assert.equal(request.headers.get("authorization"), "Bearer " + openai);
    calls.push("openai");
    return Response.json({status: "completed", output: [{type: "message", content: [{type: "output_text", text: "fixture"}]}]});
  },
}));
const headers = {Authorization: "Bearer " + admin, "Content-Type": "application/json"};
const post = (url, body) => mf.dispatchFetch("https://api.flitfancy.com" + url, {method: "POST", headers, body: JSON.stringify(body)});
try {
  let response = await post("/admin/model/config", {provider: "openai", model: "gpt-6.1-sol",
    base_url: "https://api.openai.com/v1", access: "admin", public_daily_limit: 20});
  assert.equal(response.status, 200);
  const statusResponse = await mf.dispatchFetch("https://api.flitfancy.com/admin/model/status", {headers});
  const status = await statusResponse.json();
  const cleanup = {confirm: "remove-old-models", profile_id: status.profile_id};
  response = await post("/admin/model/cleanup-old", cleanup);
  assert.equal(response.status, 409, "legacy public chat must be closed before removing its key");
  const kv = await mf.getKVNamespace("CONFIG");
  await kv.put("chat_enabled", "false");
  response = await post("/admin/model/cleanup-old", cleanup);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true, pending: true});
  const db = await mf.getD1Database("DB");
  const config = JSON.parse((await db.prepare("SELECT data FROM model_gateway_config WHERE id=1").first()).data);
  assert.equal(config.selected, "openai");
  assert.deepEqual(Object.keys(config.profiles), ["openai"]);
  response = await post("/admin/model/chat", {messages: [{role: "user", content: "fixture"}], profile_id: status.profile_id});
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["cleanup", "openai"]);
} finally { await mf.dispose(); }
console.log("workerd cleanup: scoped secret removal, D1 cleanup and active model preservation passed");
