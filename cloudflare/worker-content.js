import {
  adminAuthError,
  json,
  readJsonBody,
} from "./worker-core.js";
import {
  ensureAnchorsTable,
  ensureMemoriesTable,
  runDdlOnce,
  TABLE_ESSAYS,
} from "./worker-storage.js";

export async function handleMemories(env) {
  if (!env.DB) {
    return json({ ok: false, error: "日记未配置（请绑定 D1，绑定名为 DB）" }, 503);
  }
  await ensureMemoriesTable(env);
  const rows = await env.DB.prepare(
    `SELECT uid, created_ts, memory_time AS time, time_precision AS precision,
            perspective, content
     FROM memories ORDER BY memory_time DESC, created_ts DESC, id DESC LIMIT 200`
  ).all();
  return json({ ok: true, rows: rows.results || [] }, 200, {
    "Cache-Control": "no-store",
  });
}

export async function handleAnchors(env) {
  if (!env.DB) {
    return json({ ok: false, error: "锚点未配置（请绑定 D1，绑定名为 DB）" }, 503);
  }
  await ensureAnchorsTable(env);
  const rows = await env.DB.prepare(
    `SELECT uid, created_ts, anchor_time AS time, time_precision AS precision,
            horizon, project, title, content
     FROM anchors ORDER BY anchor_time DESC, id DESC LIMIT 200`
  ).all();
  return json({ ok: true, rows: rows.results || [] }, 200, {
    "Cache-Control": "no-store",
  });
}

export async function handleEssays(env) {
  if (!env.DB) {
    return json({ ok: false, error: "短文未配置（请绑定 D1，绑定名为 DB）" }, 503);
  }
  await runDdlOnce(env, TABLE_ESSAYS);
  const rows = await env.DB.prepare(
    `SELECT uid, created_ts, updated_ts, display_order, title, content
     FROM essays ORDER BY display_order ASC, updated_ts DESC, id DESC LIMIT 100`
  ).all();
  return json({ ok: true, rows: rows.results || [] }, 200, {
    "Cache-Control": "no-store",
  });
}

// 管理写入端点公共前置：鉴权 -> D1 就绪 -> 读体 -> uid 校验。
export async function adminContentBody(request, env, resourceLabel) {
  const authError = await adminAuthError(request, env);
  if (authError) return { error: authError };
  if (!env.DB) {
    return {
      error: json({ ok: false, error: resourceLabel + "未配置（请绑定 D1，绑定名为 DB）" }, 503),
    };
  }
  const parsed = await readJsonBody(request);
  if (parsed.error) return { error: parsed.error };
  const body = parsed.body;
  const uid = String(body.uid || "").trim();
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(uid)) {
    return { error: json({ ok: false, error: "invalid uid" }, 400) };
  }
  return { body, uid };
}

export async function handleAnchorCreate(request, env) {
  const pre = await adminContentBody(request, env, "锚点");
  if (pre.error) return pre.error;
  const body = pre.body;
  const uid = pre.uid;
  const title = String(body.title || "").trim().slice(0, 120);
  const content = String(body.content || "").trim().slice(0, 4000);
  const horizon = String(body.horizon || "").trim();
  const project = String(body.project || "").trim();
  let anchorTime = String(body.time || "").trim();
  const timePrecision = body.precision === "date" ? "date" : "second";
  if (!anchorTime) anchorTime = new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(anchorTime)) {
    return json({ ok: false, error: "time must include seconds" }, 400);
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(anchorTime)) anchorTime += "+08:00";
  if (!title || !content) {
    return json({ ok: false, error: "title and content required" }, 400);
  }
  if (horizon !== "now" && horizon !== "future") {
    return json({ ok: false, error: "invalid horizon" }, 400);
  }
  if (!["firefly", "skywork", "flitfancy", "pending"].includes(project)) {
    return json({ ok: false, error: "invalid project" }, 400);
  }
  const createdDate = new Date(body.created_at || "");
  const createdTs = Number.isNaN(createdDate.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(createdDate.getTime() / 1000);
  await ensureAnchorsTable(env);
  await env.DB.prepare(
    `INSERT INTO anchors(
       uid, created_ts, anchor_time, time_precision, horizon, project, title, content
     ) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
       anchor_time = excluded.anchor_time,
       time_precision = excluded.time_precision,
       horizon = excluded.horizon,
       project = excluded.project,
       title = excluded.title,
       content = excluded.content`
  )
    .bind(uid, createdTs, anchorTime, timePrecision, horizon, project, title, content)
    .run();
  return json({ ok: true, uid });
}

