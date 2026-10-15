import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./worker-sqlite-d1.mjs";

const worker = (await import(new URL("../cloudflare/worker.js", import.meta.url))).default;
const OBSERVATIONS_CONTRACT = JSON.parse(
  fs.readFileSync(new URL("./contracts/observations.json", import.meta.url), "utf8")
);
const ADMIN_TEST_CREDENTIAL = ["observations", "admin", "credential", "0123456789abcdef"].join("-");

const env = {
  ADMIN_TOKEN: ADMIN_TEST_CREDENTIAL,
  DB: new SqliteD1(),
  CONFIG: { async get() { return null; }, async put() {} },
};
const headers = {
  Authorization: "Bearer " + ADMIN_TEST_CREDENTIAL,
  "Content-Type": "application/json",
  "CF-Connecting-IP": "203.0.113.88",
};
const post = (path, body) => worker.fetch(new Request("https://api.flitfancy.com" + path, {
  method: "POST", headers, body: JSON.stringify(body),
}), env);

for (const [uid, title, category] of [
  ["observation-star-alpha-001", "脉冲星的钟", "宇宙与自然"],
  ["observation-star-beta-0002", "古老的齿轮", "历史与文明"],
]) {
  const response = await post("/admin/observations", {
    uid,
    published: true,
    created_at: "2026-08-22T10:00:00+08:00",
    updated_at: "2026-08-22T10:30:00+08:00",
    title,
    category,
    tags: ["时间", "发现"],
    summary: "一颗用于测试公开契约的星球。",
    content: "完整内容。",
    discovered_at: "2026-08-22",
    source_name: "示例来源",
    source_url: "https://example.com/source",
  });
  assert.equal(response.status, 200);
}

const linkUid = "observation-link-alpha-0001";
const linkResponse = await post("/admin/observation-links", {
  uid: linkUid,
  published: true,
  created_at: "2026-08-22T11:00:00+08:00",
  updated_at: "2026-08-22T11:00:00+08:00",
  source_uid: "observation-star-alpha-001",
  target_uid: "observation-star-beta-0002",
  relation: "类比",
});
assert.equal(linkResponse.status, 200);

let publicData = await (await worker.fetch(
  new Request("https://api.flitfancy.com/observations"), env
)).json();
assert.equal(publicData.rows.length, 2);
assert.deepEqual(publicData.rows[0].tags, ["时间", "发现"]);
assert.equal(publicData.links[0].relation, "类比");
assert.equal(publicData.links[0].strength, "medium");

const linkPayload = { uid: linkUid, published: true,
  source_uid: "observation-star-alpha-001", target_uid: "observation-star-beta-0002", relation: "类比" };
for (const strength of ["weak", "medium", "strong"]) {
  const result = await post("/admin/observation-links", { ...linkPayload, strength });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).strength, strength, "同步回执确认新字段");
}
await post("/admin/observation-links", linkPayload);
assert.equal(env.DB.sqlite.prepare("SELECT strength FROM observation_links WHERE uid=?").get(linkUid).strength, "strong", "旧客户端省略强度时保留已有值");
for (const strength of ["bright", "", null, 1]) {
  assert.equal((await post("/admin/observation-links", { ...linkPayload, strength })).status, 400);
}

