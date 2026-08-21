import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(
  new URL("../docs/assets/style.css", import.meta.url), "utf8"
);

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
  assert.ok(match, `缺少样式规则：${selector}`);
  return match[1];
}

const ipRule = ruleBody(".visits-table td.visit-ip");
assert.match(ipRule, /white-space:\s*nowrap/,
  "IP 在管理面板收窄时不得先折成多行");
assert.doesNotMatch(ipRule, /word-break:\s*break-all/,
  "IP 不得从任意字符处拆开");

const groupedIpRule = ruleBody(".visits-table tr.visit-collapsed-row td.visit-ip");
assert.doesNotMatch(groupedIpRule, /white-space:\s*normal|word-break:\s*break-all/,
  "同 IP 汇总行不得覆盖基础 IP 单行规则");

console.log("console visits narrow-panel layout test ok");
