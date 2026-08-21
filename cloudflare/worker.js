/**
 * 云萤 · flitfancy —— 公网 AI 对话转发 Worker
 *
 * 作用：给静态网站（GitHub Pages）提供一个调用 AI 的公开接口，
 * API 密钥存在 Cloudflare 的加密变量里，不会出现在网页代码中。
 *
 * 部署：仓库 push 后由 Workers Builds 自动构建部署。
 * 必需加密变量：AI_API_KEY、ADMIN_TOKEN；缺失时相关接口返回 503。
 * 必需绑定：KV（名 CONFIG，存公开开关/随笔与失败计数）、
 *   D1（名 DB，存访问记录、日记、锚点、传感器快照与历史）以及
 *   Cloudflare Rate Limiting（聊天、访问上报、管理鉴权失败）。
 * 鉴权策略：admin 端点统一失败计数锁定（5 次/10 分钟，按 IP）；
 *   /memories 与 /anchors 为有意公开的展示数据（产品决策）。
 * 可选变量（都有默认值）：
 *   AI_BASE_URL  AI 服务地址（默认 DeepSeek）
 *   AI_MODEL     模型名（默认 deepseek-chat）
 *   AI_SYSTEM    人设/背景知识（留空则不附加）
 */

const DEFAULTS = {
  AI_BASE_URL: "https://api.deepseek.com",
  AI_MODEL: "deepseek-chat",
};

const RATE = {
  failTtl: 600,     // 验证/开关失败计数窗口（秒）
  failMax: 5,       // 最多失败次数，超过则锁定
  chatTtl: 60,      // 聊天计数窗口（秒）
  chatMax: 15,      // 每 IP 每分钟最多聊天次数
  trackTtl: 60,     // 访问统计计数窗口（秒）
  trackMax: 120,    // 每 IP 每分钟最多上报次数
  maxMessageLen: 4000,  // 单条消息最大字符数
};

const CONFIG_CACHE_SECONDS = 30;
const MIN_ADMIN_TOKEN_LENGTH = 32;

const PUBLIC_CORS_PATHS = new Set([
  "/config",
  "/track",
  "/memories",
  "/anchors",
  "/sensors/latest",
  "/chat",
]);

const ADMIN_CORS_PATHS = new Set([
  "/admin/toggle",
  "/admin/memories",
  "/admin/anchors",
  "/admin/sensors-history",
  "/admin/sensors",
  "/visits",
  "/sensors/history",
]);

async function countKey(env, key, ttl) {
  if (!env.CONFIG) return 0;
  const cur = parseInt((await env.CONFIG.get(key)) || "0", 10) || 0;
  const next = cur + 1;
  await env.CONFIG.put(key, String(next), { expirationTtl: ttl });
  return next;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function configuredSecret(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function configuredAdminSecret(value) {
  const token = configuredSecret(value);
  return token.length >= MIN_ADMIN_TOKEN_LENGTH ? token : "";
}

async function rateLimitExceeded(env, binding, key, fallbackKey, max, ttl) {
  const limiter = env[binding];
  if (limiter && typeof limiter.limit === "function") {
    try {
      const result = await limiter.limit({ key });
      return !result.success;
    } catch (e) {
      // 绑定临时不可用时保留 KV 兜底，避免整条业务链路失效。
    }
  }
  return (await countKey(env, fallbackKey + key, ttl)) > max;
}

// 恒定时间比较：避免令牌长度/前缀差异被时序侧信道利用。
function timingSafeEqual(a, b) {
  const aBytes = new TextEncoder().encode(String(a));
  const bBytes = new TextEncoder().encode(String(b));
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) {
    diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  }
  return diff === 0;
}

async function readFails(env, ip) {
  return env.CONFIG
    ? parseInt((await env.CONFIG.get("fail:" + ip)) || "0", 10) || 0
    : 0;
}

async function bumpFails(env, ip) {
  const burstLimited = await rateLimitExceeded(
    env, "ADMIN_FAILED_AUTH_LIMITER", ip, "fail-burst:", RATE.failMax, 60
  );
  await countKey(env, "fail:" + ip, RATE.failTtl);
  return burstLimited;
}

async function clearFails(env, ip) {
  if (env.CONFIG) {
    await env.CONFIG.put("fail:" + ip, "0", { expirationTtl: RATE.failTtl });
  }
}

/**
 * 统一管理员鉴权（带失败计数与锁定，策略与本地后端一致）：
 * ADMIN_TOKEN 未配置 → 503；失败 ≥ failMax → 429；令牌不符 → 计数并 401。
 * 通过返回 null，否则返回应直接回给客户端的 Response。
 */
const MAX_BODY_BYTES = 64 * 1024;
async function readJsonBody(request) {
  // 不信任 Content-Length（缺失/伪造/负数都能绕过声明值校验）：
  // 按实际读取的字节数把关，chunked 超大请求体同样被 413 拦截。
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return { error: json({ ok: false, error: "请求体过大" }, 413) };
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(buf));
    // 字面量 null / 数组 / 标量都不是合法请求体：统一 400，避免调用方解引用 500。
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { error: json({ ok: false, error: "bad json" }, 400) };
    }
    return { body };
  } catch (e) {
    return { error: json({ ok: false, error: "bad json" }, 400) };
  }
}

