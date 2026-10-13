const { rest, audit, verifyStripe, reconcile, readRaw, stripeLive, stripeWebhookSecret } = require("../lib/common");

// Stripe fees (2.9% + 30c) come out before fuel is credited, so the ledger matches real money.
const net = (cents) => Math.max(0, cents - Math.round(cents * 0.029 + 30));

const handler = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  let raw;
  try { raw = await readRaw(req); } catch (e) { return res.status(413).end(); }
  if (!verifyStripe(raw, req.headers["stripe-signature"], stripeWebhookSecret())) {
    await audit("stripe_bad_signature", { detail: { len: raw.length } });
    return res.status(400).json({ error: "bad signature" });
  }
  const evt = JSON.parse(raw);
  // A test event never credits live fuel and vice versa (guards a mis-pointed webhook).
  if (!!evt.livemode !== stripeLive()) { await audit("stripe_mode_mismatch", { target: evt.id, detail: { livemode: !!evt.livemode } }); return res.status(200).json({ ignored: "mode" }); }
  if (evt.type !== "checkout.session.completed" && evt.type !== "checkout.session.async_payment_succeeded") return res.status(200).json({ ignored: evt.type });
  const s = evt.data.object;
  if (s.payment_status !== "paid") return res.status(200).json({ pending: true });
  const m = s.metadata || {};
  const cents = Number(s.amount_subtotal ?? s.amount_total); // tax (if any) is not fuel
  const inserted = await rest("POST", "donations?on_conflict=stripe_session_id", {
    stripe_session_id: s.id, user_id: m.user_id || null, handle: m.handle || null, amount_cents: cents,
    kind: m.kind === "boost" ? "boost" : "fuel", idea_id: m.idea_id ? Number(m.idea_id) : null, message: m.note || null,
  }, { prefer: "return=representation,resolution=ignore-duplicates" });
  if (!inserted || !inserted.length) return res.status(200).json({ duplicate: true }); // idempotent replays
  const credit = net(cents);
  await rest("POST", "fuel_ledger", { delta_cents: credit, reason: "donation", ref: s.id }, { prefer: "return=minimal" });
  if (m.kind === "boost" && m.idea_id) {
    const rows = await rest("GET", `ideas?id=eq.${Number(m.idea_id)}&select=boost_cents`);
    if (rows.length) await rest("PATCH", `ideas?id=eq.${Number(m.idea_id)}`, { boost_cents: rows[0].boost_cents + cents }, { prefer: "return=minimal" });
  }
  await audit("fuel_credit", { actor: m.user_id || null, handle: m.handle || null, ip: m.ip_hash || null, target: s.id,
    detail: { gross_cents: cents, credited_cents: credit, kind: m.kind, idea_id: m.idea_id || null, livemode: !!evt.livemode } });
  let pod = null;
  try { pod = await reconcile("donation"); } catch (e) { console.error("wake failed", e.message); }
  res.status(200).json({ ok: true, credited_cents: credit, pod });
};

module.exports = async (req, res) => {
  try { await handler(req, res); }
  catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
};
module.exports.config = { api: { bodyParser: false } };
