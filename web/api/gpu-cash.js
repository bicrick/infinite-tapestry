// Public GPU cash chart for /about: RunPod balance over time + Stripe fuel purchases.
// RUNPOD_API_KEY stays on the server (Vercel env). Browser never sees it.
// Cache ~15 min. Without the key, fall back to estimated spend from fuel_ledger + live donations.
const { env, rest, runpod } = require("../lib/common");

const START_USD = 100;
const CACHE_MS = 15 * 60e3;
const OWNER = new Set(["bicrick"]);

let cache = null; // { at, body }

function usdRound(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function liveFuelPurchases() {
  // Individual live-mode Stripe fuel purchases (site checkout). Never treat RunPod top-ups as these.
  const rows = await rest(
    "GET",
    "donations?select=amount_cents,created_at,handle,stripe_session_id&order=created_at.asc&limit=500"
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter((d) => String(d.stripe_session_id || "").startsWith("cs_live_"))
    .map((d) => {
      const handle = String(d.handle || "").trim();
      const name = !handle || OWNER.has(handle.toLowerCase()) ? "Someone" : handle;
      return {
        t: d.created_at,
        usd: usdRound((Number(d.amount_cents) || 0) / 100),
        handle: name,
        kind: "fuel",
      };
    })
    .filter((d) => d.usd > 0);
}

async function estimatedSpendByDay() {
  // Hourly burn from transparency RPC, rolled up by UTC day (cents → USD).
  try {
    const SB = env("SUPABASE_URL").replace(/\/$/, "");
    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    const r = await fetch(`${SB}/rest/v1/rpc/transparency`, {
      method: "POST",
      headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json" },
      body: "{}",
    });
    const t = await r.json();
    const byDay = new Map();
    for (const s of t.series || []) {
      const day = String(s.t).slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + (Number(s.burn) || 0) / 100);
    }
    return [...byDay.entries()]
      .map(([day, usd]) => ({ day, usd: usdRound(usd) }))
      .filter((x) => x.usd > 0)
      .sort((a, b) => a.day.localeCompare(b.day));
  } catch (_) {
    return [];
  }
}

async function runpodSnapshot() {
  // Balance + spend rate + owner credit reloads + daily inference charges.
  const d = await runpod(`query {
    myself {
      clientBalance
      currentSpendPerHr
      stripeReloadHistory { amount transactionCompletedAt type medium }
      dailyCharges { amount updatedAt podCharges diskCharges type }
    }
  }`);
  const me = d && d.myself;
  if (!me) throw new Error("runpod myself empty");
  const balance = Number(me.clientBalance);
  const spendPerHr = Number(me.currentSpendPerHr);
  const topups = (me.stripeReloadHistory || [])
    .map((x) => ({
      t: x.transactionCompletedAt,
      usd: usdRound(Number(x.amount) || 0),
      kind: "owner",
      handle: "owner top-up",
    }))
    .filter((x) => x.usd > 0 && x.t)
    .sort((a, b) => new Date(a.t) - new Date(b.t));
  // dailyCharges: prefer podCharges; amount is typically the day's charge.
  const spendDays = (me.dailyCharges || [])
    .map((c) => {
      const usd = usdRound(Number(c.podCharges) || Number(c.amount) || 0);
      const day = String(c.updatedAt || "").slice(0, 10);
      return { day, usd, t: c.updatedAt };
    })
    .filter((c) => c.day && c.usd > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
  return {
    balance: Number.isFinite(balance) ? usdRound(balance) : null,
    spend_per_hr: Number.isFinite(spendPerHr) ? usdRound(spendPerHr) : null,
    topups,
    spendDays,
  };
}

async function runpodBillingDays(startIso) {
  // REST fallback: daily pod billing buckets.
  const key = env("RUNPOD_API_KEY");
  if (!key) return [];
  const end = new Date().toISOString();
  const url = new URL("https://api.runpod.io/v1/billing/pods");
  url.searchParams.set("bucketSize", "day");
  url.searchParams.set("startTime", startIso);
  url.searchParams.set("endTime", end);
  const r = await fetch(url, { headers: { authorization: "Bearer " + key } }).catch(() => null);
  if (!r || !r.ok) return [];
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows)) return [];
  const byDay = new Map();
  for (const row of rows) {
    const day = String(row.time || "").slice(0, 10);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) || 0) + (Number(row.amount) || 0));
  }
  return [...byDay.entries()]
    .map(([day, usd]) => ({ day, usd: usdRound(usd) }))
    .filter((x) => x.usd > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
}