async function adminAuthError(request, env) {
  const token = configuredAdminSecret(env.ADMIN_TOKEN);
  if (!token) {
    return json({ ok: false, error: "ADMIN_TOKEN 未配置或长度不足" }, 503);
  }
  const ip = clientIp(request);
  const fails = await readFails(env, ip);
  if (fails >= RATE.failMax) {
    return json({ ok: false, error: "尝试次数过多，请稍后再试" }, 429);
  }
  const auth = request.headers.get("Authorization") || "";
  if (!timingSafeEqual(auth, "Bearer " + token)) {
    if (await bumpFails(env, ip)) {
      return json({ ok: false, error: "尝试次数过多，请稍后再试" }, 429);
    }
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

function corsPolicy(pathname) {
  if (PUBLIC_CORS_PATHS.has(pathname)) return "public";
  if (ADMIN_CORS_PATHS.has(pathname)) return "admin";
  return "none";
}

function adminOriginAllowed(origin) {
  return origin === "https://flitfancy.com" ||
    origin === "https://console.flitfancy.com" ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(request, policy) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  const origin = request.headers.get("Origin") || "";
  if (policy === "public") {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (policy === "admin" && origin && adminOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function withCors(response, request, policy) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request, policy))) {
    headers.set(name, value);
  }
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const policy = corsPolicy(url.pathname);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (policy === "none") {
        return withCors(json({ ok: false, error: "not found" }, 404), request, policy);
      }
      if (policy === "admin" && (!origin || !adminOriginAllowed(origin))) {
        return withCors(json({ ok: false, error: "origin not allowed" }, 403), request, "none");
      }
      return withCors(new Response(null, { status: 204 }), request, policy);
    }

    // CORS 不是认证，但必须在实际管理请求上同样执行；否则简单请求可绕过预检。
    // 不带 Origin 的后端/curl 调用仍由 Bearer 令牌鉴权，不受浏览器来源限制。
    if (policy === "admin" && origin && !adminOriginAllowed(origin)) {
      return withCors(json({ ok: false, error: "origin not allowed" }, 403), request, "none");
    }

    const response = await routeRequest(request, env, ctx, url);
    return withCors(response, request, policy);
  },
};

