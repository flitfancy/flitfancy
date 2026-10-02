import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const worker = (await import(new URL("../cloudflare/worker.js", import.meta.url))).default;
const ESSAYS_CONTRACT = JSON.parse(
  fs.readFileSync(new URL("./contracts/essays.json", import.meta.url), "utf8")
);
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
    for (const column of ["badge", "badge_kind"]) {
      if (sql.includes("ADD COLUMN " + column + " ")) this.db.anchorColumns.push(column);
    }
    if (sql.includes("INSERT INTO anchors")) {
      const [uid, createdTs, time, precision, horizon, project, title, content, badge, badgeKind] = this.values;
      this.db.anchors.set(uid, {
        uid, created_ts: createdTs, time, precision, horizon, project, title, content,
        badge, badge_kind: badgeKind,
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
    if (this.sql.includes("FROM anchors")) {
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

const cardBody = {uid:"legacy-anchor-firefly-brain", title:"原卡片", content:"原格式正文", horizon:"now",
  project:"firefly", time:"", badge:"已跑通", badge_kind:"done"};
async function saveCard(body) {
  return worker.fetch(new Request("https://api.flitfancy.com/admin/anchors", {
    method:"POST", headers:adminHeaders, body:JSON.stringify(body),
  }), env);
}
assert.equal((await saveCard(cardBody)).status, 200);
const changedCardResponse = await saveCard({...cardBody, title:"修改后的卡片", badge:"进行中", badge_kind:"doing"});
assert.equal(changedCardResponse.status, 200);
const cardConfirmation = await changedCardResponse.json();
assert.equal(cardConfirmation.precision, "none");
assert.equal(cardConfirmation.badge, "进行中");
assert.equal(cardConfirmation.badge_kind, "doing");
const savedCard = db.anchors.get(cardBody.uid);
assert.equal(savedCard.time, "");
assert.equal(savedCard.precision, "none");
assert.equal(savedCard.title, "修改后的卡片");
assert.equal(savedCard.badge, "进行中");
assert.equal(savedCard.badge_kind, "doing");
assert.equal([...db.anchors.values()].filter(row => row.uid === cardBody.uid).length, 1);
assert.ok(db.anchorColumns.includes("badge") && db.anchorColumns.includes("badge_kind"));
assert.equal((await saveCard({...cardBody, badge_kind:"unsafe"})).status, 400);

// 真实 SQLite 执行公开查询：九张原卡片独立保留，普通时间线仍只取最新 200 条。
const sqlite = new DatabaseSync(":memory:");
try {
  const sqlEnv = { ...env, DB: { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let params = [];
    return { bind(...values) { params = values; return this; },
      async run() { statement.run(...params); return { success: true }; },
      async all() { return { results: statement.all(...params) }; } };
  } } };
  const { ensureAnchorsTable } = await import("../cloudflare/worker-storage.js?anchor-pagination-test");
  await ensureAnchorsTable(sqlEnv);
  const originalUids = [...fs.readFileSync(new URL("../docs/journal.html", import.meta.url), "utf8")
    .matchAll(/data-anchor-uid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(originalUids.length, 9);
  for (const uid of originalUids) {
    const response = await worker.fetch(new Request("https://api.flitfancy.com/admin/anchors", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ ...cardBody, uid, title: "保留的修改", badge: "进行中", badge_kind: "doing" }),
    }), sqlEnv);
    assert.equal(response.status, 200);
  }
  const insert = sqlite.prepare(`INSERT INTO anchors
    (uid,created_ts,anchor_time,horizon,project,title,content) VALUES(?,1,?,'now','firefly','分页测试','正文')`);
  const dated = Array.from({ length: 205 }, (_, index) => ({
    uid: "pagination-anchor-" + String(index).padStart(4, "0"), index,
    time: index % 2 ? "2026-10-02T12:00:00+08:00" : "2026-09-01T12:00:00+08:00",
  }));
  for (const row of dated) insert.run(row.uid, row.time);
  const listed = await (await worker.fetch(new Request("https://api.flitfancy.com/anchors"), sqlEnv)).json();
  const expected = dated.sort((a, b) => b.time.localeCompare(a.time) || b.index - a.index).slice(0, 200);
  assert.deepEqual(listed.rows.filter(row => !originalUids.includes(row.uid)).map(row => row.uid), expected.map(row => row.uid));
  const originalRows = listed.rows.filter(row => originalUids.includes(row.uid));
  assert.equal(listed.rows.length, 209);
  assert.deepEqual(new Set(originalRows.map(row => row.uid)), new Set(originalUids));
  assert.ok(originalRows.every(row => row.title === "保留的修改" && row.time === "" &&
    row.precision === "none" && row.badge === "进行中" && row.badge_kind === "doing"));
} finally { sqlite.close(); }

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

// 与本地后端共用同一份契约：accept/reject 判定必须逐条一致。
for (const [index, testCase] of ESSAYS_CONTRACT.cases.entries()) {
  const response = await worker.fetch(new Request(
    "https://api.flitfancy.com/admin/essays", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({
        published: true,
        created_at: "2026-08-22T12:00:00+08:00",
        updated_at: "2026-08-22T12:00:00+08:00",
        uid: "contract-essay-" + String(index).padStart(4, "0"),
        ...testCase.payload,
      }),
    }
  ), env);
  assert.equal(response.status, testCase.valid ? 200 : 400,
    `契约用例 ${testCase.name} 判定与本地后端不一致`);
}

console.log("worker anchor taxonomy and public essays test ok");
