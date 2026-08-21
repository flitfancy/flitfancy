import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 站点骨架一致性防线：五个主页面（首页/旅途/控制台/关于/资源）的
   导航与页脚收束句必须完全一致——改导航只改一处即可，漏改任何一页
   本测试立刻失败，不再靠肉眼逐页核对。
   404/remote/debug-firefly/project 是刻意独立的页面（无导航/自定义布局），
   不在本集合内。 */

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const PAGES = ["index.html", "journal.html", "console.html", "about.html", "resources.html"];

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

const navs = PAGES.map(function (name) { return navInner(read(name)); });
const footers = PAGES.map(function (name) { return footerBrand(read(name)); });

for (let i = 1; i < PAGES.length; i++) {
  assert.equal(navs[i], navs[0],
    "导航骨架不一致：" + PAGES[0] + " vs " + PAGES[i]);
  assert.equal(footers[i], footers[0],
    "页脚收束句不一致：" + PAGES[0] + " vs " + PAGES[i]);
}

assert.ok(navs[0].includes("grad-clip"), "导航链接必须带渐变工具类");
assert.ok(footers[0].includes("grad-clip grad-flame"), "收束句必须带火焰渐变工具类");

console.log("html skeleton ok: nav/footer identical across " + PAGES.length + " pages");
