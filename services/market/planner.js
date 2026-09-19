// Deterministic planner over the Node pricer's items. Port of the routing and
// tier rules in reloop_brain/planner.py (plan v2 §5): the model identifies and
// prices, code decides what to do with each item. No LLM here.
//
// The Node pricer returns one condition-adjusted price_usd per item, not a
// price-book band, so the band is derived from it with a fixed spread.

export const MODES = ["CASH", "CLEAR_OUT", "ZERO_WASTE", "UPGRADE", "YARD_SALE"];
export const SPREAD = 0.15;
export const MIN_LISTABLE_USD = Number(process.env.RELOOP_MIN_LISTABLE_USD ?? 15);
const HEADROOM = 1.03;

const round5 = (n) => Math.max(0, Math.round(n / 5) * 5);

export function priceBand(priceUsd, basis = "") {
  const normal = Math.max(0, Math.round(Number(priceUsd) || 0));
  return {
    quickUsd: round5(normal * (1 - SPREAD)),
    normalUsd: normal,
    maxUsd: round5(normal * (1 + SPREAD)),
    basis: basis || "model estimate of the secondhand price",
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

export function normalizeGoal(input = {}) {
  const mode = String(input.mode ?? "CASH").toUpperCase();
  if (!MODES.includes(mode)) throw badRequest(`goal.mode must be one of ${MODES.join(", ")}`);
  const money = (v) => (v === undefined || v === null || v === "" ? null : Math.max(0, Math.round(Number(v)) || 0));
  const goal = {
    mode,
    targetUsd: money(input.targetUsd),
    deadline: input.deadline ? new Date(input.deadline).toISOString() : null,
    upgradeTo: input.upgradeTo ?? null,
    upgradePriceUsd: money(input.upgradePriceUsd),
    budgetUsd: money(input.budgetUsd),
  };
  if (mode === "UPGRADE" && (!goal.upgradeTo || goal.upgradePriceUsd === null || goal.budgetUsd === null)) {
    throw badRequest("UPGRADE needs upgradeTo, upgradePriceUsd and budgetUsd");
  }
  return goal;
}

// Returns { plan, rules }. `plan` is public. `rules` holds the seller floors
// and must never be sent to a client -- the caller keeps it server-side.
export function buildPlan({ items, goal: goalInput, keepIds = [], now = new Date() }) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest("no items to plan");
  const goal = normalizeGoal(goalInput);
  const keep = new Set(keepIds);
  const target =
    goal.mode === "UPGRADE" ? Math.max(0, goal.upgradePriceUsd - goal.budgetUsd) : goal.targetUsd ?? 0;

  const routed = items.map((item) => {
    const band = priceBand(item.price_usd, item.price_basis);
    if (keep.has(item.id)) return { item, band, action: "KEEP", reason: "You marked this item to keep." };
    if (item.condition === "broken") {
      return { item, band, action: "RECYCLE", reason: "Broken: route to an e-waste drop-off." };
    }
    if (goal.mode === "YARD_SALE") {
      return band.normalUsd >= 2
        ? { item, band, action: "SELL", reason: "In-person sale bypasses the online listing minimum." }
        : { item, band, action: "DONATE", reason: "Worth under $2 even at a yard sale." };
    }
    if (band.normalUsd < MIN_LISTABLE_USD) {
      return {
        item,
        band,
        action: "DONATE",
        reason: `Estimated $${band.normalUsd} is below the $${MIN_LISTABLE_USD} listing minimum; not worth a negotiation.`,
      };
    }
    return { item, band, action: "SELL", reason: "" };
  });

  const normalTotal = routed.filter((r) => r.action === "SELL").reduce((sum, r) => sum + r.band.normalUsd, 0);
  const hours = goal.deadline ? (new Date(goal.deadline) - now) / 3_600_000 : 72;
  let tier = "normalUsd";
  let tierReason = "Normal tier balances expected value and speed";
  if (["CLEAR_OUT", "YARD_SALE"].includes(goal.mode) || hours < 24) {
    tier = "quickUsd";
    tierReason = "Quick-sale tier for clearance or a short deadline";
  } else if (target > 0 && normalTotal >= target * 1.3) {
    tier = "maxUsd";
    tierReason = "Higher tier: estimated value exceeds the target by 30%";
  }
  // Urgency lowers the floor toward the quick price; a relaxed goal holds out.
  const urgent = tier === "quickUsd";

  let expectedUsd = 0;
  const rules = new Map();
  const decisions = routed.map(({ item, band, action, reason }) => {
    const decision = { itemId: item.id, label: item.label, condition: item.condition, action, band, listUsd: null, reason };
    if (action !== "SELL") return decision;
    const estimated = Math.max(2, band[tier]);
    expectedUsd += estimated;
    decision.listUsd = Math.ceil(estimated * HEADROOM);
    decision.reason =
      `${tierReason}; expected $${estimated}, listed at $${decision.listUsd} for negotiating room.` +
      (target ? ` About ${Math.round((estimated / target) * 100)}% of the $${target} target.` : "");
    const floorUsd = Math.max(1, Math.min(estimated, urgent ? round5(band.quickUsd * 0.95) : band.quickUsd));
    rules.set(item.id, { floorUsd, autoAcceptUsd: estimated, maxRounds: 4 });
    return decision;
  });

  const plan = {
    goal,
    targetUsd: target,
    decisions,
    expectedUsd,
    goalGapUsd: Math.max(0, target - expectedUsd),
    approved: false,
  };
  return { plan, rules };
}
