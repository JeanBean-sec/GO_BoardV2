#!/usr/bin/env node
/**
 * fix-ghpages-paths.js
 *
 * Run this once after every Webstudio republish, on the folder you're about
 * to commit to GitHub Pages (e.g. `docs/`):
 *
 *   node fix-ghpages-paths.js docs
 *
 * WHY THIS EXISTS:
 * Webstudio's export already includes a correct <base href="/GO_BoardV2/">
 * tag in the HTML head — but the individual asset/script references
 * (src="/assets/...", href="/assets/...", src="/board-live-feed.js") are
 * emitted as root-absolute paths, which completely bypass that <base> tag
 * (root-absolute references always resolve against the domain root,
 * ignoring <base>'s path). The fix is simple: strip the leading "/" so
 * these become plain-relative references instead, which DO correctly pick
 * up the <base> tag. This script does that stripping across every .html,
 * .js, and .css file it finds, since Webstudio regenerates all of these on
 * every export and any manual edit would just be overwritten next time.
 *
 * SAFE BY CONSTRUCTION: only three specific, known prefixes are targeted
 * (/assets/, /audio/, /board-live-feed.js) — the <base> tag's own
 * href="/GO_BoardV2/" doesn't match any of them and is left untouched.
 */

const fs = require("fs");
const path = require("path");

const targetDir = process.argv[2];
if (!targetDir) {
  console.error("Usage: node fix-ghpages-paths.js <folder>");
  console.error("Example: node fix-ghpages-paths.js docs");
  process.exit(1);
}

// Each pattern matches a quote character or CSS url( immediately followed
// by the absolute prefix, and drops just the leading "/" — e.g.
//   src="/assets/foo.svg"   -> src="assets/foo.svg"
//   href='/assets/foo.css'  -> href='assets/foo.css'
//   url(/assets/foo.png)    -> url(assets/foo.png)
const REPLACEMENTS = [
  [/(["'(])\/assets\//g, "$1assets/"],
  [/(["'(])\/audio\//g, "$1audio/"],
  [/(["'])\/board-live-feed\.js(["'])/g, "$1board-live-feed.js$2"],
];

const FILE_EXTENSIONS = /\.(html|js|css)$/i;

let filesChanged = 0;
let totalReplacements = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (FILE_EXTENSIONS.test(entry.name)) {
      fixFile(full);
    }
  }
}

function fixFile(file) {
  const original = fs.readFileSync(file, "utf8");
  let text = original;
  let fileReplacements = 0;

  for (const [pattern, replacement] of REPLACEMENTS) {
    const matches = text.match(pattern);
    if (matches) fileReplacements += matches.length;
    text = text.replace(pattern, replacement);
  }

  if (text !== original) {
    fs.writeFileSync(file, text);
    filesChanged++;
    totalReplacements += fileReplacements;
    console.log(`Fixed ${file} (${fileReplacements} reference${fileReplacements === 1 ? "" : "s"})`);
  }
}

if (!fs.existsSync(targetDir)) {
  console.error(`Folder not found: ${targetDir}`);
  process.exit(1);
}

walk(targetDir);
console.log(`\nDone — ${filesChanged} file(s) changed, ${totalReplacements} reference(s) fixed.`);
