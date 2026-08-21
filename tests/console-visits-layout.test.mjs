import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(
  new URL("../docs/assets/style.css", import.meta.url), "utf8"
);
const html = fs.readFileSync(
  new URL("../docs/console.html", import.meta.url), "utf8"
);

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
  assert.ok(match, `缺少样式规则：${selector}`);
  return match[1];
}

const panelRule = ruleBody(".visits-panel");
assert.match(panelRule, /container-name:\s*visits/,
  "访问记录应按自身宽度切换布局，而不是依赖整个窗口宽度");
assert.match(panelRule, /container-type:\s*inline-size/);

const tableRule = ruleBody(".visits-table");
assert.match(tableRule, /table-layout:\s*fixed/,
  "五列必须共享统一列宽模型，内容不得反向撑宽整张表");
assert.match(tableRule, /width:\s*100%/);
assert.match(tableRule, /min-width:\s*560px/);

assert.match(html, /<colgroup>[\s\S]*class="visits-col-time"[\s\S]*class="visits-col-ip"[\s\S]*class="visits-col-page"[\s\S]*class="visits-col-ref"[\s\S]*class="visits-col-device"[\s\S]*<\/colgroup>/,
  "表格列宽职责必须集中声明，不能散落在内容规则中");

const ipColumnRule = ruleBody(".visits-col-ip");
assert.match(ipColumnRule, /width:\s*clamp\(15ch,\s*22%,\s*24ch\)/,
  "IP 列应从完整 IPv4 宽度起，在有余量时适度扩张");
const timeColumnRule = ruleBody(".visits-col-time");
assert.match(timeColumnRule, /width:\s*clamp\(132px,\s*19%,\s*150px\)/,
  "时间列必须计入单元格内边距并随可用空间适度扩张");
const deviceColumnRule = ruleBody(".visits-col-device");
assert.match(deviceColumnRule, /width:\s*clamp\(112px,\s*15%,\s*132px\)/,
  "设备列必须完整容纳常见分辨率并随可用空间适度扩张");
const pageColumnRule = ruleBody(".visits-col-page");
assert.match(pageColumnRule, /width:\s*clamp\(72px,\s*12%,\s*96px\)/,
  "较短的页面列应限制宽度，让来源列独占剩余空间");
assert.doesNotMatch(css, /\.visits-col-ref\s*\{[^}]*width\s*:/,
  "来源列必须保持为唯一未指定宽度的列，以接收表格剩余空间");

const contentRule = ruleBody(".visit-ip-content");
assert.match(contentRule, /display:\s*block/);
assert.match(contentRule, /max-inline-size:\s*100%/,
  "IPv6 只能在已经分配的 IP 列内部换行");
assert.match(contentRule, /white-space:\s*normal/);
assert.match(contentRule, /overflow-wrap:\s*anywhere/,
  "超长 IPv6 必须能在自身容器内安全换行");
assert.doesNotMatch(contentRule, /max-content|32ch/,
  "IP 内容不能再参与决定整张表的固有宽度");

assert.match(css, /@container\s+visits\s+\(max-width:\s*559px\)/,
  "窄管理面板必须整体切换布局，不能继续横向藏掉设备列");
assert.match(css, /@container\s+visits[\s\S]*?\.visits-table\s*\{[^}]*min-width:\s*0/,
  "卡片模式必须取消桌面表格的最小宽度");

console.log("console visits responsive layout contract test ok");
