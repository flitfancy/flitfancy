import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';
import { SqliteD1 } from './worker-sqlite-d1.mjs';

const token = 'test-public-config-sync-token-0123456789';
const kv = new Map([['reflections', JSON.stringify(['legacy'])]]);
const env = { ADMIN_TOKEN: token, DB: new SqliteD1(), CONFIG: {
  async get(key) { return kv.get(key) ?? null; },
  async put(key, value) { kv.set(key, value); },
} };
const post = (body, auth = true) => worker.fetch(new Request('https://api.flitfancy.com/admin/content-config', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? {Authorization:'Bearer ' + token} : {}) },
  body: JSON.stringify(body),
}), env);
const publicConfig = async () => (await (await worker.fetch(new Request('https://api.flitfancy.com/config'), env)).json());
try {
  assert.deepEqual((await publicConfig()).reflections, ['legacy']);
  assert.notEqual((await post({key:'reflections',value:['x'],sync_revision:1}, false)).status, 200);
  const crossOrigin = await worker.fetch(new Request('https://api.flitfancy.com/admin/content-config', {
    method:'POST', headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json',Origin:'https://example.org'},
    body:JSON.stringify({key:'reflections',value:['x'],sync_revision:1}),
  }),env);
  assert.equal(crossOrigin.status,403);
  let response = await post({key:'reflections',value:['new'],sync_revision:2});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sync_revision, 2);
  assert.deepEqual((await publicConfig()).reflections, ['new']);
  assert.equal((await post({key:'reflections',value:['new'],sync_revision:2})).status, 200, 'lost acknowledgements are safe to retry');
  assert.equal((await post({key:'reflections',value:['different'],sync_revision:2})).status, 409);
  assert.equal((await post({key:'reflections',value:['old'],sync_revision:1})).status, 409);
  assert.deepEqual((await publicConfig()).reflections, ['new']);
  for (const revision of [0, -1, '3', 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await post({key:'reflections',value:['x'],sync_revision:revision})).status, 400);
  }
  assert.equal((await post({key:'chat_enabled',value:true,sync_revision:3})).status, 400, 'private/access config is not accepted');
  assert.equal((await post({key:'reflections',value:'bad',sync_revision:3})).status, 400);
  const legacyWrite = await worker.fetch(new Request('https://api.flitfancy.com/admin/toggle', {
    method:'POST', headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/json'},
    body:JSON.stringify({reflections:['old client']}),
  }), env);
  assert.equal(legacyWrite.status, 409, 'an old writer cannot bypass an established version');
  assert.deepEqual((await publicConfig()).reflections, ['new']);
  const mixed = await worker.fetch(new Request('https://api.flitfancy.com/admin/toggle', {
    method:'POST', headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/json'},
    body:JSON.stringify({chat_enabled:false,reflections:['old client']}),
  }), env);
  assert.equal(mixed.status, 409);
  assert.equal((await publicConfig()).chat_enabled, false, 'an old client can still close visitor chat');
  let release, reached;
  const delayed = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  env.DB.beforeBatch = async statements => {
    if (statements[0].values[1] === 3) { reached(); await delayed; }
  };
  const old = post({key:'reflections',value:['delayed'],sync_revision:3});
  await waiting;
  assert.equal((await post({key:'reflections',value:['latest'],sync_revision:4})).status, 200);
  release();
  assert.equal((await old).status, 409, 'late requests cannot replace newer values');
  env.DB.beforeBatch = null;
  assert.deepEqual((await publicConfig()).reflections, ['latest']);
  const essay = {uid:'sync-featured-essay-0001',title:'Selected',content:'Public snapshot',updated_at:'2026-11-12'};
  const saveEssay = payload => worker.fetch(new Request('https://api.flitfancy.com/admin/essays', {
    method:'POST',headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json'},
    body:JSON.stringify(payload),
  }),env);
  assert.equal((await saveEssay({...essay,published:true,sync_revision:1})).status,200);
  assert.equal((await post({key:'featured_essay',value:essay,sync_revision:5})).status,200);
  const getFeatured = async () => (await (await worker.fetch(new Request('https://api.flitfancy.com/essays/featured'),env)).json()).essay;
  assert.deepEqual(await getFeatured(),essay);
  assert.equal((await saveEssay({uid:essay.uid,published:false,sync_revision:2})).status,200);
  assert.equal(await getFeatured(),null,'a withdrawn essay must not leak from the stored snapshot');
  console.log('public configuration: version ordering, retry, auth, migration and legacy-writer guard passed');
} finally { env.DB.sqlite.close(); }