async function routeRequest(request, env, ctx, url) {
    if (url.pathname === "/admin/toggle" && request.method === "POST") {
      return handleToggle(request, env);
    }
    if (url.pathname === "/config" && request.method === "GET") {
      return handleConfig(request, env, ctx);
    }
    if (url.pathname === "/track" && (request.method === "GET" || request.method === "POST")) {
      return handleTrack(request, env);
    }
    if (url.pathname === "/visits" && request.method === "GET") {
      return handleVisits(request, env);
    }
    // 日记页的公开记忆墙：有意公开的展示数据（产品决策），不要求登录。
    if (url.pathname === "/memories" && request.method === "GET") {
      return handleMemories(env);
    }
    // 锚点（足迹并入日记后的里程碑内容）：同样有意公开。
    if (url.pathname === "/anchors" && request.method === "GET") {
      return handleAnchors(env);
    }
    if (url.pathname === "/admin/memories" && request.method === "POST") {
      return handleMemoryCreate(request, env);
    }
    if (url.pathname === "/admin/anchors" && request.method === "POST") {
      return handleAnchorCreate(request, env);
    }
    if (url.pathname === "/sensors/latest" && request.method === "GET") {
      return handleSensorsLatest(env);
    }
    if (url.pathname === "/sensors/history" && request.method === "GET") {
      return handleHistoryGet(request, env);
    }
    if (url.pathname === "/admin/sensors-history" && request.method === "POST") {
      return handleHistoryUpdate(request, env);
    }
    if (url.pathname === "/admin/sensors" && request.method === "POST") {
      return handleSensorUpdate(request, env);
    }
    if (url.pathname !== "/chat") {
      return json({ ok: false, error: "not found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method not allowed" }, 405);
    }

    if (!env.CONFIG) {
      return json({ ok: false, error: "公网开关未配置（请绑定 KV: CONFIG）" }, 503);
    }
    if (!(await chatEnabled(env))) {
      return json({ ok: false, error: "AI 对话已由管理员关闭" }, 403);
    }
    if (!configuredSecret(env.AI_API_KEY)) {
      return json({ ok: false, error: "AI_API_KEY 未配置" }, 503);
    }

    const ip = clientIp(request);
    if (await rateLimitExceeded(
      env, "CHAT_RATE_LIMITER", ip, "chat:", RATE.chatMax, RATE.chatTtl
    )) {
      return json({ ok: false, error: "请求过于频繁，请稍后再试" }, 429);
    }

    const parsed = await readJsonBody(request);   // 体长由 readJsonBody 按实际字节把关
    if (parsed.error) return parsed.error;
    const body = parsed.body;

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim() &&
          m.content.length <= RATE.maxMessageLen
      )
      .slice(-20);

    if (!messages.length) {
      return json({ ok: false, error: "messages required" }, 400);
    }

    const baseUrl = (env.AI_BASE_URL || DEFAULTS.AI_BASE_URL).replace(/\/+$/, "");
    const payload = {
      model: env.AI_MODEL || DEFAULTS.AI_MODEL,
      messages: messages,
      stream: false,
    };
    if (env.AI_SYSTEM) {
      payload.messages = [{ role: "system", content: env.AI_SYSTEM }, ...messages];
    }

    let resp;
    try {
      resp = await fetch(baseUrl + "/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(30000),   // 上游挂起不拖长 Worker 计费
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.AI_API_KEY,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ ok: false, error: "无法连接 AI 服务" }, 502);
    }

    if (!resp.ok) {
      const detail = await resp.text();
      return json(
        { ok: false, error: "AI 服务返回错误", detail: detail.slice(0, 300) },
        502
      );
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      return json({ ok: false, error: "AI 服务返回格式异常" }, 502);
    }

    const reply =
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";
    if (!reply) {
      return json({ ok: false, error: "AI 服务返回格式异常" }, 502);
    }
    return json({ ok: true, reply });
}

