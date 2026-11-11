import {
  adminAuthError,
  json,
  readJsonBody,
} from "./worker-core.js";
import { runDdlOnce, TABLE_ESSAYS } from "./worker-storage.js";

const CONFIG_CACHE_SECONDS = 30;
let chatEnabledCache = { t: 0, value: true };
const TABLE_PUBLIC_CONTENT_CONFIG = `CREATE TABLE IF NOT EXISTS public_content_config(
  config_key TEXT PRIMARY KEY, sync_revision INTEGER NOT NULL, value TEXT NOT NULL
)`;

async function versionedConfig(env, key) {
  if (!env.DB) return null;
  await runDdlOnce(env, TABLE_PUBLIC_CONTENT_CONFIG);
  const rows = await env.DB.prepare(
    "SELECT sync_revision, value FROM public_content_config WHERE config_key = ?"
  ).bind(key).all();
  return rows.results?.[0] || null;
}

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
  const saved = await versionedConfig(env, "reflections");
  const value = saved ? saved.value : await env.CONFIG.get("reflections");
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

function validFeaturedEssay(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.uid === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(value.uid)
    && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 120
    && typeof value.content === "string" && value.content.trim().length > 0 && value.content.length <= 12000
    && typeof value.updated_at === "string" && value.updated_at.length <= 40;
}

export async function handleFeaturedEssay(env) {
  if (!env.CONFIG) return json({ ok: false, error: "config unavailable" }, 503);
  const saved = await versionedConfig(env, "featured_essay");
  const raw = saved ? saved.value : await env.CONFIG.get("featured_essay");
  let essay = null;
  try { essay = raw ? JSON.parse(raw) : null; } catch (error) { /* 缺失或损坏时显示原序章。 */ }
  if (!validFeaturedEssay(essay) || !env.DB) {
    essay = null;
  } else {
    await runDdlOnce(env, TABLE_ESSAYS);
    // KV 选卡请求可能晚到；以 D1 公开副本确认可见性，撤下后不再返回旧快照正文。
    // 仍公开时保留选中时的快照，后续编辑不会自动替换访客正在看的文章。
    const rows = await env.DB.prepare("SELECT uid FROM essays WHERE uid = ? LIMIT 1")
      .bind(essay.uid).all();
    if (!(rows.results || []).length) essay = null;
  }
  return json({ ok: true, essay }, 200, {
    "Cache-Control": "no-store",
  });
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
  const hasFeaturedEssay = Object.prototype.hasOwnProperty.call(body, "featured_essay");
  if (hasFeaturedEssay && !validFeaturedEssay(body.featured_essay)) {
    return json({ ok: false, error: "invalid featured essay" }, 400);
  }
  // Legacy writers cannot silently replace content after a versioned writer has taken over.
  for (const [key, present] of [["reflections", hasReflections], ["featured_essay", hasFeaturedEssay]]) {
    if (present && await versionedConfig(env, key)) {
      // Keep an explicitly requested chat access change effective even if an old
      // client bundled it with content that now requires a versioned writer.
      if (hasChatEnabled) {
        const enabled = !!body.chat_enabled;
        await env.CONFIG.put("chat_enabled", enabled ? "true" : "false");
        chatEnabledCache = { t: 0, value: enabled };
        await clearConfigCache(request);
      }
      return json({ ok: false, error: "content configuration requires versioned sync" }, 409);
    }
  }
  if (!hasChatEnabled && !hasReflections && !hasFeaturedEssay) {
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
  if (hasFeaturedEssay) {
    const { uid, title, content, updated_at } = body.featured_essay;
    const essay = { uid, title, content, updated_at };
    await env.CONFIG.put("featured_essay", JSON.stringify(essay));
    result.featured_essay = essay;
  }
  await clearConfigCache(request);
  return json(result);
}

export async function handleContentConfig(request, env) {
  const authError = await adminAuthError(request, env);
  if (authError) return authError;
  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  if (!env.DB || !env.CONFIG) return json({ ok: false, error: "content configuration unavailable" }, 503);
  const { key, value, sync_revision: revision } = parsed.body;
  if (!Number.isSafeInteger(revision) || revision < 1 || !["reflections", "featured_essay"].includes(key)) {
    return json({ ok: false, error: "invalid content configuration revision or key" }, 400);
  }
  if (key === "reflections" && !Array.isArray(value) || key === "featured_essay" && !validFeaturedEssay(value)) {
    return json({ ok: false, error: "invalid content configuration" }, 400);
  }
  const normalized = key === "reflections" ? normalizeReflections(value) : {
    uid: value.uid, title: value.title, content: value.content, updated_at: value.updated_at,
  };
  const encoded = JSON.stringify(normalized);
  await runDdlOnce(env, TABLE_PUBLIC_CONTENT_CONFIG);
  // Claim and read in one D1 transaction. A timed-out older request cannot overwrite a newer value.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO public_content_config(config_key, sync_revision, value) VALUES(?,?,?)
      ON CONFLICT(config_key) DO UPDATE SET sync_revision=excluded.sync_revision, value=excluded.value
      WHERE excluded.sync_revision > public_content_config.sync_revision`).bind(key, revision, encoded),
    env.DB.prepare("SELECT sync_revision, value FROM public_content_config WHERE config_key = ?").bind(key),
  ]);
  const current = results[1].results?.[0];
  if (!current || current.sync_revision !== revision || current.value !== encoded) {
    return json({ ok: false, error: "content configuration revision conflict", sync_revision: current?.sync_revision || 0 }, 409);
  }
  await clearConfigCache(request);
  return json({ ok: true, sync_revision: revision });
}
