import {
  adminAuthError,
  clearFails,
  clientIp,
  json,
  readJsonBody,
} from "./worker-core.js";
import {
  runDdlOnce,
  TABLE_HISTORY,
  TABLE_SENSORS,
} from "./worker-storage.js";

function validSensorRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const board = String(value.board || "firefly-r1-1").trim().slice(0, 80);
  const channel = String(value.channel || "").trim().toUpperCase().slice(0, 16);
  const sensor = String(value.sensor || "").trim().slice(0, 80);
  if (!board || !/^CH\d+$/.test(channel) || !sensor) return null;
  const parsed = new Date(String(value.ts || ""));
  const ts = Number.isNaN(parsed.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(parsed.getTime() / 1000);
  const row = { ...value, board, channel, sensor, ok: Number(value.ok) === 1 ? 1 : 0 };
  const payload = JSON.stringify(row);
  if (payload.length > 12000) return null;
  return { board, channel, sensor, ts, ok: row.ok, payload };
}

export async function handleHistoryUpdate(request, env) {
  const authError = await adminAuthError(request, env);
  if (authError) return authError;
  if (!env.DB) {
    return json({ ok: false, error: "传感器历史未配置（请绑定 D1: DB）" }, 503);
  }
  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const source = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(source) || source.length < 1 || source.length > 1500) {
    return json({ ok: false, error: "rows must contain 1-1500 items" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const row of source) {
    const channel = String(row.channel || "").trim().toUpperCase();
    const bucket = String(row.bucket || "").trim();
    const n = Number(row.n);
    if (!/^CH\d+$/.test(channel) || bucket.length < 16 || !(n >= 1)) {
      return json({ ok: false, error: "invalid history row" }, 400);
    }
    const data = {};
    for (const key of Object.keys(row)) {
      if (key === "channel" || key === "bucket" || key === "n") continue;
      const value = row[key];
      data[key] = typeof value === "number" ? value : null;
    }
    rows.push({ channel, bucket, n, data: JSON.stringify(data), updated_ts: now });
  }
  await runDdlOnce(env, TABLE_HISTORY);
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT INTO sensor_history(channel, bucket, n, data, updated_ts)
       VALUES(?,?,?,?,?)
       ON CONFLICT(channel, bucket) DO UPDATE SET
         n=excluded.n, data=excluded.data, updated_ts=excluded.updated_ts`
    ).bind(row.channel, row.bucket, row.n, row.data, row.updated_ts)
  );
  await env.DB.batch(statements);
  await env.DB.prepare(
    "DELETE FROM sensor_history WHERE updated_ts < ?"
  ).bind(now - 30 * 3600).run();
  await clearFails(env, clientIp(request));
  return json({ ok: true, updated: rows.length });
}

export async function handleHistoryGet(request, env) {
  // 24 小时室内趋势比最新快照敏感，登录（带管理员令牌）才可见。
  const authError = await adminAuthError(request, env);
  if (authError) return authError;
  if (!env.DB) {
    return json({ ok: false, error: "传感器历史未配置（请绑定 D1: DB）" }, 503);
  }
  const url = new URL(request.url);
  const channel = (url.searchParams.get("channel") || "").trim().toUpperCase();
  const hoursText = url.searchParams.get("hours") || "24";
  const hours = /^\d+$/.test(hoursText) ? Math.min(72, Math.max(1, parseInt(hoursText, 10))) : 24;
  if (!/^CH\d+$/.test(channel)) {
    return json({ ok: false, error: "channel required" }, 400);
  }
  await runDdlOnce(env, TABLE_HISTORY);
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const result = await env.DB.prepare(
    `SELECT bucket, n, data FROM sensor_history
     WHERE channel = ? AND bucket >= ? ORDER BY bucket`
  ).bind(channel, cutoff).all();
  const buckets = (result.results || []).map((row) => {
    try {
      return { bucket: row.bucket, n: row.n, ...JSON.parse(row.data) };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
  return json({ ok: true, channel, hours, buckets }, 200, { "Cache-Control": "no-store" });
}

export async function handleSensorUpdate(request, env) {
  const authError = await adminAuthError(request, env);
  if (authError) return authError;
  if (!env.DB) {
    return json({ ok: false, error: "传感器数据未配置（请绑定 D1: DB）" }, 503);
  }
  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const source = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(source) || source.length < 1 || source.length > 24) {
    return json({ ok: false, error: "rows must contain 1-24 items" }, 400);
  }
  const rows = source.map(validSensorRow);
  if (rows.some((row) => !row)) {
    return json({ ok: false, error: "invalid sensor row" }, 400);
  }
  await runDdlOnce(env, TABLE_SENSORS);
  // 写路径保留各物理板快照；读路径保证同通道只展示最新的一条。
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT INTO sensor_latest(board, channel, ts, sensor, ok, payload)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(board, channel) DO UPDATE SET
         ts=excluded.ts, sensor=excluded.sensor, ok=excluded.ok,
         payload=excluded.payload
       WHERE excluded.ts >= sensor_latest.ts`
    ).bind(row.board, row.channel, row.ts, row.sensor, row.ok, row.payload)
  );
  await env.DB.batch(statements);
  await clearFails(env, clientIp(request));
  return json({ ok: true, updated: rows.length });
}

export async function handleSensorsLatest(env) {
  if (!env.DB) {
    return json({ ok: false, error: "传感器数据未配置（请绑定 D1: DB）" }, 503);
  }
  await runDdlOnce(env, TABLE_SENSORS);
  const result = await env.DB.prepare(
    "SELECT payload FROM sensor_latest ORDER BY board, channel"
  ).all();
  const parsed = (result.results || []).map((item) => {
    try {
      return JSON.parse(item.payload);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
  const byChannel = new Map();
  for (const row of parsed) {
    if (!row || !row.channel) continue;
    const cur = byChannel.get(row.channel);
    if (!cur || String(row.ts || "") >= String(cur.ts || "")) {
      byChannel.set(row.channel, row);
    }
  }
  return json({ ok: true, rows: [...byChannel.values()] }, 200, {
    "Cache-Control": "no-store",
  });
}
