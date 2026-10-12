// Social layer: accounts, idea pool, votes, chat, fuel, donations, admin.
// Loaded as a module; stays dormant when no Supabase config is present (local/dev).
const CFG = window.TAPESTRY_CONFIG || {};
let queueMode = "fifo";   // hoisted: refreshIdeas can run before the queue UI block
const $ = (id) => document.getElementById(id);
const W = () => window.TapestryWS || { send() {}, toast() {}, esc: (s) => String(s) };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const S = { enabled: false, session: null, profile: null, isAdmin: () => !!(S.profile && S.profile.is_admin), token: () => S.session && S.session.access_token, submitIdea: async () => false };
window.TapestrySocial = S;

const UP = '<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>';
const ERR = {
  not_signed_in: "Sign in to add ideas, vote and chat.",
  handle_required: "Pick a handle first.",
  one_active_idea: "You have a few ideas waiting already. Give them a moment to play.",
  too_many_pending: "You have a few ideas waiting already. Give them a moment to play.",
  content_not_allowed: "That one's outside what the tapestry paints.",
  banned: "This account is suspended.",
  muted: "You're muted for a little while.",
  handle_taken: "That handle is taken.",
  bad_image: "That image could not be attached. Try another.",
  bad_handle: "Handles are 2–20 letters, numbers or underscores.",
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

// ---------- guests: anyone can add ideas; signing in is an upgrade, not a gate ----------
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
  if (r.ok) { if (token) guest.human = true; if (d.handle) guest.handle = d.handle; return { ok: true }; }
  const map = { rate_limited: "guest_rate", too_many_pending: "guest_pending" };
  return { ok: false, err: map[d.error] || d.error || "server" };
}
// Local echo so a guest always sees what they sent (also covers ideas that never reach the pool).
const LOCAL_KEY = "it:my-guest-ideas";
const localIdeas = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]").filter((x) => Date.now() - x.t < 30 * 60e3); } catch (_) { return []; } };
const addLocal = (body, handle) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify([...localIdeas(), { body, handle, t: Date.now() }].slice(-6))); } catch (_) {} };

if (CFG.supabaseUrl && CFG.supabaseAnonKey) boot().catch((e) => console.warn("social disabled", e));

