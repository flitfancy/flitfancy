import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 全库 ?v= 资源版本一致性：8 个 HTML 的 42 处引用必须指向同一个版本。
   漏改任何一处（旧版本残留）会在此处立刻失败，而不是等浏览器缓存出问题。 */

const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const htmlFiles = fs.readdirSync(docsDir).filter((name) => name.endsWith(".html"));

const versions = new Set();
const refs = [];
for (const name of htmlFiles) {
  const content = fs.readFileSync(path.join(docsDir, name), "utf8");
  const re = /[?&]v=(\d+)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    versions.add(match[1]);
    refs.push(name + " -> v" + match[1]);
  }
}

assert.ok(versions.size > 0, "docs HTML 必须引用带版本号的资源");
assert.equal(versions.size, 1, "全库资源版本必须一致，发现多个版本：" + [...versions].join(", "));
console.log("version consistency ok: v" + [...versions][0] + " (" + refs.length + " refs in " + htmlFiles.length + " files)");
