import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* cloudflare/package.json 是发布版本的单一出处；全部 HTML 资源引用、
   CHANGELOG 最新条目与发布标签必须使用同一个语义化版本。 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(rootDir, "docs");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(rootDir, "cloudflare", "package.json"), "utf8")
);
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, "package version 必须是语义化版本");
const htmlFiles = fs.readdirSync(docsDir).filter((name) => name.endsWith(".html"));

const versions = new Set();
const refs = [];
for (const name of htmlFiles) {
  const content = fs.readFileSync(path.join(docsDir, name), "utf8");
  const re = /[?&]v=(\d+\.\d+\.\d+)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    versions.add(match[1]);
    refs.push(name + " -> v" + match[1]);
  }
}

assert.ok(versions.size > 0, "docs HTML 必须引用带版本号的资源");
assert.equal(versions.size, 1, "全库资源版本必须一致，发现多个版本：" + [...versions].join(", "));
assert.equal([...versions][0], packageJson.version, "资源版本必须与 package version 一致");

const changelog = fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
const changelogVersion = changelog.match(/^## v(\d+\.\d+\.\d+)\b/m)?.[1];
assert.ok(changelogVersion, "CHANGELOG 必须包含 ## vMAJOR.MINOR.PATCH 条目");
assert.equal(
  changelogVersion,
  packageJson.version,
  "CHANGELOG 最新版本必须与 package version 一致"
);

const releaseTag = (process.env.RELEASE_TAG || "").trim();
if (releaseTag) {
  assert.match(releaseTag, /^v\d+\.\d+\.\d+$/, "发布标签必须使用 vMAJOR.MINOR.PATCH");
  assert.equal(releaseTag, "v" + packageJson.version, "发布标签必须与 package version 一致");
}

console.log(
  "version consistency ok: v" + packageJson.version +
  " (" + refs.length + " refs in " + htmlFiles.length + " files" +
  (releaseTag ? ", tag " + releaseTag : "") + ")"
);
