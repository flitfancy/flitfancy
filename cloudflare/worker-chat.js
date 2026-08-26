import {
  RATE,
  clientIp,
  configuredSecret,
  json,
  rateLimitExceeded,
  readJsonBody,
} from "./worker-core.js";
import { chatEnabled } from "./worker-config.js";

const DEFAULTS = {
  AI_BASE_URL: "https://api.deepseek.com",
  AI_MODEL: "deepseek-chat",
};

export async function handleChat(request, env) {
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
  const limited = await rateLimitExceeded(env, "CHAT_RATE_LIMITER", ip);
  if (limited === null) {
    return json({ ok: false, error: "AI 限流服务暂不可用" }, 503);
  }
  if (limited) {
    return json({ ok: false, error: "请求过于频繁，请稍后再试" }, 429);
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim() &&
        message.content.length <= RATE.maxMessageLen
    )
    .slice(-20);

  if (!messages.length) {
    return json({ ok: false, error: "messages required" }, 400);
  }

  const baseUrl = (env.AI_BASE_URL || DEFAULTS.AI_BASE_URL).replace(/\/+$/, "");
  const payload = {
    model: env.AI_MODEL || DEFAULTS.AI_MODEL,
    messages,
    stream: false,
  };
  if (env.AI_SYSTEM) {
    payload.messages = [{ role: "system", content: env.AI_SYSTEM }, ...messages];
  }

  let response;
  try {
    response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.AI_API_KEY,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ ok: false, error: "无法连接 AI 服务" }, 502);
  }

  if (!response.ok) {
    const detail = await response.text();
    return json(
      { ok: false, error: "AI 服务返回错误", detail: detail.slice(0, 300) },
      502
    );
  }

  let data;
  try {
    data = await response.json();
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
