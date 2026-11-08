/* Model gateway: provider credentials are encrypted Worker secrets, never KV. */
import { adminAuthError, clientIp, configuredSecret, json, rateLimitExceeded, readJsonBody } from "./worker-core.js";
import { runDdlOnce } from "./worker-storage.js";
import {normalizeUsage, recordUsage, usageSummary} from "./worker-model-usage.js";

const ACCOUNT_ID = "99007f44dc64030aa39ddba200194c89";
const WORKER_NAME = "flitfancy";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
function validModel(value) {
  return typeof value === "string" && MODEL_PATTERN.test(value) && !/^(?:sk-|cfat_|cfut_|ghp_)[A-Za-z0-9_-]{12,}$/i.test(value);
}
const PROVIDERS = {
  legacy: { label: "原 Cloudflare 接口", secret: "AI_API_KEY", protocol: "chat" },
  openai: { label: "OpenAI", secret: "MODEL_OPENAI_SECRET", protocol: "responses", model: "gpt-6.1-sol", models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra"], base_url: "https://api.openai.com/v1" },
  deepseek: { label: "DeepSeek", secret: "MODEL_DEEPSEEK_SECRET", protocol: "chat", model: "deepseek-flash", models: ["deepseek-flash", "deepseek-v4-pro"], base_url: "https://api.deepseek.com" },
  mimo: { label: "小米 MiMo", secret: "MODEL_MIMO_SECRET", protocol: "chat", model: "mimo-v2.5", models: ["mimo-v2.5", "mimo-v2.5-pro"], base_url: "https://api.xiaomimimo.com/v1" },
  custom: { label: "自定义接口", secret: "MODEL_CUSTOM_SECRET", protocol: "chat", model: "", base_url: "" },
  custom2: { label: "自定义接口 2", secret: "MODEL_CUSTOM2_SECRET", protocol: "chat", model: "", base_url: "" },
  custom3: { label: "自定义接口 3", secret: "MODEL_CUSTOM3_SECRET", protocol: "chat", model: "", base_url: "" },
};
const CHAT_PROVIDERS = ["openai", "deepseek", "mimo", "custom", "custom2", "custom3"];
const DAILY_TABLE = "CREATE TABLE IF NOT EXISTS model_gateway_daily(day TEXT PRIMARY KEY, requests INTEGER NOT NULL)";
const CONFIG_TABLE = "CREATE TABLE IF NOT EXISTS model_gateway_config(id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)";
const ERROR = {
  invalid_provider: "请选择有效的模型服务。",
  invalid_model: "请输入有效的模型名称。",
  invalid_base_url: "接口地址必须是有效的 HTTPS 地址。",
  invalid_key: "API 密钥格式不正确。",
  key_required: "更换接口地址后，请重新输入该服务的密钥。",
  setup_required: "请先在控制台配置 Cloudflare 管理令牌。",
  not_configured: "模型接口尚未配置，请在控制台设置。",
  chat_disabled: "网页模型直聊未开放。",
  profile_changed: "模型配置已改变，请开启新对话。",
  daily_limit: "访客今日对话次数已用完。",
  invalid_messages: "对话内容为空或过长。",
  invalid_purpose: "模型请求用途无效。",
  invalid_effort: "当前模型不支持这个思考强度。",
  upstream_error: "模型服务暂时无法完成请求。",
  invalid_api_key: "模型服务认证失败，请检查密钥、项目权限或访问限制。",
  insufficient_balance: "模型服务账户余额不足，请检查所选服务的额度。",
  provider_forbidden: "模型服务拒绝了访问，请检查账户权限。",
  model_not_found: "模型或接口地址不存在，请检查配置。",
  provider_rate_limit: "模型服务请求过于频繁，请稍后再试。",
  invalid_request: "模型服务无法处理请求，请检查模型和接口配置。",
  provider_connection: "云端无法连接所选模型服务，请稍后重试。",
  provider_redirect: "模型接口发生跳转；为保护密钥，请在控制台填写最终接口地址。",
  provider_unavailable: "模型服务暂时不可用，请稍后重试。",
  invalid_response: "模型服务返回格式异常。",
  incomplete_response: "模型未完成本次回答，请重试。",
  empty_response: "模型没有返回文字，请重试。",
  manager_error: "Cloudflare 未能保存密钥，请检查管理令牌权限。",
  partial_save: "密钥可能已保存，但模型设置未完成。请先刷新状态确认，再决定是否重试。",
  cleanup_not_ready: "请先确认新的 OpenAI 接口可用，并关闭原访客聊天。",
  cleanup_uncertain: "旧密钥清理状态暂不确定，请先检查当前配置；没有自动重试。",
  cleanup_partial: "旧密钥已清理，但旧模型配置未能完成清理。请先检查当前配置。",
};

class GatewayError extends Error {
  constructor(code, status = 400, diagnostic = "") {
    super(ERROR[code] || "模型服务暂不可用。"); this.code = code; this.status = status; this.diagnostic = diagnostic;
  }
}
function failure(error) {
  const known = error instanceof GatewayError;
  const result = { ok: false, error: known ? error.message : "模型服务暂不可用。", code: known ? error.code : "gateway_error" };
  if (known && error.diagnostic) result.diagnostic = error.diagnostic;
  return json(result, known ? error.status : 503, { "Cache-Control": "no-store" });
}
function connectionDiagnostic(error) {
  const detail = String(error && error.message || "").toLowerCase();
  if (/redirect/.test(detail)) return "redirect";
  if (/timeout|timed out|abort/.test(detail) || error?.name === "TimeoutError") return "timeout";
  if (/dns|resolve/.test(detail)) return "dns";
  if (/tls|ssl|certificate/.test(detail)) return "tls";
  return "other";
}
function baseUrl(value) {
  if (typeof value !== "string" || value.length > 512 || /\s/.test(value)) throw new GatewayError("invalid_base_url");
  let parsed;
  try { parsed = new URL(value); } catch { throw new GatewayError("invalid_base_url"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !parsed.hostname.includes(".") || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(parsed.hostname) ||
      parsed.hostname.toLowerCase().endsWith(".local")) throw new GatewayError("invalid_base_url");
  return parsed.toString().replace(/\/+$/, "");
}
function keyValid(value, provider) {
  return typeof value === "string" && /^[\x21-\x7e]{8,512}$/.test(value) && (provider !== "openai" || value.startsWith("sk-"));
}
function providerName(value) {
  if (!Object.hasOwn(PROVIDERS, value)) throw new GatewayError("invalid_provider");
  return value;
}
async function readConfig(env) {
  if (!env.DB) throw new GatewayError("not_configured", 503);
  let raw;
  try {
    await runDdlOnce(env, CONFIG_TABLE);
    const row = await env.DB.prepare("SELECT data FROM model_gateway_config WHERE id = 1").first();
    raw = row && row.data;
  } catch { throw new GatewayError("not_configured", 503); }
  let config = {};
  try { config = raw ? JSON.parse(raw) : {}; } catch { throw new GatewayError("not_configured", 503); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new GatewayError("not_configured", 503);
  return config;
}
function profile(env, config, name, modelOverride) {
  name = providerName(name || config.selected || "legacy");
  const defaults = PROVIDERS[name];
  const saved = config.profiles && typeof config.profiles[name] === "object" ? config.profiles[name] : {};
  const legacy = name === "legacy";
  const base = legacy ? String(env.AI_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "") : String(saved.base_url || defaults.base_url || "");
  const originalModel = String(env.AI_MODEL || "deepseek-chat");
  const defaultLegacyModel = base === "https://api.deepseek.com" && originalModel === "deepseek-chat" ? "deepseek-flash" : originalModel;
  const defaultModel = legacy ? String(saved.model || defaultLegacyModel) : String(saved.model || defaults.model || "");
  const models = [...new Set([defaultModel, ...(Array.isArray(saved.models) ? saved.models : defaults.models || [])].filter(validModel))].slice(0, 20);
  if (modelOverride !== undefined && (typeof modelOverride !== "string" || !models.includes(modelOverride))) throw new GatewayError("invalid_model");
  const model = modelOverride === undefined ? defaultModel : modelOverride;
  let secret = null;
  if (legacy) {
    if (configuredSecret(env.AI_API_KEY)) secret = { base_url: base, api_key: env.AI_API_KEY };
  } else {
    try { secret = JSON.parse(env[defaults.secret] || "null"); } catch { secret = null; }
  }
  let ready = false;
  try { ready = Boolean(validModel(model) && baseUrl(base) === base && secret && secret.base_url === base && keyValid(secret.api_key, legacy ? "custom" : name)); } catch { /* invalid config is unavailable */ }
  const rawEffort = typeof saved.default_effort === "string" ? saved.default_effort : "auto";
  const allowedEfforts = effortOptions({provider: name, model});
  return { provider: name, provider_label: defaults.label, model, models, default_effort: allowedEfforts.includes(rawEffort) ? rawEffort : "auto", base_url: base, protocol: defaults.protocol, secret,
    key_saved: Boolean(secret && keyValid(secret.api_key, legacy ? "custom" : name)), configured: ready };
}
async function profileId(item) {
  const input = new TextEncoder().encode([item.provider, item.model, item.base_url].join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hash).slice(0, 8), x => x.toString(16).padStart(2, "0")).join("");
}
async function connectionId(item) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([item.provider, item.base_url].join("\n")));
  return Array.from(new Uint8Array(hash).slice(0, 8), x => x.toString(16).padStart(2, "0")).join("");
}
async function status(env, config, provider, modelOverride) {
  const item = profile(env, config, provider, modelOverride);
  const access = ["off", "admin", "all"].includes(config.access) ? config.access : "admin";
  const limit = Number.isInteger(config.public_daily_limit) && config.public_daily_limit >= 1 && config.public_daily_limit <= 200 ? config.public_daily_limit : 20;
  return { configured: item.configured, key_saved: item.key_saved, provider: item.provider, provider_label: item.provider_label,
    selected_provider: config.selected || "legacy", model: item.model, models: item.models, default_effort: item.default_effort, base_url: item.base_url,
    profile_id: await profileId(item), connection_id: await connectionId(item), access, public_daily_limit: limit, public_enabled: publicProvider(config, item.provider),
    manager_ready: Boolean(configuredSecret(env.CF_SECRET_MANAGER_TOKEN)), storage: "cloudflare",
    interface_version: 1, model_ui_version: 2, efforts: effortOptions(item), capabilities: { text: true, multi_turn: true, streaming: false, tools: false, images: false } };
}
function publicProvider(config, provider) {
  return Array.isArray(config.public_providers) ? config.public_providers.includes(provider) : provider === (config.selected || "legacy");
}
function publicModel(config, item) {
  const saved = config.profiles?.[item.provider] || {};
  const allowed = Array.isArray(saved.models) ? saved.models : [saved.model || PROVIDERS[item.provider]?.model];
  return allowed.includes(item.model);
}
function effortOptions(item) {
  if (item.provider === "openai" && /^(gpt-6\.1-sol|gpt-6-astra)(?:$|-)/.test(item.model)) return ["auto", "low", "medium", "high", "xhigh", "max"];
  if (item.provider === "openai" && /^(gpt-6-sol|gpt-6-luna|gpt-6\.1-terra)(?:$|-)/.test(item.model)) return ["auto", "none", "low", "medium", "high", "xhigh", "max"];
  if (item.provider === "deepseek" && /^(deepseek-flash|deepseek-v4-pro)(?:$|-)/.test(item.model)) return ["auto", "none", "low", "high", "max"];
  if (item.provider === "mimo" && /^mimo-v2\.5(?:$|-)/.test(item.model)) return ["auto", "none", "high"];
  return ["auto"];
}
async function catalog(env, config, publicOnly = false) {
  const defaults = await Promise.all(CHAT_PROVIDERS.map(name => status(env, config, name)));
  const rows = (await Promise.all(defaults.map(row => Promise.all(row.models.map(model => status(env, config, row.provider, model)))))).flat();
  return rows.filter(row => row.configured && (!publicOnly || (publicProvider(config, row.provider) && publicModel(config, row)))).map(row => ({provider: row.provider, provider_label: row.provider_label,
    model: row.model, profile_id: row.profile_id, connection_id: row.connection_id, efforts: row.efforts, default_effort: row.default_effort}));
}
async function updateSecret(env, name, value) {
  const token = configuredSecret(env.CF_SECRET_MANAGER_TOKEN);
  if (!token) throw new GatewayError("setup_required", 503);
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ name, text: value, type: "secret_text" }), redirect: "manual", signal: AbortSignal.timeout(20000),
    });
  } catch { throw new GatewayError("manager_error", 502); }
  if (!response.ok) throw new GatewayError("manager_error", 502);
  let data;
  try { data = await response.json(); } catch { throw new GatewayError("manager_error", 502); }
  if (!data || data.success !== true) throw new GatewayError("manager_error", 502);
}
async function cleanupOldModels(env, config, body) {
  const current = profile(env, config, "openai");
  if (body.confirm !== "remove-old-models" || config.selected !== "openai" || !current.configured ||
      body.profile_id !== await profileId(current)) throw new GatewayError("cleanup_not_ready", 409);
  // The old public /chat endpoint still depends on AI_API_KEY. Never remove it while enabled.
  if (!env.CONFIG || await env.CONFIG.get("chat_enabled") !== "false") throw new GatewayError("cleanup_not_ready", 409);
  const token = configuredSecret(env.CF_SECRET_MANAGER_TOKEN);
  if (!token) throw new GatewayError("setup_required", 503);
  const secrets = {AI_API_KEY: null, MODEL_DEEPSEEK_SECRET: null, MODEL_MIMO_SECRET: null, MODEL_CUSTOM_SECRET: null};
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets-bulk`, {
      method: "PATCH", headers: {"Content-Type": "application/json", Authorization: "Bearer " + token},
      body: JSON.stringify({secrets}), redirect: "manual", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok || !(await response.json())?.success) throw new Error("unconfirmed");
  } catch { throw new GatewayError("cleanup_uncertain", 502); }
  try {
    // JSON modification happens inside D1: do not overwrite newer unrelated settings.
    const result = await env.DB.prepare(`UPDATE model_gateway_config
      SET data = json_remove(data, '$.profiles.legacy', '$.profiles.deepseek', '$.profiles.mimo', '$.profiles.custom')
      WHERE id = 1 AND json_extract(data, '$.selected') = 'openai'`).run();
    if (result?.meta?.changes !== 1) throw new Error("configuration changed");
  } catch { throw new GatewayError("cleanup_partial", 503); }
  return {ok: true, pending: true};
}
function cleanMessages(messages, isPublic) {
  const maxCount = isPublic ? 6 : 20, maxTotal = isPublic ? 6000 : 40000;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > maxCount) throw new GatewayError("invalid_messages");
  let total = 0;
  const clean = messages.map(item => {
    const limit = item && item.role === "user" ? (isPublic ? 1000 : 4000) : (isPublic ? 4000 : 12000);
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || !item.content.trim() || item.content.length > limit) throw new GatewayError("invalid_messages");
    total += item.content.length;
    return { role: item.role, content: item.content.trim() };
  });
  if (total > maxTotal || clean.at(-1).role !== "user") throw new GatewayError("invalid_messages");
  return clean;
}
async function reservePublic(env, limit) {
  if (!env.DB) throw new GatewayError("upstream_error", 503);
  try {
    await runDdlOnce(env, DAILY_TABLE);
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = await env.DB.prepare("INSERT INTO model_gateway_daily(day, requests) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1 WHERE requests < ? RETURNING requests").bind(day, limit).first();
    if (!row) throw new GatewayError("daily_limit", 429);
  } catch (error) { if (error instanceof GatewayError) throw error; throw new GatewayError("upstream_error", 503); }
}
async function infer(item, messages, purpose, effort) {
  if (!item.configured) throw new GatewayError("not_configured", 503);
  const instruction = purpose === "consult" ? "你是小流萤可按需咨询的助手。针对问题提供清楚、准确的分析；区分已知事实、推测与需要核验的内容。不要假称访问过未提供的资料。回答将交还本地助手，由她结合上下文向用户说明。" : "";
  if (!effortOptions(item).includes(effort)) throw new GatewayError("invalid_effort");
  const requestedLimit = effort === "max" ? 25000 : effort === "xhigh" ? 16000 : effort === "high" ? 10000 : effort === "medium" || effort === "auto" ? 6000 : 2500;
  const limit = purpose === "public" ? Math.min(requestedLimit, 8000) : requestedLimit;
  let payload, endpoint;
  if (item.protocol === "responses") {
    payload = { model: item.model, input: messages, store: false, max_output_tokens: limit };
    if (instruction) payload.instructions = instruction;
    if (effort !== "auto") payload.reasoning = {effort};
    else if (purpose === "public" && item.model.startsWith("gpt-6")) payload.reasoning = { effort: "low" };
    endpoint = "/responses";
  } else {
    payload = { model: item.model, messages: instruction ? [{ role: "system", content: instruction }, ...messages] : messages, stream: false };
    payload[item.provider === "mimo" ? "max_completion_tokens" : "max_tokens"] = limit;
    if (item.provider === "deepseek" && effort !== "auto") payload.reasoning_effort = effort;
    if (item.provider === "mimo" && effort !== "auto") payload.thinking = {type: effort === "none" ? "disabled" : "enabled"};
    endpoint = "/chat/completions";
  }
  let response;
  try {
    response = await fetch(item.base_url + endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + item.secret.api_key },
      body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(180000) });
  } catch (error) { throw new GatewayError("provider_connection", 502, connectionDiagnostic(error)); }
  if (response.status >= 300 && response.status < 400) throw new GatewayError("provider_redirect", 502);
  if (!response.ok) {
    const codes = { 400: "invalid_request", 401: "invalid_api_key", 402: "insufficient_balance",
      403: "provider_forbidden", 404: "model_not_found", 429: "provider_rate_limit" };
    throw new GatewayError(codes[response.status] || "provider_unavailable", response.status === 429 ? 429 : 502);
  }
  let data;
  try {
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error();
    data = JSON.parse(text);
  } catch { throw new GatewayError("invalid_response", 502); }
  const usage = normalizeUsage(data.usage);
  let reply = "";
  if (item.protocol === "responses") {
    if (data.status !== "completed") { const error = new GatewayError("incomplete_response", 502); error.usage = usage; throw error; }
    reply = (Array.isArray(data.output) ? data.output : []).filter(x => x && x.type === "message")
      .flatMap(x => Array.isArray(x.content) ? x.content : []).map(x => x && (x.type === "output_text" ? x.text : x.type === "refusal" ? x.refusal : ""))
      .filter(x => typeof x === "string" && x).join("\n").trim();
  } else {
    const choice = Array.isArray(data.choices) && data.choices[0];
    if (!choice) throw new GatewayError("invalid_response", 502);
    if (choice.finish_reason === "length") { const error = new GatewayError("incomplete_response", 502); error.usage = usage; throw error; }
    reply = typeof choice.message?.content === "string" ? choice.message.content.trim() : "";
  }
  if (!reply) { const error = new GatewayError("empty_response", 502); error.usage = usage; throw error; }
  return { reply, provider: item.provider, provider_label: item.provider_label, model: item.model,
    usage, service_tier: typeof data.service_tier === "string" ? data.service_tier : "" };
}
async function measuredInfer(env, item, messages, purpose, effort) {
  if (!item.configured) throw new GatewayError("not_configured", 503);
  if (!effortOptions(item).includes(effort)) throw new GatewayError("invalid_effort");
  let result;
  try { result = await infer(item, messages, purpose, effort); }
  catch (error) {
    await recordUsage(env, {purpose, provider: item.provider, model: item.model, effort, outcome: "error", usage: error.usage || null, tier: ""});
    throw error;
  }
  const recorded = await recordUsage(env, {purpose, provider: item.provider, model: item.model, effort,
    outcome: "complete", usage: result.usage, tier: result.service_tier});
  return {...result, usage_recorded: recorded};
}

export async function handleModelAdmin(request, env, action, ctx) {
  const denied = await adminAuthError(request, env);
  if (denied) return denied;
  try {
    const config = await readConfig(env);
    if (action === "status") return json({ ok: true, ...await status(env, config, new URL(request.url).searchParams.get("provider") || undefined) }, 200, { "Cache-Control": "no-store" });
    if (action === "catalog") return json({ok: true, profiles: await catalog(env, config), selected_provider: config.selected || "legacy"}, 200, {"Cache-Control": "no-store"});
    if (action === "usage") return json({ok: true, ...(await usageSummary(env))}, 200, {"Cache-Control": "no-store"});
    const parsed = await readJsonBody(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    if (action === "cleanup-old") return json(await cleanupOldModels(env, config, body), 200, {"Cache-Control": "no-store"});
    if (action === "config") {
      const name = providerName(body.provider), previous = profile(env, config, name);
      const access = body.access;
      if (!["off", "admin", "all"].includes(access)) throw new GatewayError("chat_disabled");
      if (body.set_default !== undefined && typeof body.set_default !== "boolean") throw new GatewayError("invalid_provider");
      if (body.public_enabled !== undefined && typeof body.public_enabled !== "boolean") throw new GatewayError("invalid_provider");
      if (!Number.isInteger(body.public_daily_limit) || body.public_daily_limit < 1 || body.public_daily_limit > 200) throw new GatewayError("invalid_messages");
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!validModel(model)) throw new GatewayError("invalid_model");
      const priorEffort = config.profiles?.[name]?.default_effort || "auto";
      const allowedEfforts = effortOptions({provider: name, model});
      const defaultEffort = body.default_effort === undefined ? (allowedEfforts.includes(priorEffort) ? priorEffort : "auto") : body.default_effort;
      if (!allowedEfforts.includes(defaultEffort)) throw new GatewayError("invalid_effort");
      if (body.models !== undefined && (!Array.isArray(body.models) || body.models.length > 20 ||
          body.models.some(value => !validModel(value)) || new Set([model, ...body.models]).size > 20)) throw new GatewayError("invalid_model");
      const base = baseUrl(body.base_url);
      if (name === "legacy" && (base !== previous.base_url || body.api_key !== undefined)) throw new GatewayError("key_required");
      if (name !== "legacy" && body.api_key !== undefined && !keyValid(body.api_key, name)) throw new GatewayError("invalid_key");
      if (name !== "legacy" && body.api_key === undefined && previous.secret && previous.secret.base_url !== base) throw new GatewayError("key_required");
      const ready = name === "legacy" ? previous.configured : Boolean(body.api_key || (previous.configured && previous.base_url === base));
      if (access === "all" && !ready) throw new GatewayError("not_configured");
      if (body.api_key !== undefined) await updateSecret(env, PROVIDERS[name].secret, JSON.stringify({ base_url: base, api_key: body.api_key }));
      if (body.public_enabled !== undefined) {
        const allowed = new Set(Array.isArray(config.public_providers) ? config.public_providers : [config.selected || name]);
        if (body.public_enabled) allowed.add(name); else allowed.delete(name);
        config.public_providers = [...allowed].filter(value => CHAT_PROVIDERS.includes(value));
      }
      if (body.set_default !== false || !config.selected) config.selected = name;
      config.access = access; config.public_daily_limit = body.public_daily_limit;
      const previousModels = config.profiles?.[name]?.models;
      const models = [...new Set([model, ...(body.models === undefined ? (Array.isArray(previousModels) ? previousModels : []) : body.models)])].slice(0, 20);
      config.profiles = { ...(config.profiles || {}), [name]: { model, models, default_effort: defaultEffort, base_url: base } };
      try {
        await env.DB.prepare("INSERT INTO model_gateway_config(id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
          .bind(JSON.stringify(config)).run();
      } catch { throw new GatewayError(body.api_key !== undefined ? "partial_save" : "upstream_error", 503); }
      const result = await status(env, config, name);
      if (body.api_key !== undefined) result.pending = true;
      return json({ ok: true, ...result }, 200, { "Cache-Control": "no-store" });
    }
    if (action === "chat") {
      const purpose = body.purpose === undefined ? "chat" : body.purpose;
      if (!["chat", "consult"].includes(purpose)) throw new GatewayError("invalid_purpose");
      if (body.provider !== undefined && !CHAT_PROVIDERS.includes(body.provider)) throw new GatewayError("invalid_provider");
      const item = profile(env, config, body.provider || undefined, body.model);
      if (purpose !== "consult" && config.access === "off") throw new GatewayError("chat_disabled", 403);
      if (body.provider !== undefined && !body.profile_id) throw new GatewayError("profile_changed", 409);
      if (body.profile_id !== undefined && body.profile_id !== await profileId(item)) throw new GatewayError("profile_changed", 409);
      const messages = cleanMessages(body.messages, false);
      const inference = measuredInfer(env, item, messages, purpose, body.effort || (purpose === "consult" ? item.default_effort : "auto"));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(inference.then(() => {}, () => {}));
      return json({ ok: true, ...await inference }, 200, { "Cache-Control": "no-store" });
    }
    return json({ ok: false }, 404);
  } catch (error) { return failure(error); }
}
export async function handleGPTStatus(request, env) {
  const limited = await rateLimitExceeded(env, "TRACK_RATE_LIMITER", "gpt-status:" + clientIp(request));
  if (limited !== false) return json({ ok: false, enabled: false }, limited ? 429 : 503);
  try {
    const config = await readConfig(env), item = await status(env, config);
    const profiles = item.access === "all" ? await catalog(env, config, true) : [];
    const selected = profiles.find(row => row.provider === item.provider) || profiles[0];
    const enabled = Boolean(selected);
    return json({ ok: true, enabled, selected_provider: enabled ? selected.provider : "", provider_label: enabled ? selected.provider_label : "", model: enabled ? selected.model : "", profile_id: enabled ? selected.profile_id : "",
      profiles }, 200, { "Cache-Control": "no-store" });
  } catch (error) { return json({ ok: false, enabled: false }, 503); }
}
export async function handleGPTChat(request, env, ctx) {
  const limited = await rateLimitExceeded(env, "GPT_RATE_LIMITER", "gpt:" + clientIp(request));
  if (limited !== false) return json({ ok: false, error: "访客对话暂不可用。" }, limited ? 429 : 503);
  try {
    const config = await readConfig(env);
    if (config.access !== "all") throw new GatewayError("chat_disabled", 403);
    const parsed = await readJsonBody(request);
    if (parsed.error) return parsed.error;
    if (parsed.body.provider !== undefined && !CHAT_PROVIDERS.includes(parsed.body.provider)) throw new GatewayError("invalid_provider");
    const item = profile(env, config, parsed.body.provider || undefined, parsed.body.model);
    if (!publicProvider(config, item.provider) || !publicModel(config, item)) throw new GatewayError("chat_disabled", 403);
    if (!item.configured) throw new GatewayError("not_configured", 503);
    if (parsed.body.provider !== undefined && !parsed.body.profile_id) throw new GatewayError("profile_changed", 409);
    if (parsed.body.profile_id !== undefined && parsed.body.profile_id !== await profileId(item)) throw new GatewayError("profile_changed", 409);
    const messages = cleanMessages(parsed.body.messages, true);
    const settings = await status(env, config);
    await reservePublic(env, settings.public_daily_limit);
    const inference = measuredInfer(env, item, messages, "public", parsed.body.effort || "auto");
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(inference.then(() => {}, () => {}));
    const result = await inference;
    return json({ ok: true, reply: result.reply, usage: result.usage, usage_recorded: result.usage_recorded }, 200, { "Cache-Control": "no-store" });
  } catch (error) { return failure(error); }
}
