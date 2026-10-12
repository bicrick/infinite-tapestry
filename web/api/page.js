const OWNER = (h) => String(h || "").toLowerCase() === "bicrick";   // never credited in previews
const { rest } = require("../lib/common");

// Same pages, per-link previews: /?at=A&to=B and /u/<handle> get their own og/twitter tags
// (a designed card of that exact spot, "by @handle"). The HTML is the static page with meta swapped.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function swap(html, m) {
  const set = (attr, key, val) => {
    const re = new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/?>`);
    const tag = `<meta ${attr}="${key}" content="${esc(val)}" />`;
    html = re.test(html) ? html.replace(re, tag) : html.replace("</head>", `  ${tag}\n</head>`);
  };
  set("property", "og:title", m.title); set("name", "twitter:title", m.title);
  set("property", "og:description", m.desc); set("name", "twitter:description", m.desc); set("name", "description", m.desc);
  set("property", "og:image", m.img); set("name", "twitter:image", m.img);
  set("property", "og:url", m.url); set("name", "twitter:card", "summary_large_image");
  if (m.title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`);
  return html;
}

module.exports = async (req, res) => {
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const kind = req.query.kind === "u" ? "u" : "at";
  const page = await fetch(`${host}/${kind === "u" ? "profile" : "index"}.html`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  if (!page) { res.setHeader("location", kind === "u" ? "/" : "/"); return res.status(302).end(); }
  let m = null;
  try {
    if (kind === "u") {
      const handle = String(req.query.handle || "").replace(/^@/, "");
      if (/^[A-Za-z0-9_]{2,20}$/.test(handle) && !OWNER(handle)) {
        const p = (await rest("GET", `profiles?handle=ilike.${encodeURIComponent(handle)}&select=handle`))[0];
        if (p) {
          const n = (await rest("GET", `ideas?handle=ilike.${encodeURIComponent(p.handle)}&status=in.(playing,played)&start_strip=not.is.null&select=id&limit=200`)).length;
          m = { title: `@${p.handle} on Infinite Tapestry`,
                desc: n ? `${n} idea${n === 1 ? "" : "s"} woven into an endless painting, steered by everyone watching.` : "Steering an endless painting, along with everyone watching.",
                img: `${host}/api/og?card=user&handle=${encodeURIComponent(p.handle)}`, url: `${host}/u/${encodeURIComponent(p.handle)}` };
        }
      }
    } else {
      const a = parseInt(req.query.at, 10), b = parseInt(req.query.to, 10);
      if (a >= 0) {
        const to = Number.isFinite(b) && b >= a ? Math.min(b, a + 63) : a + 7;
        const idea = (await rest("GET", `ideas?status=in.(playing,played)&start_strip=lte.${a + 3}&order=start_strip.desc&limit=1&select=handle,body,start_strip,end_strip,status`).catch(() => []))[0];
        const by = idea && (idea.end_strip != null ? a <= idea.end_strip : idea.status === "playing" && a <= idea.start_strip + 16) ? idea : null;
        m = { title: by ? clip(String(by.body).replace(/\s+/g, " ").trim(), 70) : "A moment from the Infinite Tapestry",
              desc: by && !OWNER(by.handle) ? `by @${by.handle} · Infinite Tapestry` : "An endless painting, steered by everyone watching.",
              img: `${host}/api/og?card=at&a=${a}&b=${to}`, url: `${host}/?at=${a}&to=${to}` };
      }
    }
  } catch (e) { console.error("page meta", e.message); }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=3600");
  res.status(200).send(m ? swap(page, m) : page);
};
