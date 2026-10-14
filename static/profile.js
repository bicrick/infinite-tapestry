// /u/<handle>: everything someone has suggested, and where it landed.
const CFG = window.TAPESTRY_CONFIG || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const handle = decodeURIComponent((location.pathname.match(/^\/u\/([^/?#]+)/) || [])[1] || new URLSearchParams(location.search).get("h") || "");

const LABEL = { upnext: "Up next", woven: "", weaving: "Painting now", pending: "Pending", rejected: "Not used", withdrawn: "Withdrawn" };
let toastT = 0;
function toast(html, ms = 2200) {
  const t = $("toast"); t.innerHTML = html; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms);
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: s > 86400 * 300 ? "numeric" : undefined });
}
const exact = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const refUrl = (p) => `${CFG.supabaseUrl}/storage/v1/object/public/idea-refs/${p}`;

let sb = null, token = null, data = null, filter = "all";

async function auth() {
  if (!(CFG.supabaseUrl && CFG.supabaseAnonKey)) return;
  try {
    sb = await (await import("/sb.js")).client();
    const { data: s } = await sb.auth.getSession();
    token = s.session && s.session.access_token;
  } catch (_) {}
}

async function load() {
  const r = await fetch(`/api/profile?handle=${encodeURIComponent(handle)}`, { headers: token ? { authorization: "Bearer " + token } : {} });
  if (r.status === 404 || r.status === 400) { notFound(); return; }
  data = await r.json();
  render();
}

function notFound() {
  document.title = "Not found · Infinite Tapestry";
  $("p-handle").textContent = "No one here";
  $("p-meta").innerHTML = `There's no weaver called @${esc(handle)}. <a href="/">Back to the tapestry</a>`;
}

function render() {
  const d = data;
  document.title = `@${d.handle} · Infinite Tapestry`;
  $("p-handle").textContent = "@" + d.handle;
  const bits = [`${d.stats.total} suggestion${d.stats.total === 1 ? "" : "s"}`, `${d.stats.woven} painted`];
  if (d.stats.votes) bits.push(`${d.stats.votes} vote${d.stats.votes === 1 ? "" : "s"}`);
  bits.push(`joined ${new Date(d.joined).toLocaleDateString([], { month: "short", year: "numeric" })}`);
  $("p-meta").textContent = bits.join(" · ");
  $("p-filter").classList.toggle("hidden", d.ideas.length < 3);
  document.querySelectorAll(".own-only").forEach((el) => el.classList.toggle("hidden", !d.own));
  
  renderBanner(d);
  const bg = d.ideas.find((i) => i.start_strip != null);
  if (bg) $("page-bg").style.backgroundImage = `url(/api/og?id=${bg.id}&size=thumb)`;

  const items = d.ideas.filter((i) => filter === "all" || i.status === filter || (filter === "woven" && i.status === "weaving") || (filter === "pending" && i.status === "upnext") || (filter === "rejected" && i.status === "withdrawn"));
  $("p-list").innerHTML = items.map(card).join("");
  const empty = $("p-empty");
  empty.classList.toggle("hidden", items.length > 0);
  empty.innerHTML = d.ideas.length ? "Nothing here." : d.own ? `You haven't suggested anything yet. <a href="/">Steer the tapestry</a>` : "No suggestions yet.";
  requestAnimationFrame(() => document.querySelectorAll(".p-card").forEach((el, k) => setTimeout(() => el.classList.add("in"), Math.min(k, 12) * 40)));
}

const safeHref = (u) => (/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(u || "") ? u : null);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } };
function renderBanner(d) {
  const b = d.banner, el = $("p-banner");
  const href = b && safeHref(b.url);
  el.classList.toggle("hidden", !d.donor);
  if (d.donor) el.innerHTML = `<span class="pb-heart" aria-hidden="true">✦</span><span class="pb-kept">Bought GPU fuel</span>` +
    (b && b.tagline ? `<span class="pb-tag">“${esc(b.tagline)}”</span>` : "") +
    (href ? `<a class="pb-link" href="${esc(href)}" target="_blank" rel="nofollow ugc noopener noreferrer">${esc(hostOf(href))} ↗</a>` : "");
  const ed = $("p-banner-edit");
  ed.classList.toggle("hidden", !(d.own && d.donor));
  if (d.own && d.donor && !ed.dataset.init) {
    ed.dataset.init = 1;
    $("pbe-tag").value = (b && b.tagline) || ""; $("pbe-url").value = (b && b.url) || "";
    $("pbe-count").textContent = `${$("pbe-tag").value.length}/60`;
  }
}
const BANNER_ERR = { content_not_allowed: "That line isn't allowed. Keep it friendly.", bad_url: "That link isn't allowed. Use a plain https website.", donors_only: "Banners are for people who have bought fuel.", login_required: "Sign in first." };
$("pbe-tag").addEventListener("input", () => { $("pbe-count").textContent = `${$("pbe-tag").value.length}/60`; });
$("p-banner-edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) return;
  const { data: out, error } = await sb.rpc("set_donor_banner", { p_tagline: $("pbe-tag").value, p_url: $("pbe-url").value });
  if (error) { const k = Object.keys(BANNER_ERR).find((x) => String(error.message).includes(x)); toast(BANNER_ERR[k] || "Couldn't save. Try again."); return; }
  data.banner = { tagline: out.tagline, url: out.url }; $("pbe-url").value = out.url || ""; renderBanner(data); toast("Saved");
});

