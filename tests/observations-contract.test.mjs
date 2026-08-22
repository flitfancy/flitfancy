import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../docs/observations.html");
const source = read("../docs/assets/observations.js");
const css = read("../docs/assets/observations.css");
const journal = read("../docs/journal.html");
const admin = read("../docs/assets/observations-admin.js");

assert.match(html, /<canvas id="sky"/, "正式见闻页必须复用全站星空、萤火虫和流星画布");
assert.match(html, /data-role="journey-nav"[\s\S]*锚点[\s\S]*日记[\s\S]*见闻/);
assert.match(html, /assets\/firefly\.js[\s\S]*assets\/sitefx\.js[\s\S]*assets\/observations\.js/);
assert.doesNotMatch(html + source + css, /PROTOTYPE|假数据|variant-[abc]|variant-prev|variant-next/i,
  "正式页不能残留原型切换器或假数据标记");
assert.doesNotMatch(html + source, /检索星球|data-role="search"|data-role="date-from"/,
  "访客界面不显示关键词或日期检索面板");
assert.match(source, /https:\/\/api\.flitfancy\.com\/observations/,
  "公网星图必须从独立公开接口读取真实数据");
assert.match(source, /function stablePosition\(/,
  "星球坐标必须继续由 UID 稳定生成");
assert.match(source, /data\.links/, "公开星图必须使用独立的弦数据模型");
assert.match(source, /星海里还没有见闻|第一颗星球/,
  "空数据必须显示自然的空星图提示");
assert.match(css, /--planet-size:\s*clamp\(104px,\s*12vw,\s*148px\)/,
  "正式星球应比原型更大");

for (const role of [
  "observation-new", "observation-title", "observation-category", "observation-tags",
  "observation-summary", "observation-content", "observation-discovered",
  "observation-source-name", "observation-source-url", "observation-status",
  "observation-link-source", "observation-link-target", "observation-link-relation",
  "observation-link-custom", "observation-link-search",
]) {
  assert.match(journal, new RegExp(`data-role="${role}"`), `旅途管理缺少 ${role}`);
}
assert.match(journal, /同源[\s\S]*因果[\s\S]*类比[\s\S]*延伸[\s\S]*自定义/,
  "弦关系必须提供四个内置词和自定义选项");
assert.match(admin, /\/api\/admin\/observations/);
assert.match(admin, /\/api\/admin\/observation-links/);
assert.match(admin, /\/api\/observations/);
assert.match(admin, /\/api\/observation-links/);

console.log("formal observations UI and admin contract test ok");
