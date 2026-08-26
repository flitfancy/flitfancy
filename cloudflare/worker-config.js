import {
  adminAuthError,
  json,
  readJsonBody,
} from "./worker-core.js";

const CONFIG_CACHE_SECONDS = 30;
let chatEnabledCache = { t: 0, value: true };

export async function chatEnabled(env) {
  if (!env.CONFIG) return false;
  const now = Date.now();
  if (now - chatEnabledCache.t < 10000) return chatEnabledCache.value;
  const value = await env.CONFIG.get("chat_enabled");
  const enabled = value !== "false";
  chatEnabledCache = { t: now, value: enabled };
  return enabled;
}

function normalizeReflections(values) {
  // 与 backend/flitfancy_core.py 的 normalize_reflections 保持同一契约。
  if (!Array.isArray(values)) return [];
  const rows = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim().slice(0, 120);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push(text);
    if (rows.length >= 100) break;
  }
  return rows;
}

async function reflections(env) {
  if (!env.CONFIG) return [];
  const value = await env.CONFIG.get("reflections");
  if (!value) return [];
  try {
    return normalizeReflections(JSON.parse(value));
  } catch (e) {
    return [];
  }
}

function defaultCache() {
  return typeof caches === "undefined" ? null : caches.default;
}

function configCacheKey(request) {
  const url = new URL(request.url);
  url.pathname = "/config";
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

async function clearConfigCache(request) {
  const cache = defaultCache();
  if (cache) await cache.delete(configCacheKey(request));
}

export async function handleConfig(request, env, ctx) {
  const cache = defaultCache();
  const cacheKey = configCacheKey(request);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  const response = json({
    ok: true,
    chat_enabled: env.CONFIG ? await chatEnabled(env) : false,
    reflections: env.CONFIG ? await reflections(env) : [],
    config_ready: !!env.CONFIG,
  }, 200, {
    "Cache-Control": `public, max-age=${CONFIG_CACHE_SECONDS}, s-maxage=${CONFIG_CACHE_SECONDS}`,
  });
  if (cache) {
    const cacheWrite = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cacheWrite);
    else await cacheWrite;
  }
  return response;
}

export async function handleToggle(request, env) {
  const authError = await adminAuthError(request, env);
  if (authError) return authError;
  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  if (!env.CONFIG) {
    return json({ ok: false, error: "KV 未绑定（绑定名为 CONFIG）" }, 500);
  }
  const hasChatEnabled = Object.prototype.hasOwnProperty.call(body, "chat_enabled");
  const hasReflections = Object.prototype.hasOwnProperty.call(body, "reflections");
  if (hasReflections && !Array.isArray(body.reflections)) {
    return json({ ok: false, error: "reflections must be an array" }, 400);
  }
  if (!hasChatEnabled && !hasReflections) {
    return json({ ok: false, error: "no supported config field" }, 400);
  }
  const result = { ok: true };
  if (hasChatEnabled) {
    const enabled = !!body.chat_enabled;
    await env.CONFIG.put("chat_enabled", enabled ? "true" : "false");
    chatEnabledCache = { t: 0, value: enabled };
    result.chat_enabled = enabled;
  }
  if (hasReflections) {
    const rows = normalizeReflections(body.reflections);
    await env.CONFIG.put("reflections", JSON.stringify(rows));
    result.reflections = rows;
  }
  await clearConfigCache(request);
  return json(result);
}
