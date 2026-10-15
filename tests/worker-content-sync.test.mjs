import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";
import { SqliteD1 } from "./worker-sqlite-d1.mjs";

const credential = ["sync", "regression", "credential", "0123456789abcdef"].join("-");
const env = {
  ADMIN_TOKEN: credential, DB: new SqliteD1(),
  CONFIG: { async get() { return "1"; }, async put() {} },
};
const headers = { Authorization: "Bearer " + credential, "Content-Type": "application/json" };
async function post(resource, body, targetEnv = env) {
  const response = await worker.fetch(new Request("https://api.flitfancy.com/admin/" + resource, {
    method: "POST", headers, body: JSON.stringify(body),
  }), targetEnv);
  return { status: response.status, body: await response.json() };
}
const table = resource => resource.replaceAll("-", "_");
const saved = (resource, uid) => env.DB.sqlite.prepare(`SELECT * FROM ${table(resource)} WHERE uid=?`).get(uid);
const revision = (resource, uid) => env.DB.sqlite.prepare(
  "SELECT sync_revision FROM content_sync_versions WHERE resource=? AND uid=?"
).get(table(resource), uid)?.sync_revision;
const essay = { uid: "sync-essay-race-0001", published: true, title: "Public", content: "Old public body" };
const observation = { uid: "sync-observation-0001", published: true, title: "Observation", category: "事",
  tags: [], summary: "Summary", content: "Body", discovered_at: "2026-10-15" };
const other = { ...observation, uid: "sync-observation-0002" };
const link = { uid: "sync-link-revision-0001", published: true,
  source_uid: observation.uid, target_uid: other.uid, relation: "关联", strength: "strong" };

