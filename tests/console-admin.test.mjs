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
