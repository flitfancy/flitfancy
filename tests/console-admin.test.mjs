import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/console-admin.js", import.meta.url), "utf8"
);
const window = {};
vm.runInNewContext(source, { window });

const safeLinkUrl = window.FlitFancyConsoleAdmin.safeLinkUrl;
assert.equal(safeLinkUrl("https://example.com/path"), "https://example.com/path");
assert.equal(safeLinkUrl("  http://127.0.0.1:2671  "), "http://127.0.0.1:2671");
assert.equal(safeLinkUrl("javascript:alert(1)"), "");
assert.equal(safeLinkUrl("data:text/html,hello"), "");
assert.equal(safeLinkUrl("//example.com"), "");
assert.match(source, /noopener,noreferrer/,
  "外部快捷入口必须隔离 window.opener 与来源信息");
assert.match(source, /authMode:\s*"none"/,
  "登录请求必须显式禁用旧令牌注入");

console.log("console admin module test ok");

// 存在页只复用登录，不需要管理面板、访问统计或配置表单。
function loginHarness({ online = true, initialToken = "", initialStatus = 200, entry = false, page = 'presence' } = {}) {
  let savedToken = initialToken, status = initialStatus, authenticated = 0, signedOut = 0;
  let hold = null;
  const requests = [];
  const selectors = [".ffs-actions", '.nav nav a[href="' + page + '.html"]',
    ...["admin-logout", "admin-overlay", "admin-username", "admin-password", "admin-login-status", "admin-login", "admin-cancel"]
      .map(role => '[data-role="' + role + '"]')];
  if (page === 'console') selectors.push(...['admin-panel', 'admin-grab', 'admin-collapse', 'admin-expand-tab',
    'admin-mode', 'cfg-save', 'cfg-model', 'cfg-model-custom', 'cfg-chat-toggle', 'ql-add', 'visits-refresh',
    'visits-group-toggle', 'quick-links'].map(role => '[data-role="' + role + '"]'));
  const nodes = new Map(selectors.map(selector => [selector, {
    hidden: true, value: "", textContent: "", handlers: {}, options: [],
    focus() {}, scrollIntoView() {}, replaceChildren() {}, addEventListener(type, handler) { this.handlers[type] = handler; },
  }]));
  const localWindow = {
    location: { href: (online ? 'https://console.flitfancy.com' : 'https://flitfancy.com') + '/' + page + '.html' + (entry ? '#login' : ''), hash: entry ? '#login' : '', pathname: '/' + page + '.html', search: '' },
    history: { replaceState(_state, _title, url) { localWindow.location.hash = ''; localWindow.location.href = url; } },
    FlitFancyPanelShell: { init: () => ({ show() {}, hide() {}, clearCollapsed() {} }) },
    FlitFancyVisits: { create: () => ({ load() {} }) },
    FlitFancyAdmin: {
      token: () => savedToken,
      setToken: (_key, value) => { savedToken = value; },
      isUnauthorized: error => error.status === 401,
      request: async url => {
        requests.push(url);
        if (hold) await hold;
        if (status !== 200) throw Object.assign(new Error("offline"), { status });
        return {};
      },
      fetchRaw: async (url, options) => {
        requests.push(url);
        if (hold && url === '/api/admin/config') await hold;
        if (url === "/api/admin/login") assert.equal(options.authMode, "none");
        const code = url === '/api/admin/config' ? status : 200;
        return { ok: code === 200, status: code, json: async () => ({ token: "test-session" }) };
      },
    },
  };
  vm.runInNewContext(source, { window: localWindow });
  const query = selector => nodes.get(selector) || null;
  const view = localWindow.FlitFancyConsoleAdmin.create({
    query, authOnly: page === 'presence', isServerOnline: () => online,
    onAuthenticated: () => { authenticated++; }, onSignedOut: () => { signedOut++; },
  });
  view.start();
  return { view, nodes, query, requests, localWindow,
    role: name => query('[data-role="' + name + '"]'),
    click: selector => query(selector).handlers.click({ preventDefault() {} }),
    setStatus: value => { status = value; },
    holdRequests: value => { hold = value; },
    state: () => ({ savedToken, authenticated, signedOut }) };
}
const login = loginHarness();
login.click('.nav nav a[href="presence.html"]');
assert.equal(login.role("admin-overlay").hidden, false, "current presence nav opens the existing login dialog");
login.role("admin-username").value = "test-admin";
login.role("admin-password").value = "test-only-password";
await login.click('[data-role="admin-login"]');
assert.equal(login.state().savedToken, "test-session");
assert.equal(login.state().authenticated, 1);
assert.equal(login.role("admin-overlay").hidden, true);
assert.equal(login.role("admin-logout").hidden, false);
assert.deepEqual(login.requests, ["/api/admin/login", "/api/admin/session"], "presence login must validate its session without loading site management config");
await login.click('[data-role="admin-logout"]');
assert.equal(login.state().savedToken, "");
assert.equal(login.state().signedOut, 1);
assert.equal(login.role("admin-logout").hidden, true);

