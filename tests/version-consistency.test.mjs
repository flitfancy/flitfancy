import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* cloudflare/package.json 是发布版本的单一出处；全部 HTML 资源引用必须
   使用同一个语义化版本。漏改任何一处会在 check 中立即失败。 */

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
console.log("version consistency ok: v" + packageJson.version + " (" + refs.length + " refs in " + htmlFiles.length + " files)");
