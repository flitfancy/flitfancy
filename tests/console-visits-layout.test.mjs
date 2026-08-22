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
assert.match(tableRule, /--visits-cell-pad-inline:\s*12px/,
  "表格列宽与单元格必须共享同一个横向内边距变量");
assert.doesNotMatch(tableRule, /--visits-cell-inline-space/,
  "表格列不再通过间接数学表达式计算内边距");
assert.match(tableRule, /min-width:\s*700px/);

assert.match(html, /<colgroup>[\s\S]*class="visits-col-time"[\s\S]*class="visits-col-ip"[\s\S]*class="visits-col-page"[\s\S]*class="visits-col-ref"[\s\S]*class="visits-col-device"[\s\S]*<\/colgroup>/,
  "表格列宽职责必须集中声明，不能散落在内容规则中");

const columnShares = [
  [".visits-col-time", 19],
  [".visits-col-ip", 20],
  [".visits-col-page", 18],
  [".visits-col-ref", 24],
  [".visits-col-device", 19]
];
let totalColumnShare = 0;
for (const [selector, expectedShare] of columnShares) {
  const columnRule = ruleBody(selector);
  assert.doesNotMatch(columnRule, /\b(?:clamp|calc|min|max|var)\s*\(/,
    `${selector} 不能在表格列宽中使用数学函数，否则浏览器可以按 auto 处理`);
  const widthMatch = columnRule.match(/width:\s*(\d+(?:\.\d+)?)%/);
  assert.ok(widthMatch, `${selector} 必须使用直接百分比宽度`);
  const actualShare = Number(widthMatch[1]);
  assert.equal(actualShare, expectedShare, `${selector} 的列宽比例不符合统一模型`);
  totalColumnShare += actualShare;
}
assert.equal(totalColumnShare, 100, "五列宽度比例总和必须正好为 100%");

const cellRuleMatch = css.match(/\.visits-table th,\s*\.visits-table td\s*\{([^}]*)\}/);
assert.ok(cellRuleMatch, "缺少访问记录单元格样式");
assert.match(cellRuleMatch[1], /padding:\s*8px\s+var\(--visits-cell-pad-inline\)/,
  "单元格实际内边距必须使用列宽模型中的同一变量");

const contentRule = ruleBody(".visit-ip-content");
assert.match(contentRule, /display:\s*block/);
assert.match(contentRule, /max-inline-size:\s*100%/,
  "IPv6 只能在已经分配的 IP 列内部换行");
assert.match(contentRule, /white-space:\s*normal/);
assert.match(contentRule, /overflow-wrap:\s*anywhere/,
  "超长 IPv6 必须能在自身容器内安全换行");
assert.doesNotMatch(contentRule, /max-content|32ch/,
  "IP 内容不能再参与决定整张表的固有宽度");

assert.match(css, /@container\s+visits\s+\(max-width:\s*699px\)/,
  "窄管理面板必须整体切换布局，不能继续横向藏掉设备列");
assert.match(css, /@container\s+visits[\s\S]*?\.visits-table\s*\{[^}]*min-width:\s*0/,
  "卡片模式必须取消桌面表格的最小宽度");

console.log("console visits responsive layout contract test ok");