const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Auto's fallback title is just the prompt cut short ("Extreme close-ups of…"): don't repeat it.
const dupTitle = (title, body) => { const t = norm(title), b = norm(body); return !t || b === t || b.startsWith(t); };
function card(i) {
  const landed = i.start_strip != null;
  const to = i.end_strip ?? (landed ? i.start_strip + 12 : null);
  const at = landed ? `/?at=${i.start_strip}&to=${to}` : null;
  const thumb = landed
    ? `<a class="p-thumb" href="${at}" title="View where it landed"><img src="/api/og?id=${i.id}&size=thumb" alt="" loading="lazy" data-tries="0" /></a>`
    : `<div class="p-thumb empty">${i.image_path ? `<img class="ok ref" src="${esc(refUrl(i.image_path))}" alt="" loading="lazy" />` : ""}<span>${i.status === "pending" ? "In the queue" : i.status === "upnext" ? "Up next" : ""}</span></div>`;
  const when = i.status === "woven" && i.played_at ? `painted ${ago(i.played_at)}` : ago(i.created_at);
  return `<li class="p-card" data-id="${i.id}">
    ${thumb}
    <div class="p-body">
      <div class="p-row">${LABEL[i.status] === "" ? "" : `<span class="p-status s-${i.status}">${LABEL[i.status] || esc(i.status)}</span>`}<time title="${esc(exact(i.created_at))}">${when}</time></div>
      <p class="p-text">${esc(i.body)}</p>${i.title && i.status !== "pending" && !dupTitle(i.title, i.body) ? `<div class="p-title">${esc(i.title)}</div>` : ""}
      <div class="p-actions">
        ${landed ? `<a href="${at}">View where it landed <span aria-hidden="true">→</span></a>` : ""}
        ${i.status === "rejected" || i.status === "withdrawn" ? "" : `<button data-share="${i.id}" type="button">Share</button>`}
      </div>
    </div>
  </li>`;
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-share]");
  if (b) {
    const url = `${location.origin}/s/${b.dataset.share}`;
    const idea = data.ideas.find((i) => String(i.id) === b.dataset.share);
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title: "Infinite Tapestry", text: idea ? `“${idea.body}”` : "", url }); return; } catch (_) {}
    }
    try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (_) { prompt("Copy this link", url); }
    return;
  }
  const f = e.target.closest("[data-f]");
  if (f) {
    filter = f.dataset.f;
    document.querySelectorAll("#p-filter button").forEach((x) => x.classList.toggle("on", x === f));
    render();
  }
});


// Thumbnails: a cold crop can take the GPU longer than one request allows, so retry a few times
// (cache-busted, backing off) instead of leaving a blank or dark fallback box.
document.addEventListener("load", (e) => { const t = e.target; if (t.matches && t.matches(".p-thumb img")) t.classList.add("ok"); }, true);
document.addEventListener("error", (e) => {
  const t = e.target; if (!(t.matches && t.matches(".p-thumb img"))) return;
  const n = +(t.dataset.tries || 0) + 1; t.dataset.tries = n;
  if (n > 4) { t.closest(".p-thumb").classList.add("empty"); return; }
  setTimeout(() => { t.src = t.src.replace(/&r=\d+$/, "") + "&r=" + n; }, 1500 * n);
}, true);

(async () => { await auth(); await load().catch(() => notFound()); })();
