import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const journalHtml = read("../docs/journal.html");
const anchorsSource = read("../docs/assets/anchors.js");
const journalAdminSource = read("../docs/assets/journal-admin.js");
const aboutHtml = read("../docs/about.html");
const essaysSource = read("../docs/assets/essays.js");
const aboutAdminSource = read("../docs/assets/about-admin.js");

assert.match(journalHtml, /data-role="anchor-horizon"[\s\S]*value="now"[\s\S]*value="future"/,
  "锚点编辑器必须要求选择现在或未来");
assert.match(journalHtml, /data-role="anchor-project"[\s\S]*value="firefly"[\s\S]*value="skywork"[\s\S]*value="flitfancy"/,
  "锚点编辑器必须提供三个项目选项");
assert.match(journalAdminSource, /horizon:\s*\$\('\[data-role="anchor-horizon"\]'\)\.value/);
assert.match(journalAdminSource, /project:\s*\$\('\[data-role="anchor-project"\]'\)\.value/);
assert.match(anchorsSource, /data-filter="project"/,
  "公开锚点必须按项目筛选");
assert.match(anchorsSource, /data-filter="horizon"/,
  "公开锚点必须按现在或未来筛选");
assert.match(anchorsSource, /anchor-badge/,
  "锚点卡片必须同时显示项目和时间视角文字徽章");

assert.match(aboutHtml, /<a href="about\.html" class="active[^>]*>关于<\/a>/,
  "关于页必须通过当前激活导航提供管理入口");
assert.doesNotMatch(aboutHtml, /data-role="essay-manage-open"/,
  "访客正文不应再放置单独的短文管理按钮");
assert.match(aboutHtml, /序章[\s\S]*data-role="essay-list"/,
  "原文章必须固定保留为序章，新短文另列展示");
assert.match(essaysSource, /https:\/\/api\.flitfancy\.com\/essays/,
  "公网短文必须从独立公开接口读取");
assert.match(aboutAdminSource, /\/api\/admin\/essays/,
  "短文管理必须读取包含草稿和归档的独立记录库");
assert.match(aboutAdminSource, /\/api\/essays/,
  "短文保存必须走独立写入接口，不能复用 120 字随笔");
assert.match(aboutHtml, /value="draft"[\s\S]*value="public"[\s\S]*value="archived"/,
  "短文必须支持草稿、公开和归档状态");

console.log("content taxonomy and essay UI contract test ok");
