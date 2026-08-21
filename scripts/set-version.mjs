import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nextVersion = process.argv[2] || "";
if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  throw new Error("版本号必须使用 MAJOR.MINOR.PATCH，例如 1.0.1");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "cloudflare", "package.json");
const docsDir = path.join(root, "docs");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const htmlFiles = fs.readdirSync(docsDir).filter((name) => name.endsWith(".html"));
const versionPattern = /([?&]v=)(\d+(?:\.\d+\.\d+)?)/g;

let referenceCount = 0;
const htmlUpdates = htmlFiles.map((name) => {
  const filePath = path.join(docsDir, name);
  const source = fs.readFileSync(filePath, "utf8");
  const content = source.replace(versionPattern, (_, prefix) => {
    referenceCount += 1;
    return prefix + nextVersion;
  });
  return { filePath, source, content };
});

if (referenceCount === 0) {
  throw new Error("docs HTML 中没有找到任何 ?v= 资源引用");
}

packageJson.version = nextVersion;
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");
for (const update of htmlUpdates) {
  if (update.content !== update.source) {
    fs.writeFileSync(update.filePath, update.content, "utf8");
  }
}

console.log(`version set to ${nextVersion}: ${referenceCount} asset refs in ${htmlFiles.length} HTML files`);
