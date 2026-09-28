import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 站点骨架一致性防线：六个主页面（首页/旅途/存在/控制台/关于/资源）的
   导航与页脚收束句必须完全一致——改导航只改一处即可，漏改任何一页
   本测试立刻失败，不再靠肉眼逐页核对。
   404/remote/debug-firefly/project 是刻意独立的页面（无导航/自定义布局），
   不在本集合内。 */

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const PAGES = ["index.html", "journal.html", "presence.html", "console.html", "about.html", "resources.html"];
const NAV_PAGES = [...PAGES, "observations.html"];

function read(name) {
  return fs.readFileSync(path.join(docs, name), "utf8");
}

function navInner(html) {
  const match = html.match(/<nav>([\s\S]*?)<\/nav>/i);
  if (!match) return "";
  return match[1]
    .replace(/\s+/g, " ")
    .replace(/ class="([^"]*)"/g, function (_all, cls) {
      // 当前页激活类允许各页不同，其余类必须一致
      const cleaned = cls.replace(/\bactive\b/, "").trim();
      return cleaned ? ' class="' + cleaned + '"' : "";
    })
    .trim();
}

function footerBrand(html) {
  const match = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i);
  if (!match) return "";
  return match[1]
    .replace(/<p[^>]*data-role="reflection-line"[\s\S]*?<\/p>/i, "")
    // data-role="footer-brand" 是日记页脚切换随笔/收束句的功能属性，允许页间差异
    .replace(/ data-role="footer-brand"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const navs = NAV_PAGES.map(function (name) { return navInner(read(name)); });
const footers = PAGES.map(function (name) { return footerBrand(read(name)); });

for (let i = 1; i < NAV_PAGES.length; i++) {
  assert.equal(navs[i], navs[0],
    "导航骨架不一致：" + NAV_PAGES[0] + " vs " + NAV_PAGES[i]);
}
for (let i = 1; i < PAGES.length; i++) {
  assert.equal(footers[i], footers[0],
    "页脚收束句不一致：" + PAGES[0] + " vs " + PAGES[i]);
}

assert.ok(navs[0].includes("grad-clip"), "导航链接必须带渐变工具类");
assert.ok(footers[0].includes("grad-clip grad-flame"), "收束句必须带火焰渐变工具类");

console.log("html skeleton ok: nav across " + NAV_PAGES.length +
  " pages; footer across " + PAGES.length + " pages");

// 页面职责与依赖随迁移一起受保护，避免误把大面板或脚本留在控制台。
const presence = read("presence.html");
const consolePage = read("console.html");
for (const role of ["sensor-grid", "audio-panel", "chat-log", "activity-panel"]) {
  assert.ok(presence.includes('data-role="' + role + '"'), role + " belongs on presence");
  assert.ok(!consolePage.includes('data-role="' + role + '"'), role + " must leave console");
}
for (const role of ["launcher-panel", "admin-panel"]) {
  assert.ok(consolePage.includes('data-role="' + role + '"'), role + " stays on console");
  assert.ok(!presence.includes('data-role="' + role + '"'), role + " must not be duplicated");
}
for (const name of ["sensor-state", "console-overview", "console-sensors", "console-audio-history", "console-audio", "console-chat", "console-dialogue", "console-activity"]) {
  assert.ok(presence.includes('assets/' + name + '.js?'), name + " loads on presence");
  assert.ok(!consolePage.includes('assets/' + name + '.js?'), name + " must not load on console");
}
assert.match(presence, /href="presence.html" class="active grad-clip grad-cool"/);
assert.match(consolePage, /href="console.html" class="active grad-clip grad-cool"/);

for (const action of ["audio", "listener"]) {
  assert.ok(presence.includes('data-action="' + action + '"'), action + " service button belongs on presence");
  assert.ok(!consolePage.includes('data-action="' + action + '"'), action + " service button must leave console");
}
for (const action of ["backend", "tunnel"]) {
  assert.ok(consolePage.includes('data-action="' + action + '"'), action + " service button stays on console");
  assert.ok(!presence.includes('data-action="' + action + '"'), action + " service button must not be duplicated");
}
