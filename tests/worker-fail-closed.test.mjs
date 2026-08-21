import assert from "node:assert/strict";
import fs from "node:fs";

const reflectionsContract = JSON.parse(fs.readFileSync(
  new URL("./contracts/reflections.json", import.meta.url), "utf8"
));
const workerModule = await import(new URL("../cloudflare/worker.js", import.meta.url));
const worker = workerModule.default;
const consoleSource = fs.readFileSync(
  new URL("../docs/assets/console.js", import.meta.url), "utf8"
);
const consoleChatSource = fs.readFileSync(
  new URL("../docs/assets/console-chat.js", import.meta.url), "utf8"
);
const consoleServicesSource = fs.readFileSync(
  new URL("../docs/assets/console-services.js", import.meta.url), "utf8"
);
const consoleAdminSource = fs.readFileSync(
  new URL("../docs/assets/console-admin.js", import.meta.url), "utf8"
);
const consoleHtmlSource = fs.readFileSync(
  new URL("../docs/console.html", import.meta.url), "utf8"
);
const adminCoreSource = fs.readFileSync(
  new URL("../docs/assets/admin-core.js", import.meta.url), "utf8"
);
const ADMIN_TOKEN = "test-admin-token-0123456789abcdef0123456789";

assert.match(consoleSource, /SENSOR_REFRESH_MS\s*=\s*5000/,
  "传感器网页刷新必须保持 5 秒");
assert.match(consoleSource, /CONFIG_REFRESH_MS\s*=\s*60000/,
  "公网配置读取必须降到 60 秒");
assert.match(consoleChatSource,
  /isServerOnline\(\)\s*\?\s*"\/api\/chat"\s*:\s*publicBase\s*\+\s*"\/chat"/,
  "聊天必须在本地后端与 Worker 明确 /chat 路由之间单选");
assert.doesNotMatch(consoleChatSource, /const\s+urls\s*=\s*\["\/api\/chat"/,
  "聊天不得把同一内容依次重试到两个后端");
assert.match(consoleServicesSource, /let\s+protocolName\s*=\s*""/,
  "自定义协议必须等待后端随机名称，不得回退到固定名称");
assert.match(consoleAdminSource, /noopener,noreferrer/,
  "外部快捷入口必须隔离 window.opener 与来源信息");
assert.match(adminCoreSource, /response\.status\s*===\s*401\s*&&\s*token/,
  "管理请求遇到 401 必须清除会话令牌");

let previousScriptIndex = -1;
[
  "console-visits.js",
  "console-overview.js",
  "console-sensors.js",
  "console-chat.js",
  "console-admin.js",
  "console-services.js",
  "console.js",
].forEach(function (name) {
  const index = consoleHtmlSource.indexOf(name);
  assert.ok(index > previousScriptIndex,
    name + " 必须存在并按依赖顺序加载在 console.js 之前");
  previousScriptIndex = index;
});

const adminRequests = [
  new Request("https://api.flitfancy.com/visits"),
  new Request("https://api.flitfancy.com/admin/toggle", {
    method: "POST", body: JSON.stringify({ chat_enabled: false }),
    headers: { "Content-Type": "application/json" },
  }),
  new Request("https://api.flitfancy.com/admin/memories", {
    method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
  }),
  new Request("https://api.flitfancy.com/admin/anchors", {
    method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
  }),
  new Request("https://api.flitfancy.com/admin/sensors", {
    method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
  }),
  new Request("https://api.flitfancy.com/admin/sensors-history", {
    method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
  }),
  new Request("https://api.flitfancy.com/sensors/history?channel=CH0&hours=24"),
];

for (const request of adminRequests) {
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 503,
    `${new URL(request.url).pathname} 缺少 ADMIN_TOKEN 时必须返回 503`);
}

