const OWNER = (h) => String(h || "").toLowerCase() === "bicrick";   // never credited
const { env, rest } = require("../lib/common");

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
  return [...new Set(hs.map((h) => (isGuest(h) ? "a guest" : "@" + h)))].join(", ");
}
const fmtEta = (s) => (s == null ? "" : s < 60 ? "any moment" : s < 3600 ? `about ${Math.round(s / 60)} min` : `about ${Math.round(s / 360) / 10} h`);

async function strips(a, b) {
  return rest("GET", `strips?session=eq.${encodeURIComponent(SESSION())}&idx=gte.${a}&idx=lte.${b}&order=idx.asc&select=idx,created_at,scene`).catch(() => []);
}

function page(res, host, m, status = 200) {
  const imgs = (m.strips || []).slice(0, 10);
  const url = `${host}${m.path}`;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", m.cache || "public, s-maxage=60, stale-while-revalidate=600");
  res.status(status).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(m.title)} · Infinite Tapestry</title>
<meta name="description" content="${esc(m.desc)}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="Infinite Tapestry" />
<meta property="og:title" content="${esc(m.title)}" /><meta property="og:description" content="${esc(m.desc)}" />
<meta property="og:image" content="${esc(m.og)}" /><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<meta property="og:url" content="${esc(url)}" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(m.title)}" />
<meta name="twitter:description" content="${esc(m.desc)}" /><meta name="twitter:image" content="${esc(m.og)}" />
${status !== 200 ? '<meta name="robots" content="noindex" />' : ""}
<link rel="icon" href="/brand/mark.svg" type="image/svg+xml" />
<style>
:root{color-scheme:dark;--fg:#e8e6e3;--mu:rgba(232,230,227,.5);--ln:rgba(232,230,227,.12)}
*{box-sizing:border-box}html,body{margin:0;background:#070707;color:var(--fg);font:14px/1.5 Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:calc(28px + env(safe-area-inset-top)) 20px calc(40px + env(safe-area-inset-bottom))}
.brand{color:var(--mu);text-decoration:none;font-size:12px;letter-spacing:.04em}
.art{display:flex;overflow:hidden;width:100%;height:clamp(220px,52vw,380px);margin:22px 0 22px;border-radius:14px;background:#111;mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)}
.art img{height:100%;width:auto;flex:none;object-fit:cover;object-position:left center}.art img:first-child{margin-left:0}
.art.empty{display:grid;place-items:center;color:var(--mu);font-size:13px;mask-image:none}
h1{font-size:22px;font-weight:500;letter-spacing:-.01em;margin:0 0 6px}
.meta{color:var(--mu);font-size:13px}.p{color:var(--mu);margin:14px 0 0;font-size:13px}
nav{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
nav a{color:var(--fg);text-decoration:none;border:1px solid var(--ln);border-radius:999px;padding:8px 16px;font-size:13px}
nav a:hover{background:rgba(232,230,227,.06)}
.rep{margin-top:28px}.rep button{background:none;border:0;padding:0;color:var(--mu);font:inherit;font-size:12px;cursor:pointer}.rep button:hover{color:var(--fg)}.rep span{color:var(--mu);font-size:12px;margin-left:8px}
</style></head><body><main>
<a class="brand" href="/">Infinite Tapestry</a>
${imgs.length ? `<a class="art" href="${esc(m.replay)}" data-n="${imgs.length}">${imgs.map((i) => `<img src="${esc(stripUrl(i))}" alt="" loading="lazy" decoding="async" />`).join("")}</a>`
    : `<div class="art empty">${esc(m.empty || "Not painted yet")}</div>`}
<h1>${esc(m.title)}</h1>
<div class="meta">${esc(m.by)}${m.at ? ` · <time datetime="${esc(m.at)}">${esc(m.at)}</time>` : ""}${m.note ? " · " + esc(m.note) : ""}</div>
${m.prompt && m.prompt !== m.title ? `<p class="p">${esc(m.prompt)}</p>` : ""}
<nav><a href="/">Watch live</a>${m.replay ? `<a href="${esc(m.replay)}">Replay</a>` : ""}${m.day ? `<a data-day href="/time-machine">Time Machine</a>` : ""}</nav>
${m.report ? `<p class="rep"><button type="button" id="rep" data-r='${esc(JSON.stringify(m.report))}'>Report</button><span id="rep-ok"></span></p>` : ""}
</main><script>
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
        og: `${host}/api/og?card=at&a=${a}&b=${b}`, strips: rows.map((r) => r.idx), replay: `/?at=${a}&to=${b}`, day: true, report: { a, b },
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
    const desc = `${by === "Auto" ? "" : byLine + " · "}Infinite Tapestry, an endless painting steered by everyone watching.`;
    if (idea.start_strip == null) {             // still waiting / about to paint
      let note = idea.status === "playing" ? "painting now" : "waiting in line";
      if (idea.status === "pending") {
        const p = (await rest("POST", "rpc/queue_place", { p_id: id }).catch(() => []))[0];
        if (p && p.place) note = `#${p.place} in line · ${fmtEta(p.eta_s)}`;
      }
      return page(res, host, { path: `/s/${id}`, title, by: byLine, note, prompt: idea.body, desc, og: `${host}/brand/og/og-3-close.jpg`, report: { idea_id: id },
        empty: idea.status === "playing" ? "Painting now. Watch live." : "Not painted yet", cache: "public, s-maxage=15" });
    }
    const a = idea.start_strip, b = idea.end_strip ?? a + 12;
    const rows = await strips(a, Math.min(b, a + 63));
    return page(res, host, { path: `/s/${id}`, title, by: byLine, prompt: idea.body, desc, at: idea.played_at || (rows[0] && rows[0].created_at),
      og: `${host}/api/og?card=idea&id=${id}`, strips: rows.map((r) => r.idx), replay: `/?at=${a}&to=${b}`, day: true, report: { idea_id: id },
      cache: idea.status === "played" ? "public, s-maxage=3600, stale-while-revalidate=86400" : "public, s-maxage=30" });
  } catch (e) {
    console.error("share", e.message);
    return notFound(res, host, `/s/${esc(raw)}`);
  }
};
