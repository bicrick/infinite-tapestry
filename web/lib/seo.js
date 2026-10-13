// SEO helpers shared by server-rendered pages and the sitemap.
// Public-indexable scenes: played, painted, not the owner's/admin test runs, not QA/test/junk prompts.
const OWNER = (h) => String(h || "").split(",").some((x) => x.trim().replace(/^@/, "").toLowerCase() === "bicrick");
const TESTY = /^\s*(qa|test|testing|smoke|debug)\b|\b(qa [a-z]?\d|test idea|smoke test|ignore this)\b|^[\d\s.,-]+$|^(.)\1{3,}$/i;
const isIndexable = (i) => !!i && i.status === "played" && i.start_strip != null && !OWNER(i.handle) && !TESTY.test(String(i.body || "")) && String(i.body || "").trim().length >= 3;
function TESTY_(s) { return TESTY.test(s); }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// JSON-LD safe for inline <script>: no "</" breakouts.
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const ORG = (site) => ({ "@type": "Organization", "@id": `${site}/#org`, name: "Infinite Tapestry", url: `${site}/`, logo: `${site}/brand/icon-512.png`, email: "support@infinitetapestry.app" });
module.exports = { isIndexable: (i) => isIndexable(i), isTesty: TESTY_, OWNER, esc, ld, ORG };