const config = { get: async () => null, put: async () => undefined };
const chatRequest = new Request("https://api.flitfancy.com/chat", {
  method: "POST",
  body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  headers: { "Content-Type": "application/json" },
});
let upstreamCalled = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  upstreamCalled = true;
  return new Response("should not be called", { status: 500 });
};
try {
  const response = await worker.fetch(chatRequest, { CONFIG: config });
  assert.equal(response.status, 503, "缺少 AI_API_KEY 时必须返回 503");
  assert.equal(upstreamCalled, false, "缺少 AI_API_KEY 时不得请求上游 AI");
} finally {
  globalThis.fetch = originalFetch;
}

const originalCaches = globalThis.caches;
const cachedResponses = new Map();
let cacheDeletes = 0;
globalThis.caches = {
  default: {
    async match(request) {
      const response = cachedResponses.get(request.url);
      return response ? response.clone() : undefined;
    },
    async put(request, response) {
      cachedResponses.set(request.url, response.clone());
    },
    async delete(request) {
      cacheDeletes += 1;
      return cachedResponses.delete(request.url);
    },
  },
};

try {
  let configReads = 0;
  const cachedConfig = {
    async get(key) {
      configReads += 1;
      if (key === "chat_enabled") return "true";
      if (key === "reflections") return JSON.stringify(["愿此行，终抵群星！", "萤火飞掠"]);
      return null;
    },
    async put() {},
  };
  const firstConfigResponse = await worker.fetch(
    new Request("https://api.flitfancy.com/config"), { CONFIG: cachedConfig }
  );
  const secondConfigResponse = await worker.fetch(
    new Request("https://api.flitfancy.com/config"), { CONFIG: cachedConfig }
  );
  assert.equal(firstConfigResponse.status, 200);
  assert.equal(secondConfigResponse.status, 200);
  const firstConfig = await firstConfigResponse.json();
  assert.deepEqual(firstConfig.reflections, ["愿此行，终抵群星！", "萤火飞掠"]);
  assert.equal(firstConfigResponse.headers.get("Access-Control-Allow-Origin"), "*",
    "公开接口必须允许跨域读取");
  assert.equal(configReads, 1, "chat_enabled 有 10 秒内存缓存；重复 /config 必须命中边缘缓存，仅首次读 reflections");
  assert.match(firstConfigResponse.headers.get("Cache-Control") || "", /max-age=30/);

  const removedVerify = await worker.fetch(
    new Request("https://api.flitfancy.com/admin/verify", {
      method: "POST",
      body: JSON.stringify({ password: ADMIN_TOKEN }),
      headers: { "Content-Type": "application/json" },
    }),
    { ADMIN_TOKEN, CONFIG: cachedConfig }
  );
  assert.equal(removedVerify.status, 404, "废弃的明文令牌验证端点必须不存在");

  const unknownPost = await worker.fetch(
    new Request("https://api.flitfancy.com/", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      headers: { "Content-Type": "application/json" },
    }),
    { CONFIG: cachedConfig, AI_API_KEY: "not-used" }
  );
  assert.equal(unknownPost.status, 404, "未匹配 POST 不得再隐式进入聊天路由");

  const legacyMemoryResponse = await worker.fetch(
    new Request("https://api.flitfancy.com/admin/memories", {
      method: "POST",
      body: JSON.stringify({
        uid: "legacy-memory-test-0001",
        date: "2026-08-11",
        title: "旧标题",
        perspective: "me",
        content: "旧正文",
      }),
      headers: {
        "Authorization": "Bearer " + ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }),
    { ADMIN_TOKEN, CONFIG: cachedConfig, DB: {} }
  );
  assert.equal(legacyMemoryResponse.status, 400,
    "Worker 必须明确拒绝已停用的 date/title 日记请求");
  assert.match((await legacyMemoryResponse.json()).error, /no longer supported/);

  const shortTokenResponse = await worker.fetch(
    new Request("https://api.flitfancy.com/admin/toggle", {
      method: "POST", body: JSON.stringify({ chat_enabled: false }),
      headers: { "Content-Type": "application/json", "Authorization": "Bearer short" },
    }),
    { ADMIN_TOKEN: "short", CONFIG: cachedConfig }
  );
  assert.equal(shortTokenResponse.status, 503, "少于 32 字符的 ADMIN_TOKEN 必须拒绝启用");

  let deniedWrites = 0;
  const deniedOriginResponse = await worker.fetch(
    new Request("https://api.flitfancy.com/admin/toggle", {
      method: "POST", body: JSON.stringify({ chat_enabled: false }),
      headers: {
        "Authorization": "Bearer " + ADMIN_TOKEN,
        "Content-Type": "application/json",
        "Origin": "https://evil.example",
      },
    }),
    { ADMIN_TOKEN, CONFIG: { async get() { return null; }, async put() { deniedWrites += 1; } } }
  );
  assert.equal(deniedOriginResponse.status, 403, "恶意来源的实际管理请求必须被拒绝");
  assert.equal(deniedOriginResponse.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(deniedWrites, 0, "来源校验必须发生在鉴权与写入之前");

  const toggleWrites = [];
  const toggleConfig = {
    async get() { return null; },
    async put(key, value) { toggleWrites.push([key, value]); },
  };
  const toggleResponse = await worker.fetch(
    new Request("https://api.flitfancy.com/admin/toggle", {
      method: "POST",
      body: JSON.stringify({ chat_enabled: false }),
      headers: {
        "Authorization": "Bearer " + ADMIN_TOKEN,
        "Content-Type": "application/json",
        "Origin": "https://flitfancy.com",
      },
    }),
    { ADMIN_TOKEN, CONFIG: toggleConfig }
  );
  assert.equal(toggleResponse.status, 200);
  assert.equal(toggleResponse.headers.get("Access-Control-Allow-Origin"), "https://flitfancy.com");
  assert.deepEqual(toggleWrites, [["chat_enabled", "false"]]);
  assert.equal(cacheDeletes, 1, "切换公网总闸后必须清除当前边缘缓存");

  toggleWrites.length = 0;
  const reflectionsResponse = await worker.fetch(
    new Request("https://api.flitfancy.com/admin/toggle", {
      method: "POST",
      body: JSON.stringify({ reflections: reflectionsContract.input }),
      headers: {
        "Authorization": "Bearer " + ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }),
    { ADMIN_TOKEN, CONFIG: toggleConfig }
  );
  assert.equal(reflectionsResponse.status, 200);
  assert.deepEqual(toggleWrites, [["reflections", JSON.stringify(reflectionsContract.expected)]]);
  assert.equal(cacheDeletes, 2, "更新随笔后必须清除 /config 边缘缓存");
  const reflectionsResult = await reflectionsResponse.json();
  assert.deepEqual(reflectionsResult.reflections, reflectionsContract.expected);
  assert.equal(Object.hasOwn(reflectionsResult, "chat_enabled"), false,
    "只更新随笔时不得误关公网 AI 总闸");
} finally {
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
}

// CORS 必须区分公开与管理路由，并覆盖实际请求而不只覆盖预检。
{
  const publicPreflight = await worker.fetch(new Request("https://api.flitfancy.com/chat", {
    method: "OPTIONS", headers: { "Origin": "https://reader.example" },
  }), {});
  assert.equal(publicPreflight.status, 204);
  assert.equal(publicPreflight.headers.get("Access-Control-Allow-Origin"), "*");

  const allowedAdminPreflight = await worker.fetch(new Request(
    "https://api.flitfancy.com/admin/toggle", {
      method: "OPTIONS", headers: { "Origin": "http://localhost:2671" },
    }
  ), {});
  assert.equal(allowedAdminPreflight.status, 204);
  assert.equal(allowedAdminPreflight.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:2671");

  const deniedAdminPreflight = await worker.fetch(new Request(
    "https://api.flitfancy.com/admin/toggle", {
      method: "OPTIONS", headers: { "Origin": "https://evil.example" },
    }
  ), {});
  assert.equal(deniedAdminPreflight.status, 403);
  assert.equal(deniedAdminPreflight.headers.get("Access-Control-Allow-Origin"), null);
}

// 生产环境优先使用原生 Rate Limiting 绑定；失败时才退回 KV。
{
  let limiterCalls = 0;
  const response = await worker.fetch(new Request("https://api.flitfancy.com/chat", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
  }), {
    AI_API_KEY: "not-used",
    CONFIG: { async get(key) { return key === "chat_enabled" ? "true" : null; } },
    CHAT_RATE_LIMITER: {
      async limit(options) {
        limiterCalls += 1;
        assert.equal(options.key, "192.0.2.10");
        return { success: false };
      },
    },
  });
  assert.equal(response.status, 429);
  assert.equal(limiterCalls, 1);
}

// /track 限流：每 IP 每分钟最多 120 次；DDL 记忆化：125 次请求只建表一次。
{
  let prepareCalls = 0;
  const trackEnv = {
    DB: {
      prepare(sql) {
        if (String(sql).includes("CREATE TABLE")) prepareCalls += 1;
        return {
          async run() {},
          async all() { return { results: [] }; },
          bind() { return this; },
        };
      },
    },
    CONFIG: {
      store: new Map(),
      async get(key) { return this.store.get(key) || null; },
      async put(key, value) { this.store.set(key, String(value)); },
    },
  };
  const statuses = [];
  for (let i = 0; i < 125; i++) {
    const response = await worker.fetch(
      new Request("https://api.flitfancy.com/track?p=/", { method: "GET" }),
      trackEnv
    );
    statuses.push(response.status);
  }
  assert.ok(statuses.slice(0, 120).every((status) => status === 200),
    "/track 限流窗口内必须 200");
  assert.ok(statuses.slice(120).every((status) => status === 429),
    "/track 超过 120 次/分钟后必须 429");
  assert.equal(prepareCalls, 1,
    "ensureVisitsTable 必须按 isolate 记忆化，125 次请求只建表一次");
}

// admin 端点爆破锁定：错误 Authorization 连续 5 次后必须 429。
{
  const failStore = new Map();
  const lockConfig = {
    async get(key) { return failStore.get(key) || null; },
    async put(key, value) { failStore.set(key, String(value)); },
  };
  const badAuth = new Request("https://api.flitfancy.com/admin/sensors", {
    method: "POST", body: "{}",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer wrong",
      "CF-Connecting-IP": "198.51.100.9",
    },
  });
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const response = await worker.fetch(badAuth, {
      ADMIN_TOKEN,
      CONFIG: lockConfig,
      DB: undefined,
    });
    lastStatus = response.status;
    if (i < 5) assert.equal(lastStatus, 401, "前 5 次错误令牌必须 401 并计数");
  }
  assert.equal(lastStatus, 429, "第 6 次必须被锁定返回 429");
  const locked = await worker.fetch(new Request("https://api.flitfancy.com/admin/sensors", {
    method: "POST", body: "{}",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + ADMIN_TOKEN,
      "CF-Connecting-IP": "198.51.100.9",
    },
  }), { ADMIN_TOKEN, CONFIG: lockConfig, DB: undefined });
  assert.equal(locked.status, 429, "锁定期间即使令牌正确也必须 429");
}

// 鉴权通过后必须继续执行（防 async adminAuthError 未 await 导致成功路径短路）
{
  const authedHistory = await worker.fetch(
    new Request("https://api.flitfancy.com/sensors/history?channel=CH0&hours=24", {
      headers: {
        "Authorization": "Bearer " + ADMIN_TOKEN,
        "CF-Connecting-IP": "203.0.113.50",
      },
    }),
    { ADMIN_TOKEN, CONFIG: { async get() { return null; }, async put() {} }, DB: undefined }
  );
  assert.equal(authedHistory.status, 503,
    "令牌正确时鉴权必须放行继续执行，缺 D1 应返回 503 而非空响应");
}

console.log("worker secrets fail-closed test ok");
