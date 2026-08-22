// 建表/迁移记忆化：每个 isolate 每种 DDL 或迁移只执行一次，消除每请求写放大。
const ddlCache = new Map();

function runOnce(env, key, work) {
  if (!env.DB) return Promise.resolve(false);
  if (!ddlCache.has(key)) {
    ddlCache.set(key, Promise.resolve().then(work).then(() => true).catch((error) => {
      ddlCache.delete(key);
      throw error;
    }));
  }
  return ddlCache.get(key);
}

export function runDdlOnce(env, sql) {
  return runOnce(env, sql, () => env.DB.prepare(sql).run());
}

export const TABLE_VISITS = `CREATE TABLE IF NOT EXISTS visits(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      page TEXT NOT NULL DEFAULT '/',
      ref TEXT,
      ip TEXT,
      ua TEXT,
      w INTEGER,
      h INTEGER
    )`;

export const TABLE_SENSORS = `CREATE TABLE IF NOT EXISTS sensor_latest(
      board TEXT NOT NULL,
      channel TEXT NOT NULL,
      ts INTEGER NOT NULL,
      sensor TEXT NOT NULL,
      ok INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(board, channel)
    )`;

export const TABLE_HISTORY = `CREATE TABLE IF NOT EXISTS sensor_history(
      channel TEXT NOT NULL,
      bucket TEXT NOT NULL,
      n INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY(channel, bucket)
    )`;

export const TABLE_ANCHORS = `CREATE TABLE IF NOT EXISTS anchors(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        created_ts INTEGER NOT NULL,
        anchor_time TEXT NOT NULL,
        time_precision TEXT NOT NULL DEFAULT 'second',
        horizon TEXT NOT NULL DEFAULT 'now',
        project TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        content TEXT NOT NULL
      )`;

export const TABLE_ESSAYS = `CREATE TABLE IF NOT EXISTS essays(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 100,
        title TEXT NOT NULL,
        content TEXT NOT NULL
      )`;

export const TABLE_OBSERVATIONS = `CREATE TABLE IF NOT EXISTS observations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        discovered_at TEXT NOT NULL,
        source_name TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        published INTEGER NOT NULL DEFAULT 0
      )`;

export const TABLE_OBSERVATION_LINKS = `CREATE TABLE IF NOT EXISTS observation_links(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        source_uid TEXT NOT NULL,
        target_uid TEXT NOT NULL,
        relation TEXT NOT NULL
      )`;

export function ensureAnchorsTable(env) {
  return runOnce(env, "anchors:migration", () => ensureAnchorsTableOnce(env));
}

// 公开查询依赖 published 标志做纵深防御（写入侧本就只保留公开副本，
// 撤下即 DELETE）。存量行按同一不变量一次性回填为 1。
export function ensureObservationsTable(env) {
  return runOnce(env, "observations:migration", () => ensureObservationsTableOnce(env));
}

async function ensureObservationsTableOnce(env) {
  await env.DB.prepare(TABLE_OBSERVATIONS).run();
  const columns = await env.DB.prepare("PRAGMA table_info(observations)").all();
  const names = (columns.results || []).map((column) => column.name);
  if (!names.includes("published")) {
    await env.DB.prepare(
      "ALTER TABLE observations ADD COLUMN published INTEGER NOT NULL DEFAULT 0"
    ).run();
    await env.DB.prepare("UPDATE observations SET published = 1").run();
  }
  return true;
}

async function ensureAnchorsTableOnce(env) {
  await env.DB.prepare(TABLE_ANCHORS).run();
  const columns = await env.DB.prepare("PRAGMA table_info(anchors)").all();
  const names = (columns.results || []).map((column) => column.name);
  if (!names.includes("horizon")) {
    await env.DB.prepare(
      "ALTER TABLE anchors ADD COLUMN horizon TEXT NOT NULL DEFAULT 'now'"
    ).run();
  }
  if (!names.includes("project")) {
    await env.DB.prepare(
      "ALTER TABLE anchors ADD COLUMN project TEXT NOT NULL DEFAULT 'pending'"
    ).run();
  }
  return true;
}

export function ensureMemoriesTable(env) {
  return runOnce(env, "memories:migration", () => ensureMemoriesTableOnce(env));
}

/**
 * 结构迁移只随 isolate 冷启动执行一次；数据回填仅在其对应列刚被
 * ALTER 添加时执行；title 合并是一次性迁移（KV 标记），完成后不再全表扫描。
 */
async function ensureMemoriesTableOnce(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      created_ts INTEGER NOT NULL,
      memory_date TEXT NOT NULL,
      perspective TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_time TEXT,
      time_precision TEXT NOT NULL DEFAULT 'second'
    )`
  ).run();
  const columns = await env.DB.prepare("PRAGMA table_info(memories)").all();
  const names = (columns.results || []).map((column) => column.name);
  if (!names.includes("memory_time")) {
    await env.DB.prepare("ALTER TABLE memories ADD COLUMN memory_time TEXT").run();
    await env.DB.prepare(
      `UPDATE memories
       SET memory_time = memory_date || 'T00:00:00+08:00'
       WHERE memory_time IS NULL OR memory_time = ''`
    ).run();
  }
  if (!names.includes("time_precision")) {
    await env.DB.prepare(
      "ALTER TABLE memories ADD COLUMN time_precision TEXT NOT NULL DEFAULT 'second'"
    ).run();
    await env.DB.prepare("UPDATE memories SET time_precision = 'date'").run();
  }
  const titleMerged = env.CONFIG ? await env.CONFIG.get("memories:title-merged") : null;
  if (titleMerged !== "1") {
    await env.DB.prepare(
      `UPDATE memories
       SET content = CASE
             WHEN trim(title) NOT IN ('', '.')
             THEN trim(title) || CASE WHEN trim(content) != '' THEN char(10) || content ELSE '' END
             ELSE content
           END,
           title = ''
       WHERE title IS NOT NULL AND title != ''`
    ).run();
    if (env.CONFIG) await env.CONFIG.put("memories:title-merged", "1");
  }
  return true;
}