function buildSeries({ startUsd, startAt, spendDays, fuel, topups, balanceNow }) {
  // Discrete events, then a daily balance polyline. Fuel = Stripe only; owner top-ups are separate.
  const events = [];
  events.push({ t: startAt, kind: "start", usd: startUsd, balance: startUsd, label: "Starting credit" });

  const spendByDay = new Map(spendDays.map((s) => [s.day, s.usd]));
  const lifts = [
    ...fuel.map((f) => ({ ...f, kind: "fuel" })),
    ...topups.map((o) => ({ ...o, kind: "owner" })),
  ].sort((a, b) => new Date(a.t) - new Date(b.t));

  // Walk day-by-day from start through today, applying spend at end-of-day and lifts at their timestamps.
  const daySet = new Set([
    ...spendByDay.keys(),
    ...lifts.map((e) => String(e.t).slice(0, 10)),
    new Date().toISOString().slice(0, 10),
  ]);
  const days = [...daySet].filter((d) => d >= String(startAt).slice(0, 10)).sort();

  let bal = startUsd;
  const points = [{ t: startAt, balance: usdRound(bal) }];
  const markers = [];

  for (const day of days) {
    const dayLifts = lifts.filter((e) => String(e.t).slice(0, 10) === day);
    dayLifts.sort((a, b) => new Date(a.t) - new Date(b.t));
    for (const e of dayLifts) {
      bal = usdRound(bal + e.usd);
      const marker = {
        t: e.t,
        kind: e.kind,
        usd: e.usd,
        balance: bal,
        label: e.kind === "fuel" ? e.handle : "owner top-up",
      };
      markers.push(marker);
      points.push({ t: e.t, balance: bal, kind: e.kind });
    }
    const spent = spendByDay.get(day) || 0;
    if (spent > 0) {
      bal = usdRound(Math.max(0, bal - spent));
      const end = `${day}T23:59:59.000Z`;
      points.push({ t: end, balance: bal, kind: "spend", spend: spent });
    }
  }

  // Nudge final point toward live RunPod balance when we have one (avoids chart drift).
  if (balanceNow != null && Number.isFinite(balanceNow)) {
    const now = new Date().toISOString();
    if (Math.abs(bal - balanceNow) > 0.02) {
      bal = balanceNow;
      points.push({ t: now, balance: bal, kind: "reconcile" });
    } else {
      points.push({ t: now, balance: bal });
    }
  }

  return { points, markers, balance_end: usdRound(bal) };
}

