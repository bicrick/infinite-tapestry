// Social layer: accounts, idea pool, votes, chat, fuel, donations, admin.
// Loaded as a module; stays dormant when no Supabase config is present (local/dev).
const CFG = window.TAPESTRY_CONFIG || {};
const $ = (id) => document.getElementById(id);
const W = () => window.TapestryWS || { send() {}, toast() {}, esc: (s) => String(s) };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const S = { enabled: false, session: null, profile: null, isAdmin: () => !!(S.profile && S.profile.is_admin), token: () => S.session && S.session.access_token, submitIdea: async () => false };
window.TapestrySocial = S;

const ERR = {
  not_signed_in: "Sign in to add ideas, vote and chat.",
  handle_required: "Pick a handle first.",
  one_active_idea: "You already have an idea in the pool. Withdraw it or wait until it plays.",
  content_not_allowed: "That one's outside what the tapestry paints.",
  banned: "This account is suspended.",
  muted: "You're muted for a little while.",
  handle_taken: "That handle is taken.",
  bad_image: "That image could not be attached. Try another.",
  bad_handle: "Handles are 2–20 letters, numbers or underscores.",
};
function friendly(e) {
  const m = String((e && (e.message || e.details)) || e || "");
  const key = Object.keys(ERR).find((k) => m.includes(k));
  if (key) return ERR[key];
  const rl = m.match(/rate_limited:?(\d+)?/);
  if (rl) return rl[1] ? `Easy there. Try again in ${rl[1]}s.` : "Easy there. Try again shortly.";
  if (m.includes("cooldown")) { const s = m.match(/(\d+)/); return `Next idea in ${s ? s[1] + "s" : "a moment"}.`; }
  return "Something went wrong. Try again.";
}
const toast = (h, ms) => W().toast(h, ms);

if (CFG.supabaseUrl && CFG.supabaseAnonKey) boot().catch((e) => console.warn("social disabled", e));

