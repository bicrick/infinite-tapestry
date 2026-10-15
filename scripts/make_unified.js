// Build step: derive the hidden unified-viewer page from the live index.html (so it never drifts from production).
// The live page itself is not touched. Output: OUT/u-9b600a56.html (noindex, no canonical, unlinked).
const fs = require("fs"), path = require("path");
const OUT = process.argv[2], SLUG = "u-9b600a56";
let s = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
s = s.replace(/<link rel="canonical"[^>]*>\s*/, "")
  .replace(/<meta name="robots"[^>]*>/, '<meta name="robots" content="noindex, nofollow, noarchive" />')
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/, "")
  .replace("</head>", '  <link rel="stylesheet" href="u.css" />\n</head>');
const overlay = fs.readFileSync(path.join(__dirname, "unified_overlay.html"), "utf8");
s = s.replace(/(\s*<script src="mobile\.js")/, `\n${overlay}\n  <script src="unified.js"></script>$1`);
if (!s.includes("unified.js")) throw new Error("make_unified: anchor not found");
fs.writeFileSync(path.join(OUT, SLUG + ".html"), s);
console.log("unified page:", SLUG + ".html");
