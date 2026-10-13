// Social layer: accounts, idea pool, votes, chat, fuel, donations, admin.
// Loaded as a module; stays dormant when no Supabase config is present (local/dev).
const CFG = window.TAPESTRY_CONFIG || {};
let queueMode = "fifo";   // hoisted: refreshIdeas can run before the queue UI block
const $ = (id) => document.getElementById(id);
const W = () => window.TapestryWS || { send() {}, toast() {}, esc: (s) => String(s) };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const S = { enabled: false, session: null, profile: null, isAdmin: () => !!(S.profile && S.profile.is_admin), token: () => S.session && S.session.access_token, submitIdea: async () => false };
window.TapestrySocial = S;

const ERR = {
  not_signed_in: "Sign in to add more ideas.",
  handle_required: "Pick a handle first.",
  one_active_idea: "You have a few ideas waiting already. Give them a moment to play.",
  too_many_pending: "You have a few ideas waiting already. Give them a moment to play.",
  content_not_allowed: "That one's outside what the tapestry paints.",
  banned: "This account is suspended.",
  muted: "You're muted for a little while.",
  handle_taken: "That handle is taken.",
  bad_image: "That image could not be attached. Try another.",
  bad_handle: "Handles are 2–20 letters, numbers or underscores.",
  handle_not_allowed: "That handle isn't available. Try another.",
  signin_required: "Ideas are sign-in only for a little while. Sign in to add one.",
  not_allowed: "Ideas from here are paused.",
  human_check: "One quick check didn't pass. Try again.",
  guest_rate: "That's a few ideas already. Give it a few minutes, or sign in for more.",
  guest_pending: "You have ideas waiting. Once one plays you can add another, or sign in for more.",
};
function friendly(e) {
  const m = String((e && (e.message || e.details)) || e || "");
  const key = Object.keys(ERR).find((k) => m.includes(k));
  if (key) return ERR[key];
  const rl = m.match(/rate_limited:?(\d+)?/);
  if (rl) return "That's a lot of ideas at once. Give it a few seconds.";
  if (m.includes("cooldown")) return "One moment, then send it again.";
  return "Something went wrong. Try again.";
}
const toast = (h, ms) => W().toast(h, ms);

// ---------- guests: anyone can add ideas; signing in just adds more steering, never a gate ----------
const isGuestHandle = (h) => /^[a-z]+-\d{4}$/.test(String(h || ""));
let fpCache = null;
async function fingerprint() {   // privacy-light: a hash of coarse, stable traits (no canvas/audio probing)
  if (fpCache) return fpCache;
  const n = navigator, sc = screen;
  const raw = [n.userAgent, n.language, (n.languages || []).join(","), Intl.DateTimeFormat().resolvedOptions().timeZone,
    sc.width + "x" + sc.height + "x" + sc.colorDepth, n.hardwareConcurrency || 0, n.deviceMemory || 0, n.platform || "", n.maxTouchPoints || 0].join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return (fpCache = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}
const guest = { handle: null, enabled: true, turnstile: false, human: false };
async function loadGuest() {
  try {
    const r = await fetch("/api/guest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fp: await fingerprint() }), credentials: "same-origin" });
    if (!r.ok) return;
    const d = await r.json(); guest.handle = d.handle; guest.enabled = d.guestsEnabled; guest.turnstile = d.turnstile;
  } catch (_) {}
}
let tsReady = null;
function turnstileToken() {   // invisible Cloudflare Turnstile, only when configured server-side
  if (!guest.turnstile || !CFG.turnstileSiteKey || guest.human) return Promise.resolve(null);
  tsReady = tsReady || new Promise((ok) => { const sc = document.createElement("script"); sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; sc.onload = ok; sc.onerror = ok; document.head.appendChild(sc); });
  return tsReady.then(() => new Promise((ok) => {
    if (!window.turnstile) return ok(null);
    // Invisible by default; if Cloudflare wants a click, show the widget above the composer.
    const box = document.createElement("div"); box.className = "ts-box"; box.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:60;opacity:0;pointer-events:none;transition:opacity .2s"; document.body.appendChild(box);
    let done = false; const fin = (t) => { if (done) return; done = true; clearTimeout(to); setTimeout(() => box.remove(), 0); ok(t); };
    const to = setTimeout(() => fin(null), 30000);
    window.turnstile.render(box, { sitekey: CFG.turnstileSiteKey, appearance: "interaction-only", callback: fin,
      "before-interactive-callback": () => { clearTimeout(to); box.style.opacity = "1"; box.style.pointerEvents = "auto"; },
      "error-callback": () => fin(null), "expired-callback": () => fin(null), "timeout-callback": () => fin(null) });
  }));
}
async function submitAsGuest(text) {
  const token = await turnstileToken();
  const r = await fetch("/api/idea", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, fp: await fingerprint(), turnstile: token }) });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { if (token) guest.human = true; if (d.handle) guest.handle = d.handle; return { ok: true, id: d.id || null }; }
  const map = { rate_limited: "guest_rate", too_many_pending: "guest_pending" };
  return { ok: false, err: map[d.error] || d.error || "server" };
}
// Local echo so a guest always sees what they sent (also covers ideas that never reach the pool).
const LOCAL_KEY = "it:my-guest-ideas";
const localIdeas = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]").filter((x) => Date.now() - x.t < 30 * 60e3); } catch (_) { return []; } };
const addLocal = (body, handle, id) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify([...localIdeas(), { body, handle, id: id || null, t: Date.now() }].slice(-6))); } catch (_) {} };
// Ideas I sent (guest ids kept locally for a day so the 'on now' share works without an account).
const MINE_KEY = "it:my-idea-ids";
const mineIds = () => { try { return JSON.parse(localStorage.getItem(MINE_KEY) || "[]").filter((x) => Date.now() - x.t < 864e5); } catch (_) { return []; } };
const addMine = (id) => { if (!id || id < 0) return; try { localStorage.setItem(MINE_KEY, JSON.stringify([...mineIds(), { id, t: Date.now() }].slice(-20))); } catch (_) {} };
S.isMine = (row) => !!row && ((S.session && row.user_id && row.user_id === S.session.user.id) || mineIds().some((x) => x.id === row.id));

