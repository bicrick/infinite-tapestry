const chrome = require("../lib/chrome");
const OWNER = (h) => String(h || "").toLowerCase() === "bicrick";   // never credited
const { env, rest, SITE_URL } = require("../lib/common");
const seo = require("../lib/seo");

// /s/<idea id> or /s/<a>-<b> (a strip range): a standalone scene page with the strips (R2), title, prompt,
// who suggested it, when it played, and links to watch live / replay. OG + Twitter meta for unfurls.
// Moderation: only pending/playing/played ideas are ever shown (rejected, withdrawn, expired and
// shadow-muted ideas never are; shadow ideas live in a separate table).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clip = (s, n) => {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).trimEnd() + "…";
};
const SESSION = () => env("TAPESTRY_STORAGE_PREFIX", "live-sdxl");
const CDN = () => env("R2_PUBLIC_URL", "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev").replace(/\/$/, "");
const stripUrl = (i) => `${CDN()}/${SESSION()}/strips/${String(i).padStart(8, "0")}.webp`;
const isGuest = (h) => /^[a-z]+-\d{4}$/.test(String(h || ""));
function credit(by, origin) {
  const hs = String(by || "").split(",").map((h) => h.trim().replace(/^@/, "")).filter((h) => h && !OWNER(h));
  if (origin === "auto" || !hs.length) return "Auto";
  return "a viewer";   // public pages never print handles or emails
}
const fmtEta = (s) => (s == null ? "" : s < 60 ? "any moment" : s < 3600 ? `about ${Math.round(s / 60)} min` : `about ${Math.round(s / 360) / 10} h`);

async function strips(a, b) {
  return rest("GET", `strips?session=eq.${encodeURIComponent(SESSION())}&idx=gte.${a}&idx=lte.${b}&order=idx.asc&select=idx,created_at,scene`).catch(() => []);
}

function page(res, host, m, status = 200) {
  const imgs = (m.strips || []).slice(0, 10);
  const site = SITE_URL();
  const url = `${site}${m.path}`;
  const noindex = status !== 200 || m.noindex;
  const alt = `${m.title}, a scene from the Infinite Tapestry endless AI painting`;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", m.cache || "public, s-maxage=60, stale-while-revalidate=600");
  res.status(status).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(clip(m.title, 62))} · Infinite Tapestry</title>
