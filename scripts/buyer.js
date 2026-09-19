#!/usr/bin/env node
// Buyer agent for ReLoop. Uses only the public store API -- the same one an
// outside autonomous agent would use -- and never sees the seller's floor.
//
// Usage:
//   node scripts/buyer.js "ps4"                  # auto-uses LLM if keys available, else scripted
//   node scripts/buyer.js "ps4" --llm            # force LLM mode
//   node scripts/buyer.js "ps4" --scripted       # force deterministic scripted mode
//   node scripts/buyer.js "monitor" --start 60   # open with a $60 offer
//   RELOOP_URL=https://... node scripts/buyer.js "ps4"

import { hasLlmCredentials, proposeBuyerMove } from "../services/market/llm-buyer.js";

const BASE = (process.env.RELOOP_URL || "http://localhost:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const query = (args.find((a) => !a.startsWith("--")) || "").toLowerCase();
const startIdx = args.indexOf("--start");
const forceScripted = args.includes("--scripted");
const forceLlm = args.includes("--llm");
const useLlm = forceLlm || (!forceScripted && hasLlmCredentials());
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const delayMs = Number(process.env.BUYER_DELAY_MS ?? 1500); // readable on a projector

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error ?? res.status}`);
  return json;
}

const { listings } = await api("/catalog.json");
const listing = listings.find((l) => l.status === "ACTIVE" && l.title.toLowerCase().includes(query));
if (!listing) {
  console.error(`No active listing matches "${query}". Available: ${listings.map((l) => l.title).join(", ") || "none"}`);
  process.exit(1);
}

const modeLabel = useLlm ? "Autonomous LLM Agent" : "Scripted Agent";
console.log(`\n🤖 [Buyer Mode]: ${modeLabel}`);
console.log(`🛍️  Found item: "${listing.title}" — listed at $${listing.listUsd} (${listing.id})\n`);

let reply = await api(`/api/listings/${listing.id}/messages`, {
  buyer: useLlm ? "llm-buyer-bot" : "demo-buyer",
  text: `Is the ${listing.title} still available? What's your best price?`,
});
const threadId = reply.threadId;
console.log(`🏪 [Seller]: "${reply.text}"`);

const history = [
  { role: "buyer", text: `Is the ${listing.title} still available? What's your best price?`, priceUsd: null },
  { role: "seller", text: reply.text, priceUsd: reply.priceUsd ?? listing.listUsd },
];

let offer = startIdx >= 0 ? Number(args[startIdx + 1]) : Math.round(listing.listUsd * 0.85);

for (let round = 0; round < 6; round += 1) {
  await pause(delayMs);

  let buyerText = "";
  let buyerPrice = offer;
  let buyerMove = "OFFER";

  if (useLlm) {
    const proposal = await proposeBuyerMove({
      listing,
      history,
      targetBudget: Math.round(listing.listUsd * 0.92),
      round,
    });
    buyerMove = proposal.move;
    buyerPrice = proposal.priceUsd ?? offer;
    buyerText = proposal.text;
  } else {
    buyerText = `I can do $${offer}.`;
  }

  if (buyerMove === "ACCEPT") {
    console.log(`🤖 [Buyer]:  "${buyerText}" (Accepting deal)`);
    await pause(delayMs);
    const sale = await api(`/api/listings/${listing.id}/checkout`, { thread_id: threadId });
    console.log(`\n🎉 SOLD "${sale.listing.title}" for $${sale.listing.soldUsd}!`);
    console.log(`   ${sale.note}`);
    process.exit(0);
  }

  console.log(`🤖 [Buyer]:  "${buyerText}"`);
  history.push({ role: "buyer", text: buyerText, priceUsd: buyerPrice });

  reply = await api(`/api/listings/${listing.id}/messages`, {
    thread_id: threadId,
    price_usd: buyerPrice,
    text: buyerText,
  });

  console.log(`🏪 [Seller]: "${reply.text}"\n`);
  history.push({ role: "seller", text: reply.text, priceUsd: reply.priceUsd });

  if (reply.move === "ACCEPT") {
    await pause(delayMs);
    const sale = await api(`/api/listings/${listing.id}/checkout`, { thread_id: threadId });
    console.log(`\n🎉 SOLD "${sale.listing.title}" for $${sale.listing.soldUsd}!`);
    console.log(`   ${sale.note}`);
    process.exit(0);
  }

  if (reply.move === "REJECT") break;

  offer = Math.min(reply.priceUsd, Math.ceil(buyerPrice + (reply.priceUsd - buyerPrice) / 2));
}

console.log("❌ No deal reached.");
process.exit(2);
