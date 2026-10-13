const { SITE_URL, rest } = require("../lib/common");
const seo = require("../lib/seo");

// /sitemap.xml (index), /sitemap-pages.xml, /sitemap-scenes-<n>.xml, /robots.txt (see vercel.json rewrites).
// Scenes: played, painted, public ideas only (no owner/QA/test prompts). Everything derives from SITE_URL.
const PER = 1000;
const x = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const iso = (d) => { const t = new Date(d); return isNaN(t) ? null : t.toISOString(); };
const STATIC = [["/", "always", "1.0"], ["/about", "weekly", "0.9"], ["/time-machine", "daily", "0.7"], ["/privacy", "yearly", "0.2"], ["/terms", "yearly", "0.2"]];
const BUILT = process.env.VERCEL_GIT_COMMIT_SHA ? new Date().toISOString() : null;

async function scenes() {
  const out = [];
  for (let off = 0; off < 20000; off += 1000) {
    const rows = await rest("GET", `ideas?status=eq.played&start_strip=not.is.null&order=id.asc&limit=1000&offset=${off}&select=id,handle,body,status,start_strip,played_at`).catch(() => null);
    if (!Array.isArray(rows)) break;
    out.push(...rows.filter(seo.isIndexable));
    if (rows.length < 1000) break;
  }
  return out;
}

function send(res, body, type = "application/xml; charset=utf-8") {
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).send(body);
}
const urlset = (urls) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `<url><loc>${x(u.loc)}</loc>${u.mod ? `<lastmod>${u.mod}</lastmod>` : ""}${u.freq ? `<changefreq>${u.freq}</changefreq>` : ""}${u.pri ? `<priority>${u.pri}</priority>` : ""}</url>`).join("\n") + `\n</urlset>\n`;

module.exports = async (req, res) => {
  const site = SITE_URL();
  const q = req.query || {};
  if (q.kind === "robots") {
    return send(res, `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /auth/\nAllow: /api/og\n\nSitemap: ${site}/sitemap.xml\n`, "text/plain; charset=utf-8");
  }
  if (q.kind === "pages") {
    const all = await scenes();
    const newest = all.reduce((m, i) => (i.played_at > m ? i.played_at : m), "");
    return send(res, urlset(STATIC.map(([p, freq, pri]) => ({ loc: `${site}${p}`, freq, pri,
      mod: p === "/" || p === "/time-machine" ? iso(newest || Date.now()) : BUILT && p === "/about" ? BUILT : null }))));
  }
  const all = await scenes();
  if (q.kind === "scenes") {
    const n = Math.max(1, parseInt(q.n, 10) || 1);
    const page = all.slice((n - 1) * PER, n * PER);
    if (!page.length && n > 1) return res.status(404).send("not found");
    return send(res, urlset(page.map((i) => ({ loc: `${site}/s/${Number(i.id)}`, mod: iso(i.played_at), freq: "yearly", pri: "0.6" }))));
  }
  const pages = Math.max(1, Math.ceil(all.length / PER));
  const newest = iso(all.reduce((m, i) => (i.played_at > m ? i.played_at : m), "") || Date.now());
  const maps = [{ loc: `${site}/sitemap-pages.xml`, mod: newest }];
  for (let n = 1; n <= pages; n++) {
    const sl = all.slice((n - 1) * PER, n * PER);
    maps.push({ loc: `${site}/sitemap-scenes-${n}.xml`, mod: iso(sl.reduce((m, i) => (i.played_at > m ? i.played_at : m), "")) || newest });
  }
  return send(res, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    maps.map((m) => `<sitemap><loc>${x(m.loc)}</loc><lastmod>${m.mod}</lastmod></sitemap>`).join("\n") + `\n</sitemapindex>\n`);
};