<meta name="description" content="${esc(m.desc)}" />
<link rel="canonical" href="${esc(url)}" />
${noindex ? '<meta name="robots" content="noindex, follow" />' : '<meta name="robots" content="index, follow, max-image-preview:large" />'}
${m.prev ? `<link rel="prev" href="${esc(site + m.prev)}" />` : ""}${m.next ? `<link rel="next" href="${esc(site + m.next)}" />` : ""}
<meta property="og:type" content="article" /><meta property="og:site_name" content="Infinite Tapestry" />
<meta property="og:title" content="${esc(m.title)}" /><meta property="og:description" content="${esc(m.desc)}" />
<meta property="og:image" content="${esc(m.og)}" /><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${esc(alt)}" />
<meta property="og:url" content="${esc(url)}" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(m.title)}" />
<meta name="twitter:description" content="${esc(m.desc)}" /><meta name="twitter:image" content="${esc(m.og)}" /><meta name="twitter:image:alt" content="${esc(alt)}" />
${m.at ? `<meta property="article:published_time" content="${esc(new Date(m.at).toISOString())}" />` : ""}
${!noindex && m.ld ? seo.ld(m.ld(site, url, imgs.map((i) => stripUrl(i)))) : ""}
<link rel="preconnect" href="${esc(CDN())}" crossorigin />
<link rel="icon" href="/brand/mark.svg" type="image/svg+xml" />
${chrome.head()}
<style>
:root{color-scheme:dark;--bg:#070707;--fg:#e8e6e3;--mu:rgba(232,230,227,.66);--ln:rgba(232,230,227,.12);--hv:rgba(232,230,227,.06)}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#fbfaf8;--fg:#141414;--mu:rgba(20,20,20,.7);--ln:rgba(20,20,20,.12);--hv:rgba(20,20,20,.05)}.art{background:#e9e7e3!important}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:12px 20px 8px}
.art{display:flex;overflow:hidden;width:100%;height:clamp(220px,52vw,380px);margin:8px 0 22px;border-radius:14px;background:#111;mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)}
.art img{height:100%;width:auto;flex:none;object-fit:cover;object-position:left center}.art img:first-child{margin-left:0}
.art.empty{display:grid;place-items:center;color:var(--mu);font-size:13px;mask-image:none}
h1{font-size:22px;font-weight:500;letter-spacing:-.01em;margin:0 0 6px}
.meta{color:var(--mu);font-size:13px}.p{color:var(--mu);margin:14px 0 0;font-size:13px}
main .acts{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
main .acts a{color:var(--fg);text-decoration:none;border:1px solid var(--ln);border-radius:999px;padding:8px 16px;font-size:13px}
main .acts a:hover{background:var(--hv)}
.it-nav{--it-page:var(--bg)}
.pn{display:flex;justify-content:space-between;gap:16px;margin-top:28px;font-size:13px}.pn a{color:var(--mu);text-decoration:none;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pn a:hover{color:var(--fg)}
.about-it{margin-top:32px;padding-top:18px;border-top:1px solid var(--ln);color:var(--mu);font-size:13px}.about-it h2{font-size:13px;font-weight:500;margin:0 0 6px;color:var(--fg)}.about-it a{color:var(--fg)}
.rep{margin-top:28px}.rep button{background:none;border:0;padding:0;color:var(--mu);font:inherit;font-size:12px;cursor:pointer}.rep button:hover{color:var(--fg)}.rep span{color:var(--mu);font-size:12px;margin-left:8px}
</style><script src="/theme.js"></script><script src="/config.js"></script></head><body>
${chrome.header()}
<main>
${imgs.length ? `<a class="art" href="${esc(m.replay)}" aria-label="Replay this scene" data-n="${imgs.length}">${imgs.map((i, k) => `<img src="${esc(stripUrl(i))}" alt="${k ? "" : esc(alt)}" width="448" height="1024" ${k < 3 ? (k ? 'loading="eager"' : 'fetchpriority="high"') : 'loading="lazy"'} decoding="async" />`).join("")}</a>`
    : `<div class="art empty">${esc(m.empty || "Not painted yet")}</div>`}
<h1>${esc(m.title)}</h1>
<div class="meta">${esc(m.by)}${m.at ? ` · <time datetime="${esc(m.at)}">${esc(m.at)}</time>` : ""}${m.note ? " · " + esc(m.note) : ""}</div>
${m.prompt && m.prompt !== m.title ? `<p class="p">${esc(m.prompt)}</p>` : ""}
<div class="acts"><a href="/">Watch live</a>${m.replay ? `<a href="${esc(m.replay)}">Replay</a>` : ""}${m.day ? `<a data-day href="/time-machine">Time Machine</a>` : ""}</div>
${m.prev || m.next ? `<nav class="pn" aria-label="More scenes">${m.prev ? `<a rel="prev" href="${esc(m.prev)}">← ${esc(m.prevT || "Previous scene")}</a>` : "<span></span>"}${m.next ? `<a rel="next" href="${esc(m.next)}">${esc(m.nextT || "Next scene")} →</a>` : ""}</nav>` : ""}
<section class="about-it"><h2>About Infinite Tapestry</h2><p>This scene was painted live into <a href="/">Infinite Tapestry</a>, an endless AI painting streamed around the clock. Anyone watching can type an idea and steer where the scroll goes next, or leave it fullscreen as an AI screensaver. <a href="/about">How it works</a> · <a href="/time-machine">Browse past days</a></p></section>
${m.report ? `<p class="rep"><button type="button" id="rep" data-r='${esc(JSON.stringify(m.report))}'>Report</button><span id="rep-ok"></span></p>` : ""}
</main>
${chrome.footer()}
${chrome.scripts()}
<script>
const rb=document.getElementById("rep");if(rb)rb.onclick=async()=>{const n=prompt("Report this scene? Add a short reason (optional).");if(n===null)return;const r=await fetch("/api/report",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...JSON.parse(rb.dataset.r),reason:"other",note:n})}).catch(()=>null);document.getElementById("rep-ok").textContent=r&&r.ok?"Thanks, we'll take a look.":"Couldn't send it.";rb.disabled=true;};
for(const t of document.querySelectorAll("time")){const d=new Date(t.dateTime);if(!isNaN(d))t.textContent=d.toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});}
const a=document.querySelector("[data-day]"),t=document.querySelector("time");if(a&&t){const d=new Date(t.dateTime);if(!isNaN(d))a.href="/time-machine#"+d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
(function fitArt(){const art=document.querySelector("a.art");if(!art)return;const imgs=[...art.querySelectorAll("img")];if(!imgs.length)return;const ov=192/448;const go=()=>{const W=art.clientWidth,H=art.clientHeight,n=imgs.length;if(!W||!H)return;const w=W/(n-(n-1)*ov);imgs.forEach((img,i)=>{img.style.width=w+"px";img.style.height=H+"px";img.style.marginLeft=i?(-w*ov)+"px":"0";});};go();addEventListener("resize",go);imgs.forEach(img=>img.decode&&img.decode().then(go).catch(()=>{}));})();
</script>
<script defer src="/_vercel/insights/script.js"></script>
<script defer src="/_vercel/speed-insights/script.js"></script>
</body></html>`);
}

const notFound = (res, host, path) => page(res, host, { path, title: "Scene not found", by: "This scene isn't available.", desc: "An endless painting, steered by everyone watching.",
  og: `${host}/brand/og/og-3-close.jpg`, empty: "Nothing here", cache: "public, s-maxage=60" }, 404);

module.exports = async (req, res) => {
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const raw = String(req.query.m || req.query.id || "");
  try {
    const mr = raw.match(/^(\d{1,7})-(\d{1,7})$/);
    if (mr) {                                   // a strip range (any scene, Auto included)
      const a = +mr[1], b = Math.max(a, Math.min(+mr[2], a + 63));
      const rows = await strips(a, b);
      if (!rows.length) return notFound(res, host, `/s/${raw}`);
      const sc = rows[0].scene || {};
      const title = clip(sc.title || "A moment from the Infinite Tapestry", 80);
      const by = credit(sc.by, sc.origin);
      return page(res, host, { path: `/s/${a}-${b}`, title, by: by === "Auto" ? "Auto" : `Suggested by ${by}`, at: rows[0].created_at,
        desc: by === "Auto" ? "Painted live on the Infinite Tapestry." : `Suggested by ${by} · painted live on the Infinite Tapestry.`,
        og: `${host}/api/og?card=at&a=${a}&b=${b}`, strips: rows.map((r) => r.idx), replay: `/?at=${a}&to=${b}`, day: true, report: { a, b }, noindex: true,
        cache: "public, s-maxage=86400, stale-while-revalidate=604800" });
    }
    const id = /^\d{1,12}$/.test(raw) ? +raw : 0;
    if (!id) return notFound(res, host, `/s/${esc(raw)}`);
    const idea = (await rest("GET", `ideas?id=eq.${id}&status=in.(pending,playing,played)&select=id,handle,body,status,start_strip,end_strip,played_at,created_at,plan`))[0];
    if (!idea) return notFound(res, host, `/s/${id}`);
    const by = credit(idea.handle, "user");
    const byLine = by === "Auto" ? "Auto" : `Suggested by ${by}`;
    // Prefer the full idea body: plan titles are often body[:40] cut mid-word with no ellipsis.
    const planned = (idea.plan && idea.plan.titles && idea.plan.titles[0]) || "";
    const body = String(idea.body || "").replace(/\s+/g, " ").trim();
    const title = clip(body || planned || "A moment from the Infinite Tapestry", 120);
    const desc = clip(`“${title}”, painted live into Infinite Tapestry, an endless AI painting steered by everyone watching. Replay the scene or suggest what comes next.`, 158);
    const indexable = seo.isIndexable(idea);
    if (idea.start_strip == null) {             // still waiting / about to paint
      let note = idea.status === "playing" ? "painting now" : "waiting in line";
      if (idea.status === "pending") {
        const p = (await rest("POST", "rpc/queue_place", { p_id: id }).catch(() => []))[0];
        if (p && p.place) note = `#${p.place} in line · ${fmtEta(p.eta_s)}`;
      }
      return page(res, host, { path: `/s/${id}`, title, by: byLine, note, prompt: idea.body, desc, og: `${host}/brand/og/og-3-close.jpg`, report: { idea_id: id },
        empty: idea.status === "playing" ? "Painting now. Watch live." : "Not painted yet", cache: "public, s-maxage=15", noindex: true });
    }
    const a = idea.start_strip, b = idea.end_strip ?? a + 12;
    const NB = "status=eq.played&start_strip=not.is.null&select=id,handle,body,status,start_strip";
    const [rows, pv, nx] = await Promise.all([strips(a, Math.min(b, a + 63)),
      rest("GET", `ideas?${NB}&id=lt.${id}&order=id.desc&limit=8`).catch(() => []),
      rest("GET", `ideas?${NB}&id=gt.${id}&order=id.asc&limit=8`).catch(() => [])]);
    const pick = (l) => (l || []).find(seo.isIndexable);
    const P = pick(pv), N = pick(nx);
    const at = idea.played_at || (rows[0] && rows[0].created_at);
    const ld = (site, url, imgs) => ({ "@context": "https://schema.org", "@graph": [
      { "@type": ["CreativeWork", "VisualArtwork"], "@id": url + "#scene", name: title, headline: title, url, description: desc,
        image: imgs.slice(0, 3).map((u) => ({ "@type": "ImageObject", contentUrl: u, url: u, caption: title, creator: { "@type": "Organization", name: "Infinite Tapestry" }, creditText: "Infinite Tapestry", copyrightNotice: "Infinite Tapestry" })).concat([{ "@type": "ImageObject", contentUrl: `${host}/api/og?card=idea&id=${id}`, url: `${host}/api/og?card=idea&id=${id}`, width: 1200, height: 630 }]),
        thumbnailUrl: `${host}/api/og?card=idea&id=${id}`, dateCreated: at, datePublished: at, artform: "Digital painting", artMedium: "AI-generated image",
        genre: "AI art", keywords: "endless AI painting, live AI art stream, AI screensaver, infinite AI art",
        isPartOf: { "@type": "WebSite", "@id": `${site}/#website`, name: "Infinite Tapestry", url: `${site}/` }, publisher: seo.ORG(site) },
      { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Infinite Tapestry", item: `${site}/` },
        { "@type": "ListItem", position: 2, name: "Time Machine", item: `${site}/time-machine` }, { "@type": "ListItem", position: 3, name: title, item: url }] }] });
    return page(res, host, { path: `/s/${id}`, title, by: byLine, prompt: indexable ? idea.body : "", desc, at, noindex: !indexable, ld,
      prev: P && `/s/${P.id}`, prevT: P && clip(P.body, 48), next: N && `/s/${N.id}`, nextT: N && clip(N.body, 48),
      og: `${host}/api/og?card=idea&id=${id}`, strips: rows.map((r) => r.idx), replay: `/?at=${a}&to=${b}`, day: true, report: { idea_id: id },
      cache: idea.status === "played" ? "public, s-maxage=3600, stale-while-revalidate=86400" : "public, s-maxage=30" });
  } catch (e) {
    console.error("share", e.message);
    return notFound(res, host, `/s/${esc(raw)}`);
  }
};
