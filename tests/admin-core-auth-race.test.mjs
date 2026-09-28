import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/admin-core.js", import.meta.url), "utf8");
function fixture() {
  const values = new Map(), requests = [];
  const sessionStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const window = { location: { hostname: "localhost" } };
  vm.runInNewContext(source, {
    window, sessionStorage, AbortController,
    setTimeout: () => 1, clearTimeout() {},
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  });
  const finish401 = () => requests.at(-1).resolve({ status: 401, ok: false, json: async () => ({ error: "fixture unauthorized" }) });
  return { core: window.FlitFancyAdmin, requests, finish401 };
}
async function unauthorized(core, method, options) {
  try {
    const response = await core[method]("/api/status", options);
    assert.equal(method, "fetchRaw");
    assert.equal(response.status, 401);
  } catch (error) {
    assert.equal(method, "request");
    assert.equal(error.status, 401);
  }
}

for (const method of ["request", "fetchRaw"]) {
  // An older in-flight request must not invalidate a freshly established session.
  {
    const f = fixture();
    f.core.setToken(undefined, "test-password-old-session");
    const pending = unauthorized(f.core, method);
    assert.equal(f.requests[0].options.headers.Authorization, "Bearer test-password-old-session");
    f.core.setToken(undefined, "fixture-new-session");
    f.finish401();
    await pending;
    assert.equal(f.core.token(), "fixture-new-session", method + " preserves a newer session");
  }
  // A rejected request using the current session still signs out normally.
  {
    const f = fixture();
    f.core.setToken(undefined, "fixture-current-session");
    const pending = unauthorized(f.core, method);
    f.finish401();
    await pending;
    assert.equal(f.core.token(), "", method + " clears the rejected current session");
  }
  // Public requests never send or erase a private token.
  {
    const f = fixture();
    f.core.setToken(undefined, "fixture-private-session");
    const pending = unauthorized(f.core, method, { authMode: "none" });
    assert.equal(f.requests[0].options.headers.Authorization, undefined);
    f.finish401();
    await pending;
    assert.equal(f.core.token(), "fixture-private-session");
  }
  // Independent token keys preserve both a newer custom session and the default session.
  {
    const f = fixture(), key = "fixture.separate.token";
    f.core.setToken(undefined, "fixture-default-session");
    f.core.setToken(key, "fixture-custom-old");
    const pending = unauthorized(f.core, method, { tokenKey: key });
    f.core.setToken(key, "fixture-custom-new");
    f.finish401();
    await pending;
    assert.equal(f.core.token(key), "fixture-custom-new");
    assert.equal(f.core.token(), "fixture-default-session");
    const current = unauthorized(f.core, method, { tokenKey: key });
    f.finish401();
    await current;
    assert.equal(f.core.token(key), "");
    assert.equal(f.core.token(), "fixture-default-session");
  }
}

console.log("admin core auth races: stale 401, current 401, public requests and independent token keys passed");
