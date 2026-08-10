const fs = require("fs");
const path = require("path");

const assetsDir = path.resolve("assets");

if (!fs.existsSync(assetsDir)) {
  console.error(`Assets directory not found:\n${assetsDir}`);
  process.exit(1);
}

let patched = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(filePath);
      continue;
    }

    if (!entry.name.endsWith(".js")) continue;

    let content = fs.readFileSync(filePath, "utf8");

    // Only modify the Vite module-preload helper.
    const oldCode = 'const Ln = function (e) {\\n  return "/" + e;\\n};';
    const newCode = 'const Ln = function (e) {\\n  return "/GO_BoardV2/" + e;\\n};';

    if (content.includes(oldCode)) {
      content = content.replaceAll(oldCode, newCode);
      fs.writeFileSync(filePath, content);

      console.log(`PATCHED: ${path.relative(process.cwd(), filePath)}`);
      patched++;
    }
  }
}

walk(assetsDir);

console.log(`\\nDone. Patched ${patched} file(s).`);