async function boot() {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
  const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" } });
  S.sb = sb;
  S.enabled = true;
  document.body.classList.add("social");
  document.querySelectorAll(".social-only").forEach((el) => el.classList.remove("hidden"));
  $("account-btn").classList.remove("hidden");
  $("fuel-chip").classList.remove("hidden");
  $("chat").classList.remove("hidden");
  $("cmd-input").placeholder = "Suggest where the tapestry goes next…";
  if (CFG.google) $("auth-google").classList.remove("hidden");

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
    $("auth-google").classList.toggle("hidden", signed || !CFG.google);
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
  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return toast(esc(error.message));
    $("auth-form").innerHTML = `<p class="fine">Check <b>${esc(email)}</b> for a sign-in link. You can close this.</p>`;
  });
  $("auth-google").addEventListener("click", () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } }));
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
  $("ref-file").addEventListener("change", async () => {
    const f = $("ref-file").files[0];
    $("ref-file").value = "";
    if (!f) return;
    if (needLogin()) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return toast("JPEG, PNG or WebP only.");
    if (f.size > 15e6) return toast("That image is too large.");
    refFile = await shrink(f);
    $("ref-thumb").src = URL.createObjectURL(refFile);
    $("ref-chip").classList.remove("hidden");
    $("cmd-input").placeholder = "Describe where to take it…";
    $("cmd-input").focus();
  });
  $("ref-clear").addEventListener("click", () => { refFile = null; $("ref-chip").classList.add("hidden"); });
  async function shrink(file) {  // downscale to <=1280px JPEG so uploads stay well under 2 MB
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
  }
  const refUrl = (p) => `${CFG.supabaseUrl}/storage/v1/object/public/idea-refs/${p}`;

  S.submitIdea = async (text) => {
    if (needLogin()) return false;
    let image = null;
    if (refFile) {
      image = `${S.session.user.id}/${Date.now().toString(36)}.jpg`;
      const up = await sb.storage.from("idea-refs").upload(image, refFile, { contentType: "image/jpeg", upsert: false });
      if (up.error) { toast("Couldn't upload the image. " + esc(up.error.message || "")); return false; }
    }
    const { error } = await sb.rpc("submit_idea", { p_body: text, p_image: image });
    if (error) { toast(friendly(error)); return false; }
    refFile = null; $("ref-chip").classList.add("hidden");
    toast(`Added to the pool <span class="muted">“${esc(text)}”</span>`, 3000);
    refreshIdeas();
    return true;
  };
  let myVotes = new Set();
  async function loadVotes() {
    myVotes = new Set();
    if (S.session) {
      const { data } = await sb.from("votes").select("idea_id").eq("user_id", S.session.user.id);
      (data || []).forEach((r) => myVotes.add(r.idea_id));
    }
    renderIdeas();
  }
  let ideas = [];
  async function refreshIdeas() {
    sb.from("ideas").select("id,handle,body,image_path,start_strip,end_strip,played_at").eq("status", "played")
      .not("start_strip", "is", null).order("played_at", { ascending: false }).limit(20).then(({ data }) => renderWoven(data || []));
    const { data } = await sb.from("ideas").select("id,handle,body,votes,boost_cents,status,user_id,created_at,image_path")
      .in("status", ["pending", "playing"]).order("status", { ascending: false }).order("boost_cents", { ascending: false })
      .order("votes", { ascending: false }).order("created_at").limit(60);
    ideas = data || [];
    renderIdeas();
  }
  const UP = '<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>';
  function renderIdeas() {
    const list = $("idea-list");
    if (!list) return;
    $("idea-empty").classList.toggle("hidden", ideas.length > 0);
    list.innerHTML = "";
    ideas.forEach((it) => {
      const li = document.createElement("li");
      li.className = "item idea";
      const mine = S.session && it.user_id === S.session.user.id;
      li.innerHTML =
        `<button class="votes${myVotes.has(it.id) ? " on" : ""}" title="Vote">${UP}<span>${it.votes}</span></button>` +
        `<div>${it.image_path ? `<img class="thumb" src="${esc(refUrl(it.image_path))}" alt="" loading="lazy" />` : ""}<div class="t">${esc(it.body)}</div><div class="who"><a class="who-link" href="/u/${encodeURIComponent(it.handle)}">@${esc(it.handle)}</a>${it.status === "playing" ? " · weaving in now" : ""}` +
        `${it.boost_cents ? ` · <span class="boosted">boosted $${(it.boost_cents / 100).toFixed(0)}</span>` : ""}</div></div>` +
        `<div class="acts">` +
        (it.status === "pending" ? `<button class="icon" data-a="boost" title="Boost with fuel">⚡︎</button>` : "") +
        (mine && it.status === "pending" ? `<button class="icon" data-a="withdraw" title="Withdraw">✕</button>` : "") +
        (S.isAdmin() ? `<button class="icon" data-a="reject" title="Reject (admin)">⊘</button>` : "") + `</div>`;
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
        `<div class="t">${esc(it.body)}</div><div class="who"><a class="who-link" href="/u/${encodeURIComponent(it.handle)}">@${esc(it.handle)}</a> · strip ${it.start_strip}</div>` +
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
  sb.channel("ideas").on("postgres_changes", { event: "*", schema: "public", table: "ideas" }, () => refreshIdeas()).subscribe();
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
  const HOUR_CENTS = CFG.centsPerHour || 20;
  let fuel = { balance_cents: null, pod_status: null };
  function renderFuel() {
    if (fuel.balance_cents == null) return;
    const cents = Math.max(0, Number(fuel.balance_cents));
    const hours = cents / HOUR_CENTS;
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
  window.addEventListener("tapestry:fuel", (e) => { fuel = { ...fuel, balance_cents: e.detail.balance_cents ?? fuel.balance_cents }; renderFuel(); });
  refreshFuel();
  setInterval(refreshFuel, 60000);

  async function refreshDonors() {
    const { data } = await sb.from("donor_wall").select("*").limit(30);
    $("donor-list").innerHTML = (data || []).map((d) =>
      `<li class="item"><div><div class="t">${d.handle === "anonymous" ? "Anonymous" : "@" + esc(d.handle)}</div>${d.message ? `<div class="p">${esc(d.message)}</div>` : ""}</div><span class="amt">$${(d.total_cents / 100).toFixed(0)}</span></li>`).join("")
      || `<li class="empty">Be the first to keep it painting.</li>`;
  }
  refreshDonors();

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