if (CFG.supabaseUrl && CFG.supabaseAnonKey) boot().catch((e) => console.warn("social disabled", e));

async function boot() {
  const A = await import("./sb.js");
  const sb = await A.client();
  S.sb = sb;
  S.enabled = true;
  document.body.classList.add("social");
  document.querySelectorAll(".social-only").forEach((el) => el.classList.remove("hidden"));
  $("account-btn").classList.remove("hidden");
  // Wire the drawer tabs before any auth await: a stalled session restore must never leave the UI dead.
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => { try { openTab(b.dataset.tab); } catch (e) { console.warn("tab", e); } }));
  $("fuel-chip").classList.remove("hidden");
  $("cmd-input").placeholder = innerWidth < 480 ? "Where next?" : "Suggest where the tapestry goes next…";
  let google = !!CFG.google;
  A.googleEnabled().then((on) => { google = on; $("auth-google").classList.toggle("hidden", !!S.session); });

  // Hoisted above first loadProfile(): loadVotes/renderIdeas run from loadProfile
  // and must not hit TDZ (was: ReferenceError myVotes / listRows before initialization).
  let myVotes = new Set();
  let ideas = [];
  let hourCents = Number(CFG.centsPerHour) || 20;
  let qsort = "up", listRows = [], listDone = false, listBusy = false, upFull = false;

  // ---------- auth ----------
  async function loadProfile() {
    S.profile = null;
    if (S.session) {
      const { data } = await sb.from("profiles").select("id,handle,is_admin").eq("id", S.session.user.id).maybeSingle();
      S.profile = data || { id: S.session.user.id, handle: null, is_admin: false };
    }
    document.body.classList.toggle("is-admin", S.isAdmin());
    document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !S.isAdmin()));
    $("account-btn").textContent = S.profile ? (S.profile.handle ? "@" + S.profile.handle : "Pick a handle") : "Sign in";
    if (S.chatAuth) S.chatAuth();
    if (S.token()) W().send({ type: "auth", token: S.token() });
    loadVotes();
  }
  // getSession can stall (auth lock / slow token refresh after sleep); never let it block the rest of boot.
  const localSession = () => { try { const j = JSON.parse(localStorage.getItem(A.storageKey()) || "null"); return j && j.access_token && j.expires_at * 1000 > Date.now() ? j : null; } catch (_) { return null; } };
  S.session = await Promise.race([
    sb.auth.getSession().then((r) => r.data.session).catch(() => localSession()),
    new Promise((ok) => setTimeout(() => ok(localSession()), 3500)),
  ]);
  try { await Promise.race([loadProfile(), new Promise((_, no) => setTimeout(() => no(new Error("profile timeout")), 5000))]); }
  catch (e) { console.warn("profile", e); }
  if (S.session && S.profile && !S.profile.handle) openAuth();
  // /?signin=1 (from /about and other static pages): open the same sign-in sheet, then tidy the URL
  if (new URLSearchParams(location.search).get("signin") === "1") { history.replaceState(null, "", location.pathname); if (!(S.session && S.profile && S.profile.handle)) openAuth(); }
  sb.auth.onAuthStateChange(async (ev, sess) => {
    const was = S.session && S.session.user.id;
    S.session = sess;
    if ((sess && sess.user.id) !== was || ev === "TOKEN_REFRESHED") {
      await loadProfile();
      if (ev === "SIGNED_IN" && S.profile && !S.profile.handle) openAuth();
    }
  });

  function openAuth() {
    const signed = !!S.session, needHandle = signed && !(S.profile && S.profile.handle);
    document.body.classList.toggle("signed-in", signed);
    // Google-only sign-in: the email magic-link form stays hidden.
    $("auth-form").classList.add("hidden");
    $("auth-google").classList.toggle("hidden", signed);
    $("auth-or").classList.add("hidden");
    $("auth-code-form").classList.add("hidden");

    $("handle-form").classList.toggle("hidden", !needHandle);
    $("auth-signed").classList.toggle("hidden", !signed || needHandle);
    $("auth-handle").textContent = S.profile && S.profile.handle ? "@" + S.profile.handle : "";
    document.querySelector("#auth-pop .sheet-title").textContent = needHandle ? "Pick a handle" : signed ? "Your account" : "Join the tapestry";
    { const sub = $("auth-sub"); if (sub) sub.textContent = needHandle ? "This is how others see your ideas." : signed ? "" : "Watching, ideas and hearts are open to everyone. Sign in to get a handle, a profile and keep your ideas."; }
    $("auth-pop").classList.remove("hidden");
    if (needHandle && !$("handle-input").value && guest.handle) $("handle-input").value = guest.handle.replace("-", "_");
    if (needHandle) setTimeout(() => $("handle-input").focus(), 50);
  }
  S.openAuth = openAuth;
  // Signed in with a handle: your name opens your profile. Otherwise it opens sign-in.
  $("account-btn").addEventListener("click", () => {
    if (S.session && S.profile && S.profile.handle) location.href = "/u/" + encodeURIComponent(S.profile.handle);
    else openAuth();
  });
  $("auth-pop").addEventListener("click", (e) => { if (e.target === $("auth-pop")) $("auth-pop").classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("auth-pop").classList.add("hidden"); });
  // Email: one message with a link (any browser) — and, once the branded template is on, a 6-digit code.
  let sentTo = "", cooldown = 0, cdTimer = 0;
  const redirect = location.origin + "/auth/confirm?next=" + encodeURIComponent(location.pathname + location.search);
  async function sendEmail(email) {
    if (Date.now() < cooldown) return;
    const btn = $("auth-send"); btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
    btn.disabled = false;
    if (error) { $("auth-msg").textContent = A.AUTH_ERR(error.message); return false; }
    sentTo = email; A.rememberEmail(email);
    $("auth-form").classList.add("hidden"); $("auth-google").classList.add("hidden"); $("auth-or").classList.add("hidden");
    $("auth-code-form").classList.remove("hidden");
    $("auth-sent-to").textContent = email; $("auth-msg").textContent = "";
    cooldown = Date.now() + 60000; tickResend();
    setTimeout(() => $("auth-code").focus(), 60);
    return true;
  }
  function tickResend() {
    clearInterval(cdTimer);
    const b = $("auth-resend");
    const step = () => { const s = Math.ceil((cooldown - Date.now()) / 1000); b.disabled = s > 0; b.textContent = s > 0 ? `Resend in ${s}s` : "Resend email"; if (s <= 0) clearInterval(cdTimer); };
    step(); cdTimer = setInterval(step, 500);
  }
  $("auth-form").addEventListener("submit", async (e) => { e.preventDefault(); await sendEmail($("auth-email").value.trim()); });
  $("auth-resend").addEventListener("click", () => sendEmail(sentTo));
  $("auth-change").addEventListener("click", () => { $("auth-code-form").classList.add("hidden"); $("auth-form").classList.remove("hidden"); $("auth-google").classList.toggle("hidden", !google); $("auth-or").classList.toggle("hidden", !google); $("auth-email").focus(); });
  $("auth-code").addEventListener("input", (e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); e.target.value = v; if (v.length === 6) $("auth-code-form").requestSubmit(); });
  $("auth-code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("auth-code").value.trim(); if (token.length < 6) return;
    $("auth-msg").textContent = "Checking…";
    const { error } = await sb.auth.verifyOtp({ email: sentTo, token, type: "email" });
    if (error) { $("auth-msg").textContent = A.AUTH_ERR(error.message); $("auth-code").select(); return; }
    $("auth-msg").textContent = ""; $("auth-code").value = "";
  });
  // ---------- sign-in nudge: once a visit, after ~10 min watching as a guest or at the guest idea limit ----------
  const NUDGE_KEY = "it_nudge_shown";
  S.nudge = () => {
    if (S.session || sessionStorage.getItem(NUDGE_KEY)) return false;
    const b = document.body;
    if (document.fullscreenElement || b.classList.contains("saver") || b.classList.contains("ambient") || document.hidden) return false;
    sessionStorage.setItem(NUDGE_KEY, "1");
    toast(`<span>Sign in with Google to add more ideas</span><button type="button" id="nudge-go">Sign in</button><button type="button" id="nudge-x" aria-label="Dismiss">×</button>`, 20000);
    const t = $("toast"), box = $("cmd-input"), c = (box.closest("form") || box).getBoundingClientRect();
    t.classList.add("nudge");
    if (c.height) t.style.setProperty("--nudge-top", Math.max(8, c.top - t.offsetHeight - 10) + "px");
    $("nudge-go").onclick = () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname + location.search } });
    $("nudge-x").onclick = () => t.classList.remove("show");
    try { window.va && window.va("event", { name: "signin_nudge" }); } catch (_) {}
    return true;
  };
  { let watched = 0; const tick = setInterval(() => {
      if (S.session || sessionStorage.getItem(NUDGE_KEY)) return clearInterval(tick);
      if (!document.hidden) watched += 15;
      if (watched >= 600 && S.nudge()) clearInterval(tick);
    }, 15000); }
  $("auth-google").addEventListener("click", () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname + location.search } }));
  $("handle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc("set_handle", { p_handle: $("handle-input").value.trim() });
    if (error) return toast(friendly(error));
    await loadProfile();
    $("auth-pop").classList.add("hidden");
    toast(`Welcome, <b>@${esc(S.profile.handle)}</b>`);
  });
  $("auth-out").addEventListener("click", async () => { await sb.auth.signOut(); $("auth-pop").classList.add("hidden"); });

  function needLogin() {
    if (!S.session || !(S.profile && S.profile.handle)) { openAuth(); return true; }
    return false;
  }

  // ---------- ideas ----------
  // ---------- optional reference image ----------
  let refFile = null;
  const refPlaceholder = $("cmd-input").placeholder;
  async function attachRef(f) {
    if (!f) return;
    if (!/^image\/(jpeg|png|webp|gif|avif|heic)$/.test(f.type)) return toast("Use a JPEG, PNG or WebP image.");
    if (f.size > 15e6) return toast("That image is too large.");
    if (needLogin()) return;
    try { refFile = await shrink(f); } catch (_) { return toast("Couldn't read that image."); }
    $("ref-thumb").src = URL.createObjectURL(refFile);
    $("ref-chip").classList.remove("hidden");
    $("cmd-input").placeholder = "Add words, or just send the image";
    $("cmd-input").focus();
  }
  function clearRef() { refFile = null; $("ref-chip").classList.add("hidden"); $("cmd-input").placeholder = refPlaceholder; }
  S.attachRef = attachRef;
  S.hasRef = () => !!refFile;
  $("ref-file").addEventListener("change", async () => {
    const f = $("ref-file").files[0];
    $("ref-file").value = "";
    attachRef(f);
  });
  $("ref-clear").addEventListener("click", clearRef);
  // Desktop: drop an image anywhere; any device: paste an image.
  const fine = matchMedia("(pointer: fine)");
  const ov = document.createElement("div");
  ov.id = "drop-ov"; ov.innerHTML = '<div class="drop-card"><span>Drop to use as reference</span></div>';
  document.body.appendChild(ov);
  const hasImg = (e) => [...(e.dataTransfer?.items || [])].some((i) => i.kind === "file" && /^image\//.test(i.type));
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if (!fine.matches || !hasImg(e)) return; e.preventDefault(); dragDepth++; ov.classList.add("on"); });
  window.addEventListener("dragover", (e) => { if (hasImg(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; ov.classList.remove("on"); } });
  window.addEventListener("drop", (e) => {
    dragDepth = 0; ov.classList.remove("on");
    const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type));
    if (!f) return;
    try { window.va && window.va("event", { name: "image_drop" }); } catch (_) {}
    e.preventDefault();
    attachRef(f);
  });
  window.addEventListener("paste", (e) => {
    const it = [...(e.clipboardData?.items || [])].find((i) => i.kind === "file" && /^image\//.test(i.type));
    if (!it) return;
    e.preventDefault();
    attachRef(it.getAsFile());
  });
  async function shrink(file) {  // downscale to <=1280px JPEG so uploads stay well under 2 MB
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
  }
  const IMAGE_ONLY = "Inspired by this image";
  const refUrl = (p) => `${CFG.supabaseUrl}/storage/v1/object/public/idea-refs/${p}`;

  loadGuest();
  S.guest = guest;
  S.submitIdea = async (text) => {
    if (!S.session || !(S.profile && S.profile.handle)) {
      if (refFile) { needLogin(); return false; }          // reference images need an account
      if (!guest.enabled) { toast(ERR.signin_required); openAuth(); return false; }
      const res = await submitAsGuest(text);
      if (!res.ok && (res.err === "guest_rate" || res.err === "guest_pending") && S.nudge()) return false;
      if (!res.ok) { toast(ERR[res.err] || "Something went wrong. Try again."); if (res.err === "signin_required") openAuth(); return false; }
      addLocal(text, guest.handle, res.id); addMine(res.id);
      try { window.va && window.va("event", { name: "idea_submitted", data: { who: "guest" } }); } catch (_) {}
            window.dispatchEvent(new CustomEvent("tapestry:submitted"));
      placeToast(res.id, ` <span class="muted">· @${esc(guest.handle || "guest")}</span>`);
      refreshIdeas();
      if (window.TapestryWS) window.TapestryWS.send({ type: "idea_added" });
      return true;
    }
    if (!text && refFile) text = IMAGE_ONLY;  // image alone is a valid idea; Auto describes it
    let image = null;
    if (refFile) {
      image = `${S.session.user.id}/${Date.now().toString(36)}.jpg`;
      const up = await sb.storage.from("idea-refs").upload(image, refFile, { contentType: "image/jpeg", upsert: false });
      if (up.error) { toast("Couldn't upload the image. " + esc(up.error.message || "")); return false; }
    }
    const { data: newId, error } = await sb.rpc("submit_idea", { p_body: text, p_image: image });
    if (error) { toast(friendly(error)); return false; }
    addMine(typeof newId === "number" ? newId : null);
    try { window.va && window.va("event", { name: "idea_submitted", data: { who: "signed_in", image: !!image } }); } catch (_) {}
    clearRef();
    window.dispatchEvent(new CustomEvent("tapestry:submitted"));
    placeToast(typeof newId === "number" ? newId : null);
    refreshIdeas();
    if (window.TapestryWS) window.TapestryWS.send({ type: "idea_added" });
    return true;
  };
  async function loadVotes() {
    myVotes = new Set();
    if (S.session) {
      const { data } = await sb.from("votes").select("idea_id").eq("user_id", S.session.user.id);
      (data || []).forEach((r) => myVotes.add(r.idea_id));
    } else {
      try {
        const r = await fetch("/api/vote?fp=" + encodeURIComponent(await fingerprint()), { credentials: "same-origin" });
        if (r.ok) ((await r.json()).ids || []).forEach((id) => myVotes.add(id));
      } catch (_) {}
    }
    renderIdeas();
    window.dispatchEvent(new Event("tapestry:social"));  // refresh Up-next hearts / voted state
  }
  // Pending + playing ideas for fun.js ("your idea is on") and the expired notice. Debounced: realtime
  // fires on every idea change, so at scale this must not run per event.
  let ideasAt = 0, ideasTimer = 0;
  function refreshIdeas() {
    const wait = Math.max(0, 3000 - (Date.now() - ideasAt));
    if (ideasTimer) return;
    ideasTimer = setTimeout(() => { ideasTimer = 0; ideasAt = Date.now(); loadIdeas(); }, wait);
  }
  async function loadIdeas() {
    const { data } = await sb.from("ideas").select("id,handle,body,votes,status,user_id,created_at,image_path")
      .in("status", ["pending", "playing"]).order("created_at").limit(60);
    ideas = data || [];
    queueMode = ideas.filter((i) => i.status === "pending").length > 3 ? "vote" : "fifo";
    S.ideas = ideas;
    window.dispatchEvent(new CustomEvent("tapestry:ideas", { detail: ideas }));
    checkExpired();
    if (qsort !== "up") loadList(true);
  }
  // Busy-queue expiry: tell the author once, kindly.
  const SEEN_KEY = "it:expired-seen";
  async function checkExpired() {
    const since = new Date(Date.now() - 864e5).toISOString();
    let q = sb.from("ideas").select("id,body").eq("status", "expired").gte("created_at", since).limit(5);
    if (S.session) q = q.eq("user_id", S.session.user.id);
    else { const ids = mineIds().map((x) => x.id); if (!ids.length) return; q = q.in("id", ids); }
    const { data } = await q;
    let seen = []; try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); } catch (_) {}
    const fresh = (data || []).filter((r) => !seen.includes(r.id));
    if (!fresh.length) return;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, ...fresh.map((r) => r.id)].slice(-50))); } catch (_) {}
    const r = fresh[0];
    toast(`Your idea didn't make it in time. Resubmit? <span class="muted">· ${esc(String(r.body).slice(0, 50))}</span>`, 7000);
  }

  // ---------- Queue tab: sort toggle (display only) over the whole pending set, paged on the server ----------
  const PAGE = 50;
  async function loadList(reset) {
    if (listBusy || (!reset && listDone)) return;
    listBusy = true;
    const target = qsort === "up" ? $("queue-more") : $("idea-list");
    const off = reset ? (qsort === "up" ? 20 : 0) : (qsort === "up" ? 20 : 0) + listRows.length;
    const { data, error } = await sb.rpc("queue_list", { p_sort: qsort, p_offset: off, p_limit: PAGE });
    listBusy = false;
    if (error) return;
    listRows = reset ? (data || []) : listRows.concat(data || []);
    listDone = (data || []).length < PAGE;
    renderList(target);
  }
  function renderList(target) {
    for (const el of [$("idea-list"), $("queue-more")]) if (el !== target) el.innerHTML = "";
    target.innerHTML = listRows.map((it) => ideaRow(it)).join("");
    $("idea-empty").classList.toggle("hidden", qsort === "up" || listRows.length > 0);
    $("q-more").classList.toggle("hidden", listDone || (qsort === "up" && !listRows.length && !upFull));
  }
  // the server's Up-next pool is capped at 20: offer "Show more" past it
  window.addEventListener("tapestry:pool", (e) => { upFull = (e.detail || 0) >= 20; if (qsort === "up") $("q-more").classList.toggle("hidden", !upFull || listDone && listRows.length > 0); });
  const etaLabel = (s) => (s == null ? "" : s < 60 ? "soon" : s < 3600 ? `~${Math.round(s / 60)} min` : `~${Math.round(s / 360) / 10} h`);
  S.etaLabel = etaLabel;
  function ideaRow(it) {
    const by = window.TapestryCredit ? window.TapestryCredit(it.handle, "user") : "@" + it.handle;
    const mine = S.isMine(it);
    return `<li class="item idea user" data-id="i${it.id}"><span class="n">${it.place ?? ""}</span><div class="body">` +
      `<div class="t" data-tip="${esc(by === "Auto" ? "Auto" : "Suggested by " + by)}">${esc(it.body)}</div>` +
      `<div class="meta">${esc(by)}${it.eta_s != null ? " · " + etaLabel(it.eta_s) : ""}${mine ? " · yours" : ""}</div>` +
      `<div class="p"><a class="open-s" href="/s/${it.id}" target="_blank" rel="noopener">Open ↗</a><button class="linkish" type="button" data-report="${it.id}">Report</button>` +
      (mine ? ` <button class="linkish" type="button" data-act="withdraw_idea" data-iid="${it.id}">Withdraw</button>` : "") +
      (S.isAdmin() ? ` <button class="linkish" type="button" data-act="admin_reject_idea" data-iid="${it.id}">Reject</button>` : "") + `</div></div>` +
      heart(it.id, it.votes) + `</li>`;
  }
  const HEART = '<svg viewBox="0 0 16 16"><path d="M8 13.5S2 10 2 5.8A3 3 0 0 1 8 4.3a3 3 0 0 1 6 1.5C14 10 8 13.5 8 13.5z"/></svg>';
  function heart(id, n) {
    return `<button class="heart${myVotes.has(id) ? " on" : ""}" type="button" data-vote="${id}" aria-label="Like">${HEART}<span>${n || 0}</span></button>`;
  }
  S.heart = heart;
  S.myVotes = () => myVotes;
  window.dispatchEvent(new Event("tapestry:social"));
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-vote]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const id = +b.dataset.vote;
    let data;
    if (S.session && S.profile && S.profile.handle) {
      const r = await sb.rpc("toggle_vote", { p_idea: id });
      if (r.error) return toast(friendly(r.error));
      data = r.data;
      myVotes.has(id) ? myVotes.delete(id) : myVotes.add(id);
    } else if (S.session) { return openAuth(); }  // signed in but no handle yet
    else {
      // Guests heart through the server (one per guest session per idea).
      const r = await fetch("/api/vote", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, fp: await fingerprint() }) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) return toast(d.error === "rate_limited" ? "Easy there — try again in a minute." : d.error === "not_votable" ? "That idea is already painting." : d.error === "signin_required" ? "Sign in to vote right now." : "Couldn't save that heart.");
      data = d.votes;
      d.on ? myVotes.add(id) : myVotes.delete(id);
    }
    document.querySelectorAll(`[data-vote="${id}"]`).forEach((x) => { x.classList.toggle("on", myVotes.has(id)); x.querySelector("span").textContent = data ?? 0; });
    const r = listRows.find((x) => x.id === id); if (r) r.votes = data ?? r.votes;
  }, true);
  $("qsort").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-s]"); if (!b || b.dataset.s === qsort) return;
    qsort = b.dataset.s;
    $("qsort").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    $("panel-next").dataset.sort = qsort;
    listRows = []; listDone = false;
    $("idea-list").innerHTML = ""; $("queue-more").innerHTML = "";
    if (qsort !== "up") loadList(true); else $("q-more").classList.toggle("hidden", !upFull);
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act][data-iid]"); if (!b) return;
    e.stopPropagation();
    const { error } = await sb.rpc(b.dataset.act, { p_id: +b.dataset.iid });
    if (error) return toast(friendly(error));
    b.closest("li")?.remove(); refreshIdeas();
  }, true);
  // Report an idea (queue rows): feeds the admin Reports list.
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-report]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const note = prompt("Report this idea? Add a short reason (optional).");
    if (note === null) return;
    const r = await fetch("/api/report", { method: "POST", headers: { "content-type": "application/json", ...(S.session ? { authorization: "Bearer " + S.session.access_token } : {}) },
      body: JSON.stringify({ idea_id: +b.dataset.report, reason: "other", note }) }).catch(() => null);
    toast(r && r.ok ? "Thanks, we'll take a look." : r && r.status === 429 ? "Too many reports. Try later." : "Couldn't send the report.");
  }, true);
  S.place = async (id) => { if (!id || id < 0) return null; const { data } = await sb.rpc("queue_place", { p_id: id }); return (data || [])[0] || null; };
  async function placeToast(id, tail) {
    const p = await S.place(id).catch(() => null);
    toast(p && p.place ? `Added · #${p.place} in line · ${etaLabel(p.eta_s)}${tail || ""}` : `Added, you're up soon${tail || ""}`, 3600);
  }
  S.placeToast = placeToast;
  $("q-more").addEventListener("click", () => loadList(listRows.length === 0));
  function renderIdeas() { if (listRows.length) renderList(qsort === "up" ? $("queue-more") : $("idea-list")); }
  refreshIdeas();
  sb.channel("ideas").on("postgres_changes", { event: "*", schema: "public", table: "ideas" }, (p) => { refreshIdeas(); window.dispatchEvent(new CustomEvent("tapestry:idea", { detail: p })); }).subscribe();
  setInterval(refreshIdeas, 60000);

  // ---------- chat ----------
  // Home-page live chat: just people talking. Realtime rides the existing Supabase channel (no polling).
  // Collapsed: the newest few lines float over the art and fade after ~20 s. Open: scrollable, with the input.
  // Signed-in users post through /api/chat (moderation, 200 chars, no links, slow mode); guests read.
  const chatEl = $("chat"), chatList = $("chat-list"), chatInput = $("chat-input"), chatNote = $("chat-note"), chatTgl = $("chat-toggle");
  const seen = new Set();
  const hideHandle = (h) => { const x = String(h || "").replace(/^@/, "").toLowerCase(); return !x || x === "bicrick" || x === "claude"; };
  const FADE_MS = 20000, KEEP = 60;
  let chatOn = (() => { try { return localStorage.getItem("it:chat") !== "off"; } catch (_) { return true; } })();
  let chatSettings = { enabled: true, slow: 5 }, slowUntil = 0, slowTimer = 0;
  const applyChatOn = () => {
    document.body.classList.toggle("chat-off", !chatOn);
    chatTgl.setAttribute("aria-pressed", chatOn ? "true" : "false");
    chatTgl.title = chatOn ? "Hide chat (C)" : "Show chat (C)";
    if (!chatOn) setChatOpen(false);
  };
  function setChatOpen(on) {
    if (on && (!chatOn || !chatSettings.enabled)) return;
    document.body.classList.toggle("chat-open", !!on);
    if (on) { chatList.scrollTop = chatList.scrollHeight; if (canChat()) { if (matchMedia("(hover: hover)").matches) setTimeout(() => chatInput.focus({ preventScroll: true }), 60); else chatInput.focus({ preventScroll: true }); } }
    else if (document.activeElement === chatInput) chatInput.blur();
  }
  // Phones: when the keyboard goes away, the sheet goes back to the compact strip (draft kept).
  const narrow = () => innerWidth < 1200 || innerWidth <= innerHeight;
  window.addEventListener("tapestry:kb", (e) => { if (!e.detail.open && narrow() && document.body.classList.contains("chat-open")) setChatOpen(false); });
  chatInput.addEventListener("blur", () => setTimeout(() => {
    if (narrow() && document.body.classList.contains("chat-open") && !chatEl.contains(document.activeElement) && !document.documentElement.classList.contains("kb-open") && matchMedia("(pointer: coarse)").matches) setChatOpen(false);
  }, 400));
  window.__chatOpen = () => setChatOpen(true); window.__chatClose = () => setChatOpen(false);
  const canChat = () => !!(S.session && S.profile && S.profile.handle);
  S.chatAuth = () => {
    const ok = canChat();
    $("chat-form").classList.toggle("hidden", !ok);
    $("chat-signin").classList.toggle("hidden", ok);
    $("chat-signin").textContent = S.session ? "Pick a name to chat" : "Sign in to chat";
  };
  S.chatAuth();
  $("chat-signin").addEventListener("click", (e) => { e.stopPropagation(); setChatOpen(false); openAuth(); });   // one sheet at a time
  chatTgl.classList.remove("hidden");
  chatTgl.addEventListener("click", () => { chatOn = !chatOn; try { localStorage.setItem("it:chat", chatOn ? "on" : "off"); } catch (_) {} applyChatOn(); });
  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "c" || e.key === "C") chatTgl.click();
    if (e.key === "Escape" && document.body.classList.contains("chat-open")) setChatOpen(false);
  });
  // Collapsed overlay: click (or tap the mobile strip) opens; outside click closes.
  chatEl.addEventListener("click", (e) => { if (!document.body.classList.contains("chat-open") && !e.target.closest(".mod")) setChatOpen(true); });
  $("chat-close").addEventListener("click", (e) => { e.stopPropagation(); setChatOpen(false); });
  document.addEventListener("pointerdown", (e) => {
    if (document.body.classList.contains("chat-open") && !chatEl.contains(e.target) && !e.target.closest("#chat-toggle, #auth-pop, .sheet")) setChatOpen(false);
  }, true);
  // Mobile strip sits just above the dock: track its top edge (layout only on resize, never per frame).
  const dock = document.querySelector(".dock");
  let dockTop = -1;
  const placeStrip = () => {
    const c = document.body.classList;   // measure only at rest (not mid intro / idle / compose motion)
    if (!dock || document.hidden || c.contains("composing") || c.contains("idle") || c.contains("intro") || !c.contains("settled")) return;
    const r = dock.getBoundingClientRect(), v = Math.round(innerHeight - r.top), vb = Math.round(innerHeight - r.bottom);
    if (v !== dockTop && v > 0) { dockTop = v; document.documentElement.style.setProperty("--dock-top", v + "px"); document.documentElement.style.setProperty("--dock-bot", Math.max(0, vb) + "px"); }
    // Room under the band (never on the art): one line if tight, hidden if none.
    const side = innerWidth >= 1200 && innerWidth > innerHeight;
    const bandBot = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--band-bot")) || innerHeight * 0.7;
    const room = side ? innerHeight - Math.max(0, vb) - bandBot - 16 : innerHeight - v - 8 - bandBot - 10;
    c.toggle("chat-noroom", room < 18); c.toggle("chat-oneline", room < 44);
  };
  if (dock && window.ResizeObserver) new ResizeObserver(placeStrip).observe(dock);
  if (dock) dock.addEventListener("transitionend", placeStrip);
  addEventListener("resize", placeStrip); placeStrip(); setInterval(placeStrip, 1000);   // one cheap rect read a second; the dock re-centres without resizing

  function fadeLater(li, t) {
    const left = FADE_MS - (Date.now() - t);
    if (left <= 0) li.classList.add("aged"); else setTimeout(() => li.classList.add("aged"), left);
  }
  function addChat(m, mine) {
    if (seen.has(m.id) || m.hidden) return;
    seen.add(m.id);
    const li = document.createElement("li");
    li.dataset.id = m.id;
    const who = hideHandle(m.handle) ? "" : `<span class="who">${esc(m.handle)}</span>`;
    const mod = S.isAdmin() && m.user_id ? `<span class="mod" data-a="hide">delete</span><span class="mod" data-a="mute">mute</span><span class="mod" data-a="ban">ban</span>` : "";
    li.innerHTML = `${who}<span class="msg">${esc(m.body)}</span>${mod}`;
    li.querySelectorAll(".mod").forEach((x) => x.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const a = x.dataset.a;
      const { error } = a === "hide" ? await sb.rpc("admin_hide_chat", { p_id: m.id })
        : await sb.rpc("admin_sanction", { p_user: m.user_id, p_kind: a, p_minutes: a === "mute" ? 60 : null, p_reason: "chat moderation" });
      if (error) return toast(friendly(error));
      if (a === "hide") li.remove();
      toast(a === "hide" ? "Message deleted" : a === "mute" ? "Muted for an hour" : "Banned");
    }));
    const t = m.created_at ? Date.parse(m.created_at) : Date.now();
    const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
    chatList.appendChild(li);
    fadeLater(li, mine ? Date.now() : t);
    while (chatList.children.length > KEEP) chatList.firstChild.remove();
    if (atBottom || mine) chatList.scrollTop = chatList.scrollHeight;
  }
  const note = (txt, ms) => { chatNote.textContent = txt || ""; chatNote.classList.toggle("on", !!txt); clearTimeout(note.t); if (txt && ms) note.t = setTimeout(() => note(""), ms); };
  function slow(sec) {
    slowUntil = Date.now() + sec * 1000;
    $("chat-form").classList.add("slow");
    clearInterval(slowTimer);
    const tick = () => {
      const left = Math.ceil((slowUntil - Date.now()) / 1000);
      if (left <= 0) { clearInterval(slowTimer); $("chat-form").classList.remove("slow"); return note(""); }
      note(`Slow mode. You can send again in ${left} s.`);
    };
    tick(); slowTimer = setInterval(tick, 500);
  }
  sb.rpc("chat_settings").then(({ data }) => {
    if (data) chatSettings = { enabled: data.enabled !== false, slow: Number(data.slow) || 5 };
    document.body.classList.toggle("chat-disabled", !chatSettings.enabled);
    chatEl.classList.remove("hidden"); applyChatOn();
  }, () => { chatEl.classList.remove("hidden"); applyChatOn(); });
  const { data: recent } = await sb.from("chat_messages").select("id,user_id,handle,body,hidden,created_at").order("created_at", { ascending: false }).limit(40);
  (recent || []).reverse().forEach((m) => addChat(m));
  sb.channel("chat").on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (p) => addChat(p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages" }, (p) => { if (p.new.hidden) { const el = chatList.querySelector(`li[data-id="${p.new.id}"]`); el && el.remove(); } })
    .subscribe();

  const CHAT_ERR = { no_links: "Links aren't allowed in chat.", content_not_allowed: "That message isn't allowed here.", muted: "You're muted for a little while.",
    chat_off: "Chat is paused for now.", bad_length: "Messages are up to 200 characters.", handle_required: "Pick a name first.", signin_required: "Sign in to chat." };
  $("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = chatInput.value.replace(/\s+/g, " ").trim();
    if (!body) return;
    if (!canChat()) return openAuth();
    if (Date.now() < slowUntil) return;
    if (/(https?:\/\/|www\.)/i.test(body)) return note(CHAT_ERR.no_links, 4000);
    $("chat-form").classList.add("sending");
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + S.token() },
      body: JSON.stringify({ text: body }) }).catch(() => null);
    $("chat-form").classList.remove("sending");
    const d = r ? await r.json().catch(() => ({})) : {};
    if (d.error === "slow_mode") return slow(Number(d.wait) || chatSettings.slow);
    if (!r || !r.ok || d.error) return note(CHAT_ERR[d.error] || "That didn't send. Try again.", 4500);
    chatInput.value = "";
    addChat({ id: d.id, user_id: S.session.user.id, handle: d.handle || S.profile.handle, body, created_at: new Date().toISOString() }, true);
    slow(chatSettings.slow);
  });

  // ---------- fuel & donations ----------
  // Fuel = donations received vs. what painting has cost so far. Never a negative "tank".
  let fuel = { balance_cents: null, pod_status: null }, FS = null, fuelAt = 0;
  const usd = (c) => "$" + (c / 100).toFixed(c >= 10000 ? 0 : 2);
  const dur = (h) => h >= 48 ? `${Math.round(h / 24)} days` : h >= 20 ? `${(h / 24).toFixed(1).replace(/\.0$/, "")} day${h >= 36 ? "s" : ""}` : h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(h * 60))} min`;
  const net = (c) => Math.max(0, c * 0.971 - 30); // Stripe fees come out before fuel is credited
  function renderFuel() {
    if (!FS) return;
    const covered = FS.hours_covered || 0, painted = FS.hours_painted || 0, rate = FS.rate_cents_per_hour || 89;
    const pct = painted ? Math.min(100, (covered / painted) * 100) : 0;
    $("fuel-fill").style.width = pct + "%";
    $("fuel-fill-big").style.width = pct + "%";
    $("fuel-text").textContent = covered > 0 ? `${dur(covered)} fueled` : "Fuel";
    $("fuel-chip").classList.remove("low");
    $("fuel-caption").innerHTML = covered > 0
      ? `Fuel covered ${esc(dur(covered))}<span class="muted"> of ${esc(dur(painted))} painted</span>`
      : `Running on the creator's dime<span class="muted"> · ${esc(dur(painted || 0))} painted</span>`;
    $("fuel-sub").textContent = `${usd(FS.donated_cents)} donated · ${usd(FS.cost_cents)} spent painting${FS.since ? " since " + new Date(FS.since).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}`;
    $("fuel-rate-note").textContent = `Painting costs about ${usd(rate)} an hour (GPU ${usd(FS.gpu_cents_per_hour)}${FS.director_cents_per_hour ? ` + Auto ${usd(FS.director_cents_per_hour)}` : ""}). Fuel helps cover it; the tapestry keeps painting around the clock either way.`;
    document.querySelectorAll("#tiers button").forEach((b) => { const sm = b.querySelector("small"); if (sm) sm.textContent = "~" + dur(net(Number(b.dataset.cents)) / rate); });
  }
  async function refreshFuel(force) {
    if (!force && Date.now() - fuelAt < 50000) return; fuelAt = Date.now();
    try { const d = await (await fetch("/api/about?kind=transparency")).json(); if (d && d.fuel) { FS = d.fuel; FS._series = d.series || []; renderFuel(); } } catch (_) {}
  }
  window.addEventListener("tapestry:fuel", (e) => {
    const f = (e.detail && e.detail.fuel) || {};
    if (f.queue_mode && f.queue_mode !== queueMode) { queueMode = f.queue_mode; refreshIdeas(); }
  });
  refreshFuel(true);
  setInterval(() => refreshFuel(), 300000);
  // Chart: daily painting cost (bars) vs. donations (accent bars), last 14 days.
  async function fuelChart() {
    await refreshFuel(true);
    const svg = $("fuel-chart"); if (!svg || !FS) return;
    const days = new Map();
    for (const s of FS._series) {
      const k = new Date(s.t).toLocaleDateString("en-CA");
      const d = days.get(k) || { k, cost: 0, don: 0 }; d.cost += +s.burn || 0; d.don += +s.donated || 0; days.set(k, d);
    }
    const list = [...days.values()].slice(-14), W = 600, H = 160, base = H - 22;
    if (!list.length) { svg.innerHTML = `<text x="300" y="85" text-anchor="middle" font-size="13" fill="currentColor" opacity=".45">No history yet</text>`; $("fuel-chart-note").textContent = ""; return; }
    const max = Math.max(1, ...list.map((d) => Math.max(d.cost, d.don)));
    const slot = W / Math.max(list.length, 7), bw = Math.min(28, slot * 0.32);
    const h = (v) => (base - 10) * (v / max);
    const out = [`<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="currentColor" opacity=".15"/>`];
    list.forEach((d, i) => {
      const cx = slot * (i + 0.5);
      out.push(`<rect x="${cx - bw - 1}" y="${base - h(d.cost)}" width="${bw}" height="${h(d.cost)}" rx="2" fill="currentColor" opacity=".22"><title>${d.k}: ${usd(d.cost)} cost</title></rect>`);
      out.push(`<rect x="${cx + 1}" y="${base - h(d.don)}" width="${bw}" height="${Math.max(d.don ? 2 : 0, h(d.don))}" rx="2" fill="#e0a84a"><title>${d.k}: ${usd(d.don)} donated</title></rect>`);
      if (list.length <= 7 || i % 2 === list.length % 2 - 1 || i === list.length - 1) out.push(`<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".5">${new Date(d.k + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" })}</text>`);
    });
    svg.innerHTML = out.join("");
    $("fuel-chart-note").innerHTML = `<span class="lg cost"></span>Daily cost <span class="lg don"></span>Donations`;
  }

  const refreshDonors = () => {};   // donor wall lives only on /about


  async function donate(cents, { ideaId } = {}) {
    try {
      const r = await fetch("/api/checkout", {
        method: "POST", headers: { "content-type": "application/json", ...(S.token() ? { authorization: "Bearer " + S.token() } : {}) },
        body: JSON.stringify({ cents, ideaId: ideaId || null, note: (($("donor-note") || {}).value || "").slice(0, 140), returnTo: location.origin + location.pathname }),
      });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.error || "checkout failed");
      location.href = j.url;
    } catch (e) { toast("Couldn't open checkout. " + esc(e.message || "")); }
  }
  S.donate = donate;
  document.querySelectorAll("#tiers button, #sleep-tiers button").forEach((b) => b.addEventListener("click", () => donate(Number(b.dataset.cents))));
  $("fuel-chip").addEventListener("click", () => openTab("fuel"));
  const qs = new URLSearchParams(location.search);
  if (qs.get("fuel")) { openTab("fuel"); history.replaceState(null, "", location.pathname); }
  if (qs.get("thanks")) {
    toast("Thank you. The tapestry has more fuel.", 6000);
    history.replaceState(null, "", location.pathname);
    setTimeout(() => { refreshFuel(true); refreshDonors(); refreshIdeas(); }, 2500);
  }

  // ---------- sleep state ----------
  let wsOpen = false, closedSince = Date.now();
  window.addEventListener("tapestry:ws", (e) => { wsOpen = e.detail.open; if (!wsOpen) closedSince = Date.now(); else setSleeping(false); });
  setInterval(() => { if (!wsOpen && Date.now() - closedSince > 8000) $("sleep-note").textContent = "Waking up…"; }, 15000);
  let snapLoaded = false;
  function setSleeping(on) {
    document.body.classList.toggle("sleeping", on);
    $("sleep").classList.toggle("hidden", !on);
    if (on && !snapLoaded) {
      snapLoaded = true;
      const img = new Image();
      img.onload = () => { const v = $("view"); if (v) { v.style.backgroundImage = `url(${img.src})`; v.style.backgroundSize = "auto 100%"; v.style.backgroundPosition = "right center"; } };
      img.src = "/api/snapshot";
    }
  }

  // ---------- tabs ----------
  function openTab(name) {
    if (name === "ideas") name = "next";
    if (name === "you") {   // your profile when signed in, otherwise sign in
      if (!S.session) { $("drawer").classList.remove("open"); openAuth(); return; }
    }
    $("drawer").classList.add("open");
    if (name === "next" && window.TapestryWS) window.TapestryWS.send({ type: "upcoming_request" });
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== "panel-" + name));
    if (name === "fuel") { fuelChart(); refreshDonors(); }
    if (name === "next") refreshIdeas();
    if (name === "audit") refreshAudit();
  }
  S.openTab = openTab;
  {   // theme toggle (desktop drawer)
    const cur = localStorage.getItem("it:theme") || "";
    document.querySelectorAll(".drawer-theme button").forEach((b) => {
      b.classList.toggle("on", b.dataset.theme === cur);
      b.addEventListener("click", () => { if (window.TapestryTheme) TapestryTheme.set(b.dataset.theme); document.querySelectorAll(".drawer-theme button").forEach((x) => x.classList.toggle("on", x === b)); });
    });
  }

  // ---------- admin audit ----------
  async function refreshAudit() {
    if (!S.isAdmin()) return;
    const f = $("audit-filter").value.trim() || null;
    const { data, error } = await sb.rpc("admin_audit", { p_limit: 200, p_action: f });
    if (error) return toast(friendly(error));
    $("audit-list").innerHTML = (data || []).map((a) =>
      `<li class="item"><div><div class="t">${esc(a.action)} <span class="muted">${esc(a.actor_handle || (a.actor ? a.actor.slice(0, 8) : "system"))}</span></div>` +
      `<div class="meta">${new Date(a.at).toLocaleString()} · ${esc(a.target || "")} · ip ${esc((a.ip_hash || "").slice(0, 8))}</div>` +
      `<div class="p">${esc(JSON.stringify(a.detail || {}).slice(0, 200))}</div></div></li>`).join("");
  }
  $("audit-filter").addEventListener("keydown", (e) => { if (e.key === "Enter") refreshAudit(); });
}