function toDisplayOrder(value) {
  if (value === undefined || value === null) return 100;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return null;
}

export async function handleEssayCreate(request, env) {
  const pre = await adminContentBody(request, env, "短文");
  if (pre.error) return pre.error;
  const body = pre.body;
  const uid = pre.uid;
  await runDdlOnce(env, TABLE_ESSAYS);
  if (body.published !== true) {
    await env.DB.prepare("DELETE FROM essays WHERE uid = ?").bind(uid).run();
    return json({ ok: true, uid, published: false });
  }
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();
  // 与本地后端 int() 契约一致：缺省 100；数字向零截断；纯数字字符串可解析；
  // 其余类型拒绝（不再静默归零）。
  const rawOrder = toDisplayOrder(body.display_order);
  if (rawOrder === null) {
    return json({ ok: false, error: "invalid display order" }, 400);
  }
  const displayOrder = Math.max(0, Math.min(9999, rawOrder));
  if (!title || title.length > 120 || !content || content.length > 12000) {
    return json({ ok: false, error: "invalid essay content" }, 400);
  }
  const createdDate = new Date(body.created_at || "");
  const updatedDate = new Date(body.updated_at || "");
  const createdTs = Number.isNaN(createdDate.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(createdDate.getTime() / 1000);
  const updatedTs = Number.isNaN(updatedDate.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(updatedDate.getTime() / 1000);
  await env.DB.prepare(
    `INSERT INTO essays(
       uid, created_ts, updated_ts, display_order, title, content
     ) VALUES(?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
       updated_ts = excluded.updated_ts,
       display_order = excluded.display_order,
       title = excluded.title,
       content = excluded.content`
  ).bind(uid, createdTs, updatedTs, displayOrder, title, content).run();
  return json({ ok: true, uid, published: true });
}

export async function handleMemoryCreate(request, env) {
  const pre = await adminContentBody(request, env, "日记");
  if (pre.error) return pre.error;
  const body = pre.body;
  const uid = pre.uid;
  if (Object.prototype.hasOwnProperty.call(body, "date") ||
      Object.prototype.hasOwnProperty.call(body, "title")) {
    return json({ ok: false, error: "date/title are no longer supported; use time/content" }, 400);
  }
  const perspective = String(body.perspective || "").trim();
  const source = String(body.source || "manual").trim();
  const content = String(body.content || "").trim();
  let memoryTime = String(body.time || "").trim();
  const timePrecision = body.precision === "date" ? "date" : "second";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(memoryTime)) {
    return json({ ok: false, error: "time must include seconds" }, 400);
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(memoryTime)) memoryTime += "+08:00";
  const memoryInstant = new Date(memoryTime);
  if (Number.isNaN(memoryInstant.getTime())) {
    return json({ ok: false, error: "invalid time" }, 400);
  }
  if (perspective !== "me" && perspective !== "her") {
    return json({ ok: false, error: "invalid perspective" }, 400);
  }
  if (source !== "manual" && source !== "firefly") {
    return json({ ok: false, error: "invalid source" }, 400);
  }
  if (!content || content.length > 4000) {
    return json({ ok: false, error: "invalid content" }, 400);
  }
  const createdDate = new Date(body.created_at || "");
  const createdTs = Number.isNaN(createdDate.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(createdDate.getTime() / 1000);
  await ensureMemoriesTable(env);
  await env.DB.prepare(
    `INSERT INTO memories(
       uid, created_ts, memory_time, time_precision, memory_date,
       perspective, source, title, content
     ) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
       created_ts = excluded.created_ts,
       memory_time = excluded.memory_time,
       time_precision = excluded.time_precision,
       memory_date = excluded.memory_date,
       perspective = excluded.perspective,
       content = excluded.content`
  )
    .bind(
      uid, createdTs, memoryTime, timePrecision, memoryTime.slice(0, 10),
      perspective, source, "", content
    )
    .run();
  return json({ ok: true, uid });
}