try {
  // The original failure: a delayed publish arrives after a later withdrawal.
  let result = await post("essays", { uid: essay.uid, published: false, sync_revision: 2 });
  assert.equal(result.status, 200);
  assert.equal(result.body.sync_revision, 2);
  for (const stale of [{ ...essay, sync_revision: 1 }, essay]) {
    result = await post("essays", stale);
    assert.equal(result.status, 409);
    assert.equal(result.body.sync_revision, 2, "conflict must report accepted version, not incoming version");
    assert.equal(saved("essays", essay.uid), undefined);
  }
  result = await post("essays", { ...essay, sync_revision: 2 });
  assert.equal(result.status, 200, "equal-version retry is idempotent");
  assert.equal(result.body.sync_revision, 2);
  assert.equal(saved("essays", essay.uid), undefined, "same version cannot replace a tombstone with a publish");
  await post("essays", { ...essay, content: "New public body", sync_revision: 3 });
  result = await post("essays", { uid: essay.uid, published: false, sync_revision: 2 });
  assert.equal(result.status, 409);
  assert.equal(saved("essays", essay.uid).content, "New public body", "stale withdrawal cannot erase a new publish");

  // Delay one actual Worker request while another request commits its withdrawal.
  let releasePublish;
  let reachedPublish;
  const delayed = new Promise(resolve => { releasePublish = resolve; });
  const reached = new Promise(resolve => { reachedPublish = resolve; });
  env.DB.beforeBatch = async statements => {
    if (statements[0].values[2] === 4) { reachedPublish(); await delayed; }
  };
  const inFlight = post("essays", { ...essay, sync_revision: 4 });
  await reached;
  await post("essays", { uid: essay.uid, published: false, sync_revision: 5 });
  releasePublish();
  result = await inFlight;
  env.DB.beforeBatch = null;
  assert.equal(result.status, 409);
  assert.equal(result.body.sync_revision, 5);
  assert.equal(saved("essays", essay.uid), undefined);

  // Existing unversioned clients work until this UID accepts its first positive revision.
  const legacy = { ...essay, uid: "sync-legacy-essay-0001" };
  assert.equal((await post("essays", legacy)).status, 200);
  assert.equal((await post("essays", { ...legacy, content: "Legacy edit" })).status, 200);
  assert.equal(saved("essays", legacy.uid).content, "Legacy edit");
  await post("essays", { ...legacy, sync_revision: 1, content: "Versioned edit" });
  assert.equal((await post("essays", { uid: legacy.uid, published: false })).status, 409);
  assert.equal(saved("essays", legacy.uid).content, "Versioned edit");

  // Apply ordering and equality guards to every publish-only resource too.
  for (const [resource, payload] of [
    ["memories", { uid: "sync-memory-order-0001", time: "2026-10-15T12:00:00+08:00", perspective: "me", content: "Latest" }],
    ["anchors", { uid: "sync-anchor-order-0001", time: "2026-10-15T12:00:00+08:00",
      horizon: "now", project: "flitfancy", title: "Title", content: "Latest" }],
  ]) {
    assert.equal((await post(resource, { ...payload, sync_revision: 2 })).status, 200);
    assert.equal((await post(resource, { ...payload, content: "Stale", sync_revision: 1 })).status, 409);
    assert.equal((await post(resource, { ...payload, content: "Same version mutation", sync_revision: 2 })).status, 200);
    assert.equal(saved(resource, payload.uid).content, "Latest");
    assert.equal((await post(resource, { ...payload, content: "Legacy downgrade" })).status, 409);
  }

  await post("observations", { ...observation, sync_revision: 1 });
  await post("observations", { ...other, sync_revision: 1 });
  await post("observation-links", { ...link, sync_revision: 1 });
  assert.equal(saved("observation-links", link.uid).strength, "strong");
  await post("observation-links", { ...link, strength: "weak", sync_revision: 1 });
  assert.equal(saved("observation-links", link.uid).strength, "strong", "equal link version cannot change accepted content");

  // A versioned observation withdrawal hides links, but does not erase another
  // resource's accepted revision. Its independently versioned link tombstone does.
  await post("observations", { uid: observation.uid, published: false, sync_revision: 3 });
  assert.ok(saved("observation-links", link.uid), "endpoint withdrawal must preserve independently accepted link state");
  let publicRows = await (await worker.fetch(new Request("https://api.flitfancy.com/observations"), env)).json();
  assert.equal(publicRows.links.length, 0);
  result = await post("observations", { ...observation, sync_revision: 2 });
  assert.equal(result.status, 409);
  assert.equal(saved("observations", observation.uid), undefined);
  result = await post("observation-links", { ...link, sync_revision: 2 });
  assert.equal(result.status, 409, "a link with unavailable endpoints must retry, not acknowledge an absent write");
  assert.equal(result.body.sync_revision, 1);
  assert.equal(revision("observation-links", link.uid), 1, "blocked link publish must not consume its revision");
  await post("observation-links", { uid: link.uid, published: false, sync_revision: 3 });
  await post("observations", { ...observation, sync_revision: 4 });
  result = await post("observation-links", { ...link, sync_revision: 2 });
  assert.equal(result.status, 409);
  assert.equal(saved("observation-links", link.uid), undefined, "old link publish cannot revive after endpoint republication");
  await post("observation-links", { ...link, sync_revision: 4 });
  result = await post("observations", { uid: observation.uid, published: false, sync_revision: 3 });
  assert.equal(result.status, 409);
  assert.ok(saved("observations", observation.uid));
  assert.ok(saved("observation-links", link.uid), "stale endpoint withdrawal cannot erase newer link state");
  publicRows = await (await worker.fetch(new Request("https://api.flitfancy.com/observations"), env)).json();
  assert.equal(publicRows.links.length, 1);

  // Legacy cascade also must leave positively versioned links for their own ledger.
  const legacyEndpoint = { ...observation, uid: "sync-legacy-endpoint-0001" };
  const guardedLink = { ...link, uid: "sync-guarded-link-0001", source_uid: legacyEndpoint.uid };
  await post("observations", legacyEndpoint);
  await post("observation-links", { ...guardedLink, sync_revision: 1 });
  await post("observations", { uid: legacyEndpoint.uid, published: false });
  assert.ok(saved("observation-links", guardedLink.uid));
  publicRows = await (await worker.fetch(new Request("https://api.flitfancy.com/observations"), env)).json();
  assert.ok(publicRows.links.every(row => row.uid !== guardedLink.uid));

  // A failed body mutation must roll back its claim as well, allowing safe retry.
  const failed = { ...essay, uid: "sync-rollback-essay-0001", sync_revision: 1 };
  env.DB.sqlite.exec(`CREATE TRIGGER fail_content_sync BEFORE INSERT ON essays
    WHEN NEW.uid = '${failed.uid}' BEGIN SELECT RAISE(ABORT, 'forced regression failure'); END`);
  await assert.rejects(post("essays", failed), /forced regression failure/);
  assert.equal(revision("essays", failed.uid), undefined);
  assert.equal(saved("essays", failed.uid), undefined);
  env.DB.sqlite.exec("DROP TRIGGER fail_content_sync");
  assert.equal((await post("essays", failed)).status, 200);
  assert.equal(saved("essays", failed.uid).content, essay.content);

  for (const invalid of [0, -1, 1.5, "1", null, true, Number.MAX_SAFE_INTEGER + 1]) {
    for (const resource of ["memories", "anchors", "essays", "observations", "observation-links"]) {
      result = await post(resource, { uid: "sync-invalid-revision-0001", published: false, sync_revision: invalid });
      assert.equal(result.status, 400, `${resource} must reject malformed revision ${invalid}`);
    }
  }

  // DDL memoization must be scoped by DB binding, including independent test DBs.
  const secondEnv = { ...env, DB: new SqliteD1() };
  try {
    result = await post("essays", { ...essay, sync_revision: 1 }, secondEnv);
    assert.equal(result.status, 200);
    assert.equal(secondEnv.DB.sqlite.prepare("SELECT content FROM essays WHERE uid=?").get(essay.uid).content, essay.content);
  } finally { secondEnv.DB.sqlite.close(); }
} finally { env.DB.sqlite.close(); }

console.log("worker revision ordering, tombstones, idempotency and transactional rollback test ok");
