import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const presence = fs.readFileSync(new URL("../docs/presence.html", import.meta.url), "utf8");
const consolePage = fs.readFileSync(new URL("../docs/console.html", import.meta.url), "utf8");
const sensorPosition = presence.indexOf('id="sensor-panel"');
const flitimePosition = presence.indexOf('id="flitime-panel"');
const audioPosition = presence.indexOf('id="audio-panel"');
assert(sensorPosition >= 0 && flitimePosition > sensorPosition && audioPosition > flitimePosition,
  "Flitime belongs between reality sensing and audio on the presence page");
assert.match(presence, /data-flitime="form"/);
assert.match(presence, /assets\/console-bridge\.css\?v=/);
assert.match(presence, /assets\/console-flitime\.js\?v=/);
assert.doesNotMatch(consolePage, /data-flitime="form"|assets\/console-flitime\.js\?v=/);

const elements = {
  form: { addEventListener(_name, fn) { this.submit = fn; } },
  ip: { value: "" },
  message: { textContent: "" },
};
let saved = "192.0.2.10", opened = "";
const window = {
  localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } },
  open: (url) => { opened = url; },
};
vm.runInNewContext(fs.readFileSync(new URL("../docs/assets/console-flitime.js", import.meta.url), "utf8"), {
  window,
  document: { querySelector: (selector) => elements[selector.match(/data-flitime="([^"]+)"/)[1]] },
});
assert.equal(elements.ip.value, saved);
const submit = () => elements.form.submit({ preventDefault() {} });
elements.ip.value = "192.0.2.10/path";
submit();
assert.equal(opened, "", "arbitrary paths must not become a navigation target");
assert.match(elements.message.textContent, /IP/);
elements.ip.value = "192.0.2.10";
submit();
assert.equal(opened, "http://192.0.2.10/update");
assert.equal(saved, "192.0.2.10");
console.log("Flitime presence link checks passed");