async function payload() {
  const fuel = await liveFuelPurchases();
  const fuelBought = usdRound(fuel.reduce((a, x) => a + x.usd, 0));
  const hasKey = !!env("RUNPOD_API_KEY");

  let source = "estimated";
  let balanceNow = null;
  let spendPerHr = null;
  let topups = [];
  let spendDays = [];
  let startAt = fuel[0] ? new Date(new Date(fuel[0].t).getTime() - 864e5).toISOString() : new Date(Date.now() - 14 * 864e5).toISOString();

  if (hasKey) {
    try {
      const snap = await runpodSnapshot();
      balanceNow = snap.balance;
      spendPerHr = snap.spend_per_hr;
      topups = snap.topups;
      spendDays = snap.spendDays;
      if (topups[0] && (!fuel[0] || new Date(topups[0].t) < new Date(fuel[0].t))) {
        startAt = new Date(new Date(topups[0].t).getTime() - 864e5).toISOString();
      }
      // Prefer billing REST if dailyCharges is thin.
      const billed = await runpodBillingDays(startAt);
      if (billed.length > spendDays.length) spendDays = billed;
      source = "runpod";
    } catch (e) {
      console.warn("gpu-cash: runpod failed, estimating:", e.message || e);
      source = "estimated";
    }
  }

  if (source === "estimated") {
    spendDays = await estimatedSpendByDay();
    topups = []; // never invent owner top-ups without RunPod
  }

  const ownerTopups = usdRound(topups.reduce((a, x) => a + x.usd, 0));
  // Spend = (starting credit + owner top-ups + Stripe fuel) − balance now.
  // Owner RunPod reloads are credit, never fuel bought; Stripe purchases are the only "fuel bought".
  let spendTotal;
  if (balanceNow != null && source === "runpod") {
    spendTotal = usdRound(Math.max(0, START_USD + ownerTopups + fuelBought - balanceNow));
    const billedSum = usdRound(spendDays.reduce((a, x) => a + x.usd, 0));
    if (billedSum > 0 && Math.abs(billedSum - spendTotal) / Math.max(spendTotal, 1) < 0.45) {
      const scale = spendTotal / billedSum;
      spendDays = spendDays.map((d) => ({ ...d, usd: usdRound(d.usd * scale) }));
    } else if (!spendDays.length && spendTotal > 0) {
      const days = Math.max(1, Math.ceil((Date.now() - new Date(startAt)) / 864e5));
      const per = usdRound(spendTotal / days);
      spendDays = Array.from({ length: days }, (_, i) => {
        const d = new Date(new Date(startAt).getTime() + i * 864e5).toISOString().slice(0, 10);
        return { day: d, usd: per };
      });
    }
  } else {
    spendTotal = usdRound(spendDays.reduce((a, x) => a + x.usd, 0));
    // Estimated path: no live RunPod balance — project from credits − burn.
    balanceNow = usdRound(Math.max(0, START_USD + ownerTopups + fuelBought - spendTotal));
  }

  const { points, markers, balance_end } = buildSeries({
    startUsd: START_USD,
    startAt,
    spendDays,
    fuel,
    topups,
    balanceNow: source === "runpod" ? balanceNow : balanceNow,
  });

  return {
    starting_credit_usd: START_USD,
    spend_usd: spendTotal,
    fuel_bought_usd: fuelBought,
    owner_topups_usd: ownerTopups,
    balance_usd: source === "runpod" && balanceNow != null ? balanceNow : balance_end,
    spend_per_hr_usd: spendPerHr,
    source, // "runpod" | "estimated"
    estimated: source !== "runpod",
    points,
    markers, // fuel + owner top-up markers for dots/labels
    fuel, // Stripe purchases only
    topups, // RunPod owner credit reloads only
    updated_at: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  try {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) {
      res.setHeader("cache-control", "public, s-maxage=900, stale-while-revalidate=1800");
      res.setHeader("x-gpu-cash-cache", "hit");
      return res.status(200).json(cache.body);
    }
    const body = await payload();
    cache = { at: now, body };
    res.setHeader("cache-control", "public, s-maxage=900, stale-while-revalidate=1800");
    res.setHeader("x-gpu-cash-cache", "miss");
    return res.status(200).json(body);
  } catch (e) {
    console.error("gpu-cash", e.message || e);
    return res.status(200).json({
      starting_credit_usd: START_USD,
      spend_usd: null,
      fuel_bought_usd: 0,
      owner_topups_usd: 0,
      balance_usd: null,
      source: "unavailable",
      estimated: true,
      points: [{ t: new Date().toISOString(), balance: START_USD }],
      markers: [],
      fuel: [],
      topups: [],
      error: "unavailable",
      updated_at: new Date().toISOString(),
    });
  }
};
