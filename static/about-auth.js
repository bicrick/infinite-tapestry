// /about nav account: same Supabase session as the live site. Signed in -> @handle (profile) + Sign out; else Sign in.
import { client } from "/sb.js";
const $ = (id) => document.getElementById(id);
const show = (handle, signed) => {
  document.documentElement.classList.toggle("signed", !!signed);
  $("acct-in").hidden = !!signed; $("acct-out").hidden = !signed; $("acct-me").hidden = !signed;
  if (signed) { $("acct-me").textContent = handle ? "@" + handle : "Pick a handle"; $("acct-me").href = handle ? "/u/" + encodeURIComponent(handle) : "/?signin=1"; }
};
(async () => {
  let sb; try { sb = await client(); } catch (_) { return; }   // keep the cached signed-in hint if the client cannot load
  const load = async (sess) => {
    if (!sess) return show(null, false);
    show(null, true);
    try { const { data } = await sb.from("profiles").select("handle").eq("id", sess.user.id).maybeSingle(); show(data && data.handle, true); } catch (_) {}
  };
  const { data } = await sb.auth.getSession().catch(() => ({ data: {} }));
  await load(data && data.session);
  sb.auth.onAuthStateChange((_ev, sess) => load(sess));
  $("acct-out").onclick = async () => { await sb.auth.signOut().catch(() => {}); show(null, false); };
})();
