// Sign-in screen. Anything more is fetched from the server only for an allowed account.
import { client } from "./sb.js";
const sb = await client();
const show = () => { document.getElementById("gate").hidden = false; };
document.getElementById("g").onclick = () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
const { data } = await sb.auth.getSession();
const tok = data.session && data.session.access_token;
let ui = null;
if (tok) {
  const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: '{"action":"ui"}' }).catch(() => null);
  if (r && r.ok) ui = await r.json().catch(() => null);
}
if (!ui) show();
else {
  document.title = "Admin · Infinite Tapestry";
  const st = document.createElement("style"); st.textContent = ui.css; document.head.append(st);
  document.getElementById("gate").remove();
  document.querySelectorAll(".it-nav, .it-spacer, .it-foot").forEach((el) => el.remove());   // the dashboard has its own chrome
  document.body.insertAdjacentHTML("afterbegin", ui.html);
  const s = document.createElement("script"); s.type = "module"; s.textContent = ui.js; document.body.append(s);
}
