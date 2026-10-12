// Fun layer: reactions, chat notices, 'on now' share, up-next ping, remix, clips. Open to everyone.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const S = () => window.TapestrySocial || {};
const V = () => window.TapestryView || {};
const send = (o) => window.TapestryWS && window.TapestryWS.send(o);
const track = (name, data) => { try { window.va && window.va("event", { name, data }); } catch (_) {} };
const coarse = matchMedia("(pointer: coarse)");

// ---------- reactions ----------
const R = [["lol", "😂"], ["fire", "🔥"], ["mind", "🤯"], ["love", "❤️"], ["dead", "💀"]];
const EMO = Object.fromEntries(R);
const layer = document.createElement("div"); layer.className = "react-layer"; layer.setAttribute("aria-hidden", "true");
document.body.appendChild(layer);
const bar = document.createElement("div"); bar.className = "react-bar ui"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "React");
bar.innerHTML = R.map(([k, e]) => `<button type="button" data-k="${k}" aria-label="React ${e}">${e}</button>`).join("") +
  `<span class="react-sep"></span><button type="button" id="clip-btn" class="clip-btn" title="Share the last 10 seconds">Clip</button>`;
bar.className = "react-tray"; bar.id = "react-tray";
(document.querySelector(".dock") || document.body).appendChild(bar);
const rbtn = document.getElementById("react-btn");
const setTray = (on) => { document.body.classList.toggle("react-open", on); rbtn && rbtn.setAttribute("aria-expanded", on ? "true" : "false"); };
let trayTimer = 0;
const armTray = () => { clearTimeout(trayTimer); trayTimer = setTimeout(() => setTray(false), 6000); };
rbtn && rbtn.addEventListener("click", (e) => { e.preventDefault(); const on = !document.body.classList.contains("react-open"); setTray(on); if (on) armTray(); });
bar.addEventListener("click", armTray);
document.addEventListener("pointerdown", (e) => { if (!bar.contains(e.target) && !(rbtn && rbtn.contains(e.target))) setTray(false); });
let live = 0;
function floatUp(e, own) {
  if (live >= (own ? 30 : 22) || document.hidden) return;
  live++;
  const el = document.createElement("span"); el.className = "react-float" + (own ? " own" : ""); el.textContent = e;
  const lw = Math.max(60, layer.clientWidth - 34);
  const right = 6 + Math.random() * (own ? lw * 0.6 : lw);
  el.style.right = right + "px";
  el.style.setProperty("--dx", (Math.random() * 40 - 20).toFixed(0) + "px");
  el.style.animationDuration = (2.6 + Math.random() * 1.4).toFixed(2) + "s";
  layer.appendChild(el);
  el.addEventListener("animationend", () => { el.remove(); live--; });
}
// Client-side bucket mirrors the server (1/s, burst 5) so taps never feel ignored.
const bucket = { t: 5, at: performance.now() };
const recentOwn = {};
bar.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-k]"); if (!b) return;
  const now = performance.now();
  bucket.t = Math.min(5, bucket.t + (now - bucket.at) / 1000); bucket.at = now;
  if (bucket.t < 1) { b.classList.add("cool"); setTimeout(() => b.classList.remove("cool"), 300); return; }
  bucket.t -= 1;
  const k = b.dataset.k;
  recentOwn[k] = (recentOwn[k] || 0) + 1; setTimeout(() => { recentOwn[k] = Math.max(0, (recentOwn[k] || 0) - 1); }, 1500);
  floatUp(EMO[k], true);
  send({ type: "react", k, i: V().center ? Math.round(V().center()) : -1, s: V().title ? V().title() : "" });
  if (!fun.reacted) { fun.reacted = true; track("reaction", { k }); }
});
const fun = { reacted: false };
window.addEventListener("tapestry:react", (ev) => {
  const c = (ev.detail && ev.detail.c) || {};
  for (const [k, n0] of Object.entries(c)) {
    const e = EMO[k]; if (!e) continue;
    let n = n0;
    const mine = Math.min(n, recentOwn[k] || 0); n -= mine; recentOwn[k] = (recentOwn[k] || 0) - mine;
    n = Math.min(n, 6);   // subtle: at most a handful per batch per emoji
    for (let j = 0; j < n; j++) setTimeout(() => floatUp(e, false), j * 90 + Math.random() * 300);
  }
});

