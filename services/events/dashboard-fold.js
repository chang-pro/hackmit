// The dashboard is a fold over Event[] (plan §4): it stores nothing, so
// replaying the log rebuilds the demo. Shared by the server (for tests and
// /api/dashboard) and the browser (served at /dashboard-fold.js).

export const EVENT_KINDS = [
  "GOAL_SET",
  "IDENTIFIED",
  "PLAN_APPROVED",
  "DRAFTED",
  "DRAFT_FAILED",
  "PUBLISH_FAILED",
  "LISTED",
  "OFFER",
  "COUNTER",
  "SOLD",
  "DONATED",
  "RECYCLED",
  "REPRICED",
  "DOG_STARTED",
  "DOG_FOUND",
  "DOG_DONE",
];

// Card status only moves forward; a late DRAFTED never demotes a SOLD item.
const STAGE = { identified: 0, approved: 1, drafted: 2, live: 3, sold: 4, donated: 4, recycled: 4 };

function advance(card, status) {
  if (STAGE[status] >= STAGE[card.status]) card.status = status;
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function foldDashboard(events) {
  const goal = { mode: null, targetUsd: null, deadline: null };
  const cards = new Map();
  const feed = [];
  let recoveredUsd = 0;
  let expectedUsd = null;
  let dog = null;

  const cardFor = (event) => {
    const key = event.itemId ?? event.listingId;
    if (!key) return null;
    if (!cards.has(key)) {
      cards.set(key, {
        itemId: key,
        label: event.label ?? key,
        status: "identified",
        listUsd: null,
        soldUsd: null,
        url: null,
        source: event.source ?? null,
        spot: event.spot ?? null,
        lastOfferUsd: null,
        updatedAt: event.ts,
      });
    }
    const card = cards.get(key);
    if (event.label) card.label = event.label;
    if (event.source) card.source = event.source;
    if (event.spot) card.spot = event.spot;
    card.updatedAt = event.ts;
    return card;
  };

  for (const event of events) {
    const card = cardFor(event);
    const amount = money(event.amountUsd);
    switch (event.kind) {
      case "GOAL_SET":
        goal.mode = event.mode ?? goal.mode;
        goal.targetUsd = amount ?? goal.targetUsd;
        goal.deadline = event.deadline ?? goal.deadline;
        break;
      case "IDENTIFIED":
        if (card && amount !== null) card.listUsd = amount;
        break;
      case "PLAN_APPROVED":
        if (card) advance(card, "approved");
        if (!card && amount !== null) expectedUsd = amount;
        break;
      case "DRAFTED":
        if (card) {
          advance(card, "drafted");
          if (amount !== null) card.listUsd = amount;
          if (event.url) card.url = event.url;
        }
        break;
      case "DRAFT_FAILED":
      case "PUBLISH_FAILED":
        break; // card stays where it was; the feed says why
      case "LISTED":
        if (card) {
          advance(card, "live");
          if (amount !== null) card.listUsd = amount;
          if (event.url) card.url = event.url;
        }
        break;
      case "OFFER":
      case "COUNTER":
        if (card && amount !== null) card.lastOfferUsd = amount;
        break;
      case "REPRICED":
        if (card && amount !== null) card.listUsd = amount;
        break;
      case "SOLD":
        if (card) {
          advance(card, "sold");
          card.soldUsd = amount;
        }
        recoveredUsd += amount ?? 0;
        break;
      case "DONATED":
        if (card) advance(card, "donated");
        break;
      case "RECYCLED":
        if (card) advance(card, "recycled");
        break;
      case "DOG_STARTED":
        dog = { missionId: event.missionId ?? null, status: "RUNNING", found: 0 };
        break;
      case "DOG_FOUND":
        if (dog) dog.found += 1;
        break;
      case "DOG_DONE":
        if (dog) dog.status = "DONE";
        break;
      default:
        continue; // unknown kinds are ignored, never fatal
    }
    if (event.text) feed.push({ ts: event.ts, kind: event.kind, text: event.text });
  }

  const all = [...cards.values()];
  const count = (status) => all.filter((card) => card.status === status).length;
  return {
    goal,
    recoveredUsd,
    expectedUsd,
    goalGapUsd: goal.targetUsd === null ? null : Math.max(0, goal.targetUsd - recoveredUsd),
    counts: {
      drafted: count("drafted"),
      live: count("live"),
      sold: count("sold"),
      donated: count("donated"),
      recycled: count("recycled"),
    },
    // "Agent still working on N" -- approved for sale but not yet sold.
    workingOn: count("approved") + count("drafted") + count("live"),
    cards: all,
    feed: feed.slice(-12).reverse(),
    dog,
  };
}
