import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const journal = read("../docs/journal.html");
const observations = read("../docs/observations-prototype.html");
const css = read("../docs/assets/style.css");

function journeyNav(html) {
  const match = html.match(/<nav[^>]*data-role="journey-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(match, "旅途相关页面必须使用共享的三项子导航");
  return match[1].replace(/\s+/g, " ");
}

for (const [name, html] of [["旅途", journal], ["见闻", observations]]) {
  const nav = journeyNav(html);
  assert.match(nav, /href="journal\.html#anchors"[^>]*>\s*锚点\s*</,
    `${name}页缺少锚点入口`);
  assert.match(nav, /href="journal\.html#flow"[^>]*>\s*日记\s*</,
    `${name}页缺少日记入口`);
  assert.match(nav, /href="observations-prototype\.html"[^>]*>\s*见闻\s*</,
    `${name}页缺少见闻入口`);
}

assert.match(css,
  /@media[^{}]*max-width:\s*640px[\s\S]*?\.journey-nav\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
  "手机端旅途三入口必须固定三等分，不能被挤出视口");
assert.match(journal, /data-tab="observations"/, "旅途管理侧栏必须有见闻标签");
assert.match(journal, /data-role="observation-new"/, "旅途管理侧栏必须有新增星球入口");

console.log("journey desktop/mobile entry contract test ok");
