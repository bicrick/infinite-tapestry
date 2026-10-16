// Public GPU budget chart for /about — Infinite Tapestry only.
// Never reads or returns RunPod account balance (no clientBalance).
// Never includes owner top-ups.
// Data: cumulative tapestry-pod GPU spend since GPU_CASH_START + Stripe fuel bought.
// Framing: Patrick's $100 budget; chart is remaining budget (starts at $100, falls with spend, rises with fuel).
const { env, rest, runpod, loadPod, POD } = require("../lib/common");

// First Infinite Tapestry strip (OG era t0): 2026-10-12T07:59:16Z.
const DEFAULT_START = "2026-10-12T07:59:16.000Z";
const DEFAULT_BUDGET_USD = 100;
const CACHE_MS = 15 * 60e3;
const OWNER = new Set(["bicrick"]);

let cache = null;

function usdRound(n) {
  return Math.round(Number(n) * 100) / 100;
}

function cashStartIso() {
  const raw = String(env("GPU_CASH_START", DEFAULT_START) || DEFAULT_START).trim();
  const d = new Date(raw.length === 10 ? raw + "T00:00:00.000Z" : raw);
  return Number.isFinite(+d) ? d.toISOString() : DEFAULT_START;
}

function budgetUsd() {
  const n = Number(env("GPU_CASH_BUDGET_USD", env("GPU_CASH_START_USD", String(DEFAULT_BUDGET_USD))));
  return Number.isFinite(n) && n >= 0 ? usdRound(n) : DEFAULT_BUDGET_USD;
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
      };
    })
    .filter((d) => d.usd > 0);
}

