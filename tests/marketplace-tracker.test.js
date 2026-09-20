import test from "node:test";
import assert from "node:assert/strict";
import { Market } from "../services/market/market.js";
import { MarketplaceTracker } from "../services/market/marketplace-tracker.js";
import { sanitizeReading } from "../services/market/muse-reader.js";
import { floorFor } from "../services/market/planner.js";
import { EventLog } from "../services/events/event-log.js";

const DOG = { id: "item_001", label: "Ceramic Dog Statue", condition: "good", price_usd: 704, price_basis: "comparable statues" };

// A market with one item approved for Facebook under the given goal button.
function listed(mode) {
  const market = new Market({
    file: null,
    eventLog: new EventLog({ file: null }),
    publish: async () => ({ ok: true, dryRun: true }),
    draftQueue: { enqueue: () => ({ job: { id: "draft_001" }, done: new Promise(() => {}) }), status: () => ({}) },
  });
  const plan = market.createPlan({ items: [DOG], goal: { mode } });
  const { listings } = market.approvePlan(plan.id, { channels: ["marketplace"] });
  return { market, listing: listings[0] };
}

// muse and the reader are faked: `script` is what the reader "understood".
function trackerFor(market, script, { autoReply = false } = {}) {
  const asked = [];
  const tracker = new MarketplaceTracker({
    market,
    autoReply,
    ask: async (instruction) => { asked.push(instruction); return { reply: /Reply with exactly/.test(instruction) ? "Done, the message was sent." : "report" }; },
    read: async () => script(),
  });
  return { tracker, asked };
}

test("Max cash: more than 10% off is refused as firm, inside 10% is a deal", async () => {
  const { market, listing } = listed("CASH");
  const list = listing.listUsd;
  assert.equal(floorFor(list, "CASH"), Math.ceil(list * 0.9));

  const lowball = market.message(listing.id, { buyer: "Jake", priceUsd: Math.floor(list * 0.8), text: "would you take that" });
  assert.equal(lowball.move, "COUNTER");
  assert.match(lowball.text, /firm/i);
  assert.ok(lowball.priceUsd >= Math.ceil(list * 0.9), "even the counter stays inside 10%");

  // Inside 10% it haggles like a person would -- tries for a little more
  // first -- but never says firm, and takes the offer if the buyer holds.
  const ask = Math.ceil(list * 0.95);
  const fair = market.message(listing.id, { buyer: "Ana", priceUsd: ask, text: "5% off?" });
  assert.doesNotMatch(fair.text, /firm/i);
  const held = fair.move === "ACCEPT" ? fair : market.message(listing.id, { threadId: fair.threadId, priceUsd: ask, text: "that's my offer" });
  assert.equal(held.move, "ACCEPT");
  assert.equal(held.priceUsd, ask);
});

test("the same offer is refused under Max cash and taken under Clear out fast", async () => {
  const offerOf = (list) => Math.floor(list * 0.8);
  const cash = listed("CASH");
  const clear = listed("CLEAR_OUT");
  const a = cash.market.message(cash.listing.id, { buyer: "Jake", priceUsd: offerOf(cash.listing.listUsd) });
  const b = clear.market.message(clear.listing.id, { buyer: "Jake", priceUsd: offerOf(clear.listing.listUsd) });
  assert.notEqual(a.move, "ACCEPT");
  // 20% off is inside Clear out's 25%: a counter or a deal, never a "firm" brush-off, and it closes within the rounds.
  assert.doesNotMatch(b.text, /firm/i);
  const again = b.move === "ACCEPT" ? b : clear.market.message(clear.listing.id, { threadId: b.threadId, priceUsd: offerOf(clear.listing.listUsd) + 1 });
  assert.ok(["ACCEPT", "COUNTER"].includes(again.move));
});

test("no sequence of offers gets a price below the goal's floor", async () => {
  for (const mode of ["CASH", "CLEAR_OUT", "ZERO_WASTE"]) {
    const { market, listing } = listed(mode);
    const floor = floorFor(listing.listUsd, mode);
    let threadId = null;
    for (const offer of [1, 5, floor - 1, floor - 1, floor - 1]) {
      let r;
      try { r = market.message(listing.id, { threadId, buyer: "Pushy", priceUsd: offer }); } catch { break; }
      threadId = r.threadId;
      if (r.priceUsd !== null) assert.ok(r.priceUsd >= floor, `${mode}: ${r.move} at $${r.priceUsd} is under the $${floor} floor`);
      assert.notEqual(r.move === "ACCEPT" && offer < floor, true);
    }
  }
});