// 用真实 SQLite 验证 D1 的增量迁移和 upsert 参数，保留旧弦和省略字段的兼容行为。
const sqlite = new DatabaseSync(":memory:");
try {
  const { ensureObservationLinksTable } = await import("../cloudflare/worker-storage.js?strength-migration-test");
  sqlite.exec(`CREATE TABLE observation_links (
    uid TEXT PRIMARY KEY, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
    source_uid TEXT NOT NULL, target_uid TEXT NOT NULL, relation TEXT NOT NULL);
    INSERT INTO observation_links VALUES ('legacy-link',1,1,'a','b','延伸')`);
  const sqlEnv = { ...env, DB: new SqliteD1(sqlite) };
  await ensureObservationLinksTable(sqlEnv);
  await ensureObservationLinksTable(sqlEnv);
  assert.equal(sqlite.prepare("SELECT strength FROM observation_links WHERE uid='legacy-link'").get().strength, "medium");
  const sqlPost = body => worker.fetch(new Request("https://api.flitfancy.com/admin/observation-links", {
    method: "POST", headers, body: JSON.stringify(body),
  }), sqlEnv);
  for (const uid of [linkPayload.source_uid, linkPayload.target_uid]) {
    const observation = env.DB.sqlite.prepare("SELECT * FROM observations WHERE uid=?").get(uid);
    const response = await worker.fetch(new Request("https://api.flitfancy.com/admin/observations", {
      method: "POST", headers, body: JSON.stringify({ ...observation, published: true,
        tags: JSON.parse(observation.tags_json) }),
    }), sqlEnv);
    assert.equal(response.status, 200);
  }
  for (const strength of ["weak", "medium", "strong"]) {
    assert.equal((await sqlPost({ ...linkPayload, strength })).status, 200);
    assert.equal(sqlite.prepare("SELECT strength FROM observation_links WHERE uid=?").get(linkUid).strength, strength);
  }
  assert.equal((await sqlPost(linkPayload)).status, 200);
  assert.equal(sqlite.prepare("SELECT strength FROM observation_links WHERE uid=?").get(linkUid).strength, "strong");
} finally { sqlite.close(); }

// 纵深防御：即使清理事务异常、留下指向未公开星球的孤立弦，公网也不能泄露端点 UID。
const hiddenEndpoint = "observation-star-beta-0002";
env.DB.sqlite.prepare("UPDATE observations SET published=0 WHERE uid=?").run(hiddenEndpoint);
publicData = await (await worker.fetch(
  new Request("https://api.flitfancy.com/observations"), env
)).json();
assert.deepEqual(publicData.links, [],
  "任一端点未公开时，残留弦也不得出现在公开接口里");
env.DB.sqlite.prepare("UPDATE observations SET published=1 WHERE uid=?").run(hiddenEndpoint);

const invalidSource = await post("/admin/observations", {
  uid: "observation-star-gamma-003",
  published: true,
  title: "危险来源",
  category: "技术与造物",
  tags: [],
  summary: "来源协议不合法。",
  content: "测试。",
  discovered_at: "2026-02-30",
  source_name: "错误",
  source_url: "javascript:alert(1)",
});
assert.equal(invalidSource.status, 400, "Worker 必须再次校验日期和来源协议");

const unpublish = await post("/admin/observations", {
  uid: "observation-star-alpha-001", published: false,
});
assert.equal(unpublish.status, 200);
publicData = await (await worker.fetch(
  new Request("https://api.flitfancy.com/observations"), env
)).json();
assert.equal(publicData.rows.length, 1);
assert.deepEqual(publicData.links, [], "撤下星球必须同时撤下关联弦");

// 纵深防御契约：公开查询必须按 published 标志过滤，即使行因任何原因残留。
const remainingRow = env.DB.sqlite.prepare("SELECT uid FROM observations LIMIT 1").get();
env.DB.sqlite.prepare("UPDATE observations SET published=0 WHERE uid=?").run(remainingRow.uid);
publicData = await (await worker.fetch(
  new Request("https://api.flitfancy.com/observations"), env
)).json();
assert.equal(publicData.rows.length, 0,
  "published=0 的行绝不能出现在公开接口里");
env.DB.sqlite.prepare("UPDATE observations SET published=1 WHERE uid=?").run(remainingRow.uid);
publicData = await (await worker.fetch(
  new Request("https://api.flitfancy.com/observations"), env
)).json();
assert.equal(publicData.rows.length, 1);

// 与本地后端共用同一份契约：accept/reject 判定必须逐条一致。
for (const [index, testCase] of OBSERVATIONS_CONTRACT.cases.entries()) {
  const response = await post("/admin/observations", {
    uid: "observation-contract-" + String(index).padStart(4, "0"),
    published: true,
    created_at: "2026-08-22T12:00:00+08:00",
    updated_at: "2026-08-22T12:00:00+08:00",
    ...testCase.payload,
  });
  assert.equal(response.status, testCase.valid ? 200 : 400,
    `契约用例 ${testCase.name} 判定与本地后端不一致`);
}

console.log("worker public observations and links test ok");