// ---------- chat notices + up-next / on-now ----------
function sysChat(html) {
  const list = $("chat-list"); if (!list) return;
  const li = document.createElement("li"); li.className = "sys"; li.innerHTML = html;
  list.appendChild(li);
  while (list.children.length > 30) list.firstChild.remove();
}
const said = new Set();
let pingOn = (() => { try { return localStorage.getItem("it:ping") === "1"; } catch (_) { return false; } })();
const baseTitle = document.title;
function titlePing(txt) {
  if (!document.hidden) return;
  document.title = txt;
  const back = () => { document.title = baseTitle; document.removeEventListener("visibilitychange", back); };
  document.addEventListener("visibilitychange", back);
}
function notify(body) {
  titlePing("▶ " + body + " · Infinite Tapestry");
  if (!pingOn || !("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  try { new Notification("Infinite Tapestry", { body, icon: "/brand/icon-512.png", tag: "it-up-next" }); } catch (_) {}
}
const quote = (t) => `“${esc(String(t).slice(0, 60))}${String(t).length > 60 ? "…" : ""}”`;
// Wait until the first strip labeled with the user's idea hits the center of the
// view (same labels the captions use). Server "playing" / buffering is too early.
const awaitingOn = new Map();   // id -> idea (mine → share toast when on screen)
function handleOf(by) {
  return String(by || "").split(",").map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
}
function matchesCap(cap, it) {
  if (!cap || cap.origin !== "user" || !it) return false;
  const h = String(it.handle || "").toLowerCase();
  if (!h || !handleOf(cap.by).includes(h)) return false;
  const title = String(cap.title || "").trim();
  const body = String(it.body || "").trim();
  if (!title || !body) return true;
  // direct_plan titles are body[:40]; Haiku titles may differ — handle is enough then.
  if (body.startsWith(title) || title === body.slice(0, 40)) return true;
  return awaitingOn.size <= 1;
}
function checkViewport() {
  const cap = V().caption ? V().caption() : null;
  if (!cap) return;
  for (const [id, it] of [...awaitingOn]) {
    if (!matchesCap(cap, it)) continue;
    awaitingOn.delete(id);
    if (!said.has("on" + id)) { said.add("on" + id); onNow(it); }
  }
}
window.addEventListener("tapestry:caption", checkViewport);
let armTimer = 0;
function armWatch() {
  if (armTimer || !awaitingOn.size) return;
  armTimer = setInterval(() => {
    checkViewport();
    if (!awaitingOn.size) { clearInterval(armTimer); armTimer = 0; }
  }, 250);
}
window.addEventListener("tapestry:ideas", (ev) => {
  const ideas = ev.detail || [];
  const playing = ideas.filter((i) => i.status === "playing");
  const playIds = new Set(playing.map((i) => i.id));
  for (const id of [...awaitingOn.keys()]) if (!playIds.has(id)) awaitingOn.delete(id);
  const next = ideas.find((i) => i.status === "pending");
  playing.forEach((it) => {
    if (said.has("p" + it.id)) return; said.add("p" + it.id);
    if (fun.primed) sysChat(`<b>@${esc(it.handle)}</b>${quote(it.body)} is now painting`);
    if (!(S().isMine && S().isMine(it))) return;
    const cap = V().caption ? V().caption() : null;
    const onScreen = matchesCap(cap, it);
    // Up-next ping: idea just entered the pipeline and isn't on screen yet.
    // (Not when merely pending in the pool — that was minutes early.)
    if (!onScreen && !said.has("u" + it.id) && !said.has("on" + it.id)) {
      said.add("u" + it.id);
      notify("Your idea is up next");
    }
    if (!said.has("on" + it.id) && !onScreen) { awaitingOn.set(it.id, it); armWatch(); }
    else if (onScreen && !said.has("on" + it.id)) { said.add("on" + it.id); onNow(it); }
  });
  if (next && !said.has("n" + next.id)) {
    said.add("n" + next.id);
    if (fun.primed) sysChat(`<b>@${esc(next.handle)}</b>${quote(next.body)} is up next`);
    // No browser ping here — wait until status is playing (above).
  }
  fun.primed = true;   // first snapshot only seeds (no backlog spam on load)
});

// 'Your idea is on now. Share it?' — guest or signed in.
const card = document.createElement("div"); card.id = "share-toast"; card.className = "share-toast"; document.body.appendChild(card);
let cardTimer = 0;
function onNow(it) {
  const url = `${location.origin}/s/${it.id}`;
  notify("Your idea is on now");
  const canShare = coarse.matches && navigator.share;
  card.innerHTML = `<span>Your idea is on now. Share it?</span><button type="button" class="st-btn">${canShare ? "Share" : "Copy link"}</button><button type="button" class="st-x" aria-label="Close">×</button>`;
  card.classList.add("show");
  clearTimeout(cardTimer); cardTimer = setTimeout(() => card.classList.remove("show"), 15000);
  card.querySelector(".st-x").onclick = () => card.classList.remove("show");
  const btn = card.querySelector(".st-btn");
  btn.onclick = async () => {
    track("share_idea", { via: canShare ? "sheet" : "copy" });
    if (canShare) { try { await navigator.share({ title: "Infinite Tapestry", text: `“${it.body}” on Infinite Tapestry`, url }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(url); } catch (_) { const ta = document.createElement("textarea"); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    btn.textContent = "✓"; btn.classList.add("ok");
    clearTimeout(cardTimer); cardTimer = setTimeout(() => card.classList.remove("show"), 2500);
  };
}
window.TapestryOnNow = onNow;   // for QA

// Offer the up-next ping after a signed-in submit (account perk).
window.addEventListener("tapestry:submitted", () => {
  const s = S();
  if (!(s.session && s.profile && s.profile.handle) || pingOn || !("Notification" in window) || Notification.permission === "denied") return;
  setTimeout(() => {
    card.innerHTML = `<span>Ping me when it's up next?</span><button type="button" class="st-btn">Turn on</button><button type="button" class="st-x" aria-label="Close">×</button>`;
    card.classList.add("show"); clearTimeout(cardTimer); cardTimer = setTimeout(() => card.classList.remove("show"), 9000);
    card.querySelector(".st-x").onclick = () => card.classList.remove("show");
    card.querySelector(".st-btn").onclick = async () => {
      const p = await Notification.requestPermission().catch(() => "denied");
      pingOn = p === "granted"; try { localStorage.setItem("it:ping", pingOn ? "1" : "0"); } catch (_) {}
      card.innerHTML = `<span>${pingOn ? "We'll ping you. The tab title flips too." : "No problem. The tab title still flips when you're up."}</span>`;
      cardTimer = setTimeout(() => card.classList.remove("show"), 2500);
    };
  }, 3200);
});

// ---------- remix ----------
function remix(text) {
  const inp = $("cmd-input"); if (!inp) return;
  inp.value = `${String(text || "").replace(/\s+/g, " ").trim().slice(0, 200)}, but `;
  const d = $("drawer"); d && d.classList.remove("open");
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  track("remix");
}
window.TapestryRemix = remix;
const nowEl = document.querySelector(".dock .now");
if (nowEl) {
  const b = document.createElement("button"); b.type = "button"; b.className = "now-remix"; b.textContent = "↻ remix"; b.title = "Remix this scene";
  b.onclick = () => { const t = V().title ? V().title() : ""; if (t && t !== "—") remix(t); };
  nowEl.insertBefore(b, $("now-time"));
}

// ---------- clips: rolling ~10 s of frames, encoded client-side to GIF ----------
const FPS = 5, SECS = 10, MAXF = FPS * SECS;
const frames = [];
const CW = coarse.matches ? 360 : 480;
let grabbing = false;
setInterval(async () => {
  const cv = V().canvas; if (!cv || document.hidden || grabbing || !cv.width) return;
  grabbing = true;
  try {
    const h = Math.round(CW * cv.height / cv.width / 2) * 2;
    const bm = await createImageBitmap(cv, { resizeWidth: CW, resizeHeight: h, resizeQuality: "medium" });
    frames.push(bm);
    while (frames.length > MAXF) frames.shift().close();
  } catch (_) {} finally { grabbing = false; }
}, 1000 / FPS);

async function makeClip() {
  if (frames.length < 5) throw new Error("warming up");
  const { GIFEncoder, quantize, applyPalette } = await import("./lib/gifenc.js");
  const snap = frames.slice();
  const w = snap[0].width, h = snap[0].height;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  const raw = (V().by ? V().by() : "") || "";
  const by = /^by @/.test(raw) ? raw.split(" · ")[0] : "";
  const title = V().title ? V().title() : "";
  const gif = GIFEncoder();
  let pal = null;
  for (let i = 0; i < snap.length; i++) {
    x.drawImage(snap[i], 0, 0, w, h);
    const g = x.createLinearGradient(0, h - 44, 0, h); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.55)");
    x.fillStyle = g; x.fillRect(0, h - 44, w, 44);
    x.font = "500 12px Inter, -apple-system, sans-serif"; x.fillStyle = "rgba(255,255,255,.92)"; x.textBaseline = "bottom";
    x.fillText("Infinite Tapestry", 10, h - 9);
    const right = [title && title !== "—" ? title : "", by].filter(Boolean).join("  ·  ");
    if (right) { x.font = "400 11px Inter, -apple-system, sans-serif"; x.fillStyle = "rgba(255,255,255,.75)"; x.textAlign = "right"; x.fillText(right.slice(0, 60), w - 10, h - 9); x.textAlign = "left"; }
    const d = x.getImageData(0, 0, w, h).data;
    if (!pal || i % 10 === 0) pal = quantize(d, 192, { format: "rgb565" });
    gif.writeFrame(applyPalette(d, pal, "rgb565"), w, h, { palette: pal, delay: 1000 / FPS });
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));   // keep the page responsive
  }
  gif.finish();
  return new File([gif.bytes()], `infinite-tapestry-${Date.now().toString(36)}.gif`, { type: "image/gif" });
}
const clipBtn = $("clip-btn");
clipBtn.addEventListener("click", async () => {
  if (clipBtn.disabled) return;
  clipBtn.disabled = true; const label = clipBtn.textContent; clipBtn.textContent = "…";
  try {
    const file = await makeClip();
    track("clip", { kb: Math.round(file.size / 1024) });
    const share = { files: [file], title: "Infinite Tapestry", text: "Infinite Tapestry · you choose where it goes", url: location.origin };
    if (navigator.canShare && navigator.canShare({ files: [file] }) && coarse.matches) {
      try { await navigator.share(share); } catch (e) { if (!e || e.name !== "AbortError") download(file); }
    } else download(file);
    clipBtn.textContent = "✓";
  } catch (e) {
    window.TapestryWS && window.TapestryWS.toast(e && e.message === "warming up" ? "Give it a few seconds, then clip." : "Couldn't make a clip on this device.", 2500);
    clipBtn.textContent = label;
  } finally { setTimeout(() => { clipBtn.textContent = label; clipBtn.disabled = false; }, 1500); }
});
function download(file) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
window.TapestryClip = makeClip;   // for QA
