// The seller agent's price policy (plan v2 §5, "Negotiation"). The floor is
// code, not a prompt: whatever proposes a counter, the result is clamped here
// and nothing below floorUsd is ever accepted. `rules` never leaves the server.
//
// Proposals are deterministic (a concession schedule), so the policy runs and
// is testable without an LLM. An LLM could write `text` later; it would still
// go through the same clamp.

// Share of the (list - floor) gap the seller is willing to give up by round.
const CONCESSION = [0.25, 0.5, 0.7, 0.85];

// A yes is where a sale actually gets made or lost: it has to move straight to
// the meet-up, or the buyer drifts off.
function dealText(price) {
  return `Deal at $${price}! I can meet today or tomorrow. What time and place works for you? Somewhere public is best.`;
}

// After the price is settled the buyer is arranging the hand-off, not haggling.
export function meetupReply(listing, agreedUsd) {
  return `Perfect, that works for me. See you then! I'll have the ${listing.title} ready. $${agreedUsd}, cash or Venmo.`;
}

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
      text: `Hi! Yes, the ${listing.title} is still available. It's $${list}${listing.condition ? `, in ${String(listing.condition).replace(/_/g, " ")} condition` : ""}. Happy to answer any questions, and I can meet locally.`,
    };
  }

  if (p >= list || p >= rules.autoAcceptUsd) return { move: "ACCEPT", priceUsd: p, text: dealText(p) };

  if (round + 1 >= rules.maxRounds) {
    return p >= rules.floorUsd
      ? { move: "ACCEPT", priceUsd: p, text: `Alright, you've got a deal. ${dealText(p)}` }
      : { move: "REJECT", priceUsd: null, text: rules.firm
          ? `I appreciate the interest, but I can't go that low on this one.${lastCounterUsd ? ` My offer of $${lastCounterUsd} stands if you change your mind.` : ""}`
          : `Sorry, I can't go that low.${lastCounterUsd ? ` $${lastCounterUsd} is still on the table if you change your mind.` : ""}` };
  }

  const gap = list - rules.floorUsd;
  const proposed = Math.round(list - gap * CONCESSION[Math.min(round, CONCESSION.length - 1)]);

  // Close enough to where we were heading: take it rather than haggle over a few dollars.
  if (p >= rules.floorUsd && (p >= proposed || (lastCounterUsd !== null && lastCounterUsd - p <= gap * 0.25))) {
    return { move: "ACCEPT", priceUsd: p, text: dealText(p) };
  }

  // The clamp: never below the floor, never at or below the buyer's offer,
  // never above the list price, and never higher than our own last counter.
  const ceiling = lastCounterUsd === null ? list : Math.min(list, lastCounterUsd);
  const counter = clamp(proposed, Math.max(p + 1, rules.floorUsd), ceiling);
  if (counter <= p) return { move: "ACCEPT", priceUsd: p, text: dealText(p) };
  return {
    move: "COUNTER",
    priceUsd: counter,
    text: p < rules.floorUsd
      ? (rules.firm
          ? `Thanks for the offer, but I'm pretty firm on this one. It's priced to sell already. The best I can do is $${counter}.`
          : `That's a bit too low for me, but I do want it gone. I could do $${counter}.`)
      : `I can't quite do $${p}, but I could meet you at $${counter}.`,
  };
}
