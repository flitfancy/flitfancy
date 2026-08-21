import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/console-overview.js", import.meta.url), "utf8"
);
const window = {};
vm.runInNewContext(source, { window });

const trend = window.FlitFancyConsoleOverview.pressureTrendText;
assert.equal(trend([]), "");
assert.equal(trend(Array.from({ length: 21 }, () => ({ pressure_pa: 100000 }))),
  "气压 3h 趋势：平稳");

const rising = Array.from({ length: 21 }, (_, index) => ({
  pressure_pa: index >= 18 ? 100200 : 100000,
}));
assert.match(trend(rising), /↑ \+2\.0 hPa/);

const falling = Array.from({ length: 21 }, (_, index) => ({
  pressure_pa: index >= 18 ? 99800 : 100000,
}));
assert.match(trend(falling), /↓ -2\.0 hPa/);

console.log("console overview module test ok");
