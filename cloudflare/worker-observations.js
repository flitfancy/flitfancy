import { adminContentBody } from "./worker-content.js";
import { clearFails, clientIp, json } from "./worker-core.js";
import {
  ensureObservationsTable,
  runDdlOnce,
  TABLE_OBSERVATION_LINKS,
} from "./worker-storage.js";

const CATEGORIES = new Set([
  "宇宙与自然",
  "生命与感知",
  "技术与造物",
  "历史与文明",
  "语言与艺术",
  "思想与日常",
]);
const UID_RE = /^[a-zA-Z0-9_-]{16,80}$/;

async function ensureTables(env) {
  await ensureObservationsTable(env);
  await runDdlOnce(env, TABLE_OBSERVATION_LINKS);
}

function parseTags(value) {
  try {
    const tags = JSON.parse(value || "[]");
    return Array.isArray(tags) ? tags.map(String) : [];
  } catch (error) {
    return [];
  }
}

function publicObservation(row) {
  const result = { ...row, tags: parseTags(row.tags_json) };
  delete result.tags_json;
  return result;
}

function validSourceUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch (error) {
    return false;
  }
}

function unixTime(value) {
  const parsed = new Date(value || "");
  return Number.isNaN(parsed.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(parsed.getTime() / 1000);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function handleObservations(env) {
  if (!env.DB) {
    return json({ ok: false, error: "见闻未配置（请绑定 D1，绑定名为 DB）" }, 503);
  }
  await ensureTables(env);
  const rows = await env.DB.prepare(
    `SELECT uid, created_ts, updated_ts, title, category, tags_json,
            summary, content, discovered_at, source_name, source_url
     FROM observations WHERE published = 1
     ORDER BY discovered_at DESC, updated_ts DESC, id DESC LIMIT 300`
  ).all();
  const links = await env.DB.prepare(
    `SELECT link.uid, link.created_ts, link.updated_ts, link.source_uid,
            link.target_uid, link.relation
     FROM observation_links link
     JOIN observations source ON source.uid = link.source_uid
     JOIN observations target ON target.uid = link.target_uid
     ORDER BY link.updated_ts DESC, link.id DESC LIMIT 600`
  ).all();
  return json({
    ok: true,
    rows: (rows.results || []).map(publicObservation),
    links: links.results || [],
  }, 200, { "Cache-Control": "no-store" });
}

export async function handleObservationCreate(request, env) {
  const pre = await adminContentBody(request, env, "见闻");
  if (pre.error) return pre.error;
  const { body, uid } = pre;
  await ensureTables(env);
  if (body.published !== true) {
    await env.DB.prepare(
      "DELETE FROM observation_links WHERE source_uid = ? OR target_uid = ?"
    ).bind(uid, uid).run();
    await env.DB.prepare("DELETE FROM observations WHERE uid = ?").bind(uid).run();
    await clearFails(env, clientIp(request));
    return json({ ok: true, uid, published: false });
  }
  const title = String(body.title || "").trim();
  const category = String(body.category || "").trim();
  const summary = String(body.summary || "").trim();
  const content = String(body.content || "").trim();
  const discoveredAt = String(body.discovered_at || "").trim();
  const sourceName = String(body.source_name || "").trim();
  const sourceUrl = String(body.source_url || "").trim();
  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.map((tag) => String(tag || "").trim()).filter(Boolean))]
    : null;
  if (!title || title.length > 120 || !summary || summary.length > 400 || content.length > 12000) {
    return json({ ok: false, error: "invalid observation content" }, 400);
  }
  if (!CATEGORIES.has(category) || !tags || tags.length > 12 || tags.some((tag) => tag.length > 32)) {
    return json({ ok: false, error: "invalid observation taxonomy" }, 400);
  }
  if (!validDate(discoveredAt)) {
    return json({ ok: false, error: "invalid discovered_at" }, 400);
  }
  if (sourceName.length > 160 || sourceUrl.length > 1000 || !validSourceUrl(sourceUrl)) {
    return json({ ok: false, error: "invalid observation source" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO observations(
       uid, created_ts, updated_ts, title, category, tags_json, summary,
       content, discovered_at, source_name, source_url, published
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
     ON CONFLICT(uid) DO UPDATE SET
       updated_ts = excluded.updated_ts,
       title = excluded.title,
       category = excluded.category,
       tags_json = excluded.tags_json,
       summary = excluded.summary,
       content = excluded.content,
       discovered_at = excluded.discovered_at,
       source_name = excluded.source_name,
       source_url = excluded.source_url,
       published = 1`
  ).bind(
    uid, unixTime(body.created_at), unixTime(body.updated_at), title, category,
    JSON.stringify(tags), summary, content, discoveredAt, sourceName, sourceUrl
  ).run();
  await clearFails(env, clientIp(request));
  return json({ ok: true, uid, published: true });
}

export async function handleObservationLinkCreate(request, env) {
  const pre = await adminContentBody(request, env, "星弦");
  if (pre.error) return pre.error;
  const { body, uid } = pre;
  await ensureTables(env);
  if (body.published !== true) {
    await env.DB.prepare("DELETE FROM observation_links WHERE uid = ?").bind(uid).run();
    await clearFails(env, clientIp(request));
    return json({ ok: true, uid, published: false });
  }
  const sourceUid = String(body.source_uid || "").trim();
  const targetUid = String(body.target_uid || "").trim();
  const relation = String(body.relation || "").trim();
  if (!UID_RE.test(sourceUid) || !UID_RE.test(targetUid) || sourceUid === targetUid) {
    return json({ ok: false, error: "invalid observation link endpoints" }, 400);
  }
  if (!relation || relation.length > 80) {
    return json({ ok: false, error: "invalid observation relation" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO observation_links(
       uid, created_ts, updated_ts, source_uid, target_uid, relation
     ) VALUES(?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
       updated_ts = excluded.updated_ts,
       source_uid = excluded.source_uid,
       target_uid = excluded.target_uid,
       relation = excluded.relation`
  ).bind(
    uid, unixTime(body.created_at), unixTime(body.updated_at),
    sourceUid, targetUid, relation
  ).run();
  await clearFails(env, clientIp(request));
  return json({ ok: true, uid, published: true });
}
