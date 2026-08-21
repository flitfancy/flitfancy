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

const valueRule = ruleBody(".visit-ip-value");
assert.match(valueRule, /inline-size:\s*max-content/,
  "短 IP 应按内容自然占宽，不得跟随列宽提前折行");
assert.match(valueRule, /max-inline-size:\s*24ch/,
  "长 IPv6 必须在可控上限后换行，不能无限挤占其它列");
assert.match(valueRule, /white-space:\s*normal/);
assert.match(valueRule, /overflow-wrap:\s*anywhere/,
  "超长 IPv6 必须能在自身容器内安全换行");
assert.doesNotMatch(valueRule, /word-break:\s*break-all/,
  "IP 不得无上限地从任意字符处提前拆开");

const metaRule = ruleBody(".visit-ip-meta");
assert.match(metaRule, /display:\s*block/,
  "汇总信息应独占一行，不能继续扩张 IP 列宽");
assert.match(metaRule, /white-space:\s*nowrap/,
  "同 IP 汇总文字必须保持完整");

console.log("console visits narrow-panel layout test ok");
