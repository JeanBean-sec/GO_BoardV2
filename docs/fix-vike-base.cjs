const fs = require("fs");
const path = require("path");

const file = path.resolve(
  "assets",
  "entries",
  "entry-server-routing.DDgKCHFx.js"
);

if (!fs.existsSync(file)) {
  console.error(`File not found:\n${file}`);
  process.exit(1);
}

let content = fs.readFileSync(file, "utf8");

const oldCode = 'return "/" + e;';
const newCode = 'return "/GO_BoardV2/" + e;';

if (!content.includes(oldCode)) {
  console.log("Target code was not found. Nothing changed.");
  process.exit(0);
}

content = content.replace(oldCode, newCode);

fs.writeFileSync(file, content);

console.log(`Fixed Vike base path in:\n${file}`);