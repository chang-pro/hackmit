#!/usr/bin/env node
// Scripted buyer agent. It uses only the public store API -- the same one an
// outside agent would -- and never sees the seller's floor.
//
//   node scripts/buyer.js "ps4"                  # haggle for the first match
//   node scripts/buyer.js "monitor" --start 60   # open with a $60 offer
//   RELOOP_URL=https://... node scripts/buyer.js "ps4"
//
// Strategy: ask the price, open well under it, then close half the gap to the
// seller's counter each round. Checks out as soon as the seller accepts.

const BASE = (process.env.RELOOP_URL || "http://localhost:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const query = (args.find((a) => !a.startsWith("--")) || "").toLowerCase();
const startIdx = args.indexOf("--start");
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
console.log(`Found: ${listing.title} — listed at $${listing.listUsd} (${listing.id})`);

let reply = await api(`/api/listings/${listing.id}/messages`, { buyer: "demo-buyer", text: `Is the ${listing.title} still available? What's your best price?` });
const threadId = reply.threadId;
console.log(`  seller: ${reply.text}`);

let offer = startIdx >= 0 ? Number(args[startIdx + 1]) : Math.round(listing.listUsd * 0.85);
for (let round = 0; round < 6; round += 1) {
  await pause(delayMs);
  console.log(`  buyer:  I can do $${offer}.`);
  reply = await api(`/api/listings/${listing.id}/messages`, { thread_id: threadId, price_usd: offer, text: `Would you take $${offer}?` });
  console.log(`  seller: ${reply.text}`);
  if (reply.move === "ACCEPT") {
    await pause(delayMs);
    const sale = await api(`/api/listings/${listing.id}/checkout`, { thread_id: threadId });
    console.log(`SOLD ${sale.listing.title} for $${sale.listing.soldUsd}. ${sale.note}`);
    process.exit(0);
  }
  if (reply.move === "REJECT") break;
  offer = Math.min(reply.priceUsd, Math.ceil(offer + (reply.priceUsd - offer) / 2));
}
console.log("No deal.");
process.exit(2);