async function estimatedSpendByDay(startIso) {
  // Tapestry fuel_ledger burn via transparency RPC (cents → USD), after project start.
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
    // Pod list only — never query clientBalance / account spend.
    const d = await runpod(`query { myself { pods { id name } } }`);
    for (const p of (d && d.myself && d.myself.pods) || []) {
      if (p && p.id && podNameMatch(p.name)) ids.add(p.id);
    }
  } catch (_) {}
  try {
    const rows = await rest(
      "GET",
      "audit_log?action=in.(pod_adopt,pod_replace,pod_start,pod_stop,admin_gpu_start,admin_gpu_stop,gpu_on,gpu_off)&select=target,detail&order=created_at.desc&limit=200"
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

async function podCostPerHr(podId) {
  // Rate from the pod itself (costPerHr), not account currentSpendPerHr.
  if (!podId) return null;
  try {
    const d = await runpod(`query { pod(input: {podId: "${podId}"}) { costPerHr desiredStatus } }`);
    const n = d && d.pod ? Number(d.pod.costPerHr) : NaN;
    return Number.isFinite(n) ? usdRound(n) : null;
  } catch (_) {
    return null;
  }
}

async function fetchBillingRows(startIso, extra = {}) {
  const key = env("RUNPOD_API_KEY");
  if (!key) return [];
  const end = new Date().toISOString();
  // Try both REST hosts; RunPod has flipped between api. and rest. over time.
  const hosts = ["https://rest.runpod.io/v1/billing/pods", "https://api.runpod.io/v1/billing/pods"];
  for (const base of hosts) {
    const url = new URL(base);
    url.searchParams.set("bucketSize", "day");
    url.searchParams.set("startTime", startIso);
    url.searchParams.set("endTime", end);
    url.searchParams.set("grouping", "podId");
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { authorization: "Bearer " + key } }).catch(() => null);
    if (!r || !r.ok) continue;
    const rows = await r.json().catch(() => null);
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

async function tapestryBillingDays(startIso, podIds) {
  const idSet = new Set(podIds);
  const byDay = new Map();
  const byPod = {};

  let rows = [];
  if (podIds.length === 1) {
    rows = await fetchBillingRows(startIso, { podId: podIds[0] });
  } else if (podIds.length > 1) {
    rows = (await fetchBillingRows(startIso)).filter((row) => idSet.has(String(row.podId || "")));
    if (!rows.length) {
      for (const id of podIds) rows = rows.concat(await fetchBillingRows(startIso, { podId: id }));
    }
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

/** Remaining = budget − spend + fuel. Starts at budget; spend lowers it; fuel bumps it up. */
function remainingOf(budget, spend, fuelBought) {
  return usdRound(budget - spend + fuelBought);
}

/** Build remaining-budget series (+ spend/net for totals). */
function buildSeries({ startAt, budget, spendDays, fuel }) {
  const spendByDay = new Map(spendDays.map((s) => [s.day, s.usd]));
  const fuelEvents = [...fuel].sort((a, b) => new Date(a.t) - new Date(b.t));

  const daySet = new Set([
    ...spendByDay.keys(),
    ...fuelEvents.map((e) => String(e.t).slice(0, 10)),
    new Date().toISOString().slice(0, 10),
  ]);
  const startDay = String(startAt).slice(0, 10);
  const days = [...daySet].filter((d) => d >= startDay).sort();

  let cumSpend = 0;
  let cumFuel = 0;
  const rem0 = remainingOf(budget, 0, 0);
  const points = [{ t: startAt, spend: 0, net: 0, fuel: 0, remaining: rem0, budget, kind: "start" }];
  const markers = [];

  for (const day of days) {
    const dayFuel = fuelEvents.filter((e) => String(e.t).slice(0, 10) === day);
    dayFuel.sort((a, b) => new Date(a.t) - new Date(b.t));

    // Billing is daily, so spread the day's spend evenly across its window; a fuel purchase
    // then lands as a vertical step up on a continuously falling line.
    const spentToday = spendByDay.get(day) || 0;
    const winStart = Math.max(+new Date(`${day}T00:00:00.000Z`), +new Date(startAt));
    const winEnd = Math.min(+new Date(`${day}T23:59:59.000Z`), Date.now());
    const spendAt = (t) => {
      const frac = winEnd > winStart ? Math.min(1, Math.max(0, (+new Date(t) - winStart) / (winEnd - winStart))) : 1;
      return usdRound(cumSpend + spentToday * frac);
    };
    for (const e of dayFuel) {
      const s = spendAt(e.t);
      points.push({
        t: e.t, spend: s, net: usdRound(Math.max(0, s - cumFuel)), fuel: cumFuel,
        remaining: remainingOf(budget, s, cumFuel), budget, kind: "pre-fuel",
      });
      cumFuel = usdRound(cumFuel + e.usd);
      const net = usdRound(Math.max(0, s - cumFuel));
      const remaining = remainingOf(budget, s, cumFuel);
      markers.push({ t: e.t, usd: e.usd, handle: e.handle, spend: s, net, fuel: cumFuel, remaining });
      points.push({ t: e.t, spend: s, net, fuel: cumFuel, remaining, budget, kind: "fuel" });
    }

    const spent = spendByDay.get(day) || 0;
    if (spent > 0) {
      cumSpend = usdRound(cumSpend + spent);
      const net = usdRound(Math.max(0, cumSpend - cumFuel));
      const remaining = remainingOf(budget, cumSpend, cumFuel);
      // Today's bucket is still open: stamp it at now, never in the future.
      const endOfDay = `${day}T23:59:59.000Z`;
      const nowIso = new Date().toISOString();
      points.push({
        t: endOfDay < nowIso ? endOfDay : nowIso,
        spend: cumSpend,
        net,
        fuel: cumFuel,
        remaining,
        budget,
        kind: "spend",
        day_spend: spent,
      });
    }
  }

  points.sort((a, b) => new Date(a.t) - new Date(b.t));
  const now = new Date().toISOString();
  const last = points[points.length - 1];
  const remaining = remainingOf(budget, cumSpend, cumFuel);
  if (!last || +new Date(last.t) < +new Date(now)) {
    points.push({
      t: now,
      spend: usdRound(cumSpend),
      net: usdRound(Math.max(0, cumSpend - cumFuel)),
      fuel: usdRound(cumFuel),
      remaining,
      budget,
    });
  }

  return {
    points,
    markers,
    spend_usd: usdRound(cumSpend),
    fuel_bought_usd: usdRound(cumFuel),
    net_burn_usd: usdRound(Math.max(0, cumSpend - cumFuel)),
    remaining_usd: remaining,
  };
}

async function payload() {
  const startAt = cashStartIso();
  const budget = budgetUsd();
  const fuel = await liveFuelPurchases(startAt);
  const hasKey = !!env("RUNPOD_API_KEY");

  let source = "estimated";
  let spendDays = [];
  let podIds = [];
  let spendByPod = {};
  let spendPerHr = null;

  if (hasKey) {
    try {
      podIds = await tapestryPodIds();
      const billed = await tapestryBillingDays(startAt, podIds);
      spendDays = billed.spendDays;
      spendByPod = billed.byPod;
      spendPerHr = await podCostPerHr(POD() || podIds[0]);
      if (spendDays.length) {
        source = "runpod";
      } else {
        // Billing empty (API quirk / new pods) — fall back to ledger, still no balance.
        console.warn("gpu-cash: no tapestry pod billing rows; using fuel ledger estimate");
        spendDays = await estimatedSpendByDay(startAt);
      }
    } catch (e) {
      console.warn("gpu-cash: runpod failed, estimating:", e.message || e);
      spendDays = await estimatedSpendByDay(startAt);
    }
  } else {
    spendDays = await estimatedSpendByDay(startAt);
  }

  const series = buildSeries({ startAt, budget, spendDays, fuel });

  return {
    budget_usd: budget,
    start_at: startAt,
    spend_usd: series.spend_usd,
    fuel_bought_usd: series.fuel_bought_usd,
    net_burn_usd: series.net_burn_usd,
    remaining_usd: series.remaining_usd,
    spend_per_hr_usd: spendPerHr, // pod costPerHr only; null if unknown
    source,
    estimated: source !== "runpod",
    pod_ids: podIds,
    spend_by_pod_usd: spendByPod,
    points: series.points,
    markers: series.markers, // fuel purchase markers only
    fuel,
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
    const budget = budgetUsd();
    return res.status(200).json({
      budget_usd: budget,
      start_at: startAt,
      spend_usd: null,
      fuel_bought_usd: 0,
      net_burn_usd: null,
      remaining_usd: budget,
      spend_per_hr_usd: null,
      source: "unavailable",
      estimated: true,
      points: [{ t: startAt, spend: 0, net: 0, fuel: 0, remaining: budget, budget, kind: "start" }],
      markers: [],
      fuel: [],
      error: "unavailable",
      updated_at: new Date().toISOString(),
    });
  }
};