async function boot() {
  const A = await import("./sb.js");
  const sb = await A.client();
  S.sb = sb;
  S.enabled = true;
  document.body.classList.add("social");
  document.querySelectorAll(".social-only").forEach((el) => el.classList.remove("hidden"));
  $("account-btn").classList.remove("hidden");
  $("fuel-chip").classList.remove("hidden");
  $("chat").classList.remove("hidden");
  $("cmd-input").placeholder = innerWidth < 480 ? "Where next?" : "Suggest where the tapestry goes next…";
  let google = !!CFG.google;
  A.googleEnabled().then((on) => { google = on; $("auth-google").classList.toggle("hidden", !on || !!S.session); $("auth-or").classList.toggle("hidden", !on || !!S.session); });

  // Hoisted above first loadProfile(): loadVotes/renderIdeas run from loadProfile
  // and must not hit TDZ (was: ReferenceError myVotes before initialization).
  let myVotes = new Set();
  let ideas = [];
  let hourCents = Number(CFG.centsPerHour) || 20;

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
    $("chat-input").placeholder = S.profile ? "Say something…" : "Sign in to chat";
    if (S.token()) W().send({ type: "auth", token: S.token() });
    loadVotes();
  }
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  await loadProfile();
  if (S.session && S.profile && !S.profile.handle) openAuth();
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
    $("auth-form").classList.toggle("hidden", signed);
    $("auth-google").classList.toggle("hidden", signed || !google);
    $("auth-or").classList.toggle("hidden", signed || !google);
    $("auth-code-form").classList.add("hidden");
    if (!signed) { $("auth-form").classList.remove("hidden"); if (!$("auth-email").value) $("auth-email").value = A.lastEmail(); }
    $("handle-form").classList.toggle("hidden", !needHandle);
    $("auth-signed").classList.toggle("hidden", !signed || needHandle);
    $("auth-handle").textContent = S.profile && S.profile.handle ? "@" + S.profile.handle : "";
    document.querySelector("#auth-pop .sheet-title").textContent = needHandle ? "Almost there" : signed ? "Your account" : "Join the tapestry";
    $("auth-pop").classList.remove("hidden");
    setTimeout(() => (needHandle ? $("handle-input") : $("auth-email")).focus(), 50);
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
      if (!res.ok) { toast(ERR[res.err] || "Something went wrong. Try again."); if (res.err === "signin_required") openAuth(); return false; }
      addLocal(text, guest.handle);
      try { window.va && window.va("event", { name: "idea_submitted", data: { who: "guest" } }); } catch (_) {}
            window.dispatchEvent(new CustomEvent("tapestry:submitted"));
      toast(`Added to the pool as <b>@${esc(guest.handle || "guest")}</b> <span class="muted">“${esc(text)}”</span><br><span class="muted">Sign in anytime to keep your ideas and add more.</span>`, 4200);
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
    const { error } = await sb.rpc("submit_idea", { p_body: text, p_image: image });
    if (error) { toast(friendly(error)); return false; }
    try { window.va && window.va("event", { name: "idea_submitted", data: { who: "signed_in", image: !!image } }); } catch (_) {}
    clearRef();
    window.dispatchEvent(new CustomEvent("tapestry:submitted"));
    toast(`Added to the pool <span class="muted">“${esc(text)}”</span>`, 3000);
    refreshIdeas();
    if (window.TapestryWS) window.TapestryWS.send({ type: "idea_added" });
    return true;
  };
  async function loadVotes() {
    myVotes = new Set();
    if (S.session) {
      const { data } = await sb.from("votes").select("idea_id").eq("user_id", S.session.user.id);
      (data || []).forEach((r) => myVotes.add(r.idea_id));
    }
    renderIdeas();
  }
  async function refreshIdeas() {
    sb.from("ideas").select("id,handle,body,image_path,start_strip,end_strip,played_at").eq("status", "played")
      .not("start_strip", "is", null).order("played_at", { ascending: false }).limit(20).then(({ data }) => renderWoven(data || []));
    const { data } = await sb.from("ideas").select("id,handle,body,votes,boost_cents,status,user_id,created_at,image_path")
      .in("status", ["pending", "playing"]).order("status", { ascending: false }).order("boost_cents", { ascending: false })
      .order("votes", { ascending: false }).order("created_at").limit(60);
    ideas = data || [];
    // Adaptive voting: few pending ideas play first-come-first-served; votes only matter when busy.
    const pending = ideas.filter((i) => i.status === "pending").length;
    queueMode = pending > 3 ? "vote" : "fifo";
    if (queueMode === "fifo") ideas.sort((a, b) => (a.status === "playing" ? -1 : b.status === "playing" ? 1 : 0) || String(a.created_at).localeCompare(String(b.created_at)));
    renderIdeas();
  }
  function renderIdeas() {
    const list = $("idea-list");
    if (!list) return;
    list.classList.toggle("fifo", queueMode === "fifo");
    let hint = $("idea-mode-hint");
    if (!hint) { hint = document.createElement("p"); hint.id = "idea-mode-hint"; hint.className = "idea-mode-hint"; list.before(hint); }
    hint.textContent = queueMode === "vote" ? "Busy right now · vote to choose what's painted next" : "";
    hint.classList.toggle("hidden", queueMode !== "vote");
    const echo = S.session ? [] : localIdeas().filter((x) => !ideas.some((i) => i.body === x.body && i.handle === x.handle))
      .map((x) => ({ id: null, body: x.body, handle: x.handle, votes: 0, status: "pending", local: true }));
    const shown = [...ideas, ...echo];
    $("idea-empty").classList.toggle("hidden", shown.length > 0);
    list.innerHTML = "";
    shown.forEach((it) => {
      const li = document.createElement("li");
      li.className = "item idea";
      const mine = S.session && it.user_id === S.session.user.id;
      li.innerHTML =
        `<button class="votes${myVotes.has(it.id) ? " on" : ""}" title="Vote">${UP}<span>${it.votes}</span></button>` +
        `<div>${it.image_path ? `<img class="thumb" src="${esc(refUrl(it.image_path))}" alt="" loading="lazy" />` : ""}<div class="t">${esc(it.body)}</div><div class="who">${isGuestHandle(it.handle) ? `<span class="who-guest">@${esc(it.handle)}</span>` : `<a class="who-link" href="/u/${encodeURIComponent(it.handle)}">@${esc(it.handle)}</a>`}${it.status === "playing" ? " · weaving in now" : ""}` +
        `${it.boost_cents ? ` · <span class="boosted">boosted $${(it.boost_cents / 100).toFixed(0)}</span>` : ""}</div></div>` +
        `<div class="acts">` +
        (it.status === "pending" ? `<button class="icon" data-a="boost" title="Boost with fuel">⚡︎</button>` : "") +
        (mine && it.status === "pending" ? `<button class="icon" data-a="withdraw" title="Withdraw">✕</button>` : "") +
        (S.isAdmin() ? `<button class="icon" data-a="reject" title="Reject (admin)">⊘</button>` : "") + `</div>`;
      if (it.local) { li.querySelector(".acts").innerHTML = ""; li.querySelector(".votes").disabled = true; li.classList.add("local"); list.appendChild(li); return; }
      li.querySelector(".votes").addEventListener("click", async () => {
        if (needLogin()) return;
        const { data, error } = await sb.rpc("toggle_vote", { p_idea: it.id });
        if (error) return toast(friendly(error));
        myVotes.has(it.id) ? myVotes.delete(it.id) : myVotes.add(it.id);
        it.votes = data ?? it.votes;
        renderIdeas();
      });
      li.querySelectorAll(".acts button").forEach((b) => b.addEventListener("click", async () => {
        const a = b.dataset.a;
        if (a === "boost") return donate(500, { ideaId: it.id });
        const fn = a === "withdraw" ? "withdraw_idea" : "admin_reject_idea";
        const { error } = await sb.rpc(fn, { p_id: it.id });
        if (error) return toast(friendly(error));
        refreshIdeas();
      }));
      list.appendChild(li);
    });
  }
  function permalink(it) {
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set("at", it.start_strip);
    if (it.end_strip != null) u.searchParams.set("to", it.end_strip);
    return u.toString();
  }
  function renderWoven(rows) {
    $("woven-list").innerHTML = "";
    rows.forEach((it) => {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML = `<div>${it.image_path ? `<img class="thumb" src="${esc(refUrl(it.image_path))}" alt="" loading="lazy" />` : ""}` +
        `<div class="t">${esc(it.body)}</div><div class="who">${isGuestHandle(it.handle) ? `<span class="who-guest">@${esc(it.handle)}</span>` : `<a class="who-link" href="/u/${encodeURIComponent(it.handle)}">@${esc(it.handle)}</a>`} · strip ${it.start_strip}</div>` +
        `<div class="links"><a data-a="view">View where it landed</a><a data-a="copy">Copy link</a></div></div>`;
      li.addEventListener("click", async (e) => {
        if (e.target.dataset.a === "copy") {
          e.stopPropagation();
          try { await navigator.clipboard.writeText(permalink(it)); toast("Link copied"); } catch (_) { toast(esc(permalink(it))); }
          return;
        }
        $("drawer").classList.remove("open");
        window.TapestrySeek && window.TapestrySeek(it.start_strip, it.end_strip);
      });
      $("woven-list").appendChild(li);
    });
    if (!rows.length) $("woven-list").innerHTML = '<li class="empty">Ideas appear here once they are painted.</li>';
  }
  refreshIdeas();
  sb.channel("ideas").on("postgres_changes", { event: "*", schema: "public", table: "ideas" }, (p) => { refreshIdeas(); window.dispatchEvent(new CustomEvent("tapestry:idea", { detail: p })); }).subscribe();
  setInterval(refreshIdeas, 60000);

  // ---------- chat ----------
  const chatList = $("chat-list");
  const seen = new Set();
  function addChat(m) {
    if (seen.has(m.id) || m.hidden) return;
    seen.add(m.id);
    const li = document.createElement("li");
    li.dataset.id = m.id;
    li.innerHTML = `<b>${esc(m.handle)}</b>${esc(m.body)}<span class="mod" data-a="hide">hide</span><span class="mod" data-a="mute">mute</span><span class="mod" data-a="ban">ban</span>`;
    li.querySelectorAll(".mod").forEach((x) => x.addEventListener("click", async () => {
      const a = x.dataset.a;
      const { error } = a === "hide" ? await sb.rpc("admin_hide_chat", { p_id: m.id })
        : await sb.rpc("admin_sanction", { p_user: m.user_id, p_kind: a, p_minutes: a === "mute" ? 60 : null, p_reason: "chat moderation" });
      if (error) return toast(friendly(error));
      if (a === "hide") li.remove();
      toast(a === "hide" ? "Message hidden" : `@${esc(m.handle)} ${a === "mute" ? "muted for an hour" : "banned"}`);
    }));
    chatList.appendChild(li);
    while (chatList.children.length > 30) chatList.firstChild.remove();
  }
  const { data: recent } = await sb.from("chat_messages").select("id,user_id,handle,body,hidden,created_at").order("created_at", { ascending: false }).limit(20);
  (recent || []).reverse().forEach(addChat);
  sb.channel("chat").on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (p) => addChat(p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages" }, (p) => { if (p.new.hidden) { const el = chatList.querySelector(`li[data-id="${p.new.id}"]`); el && el.remove(); } })
    .subscribe();
  $("chat-input").addEventListener("focus", () => { if (!S.session || !(S.profile && S.profile.handle)) { $("chat-input").blur(); openAuth(); } });
  $("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = $("chat-input").value.trim();
    if (!body || needLogin()) return;
    const { data, error } = await sb.rpc("send_chat", { p_body: body });
    if (error) return toast(friendly(error));
    $("chat-input").value = "";
    addChat({ id: data, user_id: S.session.user.id, handle: S.profile.handle, body });
  });

  // ---------- fuel & donations ----------
  let fuel = { balance_cents: null, pod_status: null };
  function renderFuel() {
    if (fuel.balance_cents == null) return;
    const cents = Math.max(0, Number(fuel.balance_cents));
    const rate = hourCents || Number(CFG.centsPerHour) || 20;
    const hours = cents / rate;
    const pct = Math.min(100, (hours / 48) * 100);  // full bar = two days
    $("fuel-fill").style.width = pct + "%";
    $("fuel-fill-big").style.width = pct + "%";
    const label = hours >= 48 ? `${Math.floor(hours / 24)} days` : hours >= 1 ? `${Math.floor(hours)} h` : `${Math.round(hours * 60)} min`;
    $("fuel-text").textContent = label;
    $("fuel-hours").textContent = label;
    $("fuel-chip").classList.toggle("low", hours < 3);
    setSleeping(cents <= 0 && !wsOpen);
  }
  async function refreshFuel() {
    const { data } = await sb.from("fuel_status").select("*").maybeSingle();
    if (data) { fuel = data; renderFuel(); }
  }
  window.addEventListener("tapestry:config", (e) => {
    const r = e.detail && e.detail.gpu_cents_per_hour;
    if (r) { hourCents = Number(r) || hourCents; renderFuel(); }
  });
  window.addEventListener("tapestry:fuel", (e) => {
    const f = (e.detail && e.detail.fuel) || {};
    if (f.queue_mode && f.queue_mode !== queueMode) { queueMode = f.queue_mode; refreshIdeas(); }
    if (f.gpu_cents_per_hour) hourCents = Number(f.gpu_cents_per_hour) || hourCents;
    const cents = f.cents ?? e.detail.balance_cents;
    if (cents != null) fuel = { ...fuel, balance_cents: cents };
    renderFuel();
  });
  refreshFuel();
  setInterval(refreshFuel, 60000);

  // Donor wall: recent gifts and the all-time board; shout-out banners link out (nofollow ugc).
  let donorTab = "recent", donorsTop = [];
  const ago = (iso) => { const m = (Date.now() - new Date(iso).getTime()) / 60000; return m < 1 ? "just now" : m < 60 ? `${Math.floor(m)}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
  const safeHref = (u) => (/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(u || "") ? u : null);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } };
  const donorName = (h) => (h === "anonymous" || !h ? "Anonymous" : `<a href="/u/${encodeURIComponent(h)}">@${esc(h)}</a>`);
  const shout = (d) => (d.tagline ? `<div class="p">“${esc(d.tagline)}”</div>` : "") +
    (safeHref(d.url) ? `<a class="d-link" href="${esc(d.url)}" target="_blank" rel="nofollow ugc noopener noreferrer">${esc(hostOf(d.url))} ↗</a>` : "");
  async function refreshDonors() {
    const [rec, top] = await Promise.all([sb.from("donors_recent").select("*").limit(20), sb.from("donors_top").select("*").limit(30)]);
    donorsTop = (top.data || []).filter((d) => d.handle && d.handle !== "anonymous");
    const rows = donorTab === "recent" ? (rec.data || []) : (top.data || []);
    $("donor-list").innerHTML = rows.map((d, k) =>
      `<li class="item"><div>${donorTab === "top" ? `<span class="rank">${k + 1}</span>` : ""}<div class="t">${donorName(d.handle)}${donorTab === "recent" ? ` <span class="muted">· ${ago(d.created_at)}</span>` : ""}</div>${shout(d)}</div>` +
      `<span class="amt">$${((donorTab === "recent" ? d.amount_cents : d.total_cents) / 100).toFixed(0)}</span></li>`).join("")
      || `<li class="empty">Be the first to keep it painting.</li>`;
    renderKept();
  }
  document.querySelectorAll(".donor-tabs [data-dl]").forEach((b) => b.addEventListener("click", () => {
    donorTab = b.dataset.dl; document.querySelectorAll(".donor-tabs [data-dl]").forEach((x) => x.classList.toggle("on", x === b)); refreshDonors();
  }));
  // "kept alive by @x": a quiet ticker that cycles through donors.
  let keptI = 0, keptT = 0;
  function renderKept() {
    const el = $("kept"), names = donorsTop.slice(0, 12);
    el.classList.toggle("hidden", !names.length);
    if (!names.length) return;
    const show = () => {
      const d = names[keptI++ % names.length], a = $("kept-name");
      a.classList.remove("in"); void a.offsetWidth;
      a.textContent = "@" + d.handle; a.href = "/u/" + encodeURIComponent(d.handle); a.title = d.tagline || "";
      a.classList.add("in");
    };
    if (!keptT) { show(); if (names.length > 1) keptT = setInterval(show, 7000); }
  }
  refreshDonors();
  setInterval(refreshDonors, 120000);

  // Low-fuel nudge: soft, a few seconds after load, at most once per session.
  let nudged = false;
  function maybeNudge() {
    if (nudged) return;
    const force = /[?&]lowfuel\b/.test(location.search);
    let seen = false; try { seen = sessionStorage.getItem("it:nudged") === "1"; } catch (_) {}
    if (!force && seen) return;
    const low = Number(fuel.low_cents || 500), cents = Number(fuel.balance_cents);
    if (!force && !(fuel.balance_cents != null && cents < low)) return;
    nudged = true; try { sessionStorage.setItem("it:nudged", "1"); } catch (_) {}
    const hrs = Math.max(0, cents) / (hourCents || 17);
    $("nudge-left").textContent = Number.isFinite(hrs) ? (hrs < 1 ? "Less than an hour of painting left." : `About ${Math.round(hrs)} hours of painting left.`) : "";
    $("nudge").classList.remove("hidden"); requestAnimationFrame(() => $("nudge").classList.add("on"));
    try { window.va && window.va("event", { name: "nudge_shown" }); } catch (_) {}
  }
  const closeNudge = () => { $("nudge").classList.remove("on"); setTimeout(() => $("nudge").classList.add("hidden"), 300); };
  $("nudge-x").addEventListener("click", closeNudge);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("nudge").classList.contains("hidden")) closeNudge(); });
  document.querySelectorAll(".nudge-tiers button").forEach((b) => b.addEventListener("click", () => { closeNudge(); donate(Number(b.dataset.cents)); }));
  window.addEventListener("tapestry:revealed", () => setTimeout(maybeNudge, 4000), { once: true });
  setTimeout(maybeNudge, 9000);   // in case the intro already finished

  async function donate(cents, { ideaId } = {}) {
    try {
      const r = await fetch("/api/checkout", {
        method: "POST", headers: { "content-type": "application/json", ...(S.token() ? { authorization: "Bearer " + S.token() } : {}) },
        body: JSON.stringify({ cents, ideaId: ideaId || null, note: ($("donor-note").value || "").slice(0, 140), returnTo: location.origin + location.pathname }),
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
    setTimeout(() => { refreshFuel(); refreshDonors(); refreshIdeas(); }, 2500);
  }

  // ---------- sleep state ----------
  let wsOpen = false, closedSince = Date.now();
  window.addEventListener("tapestry:ws", (e) => { wsOpen = e.detail.open; if (!wsOpen) closedSince = Date.now(); else setSleeping(false); });
  setInterval(() => { if (!wsOpen && Date.now() - closedSince > 8000) refreshFuel().then(() => { if (Number(fuel.balance_cents) > 0) $("sleep-note").textContent = "Waking up…"; }); }, 15000);
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
    $("drawer").classList.add("open");
    if (name === "next" && window.TapestryWS) window.TapestryWS.send({ type: "upcoming_request" });
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== "panel-" + name));
    if (name === "fuel") { refreshFuel(); refreshDonors(); }
    if (name === "ideas") refreshIdeas();
    if (name === "audit") refreshAudit();
  }
  S.openTab = openTab;
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));

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