test("a check with muse marks a listing live and answers a new buyer once", async () => {
  const { market, listing } = listed("CASH");
  const offer = Math.floor(listing.listUsd * 0.7);
  const { tracker, asked } = trackerFor(market, () => sanitizeReading({
    listings: [{ listing_id: listing.id, status: "live", url: "https://www.facebook.com/marketplace/item/42" }],
    messages: [{ listing_id: listing.id, buyer: "Jake", text: `would you take ${offer}?`, intent: "offer", offer_usd: offer }],
  }, [{ id: listing.id }]));

  const found = await tracker.sync();
  assert.deepEqual(found.wentLive, ["Ceramic Dog Statue"]);
  assert.equal(found.newMessages.length, 1);
  assert.match(found.newMessages[0].reply, /firm/i);
  assert.equal(market.getListing(listing.id).marketplace.status, "live");
  assert.match(asked[0], /Do not change, publish, delete or reply/);
  assert.doesNotMatch(asked[0], new RegExp(String(floorFor(listing.listUsd, "CASH"))), "muse is never told the floor");

  // Nothing was sent to the buyer: auto-reply is off, it waits for a person.
  assert.equal(asked.length, 1);
  assert.equal(market.publicThreads(listing.id)[0].messages.at(-1).sent, null);

  // muse reports the same waiting message again on the next check.
  const second = await tracker.sync();
  assert.equal(second.newMessages.length, 0, "the same message is not answered twice");
  assert.equal(market.publicThreads(listing.id)[0].messages.length, 2);

  // Send: muse is handed the policy's exact words, and the line is marked sent.
  const sent = await tracker.sendReply(found.newMessages[0].threadId);
  assert.equal(sent.sent, true);
  assert.match(asked.at(-1), /Reply with exactly this message/);
  assert.ok(asked.at(-1).includes(found.newMessages[0].reply.replace(/"/g, "'")));
  assert.ok(market.publicThreads(listing.id)[0].messages.at(-1).sent);
});

test("with auto-reply on, the answer goes out in the same check", async () => {
  const { market, listing } = listed("CLEAR_OUT");
  const { tracker, asked } = trackerFor(market, () => sanitizeReading({
    listings: [],
    messages: [{ listing_id: listing.id, buyer: "Ana", text: "is this still available?", intent: "availability", offer_usd: 0 }],
  }, [{ id: listing.id }]), { autoReply: true });
  const found = await tracker.sync();
  assert.equal(found.replies[0].sent, true);
  assert.equal(asked.length, 2);
});

test("the reader's output is not trusted: unknown listings, bad links and wild prices are dropped", () => {
  const out = sanitizeReading({
    listings: [
      { listing_id: "lst_real", status: "live", url: "javascript:alert(1)" },
      { listing_id: "lst_made_up", status: "live", url: "" },
      { listing_id: "lst_real", status: "on fire", url: "https://evil.example/facebook.com/" },
    ],
    messages: [
      { listing_id: "lst_real", buyer: "", text: "  ", intent: "offer", offer_usd: 5 },
      { listing_id: "lst_real", buyer: "Jake", text: "take 1e12?", intent: "offer", offer_usd: 1e12 },
      { listing_id: "lst_other", buyer: "Eve", text: "hi", intent: "other", offer_usd: 0 },
    ],
  }, [{ id: "lst_real" }]);
  assert.deepEqual(out.listings, [
    { listingId: "lst_real", status: "live", url: null },
    { listingId: "lst_real", status: "unknown", url: null },
  ]);
  assert.deepEqual(out.messages, [{ listingId: "lst_real", buyer: "Jake", text: "take 1e12?", intent: "offer", offerUsd: null }]);
});

test("a draft's link is kept for the owner to publish, and a removed listing stops being waited on", async () => {
  const { market, listing } = listed("CASH");
  let report = { listings: [{ listing_id: listing.id, status: "draft", url: "https://www.facebook.com/marketplace/item/77" }], messages: [] };
  const { tracker } = trackerFor(market, () => sanitizeReading(report, [{ id: listing.id }]));
  await tracker.sync();
  assert.equal(market.getListing(listing.id).marketplace.url, "https://www.facebook.com/marketplace/item/77");
  assert.notEqual(market.getListing(listing.id).marketplace.status, "live");

  report = { listings: [{ listing_id: listing.id, status: "removed", url: "" }], messages: [] };
  const found = await tracker.sync();
  assert.deepEqual(found.removed, ["Ceramic Dog Statue"]);
  assert.equal(market.getListing(listing.id).marketplace.status, "removed");
  assert.equal((await tracker.sync()).checked, 0, "muse is not asked about it again");
});
