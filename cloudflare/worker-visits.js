import {
  RATE,
  adminAuthError,
  clientIp,
  json,
  rateLimitExceeded,
  readJsonBody,
} from "./worker-core.js";
import { runDdlOnce, TABLE_VISITS } from "./worker-storage.js";

export async function handleTrack(request, env) {
  let page = "/";
  let ref = "";
  let w = 0;
  let h = 0;
  if (request.method === "GET") {
    const url = new URL(request.url);
    page = (url.searchParams.get("p") || "/").slice(0, 200);
    ref = (url.searchParams.get("r") || "").slice(0, 500);
    w = parseInt(url.searchParams.get("w") || "0", 10) || 0;
    h = parseInt(url.searchParams.get("h") || "0", 10) || 0;
  } else {
    const parsed = await readJsonBody(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    page = String(body.page || "/").slice(0, 200);
    ref = String(body.ref || "").slice(0, 500);
    w = parseInt(body.w, 10) || 0;
    h = parseInt(body.h, 10) || 0;
  }
  if (!env.DB) {
    return json({ ok: false, error: "访问记录未配置（请绑定 D1，绑定名为 DB）" }, 503);
  }
  const ip = clientIp(request);
  if (await rateLimitExceeded(
    env, "TRACK_RATE_LIMITER", ip, "track:", RATE.trackMax, RATE.trackTtl
  )) {
    return json({ ok: false, error: "请求过于频繁" }, 429);
  }
  await runDdlOnce(env, TABLE_VISITS);
  const ts = Math.floor(Date.now() / 1000);
  const ua = (request.headers.get("User-Agent") || "").slice(0, 300);
  await env.DB.prepare(
    "INSERT INTO visits(ts, page, ref, ip, ua, w, h) VALUES(?,?,?,?,?,?,?)"
  )
    .bind(ts, page, ref, ip, ua, w || null, h || null)
    .run();
  return json({ ok: true });
}

export async function handleVisits(request, env) {
  const authError = await adminAuthError(request, env);
  if (authError) return authError;
  if (!env.DB) {
    return json({ ok: false, error: "访问记录未配置（请绑定 D1，绑定名为 DB）" }, 503);
  }
  await runDdlOnce(env, TABLE_VISITS);
  const [recent, total, uniq, today, byDay, byPage] = await Promise.all([
    env.DB.prepare(
      "SELECT id, ts, page, ref, ip, ua, w, h FROM visits ORDER BY ts DESC, id DESC LIMIT 200"
    ).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM visits").first(),
    env.DB.prepare(
      "SELECT COUNT(DISTINCT ip) AS n FROM visits WHERE ip IS NOT NULL"
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM visits WHERE date(ts, 'unixepoch', '+8 hours') = date('now', '+8 hours')"
    ).first(),
    env.DB.prepare(
      "SELECT date(ts, 'unixepoch', '+8 hours') AS d, COUNT(*) AS n FROM visits GROUP BY d ORDER BY d DESC LIMIT 14"
    ).all(),
    env.DB.prepare(
      "SELECT page, COUNT(*) AS n FROM visits GROUP BY page ORDER BY n DESC LIMIT 20"
    ).all(),
  ]);
  return json({
    ok: true,
    recent: recent.results || [],
    stats: {
      total: (total && total.n) || 0,
      uniq: (uniq && uniq.n) || 0,
      today: (today && today.n) || 0,
      by_day: byDay.results || [],
      by_page: byPage.results || [],
    },
  });
}
