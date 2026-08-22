import assert from "node:assert/strict";

const worker = (await import(new URL("../cloudflare/worker.js", import.meta.url))).default;
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
        source_name: sourceName, source_url: sourceUrl,
      });
    } else if (this.sql.includes("DELETE FROM observations")) {
      this.db.observations.delete(this.values[0]);
    } else if (this.sql.includes("INSERT INTO observation_links")) {
      const [uid, createdTs, updatedTs, sourceUid, targetUid, relation] = this.values;
      this.db.links.set(uid, {
        uid, created_ts: createdTs, updated_ts: updatedTs,
        source_uid: sourceUid, target_uid: targetUid, relation,
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
    if (this.sql.includes("FROM observations ORDER BY")) {
      return { results: [...this.db.observations.values()] };
    }
    if (this.sql.includes("FROM observation_links") && this.sql.includes("JOIN observations")) {
      return {
        results: [...this.db.links.values()].filter((link) =>
          this.db.observations.has(link.source_uid) && this.db.observations.has(link.target_uid)),
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

console.log("worker public observations and links test ok");
