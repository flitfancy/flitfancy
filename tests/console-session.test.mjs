import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/console.js", import.meta.url), "utf8");
const schedulerSource = fs.readFileSync(new URL('../docs/assets/refresh-scheduler.js', import.meta.url), 'utf8');
async function run(status, fault = "", page = "presence", publicHost = false, signedIn = true, bfcache = false) {
  const notices = [], requests = [], lifecycle = {};
  let audioStarts = 0, sensorRenders = 0, retries = 0, launcherStarts = 0, chatStarts = 0, publicReads = 0;
  let adminOptions, audioOptions, activityOptions, heartbeatOptions, heartbeatCreates = 0, activityStarts = 0, activityClears = 0;
  const chatStates = [];
  const html = fs.readFileSync(new URL("../docs/" + page + ".html", import.meta.url), "utf8");
  const statusElement = { textContent: "" };
  const noop = function () {};
  const chat = { start: () => { chatStarts++; }, setEnabled: noop, refreshPublicConfig: noop,
    updateState: value => chatStates.push(value) };
  const window = {
    setTimeout, clearTimeout,
    addEventListener: (name, callback) => { lifecycle[name] = callback; },
    FlitFancyHeartbeats: { create: options => { heartbeatCreates++; heartbeatOptions = options; return {start:noop,refresh:noop,clearPrivate:noop,dispose:noop}; } },
    FlitFancySensorState: {}, FlitFancyConsoleOverview: {}, FlitFancyBridgeHash: {}, FlitFancyBridgeFiles: {},
    FlitFancyConsoleBridge: { create: () => ({ start: noop, refresh: noop, clearPrivate: noop }) },
    FlitFancyConsoleActivity: { create: options => {
      activityOptions = options;
      return { start: () => { activityStarts++; }, refresh: noop, clearPrivate: () => { activityClears++; } };
    } },
    FlitFancyPanelShell: {}, FlitFancyVisits: {},
    FlitFancyAdmin: {
      isAdminHost: () => !publicHost, installErrorHandler: noop,
      isUnauthorized: error => error.status === 401,
      request: async (url) => {
        requests.push(url);
        if (url === "/api/status" && status !== 200) {
          const error = new Error("request failed"); error.status = status; throw error;
        }
        return url === "/api/status" ? { services: { backend: true } } : { rows: [] };
      },
      fetchRaw: async (_url, options) => {
        assert.equal(options.authMode, 'none', 'public reads must not carry private tokens');
        publicReads++; return {ok:true,json:async()=>({rows:[]})};
      },
    },
    FlitFancyConsoleServices: { create: () => ({ update: noop, setProtocolName: noop }) },
    FlitFancyConsoleSensors: { create: () => ({ render: () => { sensorRenders++; }, notePressure: noop }) },
    FlitFancyConsoleAdmin: { create: options => {
      adminOptions = options;
      return { start: noop, token: () => signedIn ? 'fixture-session' : '', setLoginRequired: value => notices.push(value) };
    } },
    FlitFancyConsoleDialogue: { create: () => chat },
    FlitFancyConsoleChat: { create: () => chat },
    FlitFancyConsoleAudio: { create: options => {
      audioOptions = options;
      return { start: () => { audioStarts++; }, render: value => options.onState(value) };
    } },
    FlitFancyConsoleLauncher: { create: () => ({ start: () => { launcherStarts++; }, refresh: noop, clearPrivate: noop }) },
  };
  vm.runInNewContext(schedulerSource, {window});
  if (fault === "missing-dialogue") delete window.FlitFancyConsoleDialogue;
  if (fault === "broken-dialogue") window.FlitFancyConsoleDialogue.create = () => { throw new Error("broken module"); };
  if (fault === "broken-services") window.FlitFancyConsoleServices.create = () => ({ update() { throw new Error("render failed"); } });
  if (fault === "missing-core") delete window.FlitFancyAdmin;
  // Only exports actually loaded by this page are present in the browser.
  const exports = new Set(Array.from(html.matchAll(/data-console-module="([^"]+)"/g), match => match[1]));
  for (const name of Object.keys(window)) if (name.startsWith('FlitFancy') && !exports.has(name)) delete window[name];
  const scripts = [];
  if (fault === "transient-script" || fault === "persistent-script") {
    delete window.FlitFancyConsoleDialogue;
    scripts.push({ dataset: { consoleModule: "FlitFancyConsoleDialogue" }, src: "http://localhost/assets/console-dialogue.js?v=1.16.1" });
  }
  const failureElement = { hidden: true, textContent: "" };
  vm.runInNewContext(source, {
    window,
    setTimeout, clearTimeout,
    document: {
      hidden:false, addEventListener: (name, callback) => { lifecycle[name] = callback; },
      querySelectorAll: () => scripts,
      createElement: () => ({ remove: noop }),
      head: { appendChild(script) {
        retries++;
        assert.match(script.src, /\?v=1\.16\.1&console_retry=[12]$/, "retry must preserve the asset version");
        queueMicrotask(() => {
          if (fault === "transient-script") {
            window.FlitFancyConsoleDialogue = { create: () => chat };
            script.onload();
          } else script.onerror();
        });
      } },
      querySelector: selector => {
        const role = selector.match(/data-role="([^"]+)"/);
        if (role && !html.includes('data-role="' + role[1] + '"')) return null;
        return selector.includes("module-error-text") ? failureElement :
          selector.includes('"status"') ? statusElement : { classList: { toggle: noop }, addEventListener: noop };
      },
    },
    fetch: async () => { publicReads++; return { ok: true, json: async () => ({ rows: [] }) }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  if (bfcache) {
    lifecycle.pagehide?.({persisted:true});
    lifecycle.pageshow?.({persisted:true});
    await new Promise(resolve => setImmediate(resolve));
  }
  lifecycle.pagehide?.();
  return { notices, statusElement, audioStarts, sensorRenders, failureElement, retries,
    launcherStarts, chatStarts, requests, publicReads, adminOptions, audioOptions, chatStates,
    activityOptions, activityStarts, heartbeatOptions, heartbeatCreates, activityClears: () => activityClears };
}
const unauthorized = await run(401);
assert.deepEqual(unauthorized.notices, [true], "401 must close the management panel while preserving the hidden login entry");
assert.match(unauthorized.statusElement.textContent, /登录/);
assert.deepEqual((await run(200)).notices, [false], "successful refresh must clear login-required state");
assert.deepEqual((await run(200, '', 'presence', false, false)).notices, [true], 'public status success must not imply administrator login');
assert.deepEqual((await run(503)).notices, [], "server failure must not be misidentified as a login failure");
for (const fault of ["missing-dialogue", "broken-dialogue"]) {
  const result = await run(200, fault);
  assert.equal(result.audioStarts, 1, fault + " must not prevent audio initialization");
  assert.ok(result.sensorRenders >= 2, fault + " must not prevent sensor refresh");
  assert.deepEqual(result.notices, [false], fault + " must not be treated as a backend outage");
  assert.ok(result.failureElement.textContent, fault + " must be visible to the user");
}
const missingCore = await run(200, "missing-core");
assert.equal(missingCore.audioStarts, 0, "missing authentication core must fail closed");
assert.ok(missingCore.failureElement.textContent);
const transient = await run(200, "transient-script");
assert.equal(transient.retries, 1, "stop retrying as soon as the missing script recovers");
assert.equal(transient.audioStarts, 1, "recovery must not initialize healthy modules twice");
assert.equal(transient.failureElement.textContent, "");
const persistent = await run(200, "persistent-script");
assert.equal(persistent.retries, 2, "persistent errors must have a bounded retry count");
assert.equal(persistent.audioStarts, 1);
assert.ok(persistent.sensorRenders >= 2);
assert.match(persistent.failureElement.textContent, /对话/);
const presence = await run(200);
assert.equal(presence.heartbeatCreates, 0, 'presence no longer owns a tab heartbeat publisher');
assert.equal(presence.activityStarts, 1, 'presence initializes private usage module');
assert.equal(presence.activityOptions.isAdmin(), true);
assert.equal(presence.activityOptions.isServerOnline(), true);
assert.equal(presence.adminOptions.authOnly, true, "presence reuses login without management dependencies");
assert.equal(presence.launcherStarts, 0);
assert.equal(presence.chatStarts, 1);
const audioState = { available: true, conversation: { messages: [] } };
presence.audioOptions.onState(audioState);
assert.equal(presence.chatStates.at(-1), audioState, "audio must still feed dialogue on presence");
presence.adminOptions.onSignedOut();
assert.equal(presence.activityClears(), 1, 'logout clears the usage card');
assert.equal(presence.chatStates.at(-1), null, "logout clears private dialogue state");
for (const status of [200, 401, 503]) {
  const consolePage = await run(status, "", "console");
  assert.equal(consolePage.heartbeatCreates, 1, 'console owns the backend heartbeat view');
  assert.equal(typeof consolePage.heartbeatOptions.request, 'function', 'heartbeat requests reuse authenticated request handling');
  assert.equal(consolePage.audioStarts, 0);
  assert.equal(consolePage.activityStarts, 0, 'usage stays on presence');
  assert.equal(consolePage.sensorRenders, 0);
  assert.equal(consolePage.chatStarts, 0);
  assert.equal(consolePage.launcherStarts, 1);
  assert.equal(consolePage.publicReads, 0, "console must not fetch public sensor data after migration");
  assert.deepEqual(consolePage.requests, ["/api/status"]);
  assert.equal(consolePage.failureElement.textContent, "", "absent modules are not failures");
  assert.equal(consolePage.adminOptions.authOnly, false);
}
const servicesFailure = await run(200, "broken-services", "console");
assert.equal(servicesFailure.launcherStarts, 1, "service rendering failure must not prevent launcher startup");
assert.deepEqual(servicesFailure.notices, [false]);
assert.match(servicesFailure.failureElement.textContent, /服务状态/);
const publicPresence = await run(200, "", "presence", true);
assert.equal(publicPresence.publicReads, 1);
assert.equal(publicPresence.chatStarts, 1);
assert.deepEqual(publicPresence.requests, [], "public presence must not use private status APIs");
assert.equal(publicPresence.failureElement.textContent, "");
const publicConsole = await run(200, "", "console", true);
assert.equal(publicConsole.publicReads, 0);
assert.equal(publicConsole.chatStarts, 0);
assert.deepEqual(publicConsole.requests, []);
const restoredConsole = await run(200, '', 'console', false, true, true);
assert.equal(restoredConsole.requests.filter(url=>url==='/api/status').length,2,'back-forward restored pages resume their scheduler');
assert.equal(restoredConsole.launcherStarts,1,'restoring a cached page must not duplicate module listeners');
console.log("console session recovery tests passed");
