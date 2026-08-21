/**
 * 云萤 · flitfancy —— 公网 API Worker
 *
 * 部署：仓库 push 后由 Workers Builds 自动构建部署。
 * 必需加密变量：AI_API_KEY、ADMIN_TOKEN；缺失时相关接口返回 503。
 * 必需绑定：KV（CONFIG）、D1（DB）与三个 Rate Limiting 绑定。
 */

import { handleChat } from "./worker-chat.js";
import { handleConfig, handleToggle } from "./worker-config.js";
import {
  handleAnchorCreate,
  handleAnchors,
  handleMemories,
  handleMemoryCreate,
} from "./worker-content.js";
import {
  adminOriginAllowed,
  corsPolicy,
  json,
  withCors,
} from "./worker-core.js";
import {
  handleHistoryGet,
  handleHistoryUpdate,
  handleSensorsLatest,
  handleSensorUpdate,
} from "./worker-sensors.js";
import { handleTrack, handleVisits } from "./worker-visits.js";

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

    // CORS 不是认证，但实际管理请求也必须做来源限制；无 Origin 的服务端调用仍靠令牌鉴权。
    if (policy === "admin" && origin && !adminOriginAllowed(origin)) {
      return withCors(json({ ok: false, error: "origin not allowed" }, 403), request, "none");
    }

    const response = await routeRequest(request, env, ctx, url);
    return withCors(response, request, policy);
  },
};

async function routeRequest(request, env, ctx, url) {
  const { pathname } = url;

  if (pathname === "/admin/toggle" && request.method === "POST") {
    return handleToggle(request, env);
  }
  if (pathname === "/config" && request.method === "GET") {
    return handleConfig(request, env, ctx);
  }
  if (pathname === "/track" && (request.method === "GET" || request.method === "POST")) {
    return handleTrack(request, env);
  }
  if (pathname === "/visits" && request.method === "GET") {
    return handleVisits(request, env);
  }
  if (pathname === "/memories" && request.method === "GET") {
    return handleMemories(env);
  }
  if (pathname === "/anchors" && request.method === "GET") {
    return handleAnchors(env);
  }
  if (pathname === "/admin/memories" && request.method === "POST") {
    return handleMemoryCreate(request, env);
  }
  if (pathname === "/admin/anchors" && request.method === "POST") {
    return handleAnchorCreate(request, env);
  }
  if (pathname === "/sensors/latest" && request.method === "GET") {
    return handleSensorsLatest(env);
  }
  if (pathname === "/sensors/history" && request.method === "GET") {
    return handleHistoryGet(request, env);
  }
  if (pathname === "/admin/sensors-history" && request.method === "POST") {
    return handleHistoryUpdate(request, env);
  }
  if (pathname === "/admin/sensors" && request.method === "POST") {
    return handleSensorUpdate(request, env);
  }
  if (pathname !== "/chat") {
    return json({ ok: false, error: "not found" }, 404);
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  return handleChat(request, env);
}
