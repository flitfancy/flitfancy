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

const contentRule = ruleBody(".visit-ip-content");
assert.match(contentRule, /inline-size:\s*max-content/,
  "短 IP 与汇总文字必须按自然宽度排版，不得参与列宽压缩");
assert.match(contentRule, /max-inline-size:\s*32ch/,
  "长 IPv6 必须在可控上限后换行，不能无限挤占其它列");
assert.match(contentRule, /white-space:\s*normal/);
assert.match(contentRule, /overflow-wrap:\s*anywhere/,
  "超长 IPv6 必须能在自身容器内安全换行");
assert.doesNotMatch(contentRule, /word-break:\s*break-all/,
  "IP 不得无上限地从任意字符处提前拆开");

console.log("console visits narrow-panel layout test ok");
