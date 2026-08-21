import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/about.js", import.meta.url), "utf8"
);
const line = { hidden: true };
const text = { textContent: "" };
let requestedUrl = "";
const fixedMath = Object.create(Math);
fixedMath.random = () => 0.5;

vm.runInNewContext(source, {
  document: {
    querySelector(selector) {
      if (selector === '[data-role="reflection-line"]') return line;
      if (selector === '[data-role="reflection-text"]') return text;
      return null;
    },
    addEventListener() {},
  },
  location: { hostname: "flitfancy.com" },
  fetch: async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      async json() {
        return { reflections: ["第一句", "第二句", "第三句"] };
      },
    };
  },
  Math: fixedMath,
  setTimeout: () => 0,
  clearTimeout: () => {},
  AbortController: AbortController,
});

await new Promise((resolve) => setImmediate(resolve));
assert.equal(requestedUrl, "https://api.flitfancy.com/config");
assert.equal(text.textContent, "第二句");
assert.equal(line.hidden, false);

console.log("about reflections random display test ok");
