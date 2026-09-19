// The seller agent's price policy (plan v2 §5, "Negotiation"). The floor is
// code, not a prompt: whatever proposes a counter, the result is clamped here
// and nothing below floorUsd is ever accepted. `rules` never leaves the server.
//
// Proposals are deterministic (a concession schedule), so the policy runs and
// is testable without an LLM. An LLM could write `text` later; it would still
// go through the same clamp.

// Share of the (list - floor) gap the seller is willing to give up by round.
const CONCESSION = [0.25, 0.5, 0.7, 0.85];

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// m: { priceUsd?: number }. listing: { listUsd, title }. rules: { floorUsd,
// autoAcceptUsd, maxRounds }. round: 0-based count of buyer messages so far.
// lastCounterUsd: the seller's previous counter in this thread, if any.
// Returns { move: "ACCEPT" | "COUNTER" | "REJECT" | "INFO", priceUsd, text }.
export function respond(m, listing, rules, round, lastCounterUsd = null) {
  const p = m.priceUsd === undefined || m.priceUsd === null ? null : Math.round(Number(m.priceUsd));
  const list = listing.listUsd;

  if (p === null || !Number.isFinite(p)) {
    return {
      move: "INFO",
      priceUsd: list,
      text: `The ${listing.title} is $${list}. ${listing.condition ? `Condition: ${listing.condition}. ` : ""}Make me an offer.`,
    };
  }

  if (p >= list || p >= rules.autoAcceptUsd) return { move: "ACCEPT", priceUsd: p, text: "Deal." };

  if (round + 1 >= rules.maxRounds) {
    return p >= rules.floorUsd
      ? { move: "ACCEPT", priceUsd: p, text: "Alright, deal." }
      : { move: "REJECT", priceUsd: null, text: "Can't go that low, sorry." };
  }

  const gap = list - rules.floorUsd;
  const proposed = Math.round(list - gap * CONCESSION[Math.min(round, CONCESSION.length - 1)]);

  // Close enough to where we were heading: take it rather than haggle over a few dollars.
  if (p >= rules.floorUsd && (p >= proposed || (lastCounterUsd !== null && lastCounterUsd - p <= gap * 0.25))) {
    return { move: "ACCEPT", priceUsd: p, text: "Deal." };
  }

  // The clamp: never below the floor, never at or below the buyer's offer,
  // never above the list price, and never higher than our own last counter.
  const ceiling = lastCounterUsd === null ? list : Math.min(list, lastCounterUsd);
  const counter = clamp(proposed, Math.max(p + 1, rules.floorUsd), ceiling);
  if (counter <= p) return { move: "ACCEPT", priceUsd: p, text: "Deal." };
  return {
    move: "COUNTER",
    priceUsd: counter,
    text: p < rules.floorUsd ? `That's too low for me. I could do $${counter}.` : `I can do $${counter}.`,
  };
}