const restored = loginHarness({ initialToken: "existing-session" });
await new Promise(resolve => setImmediate(resolve));
assert.equal(restored.role("admin-logout").hidden, false, "same-tab navigation reuses the existing session");
restored.setStatus(503);
await restored.view.loadConfig();
assert.equal(restored.state().savedToken, "existing-session", "transient outages preserve the session");
restored.setStatus(401);
await restored.view.loadConfig();
assert.equal(restored.state().savedToken, "");
assert.equal(restored.role("admin-logout").hidden, true);

const publicPage = loginHarness({ online: false });
publicPage.click('.nav nav a[href="presence.html"]');
assert.equal(publicPage.localWindow.location.href, "https://console.flitfancy.com/presence.html#login", "remote entry must carry login intent with its destination");
assert.deepEqual(publicPage.requests, []);
const arrived = loginHarness({ entry: true });
await new Promise(resolve => setImmediate(resolve));
assert.equal(arrived.role('admin-overlay').hidden, false, 'arriving from the hidden entry must open login without another click');
assert.equal(arrived.localWindow.location.hash, '', 'consume the one-shot login intent');
const normalVisit = loginHarness();
assert.equal(normalVisit.role('admin-overlay').hidden, true, 'ordinary navigation must not open login');
const validEntry = loginHarness({ entry: true, initialToken: 'existing-session' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(validEntry.role('admin-overlay').hidden, true, 'a validated existing session skips login');
assert.equal(validEntry.role('admin-logout').hidden, false);
const expiredEntry = loginHarness({ entry: true, initialToken: 'old-session', initialStatus: 401 });
await new Promise(resolve => setImmediate(resolve));
assert.equal(expiredEntry.role('admin-overlay').hidden, false, 'expired entry session must open login automatically');
assert.equal(expiredEntry.state().savedToken, '');
for (const page of ['presence', 'console']) {
  const publicEntry = loginHarness({online: false, page});
  await publicEntry.click('.nav nav a[href="' + page + '.html"]');
  assert.equal(publicEntry.localWindow.location.href, 'https://console.flitfancy.com/' + page + '.html#login');
  const target = loginHarness({entry: true, page});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(target.role('admin-overlay').hidden, false, page + ': no second click at destination');
  await target.click('[data-role="admin-cancel"]');
  assert.equal(target.role('admin-overlay').hidden, true, page + ': cancellation closes the dialog without a redirect loop');
  const expired = loginHarness({entry: true, page, initialToken: 'old-session', initialStatus: 401});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(expired.role('admin-overlay').hidden, false);
  assert.equal(expired.state().savedToken, '');
  const unavailable = loginHarness({entry: true, page, initialToken: 'existing-session', initialStatus: 503});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unavailable.state().savedToken, 'existing-session', page + ': network failure must preserve the session');
  assert.equal(unavailable.role('admin-logout').hidden, true, page + ': unverified session must not expose management controls');
  assert.match(unavailable.role('admin-login-status').textContent, /暂时无法确认/);
  const valid = loginHarness({entry: true, page, initialToken: 'existing-session'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(valid.role('admin-overlay').hidden, true);
  assert.equal(valid.role('admin-logout').hidden, false);
  const stalePublic = loginHarness({online: false, page, initialToken: 'stale-public-token'});
  await stalePublic.click('.nav nav a[href="' + page + '.html"]');
  assert.deepEqual(stalePublic.requests, [], page + ': a token on the public origin must not trigger admin requests');
  assert.equal(stalePublic.localWindow.location.href, 'https://console.flitfancy.com/' + page + '.html#login');
  const cancelled = loginHarness({page, initialToken: 'existing-session'});
  await new Promise(resolve => setImmediate(resolve));
  let finish;
  cancelled.holdRequests(new Promise(resolve => { finish = resolve; }));
  const pending = cancelled.click('.nav nav a[href="' + page + '.html"]');
  await cancelled.click('[data-role="admin-logout"]');
  finish(); await pending;
  assert.equal(cancelled.role('admin-overlay').hidden, true, page + ': stale entry must not reopen login after logout');
  assert.equal(cancelled.role('admin-logout').hidden, true);
}
console.log("presence shared login, restore, expiration and remote entry tests ok");