async function handleTrack(request, env) {
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

async function handleVisits(request, env) {
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

// 建表/迁移记忆化：每个 isolate 每种 DDL 或迁移只执行一次，消除每请求写放大。
// 单一机制统一覆盖两张用法：纯建表（按 SQL 字符串去重）与多步迁移（按固定 key 去重）。
const ddlCache = new Map();
function runOnce(env, key, work) {
  if (!env.DB) return Promise.resolve(false);
  if (!ddlCache.has(key)) {
    ddlCache.set(key, Promise.resolve().then(work).then(() => true).catch((e) => {
      ddlCache.delete(key);
      throw e;
    }));
  }
  return ddlCache.get(key);
}
function runDdlOnce(env, sql) {
  return runOnce(env, sql, () => env.DB.prepare(sql).run());
}

const TABLE_VISITS = `CREATE TABLE IF NOT EXISTS visits(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      page TEXT NOT NULL DEFAULT '/',
      ref TEXT,
      ip TEXT,
      ua TEXT,
      w INTEGER,
      h INTEGER
    )`;
const TABLE_SENSORS = `CREATE TABLE IF NOT EXISTS sensor_latest(
      board TEXT NOT NULL,
      channel TEXT NOT NULL,
      ts INTEGER NOT NULL,
      sensor TEXT NOT NULL,
      ok INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(board, channel)
    )`;
const TABLE_HISTORY = `CREATE TABLE IF NOT EXISTS sensor_history(
      channel TEXT NOT NULL,
      bucket TEXT NOT NULL,
      n INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY(channel, bucket)
    )`;
const TABLE_ANCHORS = `CREATE TABLE IF NOT EXISTS anchors(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        created_ts INTEGER NOT NULL,
        anchor_time TEXT NOT NULL,
        time_precision TEXT NOT NULL DEFAULT 'second',
        title TEXT NOT NULL,
        content TEXT NOT NULL
      )`;

function ensureMemoriesTable(env) {
  return runOnce(env, "memories:migration", () => ensureMemoriesTableOnce(env));
}

/**
 * 结构迁移只随 isolate 冷启动执行一次；数据回填仅在其对应列刚被
 * ALTER 添加时执行；title 合并是一次性迁移（KV 标记），完成后不再全表扫描。
 */
async function ensureMemoriesTableOnce(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      created_ts INTEGER NOT NULL,
      memory_date TEXT NOT NULL,
      perspective TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_time TEXT,
      time_precision TEXT NOT NULL DEFAULT 'second'
    )`
  ).run();
  const columns = await env.DB.prepare("PRAGMA table_info(memories)").all();
  const names = (columns.results || []).map((column) => column.name);
  if (!names.includes("memory_time")) {
    await env.DB.prepare("ALTER TABLE memories ADD COLUMN memory_time TEXT").run();
    await env.DB.prepare(
      `UPDATE memories
       SET memory_time = memory_date || 'T00:00:00+08:00'
       WHERE memory_time IS NULL OR memory_time = ''`
    ).run();
  }
  if (!names.includes("time_precision")) {
    await env.DB.prepare(
      "ALTER TABLE memories ADD COLUMN time_precision TEXT NOT NULL DEFAULT 'second'"
    ).run();
    await env.DB.prepare("UPDATE memories SET time_precision = 'date'").run();
  }
  const titleMerged = env.CONFIG ? await env.CONFIG.get("memories:title-merged") : null;
  if (titleMerged !== "1") {
    await env.DB.prepare(
      `UPDATE memories
       SET content = CASE
             WHEN trim(title) NOT IN ('', '.')
             THEN trim(title) || CASE WHEN trim(content) != '' THEN char(10) || content ELSE '' END
             ELSE content
           END,
           title = ''
       WHERE title IS NOT NULL AND title != ''`
    ).run();
    if (env.CONFIG) await env.CONFIG.put("memories:title-merged", "1");
  }
  return true;
}

function validMemoryDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function handleMemories(env) {
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

async function handleAnchors(env) {
  if (!env.DB) {
    return json({ ok: false, error: "锚点未配置（请绑定 D1，绑定名为 DB）" }, 503);
  }
  await runDdlOnce(env, TABLE_ANCHORS);
  const rows = await env.DB.prepare(
    `SELECT uid, created_ts, anchor_time AS time, time_precision AS precision,
            title, content
     FROM anchors ORDER BY anchor_time DESC, id DESC LIMIT 200`
  ).all();
  return json({ ok: true, rows: rows.results || [] }, 200, {
    "Cache-Control": "no-store",
  });
}

/* 管理写入端点的公共前置：鉴权 -> D1 就绪 -> 读体 -> uid 校验。
   锚点/日记两个写入端点共用，避免同样的四段检查各写一份。 */
async function adminBody(request, env, resourceLabel) {
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

async function handleAnchorCreate(request, env) {
  const pre = await adminBody(request, env, "锚点");
  if (pre.error) return pre.error;
  const body = pre.body;
  const uid = pre.uid;
  const title = String(body.title || "").trim().slice(0, 120);
  const content = String(body.content || "").trim().slice(0, 4000);
  let anchorTime = String(body.time || "").trim();
  let timePrecision = body.precision === "date" ? "date" : "second";
  if (!anchorTime) {
    anchorTime = new Date().toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(anchorTime)) {
    return json({ ok: false, error: "time must include seconds" }, 400);
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(anchorTime)) {
    anchorTime += "+08:00";
  }
  if (!title || !content) {
    return json({ ok: false, error: "title and content required" }, 400);
  }
  const createdDate = new Date(body.created_at || "");
  const createdTs = Number.isNaN(createdDate.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(createdDate.getTime() / 1000);
  await runDdlOnce(env, TABLE_ANCHORS);
  // 本地编辑锚点后会带着同一 uid 重新推送：冲突时更新而非忽略，
  // 与 memories 的 upsert 语义保持一致。
  await env.DB.prepare(
    `INSERT INTO anchors(
       uid, created_ts, anchor_time, time_precision, title, content
     ) VALUES(?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
       anchor_time = excluded.anchor_time,
       time_precision = excluded.time_precision,
       title = excluded.title,
       content = excluded.content`
  )
    .bind(uid, createdTs, anchorTime, timePrecision, title, content)
    .run();
  await clearFails(env, clientIp(request));
  return json({ ok: true, uid });
}

async function handleMemoryCreate(request, env) {
  const pre = await adminBody(request, env, "日记");
  if (pre.error) return pre.error;
  const body = pre.body;
  const uid = pre.uid;
  const legacyDate = String(body.date || "").trim();
  const perspective = String(body.perspective || "").trim();
  const source = String(body.source || "manual").trim();
  const legacyTitle = String(body.title || "").trim();
  let content = String(body.content || "").trim();
  let memoryTime = String(body.time || "").trim();
  let timePrecision = body.precision === "date" ? "date" : "second";
  if (!memoryTime && validMemoryDate(legacyDate)) {
    memoryTime = legacyDate + "T00:00:00+08:00";
    timePrecision = "date";
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(memoryTime)) {
    return json({ ok: false, error: "time must include seconds" }, 400);
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(memoryTime)) {
    memoryTime += "+08:00";
  }
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
  if (legacyTitle && legacyTitle !== ".") {
    content = legacyTitle + (content ? "\n" + content : "");
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
  await clearFails(env, clientIp(request));
  return json({ ok: true, uid });
}

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
  // 防止意外的大对象或原型字段进入公开快照。
  const payload = JSON.stringify(row);
  if (payload.length > 12000) return null;
  return { board, channel, sensor, ts, ok: row.ok, payload };
}

async function handleHistoryUpdate(request, env) {
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
  // 清理 30 小时以外的旧桶（每次同步顺带，防无限增长）
  await env.DB.prepare(
    "DELETE FROM sensor_history WHERE updated_ts < ?"
  ).bind(now - 30 * 3600).run();
  await clearFails(env, clientIp(request));
  return json({ ok: true, updated: rows.length });
}

async function handleHistoryGet(request, env) {
  /* 隐私决策：24 小时室内趋势比最新快照敏感，登录（带管理员令牌）才可见 */
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

async function handleSensorUpdate(request, env) {
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
  // 注意：这里不做跨板名删除——通道名 CH0-CH5 是通用命名，第二块物理板
  // （如 bench 板）接入时各自的最新快照都应保留，写路径绝不互删。
  // 显示侧的单轨保证放在 /sensors/latest 读路径：同通道只取最新快照。
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

async function handleSensorsLatest(env) {
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
  // 读取侧兜底：同通道只保留最新快照，即使历史遗留了多板名数据也不双轨显示。
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

let chatEnabledCache = { t: 0, value: true };
async function chatEnabled(env) {
  if (!env.CONFIG) return false;
  const now = Date.now();
  if (now - chatEnabledCache.t < 10000) {
    return chatEnabledCache.value;
  }
  const value = await env.CONFIG.get("chat_enabled");
  const enabled = value !== "false";
  chatEnabledCache = { t: now, value: enabled };
  return enabled;
}

function normalizeReflections(values) {
  /* 与 backend/server.py 的 normalize_reflections 是跨语言双胞胎：
     改动规则时必须两边同步改。 */
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

async function handleConfig(request, env, ctx) {
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

async function handleToggle(request, env) {
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
    chatEnabledCache = { t: 0, value: enabled };   // 开关变更立即生效
    result.chat_enabled = enabled;
  }
  if (hasReflections) {
    const rows = normalizeReflections(body.reflections);
    await env.CONFIG.put("reflections", JSON.stringify(rows));
    result.reflections = rows;
  }
  if ((await readFails(env, clientIp(request))) > 0) {
    await clearFails(env, clientIp(request));
  }
  await clearConfigCache(request);
  return json(result);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
