/**
 * 云萤 · flitfancy —— 公网 AI 对话转发 Worker
 *
 * 作用：给静态网站（GitHub Pages）提供一个调用 AI 的公开接口，
 * API 密钥存在 Cloudflare 的加密变量里，不会出现在网页代码中。
 *
 * 部署：新建 Worker → 粘贴本文件 → 设置加密变量 AI_API_KEY → 部署。
 * 可选变量（都有默认值）：
 *   AI_BASE_URL  AI 服务地址（默认 DeepSeek）
 *   AI_MODEL     模型名（默认 deepseek-chat）
 *   AI_SYSTEM    人设/背景知识（留空则不附加）
 */

const DEFAULTS = {
  AI_BASE_URL: "https://api.deepseek.com",
  AI_MODEL: "deepseek-chat",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: "bad json" }, 400);
    }

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim()
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
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (env.AI_API_KEY || ""),
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
  },
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors(),
    },
  });
}
