import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const worker = (await import(new URL("../cloudflare/worker.js", import.meta.url))).default;
const OBSERVATIONS_CONTRACT = JSON.parse(
  fs.readFileSync(new URL("./contracts/observations.json", import.meta.url), "utf8")
);
const ADMIN_TEST_CREDENTIAL = ["observations", "admin", "credential", "0123456789abcdef"].join("-");

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = String(sql);
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    if (this.sql.includes("INSERT INTO observations")) {
      const [uid, createdTs, updatedTs, title, category, tagsJson, summary,
        content, discoveredAt, sourceName, sourceUrl] = this.values;
      this.db.observations.set(uid, {
        uid, created_ts: createdTs, updated_ts: updatedTs, title, category,
        tags_json: tagsJson, summary, content, discovered_at: discoveredAt,
        source_name: sourceName, source_url: sourceUrl, published: 1,
      });
    } else if (this.sql.includes("DELETE FROM observations")) {
      this.db.observations.delete(this.values[0]);
    } else if (this.sql.includes("INSERT INTO observation_links")) {
      const [uid, createdTs, updatedTs, sourceUid, targetUid, relation, strength, updateStrength] = this.values;
      const existing = this.db.links.get(uid);
      this.db.links.set(uid, {
        uid, created_ts: createdTs, updated_ts: updatedTs,
        source_uid: sourceUid, target_uid: targetUid, relation,
        strength: existing ? updateStrength ?? existing.strength : strength,
      });
    } else if (this.sql.includes("DELETE FROM observation_links WHERE uid")) {
      this.db.links.delete(this.values[0]);
    } else if (this.sql.includes("DELETE FROM observation_links")) {
      const starUid = this.values[0];
      for (const [uid, link] of this.db.links) {
        if (link.source_uid === starUid || link.target_uid === starUid) this.db.links.delete(uid);
      }
    }
    return { success: true };
  }

  async all() {
    if (this.sql.includes("FROM observations ")) {
      // 与真实 WHERE published = 1 行为一致：未打公开标志的行不返回。
      return { results: [...this.db.observations.values()].filter((row) => row.published === 1) };
    }
    if (this.sql.includes("FROM observation_links") && this.sql.includes("JOIN observations")) {
      const requiresPublishedEndpoints =
        this.sql.includes("source.published = 1") &&
        this.sql.includes("target.published = 1");
      return {
        results: [...this.db.links.values()].filter((link) =>
          this.db.observations.has(link.source_uid) &&
          this.db.observations.has(link.target_uid) &&
          (!requiresPublishedEndpoints || (
            this.db.observations.get(link.source_uid).published === 1 &&
            this.db.observations.get(link.target_uid).published === 1
          ))),
      };
    }
    return { results: [] };
  }
}

class FakeDB {
  constructor() {
    this.observations = new Map();
    this.links = new Map();
  }
  prepare(sql) { return new FakeStatement(this, sql); }
}

const env = {
  ADMIN_TOKEN: ADMIN_TEST_CREDENTIAL,
  DB: new FakeDB(),
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
assert.equal(env.DB.links.get(linkUid).strength, "strong", "旧客户端省略强度时保留已有值");
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
  const sqlEnv = { ...env, DB: { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let params = [];
    return { bind(...values) { params = values; return this; },
      async run() { statement.run(...params); return { success: true }; },
      async all() { return { results: statement.all(...params) }; } };
  } } };
  await ensureObservationLinksTable(sqlEnv);
  await ensureObservationLinksTable(sqlEnv);
  assert.equal(sqlite.prepare("SELECT strength FROM observation_links WHERE uid='legacy-link'").get().strength, "medium");
  const sqlPost = body => worker.fetch(new Request("https://api.flitfancy.com/admin/observation-links", {
    method: "POST", headers, body: JSON.stringify(body),
  }), sqlEnv);
  for (const strength of ["weak", "medium", "strong"]) {
    assert.equal((await sqlPost({ ...linkPayload, strength })).status, 200);
    assert.equal(sqlite.prepare("SELECT strength FROM observation_links WHERE uid=?").get(linkUid).strength, strength);
  }
  assert.equal((await sqlPost(linkPayload)).status, 200);
  assert.equal(sqlite.prepare("SELECT strength FROM observation_links WHERE uid=?").get(linkUid).strength, "strong");
} finally { sqlite.close(); }

// 纵深防御：即使清理事务异常、留下指向未公开星球的孤立弦，公网也不能泄露端点 UID。
const hiddenEndpoint = env.DB.observations.get("observation-star-beta-0002");
hiddenEndpoint.published = 0;
publicData = await (await worker.fetch(
  new Request("https://api.flitfancy.com/observations"), env
)).json();
assert.deepEqual(publicData.links, [],
  "任一端点未公开时，残留弦也不得出现在公开接口里");
hiddenEndpoint.published = 1;

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
const remainingRow = [...env.DB.observations.values()][0];
remainingRow.published = 0;
publicData = await (await worker.fetch(
  new Request("https://api.flitfancy.com/observations"), env
)).json();
assert.equal(publicData.rows.length, 0,
  "published=0 的行绝不能出现在公开接口里");
remainingRow.published = 1;
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
