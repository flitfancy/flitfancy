import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../docs/assets/console.js", import.meta.url), "utf8");
async function run(status, fault = "") {
  const notices = [], timers = [];
  let audioStarts = 0, sensorRenders = 0, retries = 0;
  const statusElement = { textContent: "" };
  const noop = function () {};
  const chat = { start: noop, setEnabled: noop, refreshPublicConfig: noop };
  const window = {
    FlitFancySensorState: {}, FlitFancyConsoleOverview: {},
    FlitFancyPanelShell: {}, FlitFancyVisits: {},
    FlitFancyAdmin: {
      isAdminHost: () => true, installErrorHandler: noop,
      isUnauthorized: error => error.status === 401,
      request: async (url) => {
        if (url === "/api/status" && status !== 200) {
          const error = new Error("request failed"); error.status = status; throw error;
        }
        return url === "/api/status" ? { services: { backend: true } } : { rows: [] };
      },
    },
    FlitFancyConsoleServices: { create: () => ({ update: noop, setProtocolName: noop }) },
    FlitFancyConsoleSensors: { create: () => ({ render: () => { sensorRenders++; }, notePressure: noop }) },
    FlitFancyConsoleAdmin: { create: () => ({
      start: noop, token: () => "", setLoginRequired: value => notices.push(value),
    }) },
    FlitFancyConsoleDialogue: { create: () => chat },
    FlitFancyConsoleAudio: { create: () => ({ start: () => { audioStarts++; } }) },
    FlitFancyConsoleLauncher: { create: () => ({ start: noop, refresh: noop, clearPrivate: noop }) },
  };
  if (fault === "missing-dialogue") delete window.FlitFancyConsoleDialogue;
  if (fault === "broken-dialogue") window.FlitFancyConsoleDialogue.create = () => { throw new Error("broken module"); };
  if (fault === "broken-services") window.FlitFancyConsoleServices.create = () => ({ update() { throw new Error("render failed"); } });
  if (fault === "missing-core") delete window.FlitFancyAdmin;
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
      querySelector: selector => selector.includes("module-error-text") ? failureElement :
        selector.includes('"status"') ? statusElement : { classList: { toggle: noop }, addEventListener: noop },
    },
    fetch: async () => ({ ok: true, json: async () => ({ rows: [] }) }),
    setInterval: callback => timers.push(callback),
  });
  await new Promise(resolve => setImmediate(resolve));
  return { notices, statusElement, audioStarts, sensorRenders, failureElement, retries };
}
const unauthorized = await run(401);
assert.deepEqual(unauthorized.notices, [true], "401 must close the management panel while preserving the hidden login entry");
assert.match(unauthorized.statusElement.textContent, /登录/);
assert.deepEqual((await run(200)).notices, [false], "successful refresh must clear login-required state");
assert.deepEqual((await run(503)).notices, [], "server failure must not be misidentified as a login failure");
for (const fault of ["missing-dialogue", "broken-dialogue", "broken-services"]) {
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
console.log("console session recovery tests passed");
