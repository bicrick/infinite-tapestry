// Public GPU cash chart for /about — Infinite Tapestry only.
// RunPod account history includes Patrick's other projects; we scope to:
//   - GPU_CASH_START (default: first painted strip, 2026-10-12)
//   - Spend billed to tapestry pod id(s) only (name match + pod_state + audit)
//   - Owner top-ups on/after the start date (account-level credits; temporally scoped)
// Stripe live fuel purchases remain the only "fuel bought".
// Account clientBalance is whole-account and cannot be split per project — returned
// separately; the chart's balance is the reconstructed tapestry project balance.
const { env, rest, runpod, loadPod, POD } = require("../lib/common");

// First Infinite Tapestry strip (OG era t0 from /api/about?kind=tm): 2026-10-12T07:59:16Z.
// Override with GPU_CASH_START (ISO date or datetime) if the project window moves.
const DEFAULT_START = "2026-10-12T07:59:16.000Z";
const DEFAULT_START_USD = 100;
const CACHE_MS = 15 * 60e3;
const OWNER = new Set(["bicrick"]);

let cache = null; // { at, body }

function usdRound(n) {
  return Math.round(Number(n) * 100) / 100;
}

function cashStartIso() {
  const raw = String(env("GPU_CASH_START", DEFAULT_START) || DEFAULT_START).trim();
  const d = new Date(raw.length === 10 ? raw + "T00:00:00.000Z" : raw);
  return Number.isFinite(+d) ? d.toISOString() : DEFAULT_START;
}

function cashStartUsd() {
  const n = Number(env("GPU_CASH_START_USD", String(DEFAULT_START_USD)));
  return Number.isFinite(n) && n >= 0 ? usdRound(n) : DEFAULT_START_USD;
}

function onOrAfter(iso, startIso) {
  return iso && +new Date(iso) >= +new Date(startIso);
}

