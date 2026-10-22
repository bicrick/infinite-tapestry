#!/usr/bin/env node
// Build step: stamp the shared header/footer (web/lib/chrome.js) into every built static page.
const fs = require("fs"), path = require("path");
const C = require(path.join(__dirname, "..", "web", "lib", "chrome.js"));
const out = process.argv[2];
let n = 0;
for (const f of fs.readdirSync(out).filter((x) => x.endsWith(".html"))) {
  const p = path.join(out, f); let s = fs.readFileSync(p, "utf8"); const o = s;
  s = s.replace(/<!--chrome:header( overlay)?-->/g, (_, ov) => C.header({ overlay: !!ov }))
       .replace(/<!--chrome:footer-->/g, C.footer()).replace(/<!--chrome:head-->/g, C.head()).replace(/<!--chrome:scripts-->/g, C.scripts());
  if (s !== o) { fs.writeFileSync(p, s); n++; }
}
console.log(`chrome stamped into ${n} pages`);
