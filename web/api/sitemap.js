const { SITE_URL, rest } = require("../lib/common");

// /sitemap.xml and /robots.txt (see vercel.json rewrites). Both derive from SITE_URL.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

module.exports = async (req, res) => {
  const site = SITE_URL();
  if (req.query && req.query.kind === "robots") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "public, s-maxage=3600");
    return res.status(200).send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /auth/\n\nSitemap: ${site}/sitemap.xml\n`);
  }
  const ideas = await rest("GET", "ideas?status=eq.played&start_strip=not.is.null&order=played_at.desc&limit=500&select=id,played_at").catch(() => []);
  const urls = [
    { loc: `${site}/`, freq: "always", pri: "1.0" },
    { loc: `${site}/about`, freq: "weekly", pri: "0.8" },
    { loc: `${site}/time-machine`, freq: "daily", pri: "0.6" },
    { loc: `${site}/privacy`, freq: "yearly", pri: "0.2" },
    { loc: `${site}/terms`, freq: "yearly", pri: "0.2" },
    ...(Array.isArray(ideas) ? ideas : []).map((i) => ({ loc: `${site}/s/${Number(i.id)}`, mod: i.played_at, freq: "never", pri: "0.5" })),
  ];
  res.setHeader("content-type", "application/xml; charset=utf-8");
  res.setHeader("cache-control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `<url><loc>${esc(u.loc)}</loc>${u.mod ? `<lastmod>${esc(new Date(u.mod).toISOString())}</lastmod>` : ""}<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join("\n") +
    `\n</urlset>\n`);
};
