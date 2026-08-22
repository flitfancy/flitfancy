import assert from "node:assert/strict";

const worker = (await import(new URL("../cloudflare/worker.js", import.meta.url))).default;
const ADMIN_TOKEN = "taxonomy-admin-token-0123456789abcdef012345";

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
    const sql = this.sql;
    if (sql.includes("ADD COLUMN horizon")) this.db.anchorColumns.push("horizon");
    if (sql.includes("ADD COLUMN project")) this.db.anchorColumns.push("project");
    if (sql.includes("INSERT INTO anchors")) {
      const [uid, createdTs, time, precision, horizon, project, title, content] = this.values;
      this.db.anchors.set(uid, {
        uid, created_ts: createdTs, time, precision, horizon, project, title, content,
      });
    }
    if (sql.includes("INSERT INTO essays")) {
      const [uid, createdTs, updatedTs, displayOrder, title, content] = this.values;
      this.db.essays.set(uid, {
        uid, created_ts: createdTs, updated_ts: updatedTs,
        display_order: displayOrder, title, content,
      });
    }
    if (sql.includes("DELETE FROM essays")) this.db.essays.delete(this.values[0]);
    return { success: true };
  }

  async all() {
    if (this.sql.includes("PRAGMA table_info(anchors)")) {
      return { results: this.db.anchorColumns.map((name) => ({ name })) };
    }
    if (this.sql.includes("FROM anchors ORDER BY")) {
      return { results: [...this.db.anchors.values()] };
    }
    if (this.sql.includes("FROM essays ORDER BY")) {
      return {
        results: [...this.db.essays.values()].sort((a, b) =>
          a.display_order - b.display_order || b.updated_ts - a.updated_ts),
      };
    }
    return { results: [] };
  }
}

class FakeDB {
  constructor() {
    this.anchorColumns = [
      "id", "uid", "created_ts", "anchor_time", "time_precision", "title", "content",
    ];
    this.anchors = new Map();
    this.essays = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

const config = {
  async get() { return null; },
  async put() {},
};
const db = new FakeDB();
const env = { ADMIN_TOKEN, CONFIG: config, DB: db };
const adminHeaders = {
  "Authorization": "Bearer " + ADMIN_TOKEN,
  "Content-Type": "application/json",
  "CF-Connecting-IP": "203.0.113.72",
};

const anchorResponse = await worker.fetch(new Request(
  "https://api.flitfancy.com/admin/anchors", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      uid: "taxonomy-anchor-0001",
      created_at: "2026-08-22T10:00:00+08:00",
      time: "2026-08-22T10:00:00+08:00",
      precision: "second",
      horizon: "future",
      project: "skywork",
      title: "下一块感知板",
      content: "把展望也放进锚点。",
    }),
  }
), env);
assert.equal(anchorResponse.status, 200);
assert.ok(db.anchorColumns.includes("horizon") && db.anchorColumns.includes("project"),
  "旧 D1 anchors 表必须原地补齐分类列");
const anchors = await (await worker.fetch(
  new Request("https://api.flitfancy.com/anchors"), env
)).json();
assert.equal(anchors.rows[0].horizon, "future");
assert.equal(anchors.rows[0].project, "skywork");

const essayBody = {
  uid: "taxonomy-essay-0001",
  published: true,
  created_at: "2026-08-22T10:00:00+08:00",
  updated_at: "2026-08-22T10:30:00+08:00",
  display_order: 20,
  title: "公开短文",
  content: "只在公开后进入 D1。",
};
const publishResponse = await worker.fetch(new Request(
  "https://api.flitfancy.com/admin/essays", {
    method: "POST", headers: adminHeaders, body: JSON.stringify(essayBody),
  }
), env);
assert.equal(publishResponse.status, 200);
let essays = await (await worker.fetch(
  new Request("https://api.flitfancy.com/essays"), env
)).json();
assert.equal(essays.rows[0].title, "公开短文");

const unpublishResponse = await worker.fetch(new Request(
  "https://api.flitfancy.com/admin/essays", {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ uid: essayBody.uid, published: false }),
  }
), env);
assert.equal(unpublishResponse.status, 200);
essays = await (await worker.fetch(
  new Request("https://api.flitfancy.com/essays"), env
)).json();
assert.deepEqual(essays.rows, []);

console.log("worker anchor taxonomy and public essays test ok");
