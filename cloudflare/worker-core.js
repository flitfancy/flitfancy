const RATE = {
  failTtl: 600,
  failMax: 5,
  chatTtl: 60,
  chatMax: 15,
  trackTtl: 60,
  trackMax: 120,
  maxMessageLen: 4000,
};

const MIN_ADMIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 64 * 1024;

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

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export function configuredSecret(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function configuredAdminSecret(value) {
  const token = configuredSecret(value);
  return token.length >= MIN_ADMIN_TOKEN_LENGTH ? token : "";
}

export async function rateLimitExceeded(env, binding, key, fallbackKey, max, ttl) {
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

export async function readFails(env, ip) {
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

export async function clearFails(env, ip) {
  if (env.CONFIG) {
    await env.CONFIG.put("fail:" + ip, "0", { expirationTtl: RATE.failTtl });
  }
}

/**
 * 统一管理员鉴权（带失败计数与锁定，策略与本地后端一致）：
 * ADMIN_TOKEN 未配置 → 503；失败 ≥ failMax → 429；令牌不符 → 计数并 401。
 * 通过返回 null，否则返回应直接回给客户端的 Response。
 */
export async function adminAuthError(request, env) {
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

export async function readJsonBody(request) {
  // 不信任 Content-Length（缺失/伪造/负数都能绕过声明值校验）。
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return { error: json({ ok: false, error: "请求体过大" }, 413) };
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(buf));
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { error: json({ ok: false, error: "bad json" }, 400) };
    }
    return { body };
  } catch (e) {
    return { error: json({ ok: false, error: "bad json" }, 400) };
  }
}

export function corsPolicy(pathname) {
  if (PUBLIC_CORS_PATHS.has(pathname)) return "public";
  if (ADMIN_CORS_PATHS.has(pathname)) return "admin";
  return "none";
}

export function adminOriginAllowed(origin) {
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

export function withCors(response, request, policy) {
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

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export { RATE };
