// Build step: the hidden one-renderer page (plan docs/plans/one-renderer.md, phases 1-5). Unlinked, noindex.
// Output: OUT/one-3c9d1f.html. Nothing touches "/" until phase 6.
const fs = require("fs"), path = require("path");
const OUT = process.argv[2], SLUG = "one-3c9d1f";
const src = path.join(OUT, "one", "page.html");
if (!fs.existsSync(src)) throw new Error("make_one: one/page.html missing");
fs.writeFileSync(path.join(OUT, SLUG + ".html"), fs.readFileSync(src, "utf8"));
fs.unlinkSync(src);
console.log("one-renderer page:", SLUG + ".html");