async function liveFuelPurchases(startIso) {
  const rows = await rest(
    "GET",
    "donations?select=amount_cents,created_at,handle,stripe_session_id&order=created_at.asc&limit=500"
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter((d) => String(d.stripe_session_id || "").startsWith("cs_live_"))
    .filter((d) => onOrAfter(d.created_at, startIso))
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

async function estimatedSpendByDay(startIso) {
  // Hourly burn from transparency RPC (tapestry ledger only), after project start.
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
    const startDay = startIso.slice(0, 10);
    for (const s of t.series || []) {
      const day = String(s.t).slice(0, 10);
      if (day < startDay) continue;
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

function podNameMatch(name) {
  const want = env("RUNPOD_POD_NAME", "tapestry-sdxl");
  const re = new RegExp(env("GPU_CASH_POD_NAME_RE", "^tapestry"), "i");
  const n = String(name || "");
  return n === want || re.test(n);
}

async function tapestryPodIds() {
  const ids = new Set();
  await loadPod(true).catch(() => null);
  if (POD()) ids.add(POD());
  if (env("RUNPOD_POD_ID")) ids.add(env("RUNPOD_POD_ID"));
  for (const id of String(env("GPU_CASH_POD_IDS", "")).split(",").map((s) => s.trim()).filter(Boolean)) {
    ids.add(id);
  }
  try {
    const d = await runpod(`query { myself { pods { id name } } }`);
    for (const p of (d && d.myself && d.myself.pods) || []) {
      if (p && p.id && podNameMatch(p.name)) ids.add(p.id);
    }
  } catch (_) {}
  // Migrated / prior tapestry pods recorded in audit.
  try {
    const rows = await rest(
      "GET",
      "audit_log?action=in.(pod_adopt,pod_start,pod_stop,admin_gpu_start,admin_gpu_stop)&select=target,detail&order=created_at.desc&limit=200"
    ).catch(() => []);
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r.target) ids.add(String(r.target));
      const det = r.detail || {};
      for (const k of ["from", "to", "pod_id", "podId"]) {
        if (det[k]) ids.add(String(det[k]));
      }
    }
  } catch (_) {}
  return [...ids].filter(Boolean);
}

async function runpodAccount() {
  const d = await runpod(`query {
    myself {
      clientBalance
      currentSpendPerHr
      stripeReloadHistory { amount transactionCompletedAt type medium }
    }
  }`);
  const me = d && d.myself;
  if (!me) throw new Error("runpod myself empty");
  const balance = Number(me.clientBalance);
  const spendPerHr = Number(me.currentSpendPerHr);
  return {
    account_balance: Number.isFinite(balance) ? usdRound(balance) : null,
    spend_per_hr: Number.isFinite(spendPerHr) ? usdRound(spendPerHr) : null,
    reloads: (me.stripeReloadHistory || [])
      .map((x) => ({
        t: x.transactionCompletedAt,
        usd: usdRound(Number(x.amount) || 0),
        kind: "owner",
        handle: "owner top-up",
      }))
      .filter((x) => x.usd > 0 && x.t)
      .sort((a, b) => new Date(a.t) - new Date(b.t)),
  };
}

async function tapestryBillingDays(startIso, podIds) {
  // Daily spend for tapestry pods only. Prefer per-pod REST billing; fall back to
  // grouping=podId over the window and keep matching ids.
  const key = env("RUNPOD_API_KEY");
  if (!key) return { spendDays: [], byPod: {} };
  const end = new Date().toISOString();
  const idSet = new Set(podIds);
  const byDay = new Map();
  const byPod = {};

  async function fetchBilling(extra) {
    const url = new URL("https://api.runpod.io/v1/billing/pods");
    url.searchParams.set("bucketSize", "day");
    url.searchParams.set("startTime", startIso);
    url.searchParams.set("endTime", end);
    url.searchParams.set("grouping", "podId");
    for (const [k, v] of Object.entries(extra || {})) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { authorization: "Bearer " + key } }).catch(() => null);
    if (!r || !r.ok) return [];
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  }

  let rows = [];
  if (podIds.length === 1) {
    rows = await fetchBilling({ podId: podIds[0] });
  } else if (podIds.length > 1) {
    // One request for the window, filter client-side (avoids N round-trips).
    rows = (await fetchBilling({})).filter((row) => idSet.has(String(row.podId || "")));
    // If the unfiltered call failed / returned nothing useful, try each id.
    if (!rows.length) {
      for (const id of podIds) {
        rows = rows.concat(await fetchBilling({ podId: id }));
      }
    }
  } else {
    rows = [];
  }

  for (const row of rows) {
    const day = String(row.time || "").slice(0, 10);
    const usd = Number(row.amount) || 0;
    const pid = String(row.podId || "unknown");
    if (!day || usd <= 0) continue;
    if (idSet.size && row.podId && !idSet.has(pid)) continue;
    byDay.set(day, (byDay.get(day) || 0) + usd);
    byPod[pid] = usdRound((byPod[pid] || 0) + usd);
  }

  const spendDays = [...byDay.entries()]
    .map(([day, usd]) => ({ day, usd: usdRound(usd) }))
    .filter((x) => x.usd > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
  return { spendDays, byPod };
}

function buildSeries({ startUsd, startAt, spendDays, fuel, topups }) {
  const spendByDay = new Map(spendDays.map((s) => [s.day, s.usd]));
  const lifts = [
    ...fuel.map((f) => ({ ...f, kind: "fuel" })),
    ...topups.map((o) => ({ ...o, kind: "owner" })),
  ].sort((a, b) => new Date(a.t) - new Date(b.t));

  const daySet = new Set([
    ...spendByDay.keys(),
    ...lifts.map((e) => String(e.t).slice(0, 10)),
    new Date().toISOString().slice(0, 10),
  ]);
  const startDay = String(startAt).slice(0, 10);
  const days = [...daySet].filter((d) => d >= startDay).sort();

  let bal = startUsd;
  const points = [{ t: startAt, balance: usdRound(bal), kind: "start" }];
  const markers = [];

  for (const day of days) {
    const dayLifts = lifts.filter((e) => String(e.t).slice(0, 10) === day);
    dayLifts.sort((a, b) => new Date(a.t) - new Date(b.t));
    for (const e of dayLifts) {
      bal = usdRound(bal + e.usd);
      markers.push({
        t: e.t,
        kind: e.kind,
        usd: e.usd,
        balance: bal,
        label: e.kind === "fuel" ? e.handle : "owner top-up",
      });
      points.push({ t: e.t, balance: bal, kind: e.kind });
    }
    const spent = spendByDay.get(day) || 0;
    if (spent > 0) {
      bal = usdRound(Math.max(0, bal - spent));
      points.push({ t: `${day}T23:59:59.000Z`, balance: bal, kind: "spend", spend: spent });
    }
  }

  const now = new Date().toISOString();
  if (!points.length || points[points.length - 1].t < now) {
    points.push({ t: now, balance: usdRound(bal) });
  }

  return { points, markers, balance_end: usdRound(bal) };
}

async function payload() {
  const startAt = cashStartIso();
  const startUsd = cashStartUsd();
  const fuel = await liveFuelPurchases(startAt);
  const fuelBought = usdRound(fuel.reduce((a, x) => a + x.usd, 0));
  const hasKey = !!env("RUNPOD_API_KEY");

  let source = "estimated";
  let accountBalance = null;
  let spendPerHr = null;
  let topups = [];
  let spendDays = [];
  let podIds = [];
  let spendByPod = {};
  let note = null;

  if (hasKey) {
    try {
      const [acct, ids] = await Promise.all([runpodAccount(), tapestryPodIds()]);
      accountBalance = acct.account_balance;
      spendPerHr = acct.spend_per_hr;
      podIds = ids;
      topups = acct.reloads.filter((t) => onOrAfter(t.t, startAt));
      const billed = await tapestryBillingDays(startAt, podIds);
      spendDays = billed.spendDays;
      spendByPod = billed.byPod;
      source = "runpod";
      note =
        "Chart is Infinite Tapestry only (spend filtered to tapestry pod id(s) since GPU_CASH_START). "
        + "account_balance_usd is the whole RunPod account and cannot be split per project, so the "
        + "chart ends at the reconstructed project balance (starting credit + post-start top-ups + fuel − tapestry spend).";
    } catch (e) {
      console.warn("gpu-cash: runpod failed, estimating:", e.message || e);
      source = "estimated";
    }
  }

  if (source === "estimated") {
    spendDays = await estimatedSpendByDay(startAt);
    topups = [];
    note =
      "Estimated from tapestry fuel ledger burn + live Stripe fuel purchases (RUNPOD_API_KEY missing or RunPod unreachable).";
  }

  const ownerTopups = usdRound(topups.reduce((a, x) => a + x.usd, 0));
  // Project spend = sum of tapestry-pod billing (or ledger estimate). Do NOT derive from
  // account balance — that includes unrelated projects.
  const spendTotal = usdRound(spendDays.reduce((a, x) => a + x.usd, 0));

  const { points, markers, balance_end } = buildSeries({
    startUsd,
    startAt,
    spendDays,
    fuel,
    topups,
  });

  return {
    starting_credit_usd: startUsd,
    start_at: startAt,
    spend_usd: spendTotal,
    fuel_bought_usd: fuelBought,
    owner_topups_usd: ownerTopups,
    balance_usd: balance_end, // tapestry project balance (reconstructed)
    account_balance_usd: accountBalance, // whole RunPod account; not chart endpoint
    spend_per_hr_usd: spendPerHr,
    source,
    estimated: source !== "runpod",
    pod_ids: podIds,
    spend_by_pod_usd: spendByPod,
    note,
    points,
    markers,
    fuel,
    topups,
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
    const startAt = cashStartIso();
    const startUsd = cashStartUsd();
    return res.status(200).json({
      starting_credit_usd: startUsd,
      start_at: startAt,
      spend_usd: null,
      fuel_bought_usd: 0,
      owner_topups_usd: 0,
      balance_usd: null,
      account_balance_usd: null,
      source: "unavailable",
      estimated: true,
      points: [{ t: startAt, balance: startUsd, kind: "start" }],
      markers: [],
      fuel: [],
      topups: [],
      error: "unavailable",
      updated_at: new Date().toISOString(),
    });
  }
};
