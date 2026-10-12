// /auth/confirm — lands email links on our own domain.
// Handles: ?token_hash=&type= (branded template) · #access_token (default template, any browser) ·
// ?code= (legacy PKCE links) · #error_code=otp_expired etc. → one-tap resend.
import { client, lastEmail, rememberEmail, AUTH_ERR } from "/sb.js";
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
const nextUrl = (() => { const n = q.get("next") || "/"; return n.startsWith("/") && !n.startsWith("//") ? n : "/"; })();
const done = () => { $("c-title").textContent = "You're in"; $("c-text").textContent = "Taking you to the tapestry…"; setTimeout(() => location.replace(nextUrl), 500); };
function failed(msg) {
  $("c-title").textContent = "This link has expired";
  $("c-text").textContent = msg || "Sign-in links work once and expire after an hour. We'll send you a fresh one.";
  $("c-retry").classList.remove("hidden"); $("c-home").classList.remove("hidden");
  $("c-email").value = lastEmail();
  if ($("c-email").value) $("c-send").textContent = "Send a new link to this email";
}
(async () => {
  const sb = await client();
  const err = h.get("error_code") || q.get("error_code") || h.get("error") || q.get("error");
  try {
    if (q.get("token_hash")) {
      const { error } = await sb.auth.verifyOtp({ token_hash: q.get("token_hash"), type: q.get("type") || "email" });
      if (error) return failed(/expired|invalid/i.test(error.message) ? null : error.message);
      return done();
    }
    if (q.get("code")) {
      const { error } = await sb.auth.exchangeCodeForSession(q.get("code"));
      if (error) return failed("This link was opened in a different browser than the one that asked for it. Send a new one here, or enter the code in the app.");
      return done();
    }
    if (err) return failed(/expired|otp/i.test(err) ? null : (h.get("error_description") || q.get("error_description") || "").replace(/\+/g, " "));
    // #access_token: detectSessionInUrl has already stored the session by the time getSession resolves.
    const { data } = await sb.auth.getSession();
    if (data.session) return done();
    failed("We couldn't find a sign-in in this link.");
  } catch (e) { failed(AUTH_ERR(e.message)); }
  $("c-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("c-email").value.trim(); rememberEmail(email);
    $("c-send").disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + "/auth/confirm?next=" + encodeURIComponent(nextUrl) } });
    $("c-send").disabled = false;
    if (error) { $("c-text").textContent = AUTH_ERR(error.message); return; }
    $("c-title").textContent = "Check your email";
    $("c-text").textContent = `A new link is on its way to ${email}. Tap it on this device, or enter the code below.`;
    $("c-form").classList.add("hidden"); $("c-code-form").classList.remove("hidden"); $("c-code").focus();
  });
  $("c-code").addEventListener("input", async (e) => {
    const v = e.target.value.replace(/\D/g, "").slice(0, 6); e.target.value = v;
    if (v.length < 6) return;
    const { error } = await sb.auth.verifyOtp({ email: $("c-email").value.trim(), token: v, type: "email" });
    if (error) { $("c-text").textContent = AUTH_ERR(error.message); e.target.select(); } else done();
  });
})();
