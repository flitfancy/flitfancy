/* Exercise the gateway inside workerd, with isolated D1/KV and mocked egress. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
async function exercisePythonClient() {
  const ready = await mf.ready;
  const script = `
import asyncio, json, os, sys, urllib.parse, urllib.request
from unittest.mock import patch
sys.path.insert(0, os.path.abspath('backend'))
import flitfancy_openai as gateway
class LocalOpener:
    def open(self, request, timeout=None):
        path = urllib.parse.urlsplit(request.full_url).path
        local = urllib.request.Request(os.environ['FIXTURE_GATEWAY_URL'].rstrip('/') + path,
            data=request.data, headers=dict(request.header_items()), method=request.get_method())
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(local, timeout=timeout)
config = {'worker_admin_url': 'https://api.flitfancy.com', 'worker_admin_token': 'fixture-admin-token-0123456789abcdef'}
opener = LocalOpener()
status = gateway.public_status(config, opener=opener)
result = gateway.ask_openai([{'role': 'user', 'content': 'synthetic test'}], config,
                            purpose='consult', profile_id=status['profile_id'], opener=opener)
assert status['capabilities']['text'] is True
assert result['reply'] == '合成答复'
import firefly_consult_test as fixture
case = fixture.ConsultTests()
case.setUp()
try:
    with patch.object(gateway, '_transport', return_value=opener), \
         patch.object(fixture.plugin_module, 'read_config', return_value=config), \
         patch.object(gateway, 'configured_settings', return_value=status):
        result = asyncio.run(case.plugin.consult_gpt(fixture.Event(), '合成咨询问题'))
    assert '合成答复' in result
    events = fixture.ConsultationStore().list_events()
    assert [(event['phase'], event['content']) for event in events] == [('question', '合成咨询问题'), ('answer', '合成答复')]
finally:
    case.doCleanups()
print('Python-to-workerd consultation passed')
`;
  const command = process.platform === "win32" ? "py" : "python3";
  const args = process.platform === "win32" ? ["-3", "-"] : ["-"];
  const child = spawn(command, args, {cwd: path.resolve(workerDirectory, ".."),
    env: {...process.env, FIXTURE_GATEWAY_URL: String(ready), PYTHONUTF8: "1"}, stdio: ["pipe", "pipe", "pipe"]});
  let output = "", errors = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { errors += data; });
  child.stdin.end(script);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, "Python gateway must interoperate with workerd: " + errors);
  assert.match(output, /Python-to-workerd consultation passed/);
}
try {
  let response = await mf.dispatchFetch("https://api.flitfancy.com/admin/model/status", {headers});
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.configured, true);
  assert.equal(status.model, "deepseek-flash");
  assert.equal(status.interface_version, 1);
  assert.deepEqual(status.capabilities, {text: true, multi_turn: true, streaming: false, tools: false, images: false});
  const body = {messages: [{role: "user", content: "合成测试"}], profile_id: status.profile_id};
  response = await post("/admin/model/chat", body);
  assert.equal(response.status, 200, "actual Worker runtime must send the provider request");
  assert.equal((await response.json()).reply, "合成答复");
  await exercisePythonClient();
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
