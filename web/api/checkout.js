const { env, rest, userFromToken, ipHash, audit, stripe, readRaw } = require("../lib/common");

const TIERS = new Set([300, 500, 1000, 2500]);
const recent = new Map(); // best-effort per-instance IP throttle

const handler = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const ip = ipHash(req);
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= 6) return res.status(429).json({ error: "Too many checkouts, try again in a minute." });
  hits.push(now); recent.set(ip, hits);
  let body;
  try { body = JSON.parse(await readRaw(req) || "{}"); } catch (e) { return res.status(400).json({ error: "bad body" }); }
  const cents = Number(body.cents);
  if (!TIERS.has(cents)) return res.status(400).json({ error: "Pick one of the tiers." });
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const user = token ? await userFromToken(token).catch(() => null) : null;
  const ideaId = body.ideaId ? Number(body.ideaId) : null;
  if (ideaId) {
    if (!user) return res.status(401).json({ error: "Sign in to boost ideas." });
    const rows = await rest("GET", `ideas?id=eq.${ideaId}&status=eq.pending&select=id`);
    if (!rows.length) return res.status(400).json({ error: "That idea is no longer in the pool." });
  }
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  let back = String(body.returnTo || host + "/");
  if (!back.startsWith(host)) back = host + "/";
  const note = String(body.note || "").replace(/[\u0000-\u001f]/g, " ").slice(0, 140);
  const session = await stripe("checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": cents,
    "line_items[0][price_data][product_data][name]": ideaId ? "Boost an idea · Infinite Tapestry" : "Prepaid GPU fuel · Infinite Tapestry",
    "line_items[0][price_data][product_data][tax_code]": env("STRIPE_TAX_CODE", "txcd_10000000"),
    "line_items[0][price_data][product_data][description]": ideaId
      ? "Boosts an idea in the Infinite Tapestry queue."
      : "Prepaid GPU compute time used to generate images on Infinite Tapestry.",
    submit_type: "pay",
    // Receipts: Stripe emails one for live payments when the customer email is known (signed-in users), or
    // asks for it on the Checkout page otherwise. Enable "Successful payments" emails in the Stripe dashboard.
    customer_email: user && user.email ? user.email : undefined,
    customer_creation: "if_required",
    success_url: back + (back.includes("?") ? "&" : "?") + "thanks=1",
    cancel_url: back,
    metadata: { user_id: user ? user.id : "", handle: user && user.handle ? user.handle : "", idea_id: ideaId || "", note, kind: ideaId ? "boost" : "fuel", ip_hash: ip },
  });
  await audit("checkout_created", { actor: user && user.id, handle: user && user.handle, ip, target: session.id, detail: { cents, idea_id: ideaId } });
  res.status(200).json({ url: session.url });
};

module.exports = async (req, res) => {
  try { await handler(req, res); }
  catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
};
