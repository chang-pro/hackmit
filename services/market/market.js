// ReLoop's own market: plans, approval, the public store, negotiation and
// checkout. Every state change is an event, so the dashboard and the phone
// learn about it from the log rather than from this object.
//
// Two channels per approved SELL item:
//   - a ReLoop store listing, live immediately, where our seller agent
//     negotiates with a hard floor (the stage demo);
//   - a Facebook Marketplace draft through muse.ai (reach). A human publishes
//     it, then reports it live via markMarketplaceLive().
//
// Seller floors live in #rules, a private field. No method returns them.

import { randomUUID } from "node:crypto";
import { buildPlan } from "./planner.js";
import { respond } from "./seller.js";

const HOLD_MS = 10 * 60_000;
const MAX_THREADS_PER_LISTING = 50;

function fail(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const shortId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

export class Market {
  #eventLog;
  #draftQueue;
  #rules = new Map(); // listingId -> { floorUsd, autoAcceptUsd, maxRounds }
  #pendingRules = new Map(); // planId -> Map(itemId -> rules), until approval
  plans = new Map();
  listings = new Map();
  threads = new Map();

  constructor({ eventLog, draftQueue }) {
    this.#eventLog = eventLog;
    this.#draftQueue = draftQueue;
  }

  #emit(event) {
    return this.#eventLog.append(event);
  }

  // items: the Node pricer's items ({ id, label, condition, price_usd, price_basis }).
  // photoUrl: where the frame these items came from is served, if stored.
  createPlan({ items, goal, keepIds = [], photoUrl = null, source = null }) {
    // Pricer ids (item_001...) restart every frame, so a plan re-keys them.
    const planId = shortId("plan");
    const keyed = items.map((item, i) => ({
      ...item,
      sourceItemId: item.id,
      id: `${planId}_${String(i + 1).padStart(2, "0")}`,
    }));
    const keep = keepIds.map((id) => keyed.find((item) => item.sourceItemId === id || item.id === id)?.id).filter(Boolean);
    const { plan, rules } = buildPlan({ items: keyed, goal, keepIds: keep });
    const stored = { ...plan, id: planId, createdAt: new Date().toISOString(), photoUrl, source, items: keyed };
    this.plans.set(planId, stored);
    this.#pendingRules.set(planId, rules);
    return this.publicPlan(stored);
  }

  publicPlan(plan) {
    const { items, ...rest } = plan;
    return rest;
  }

  getPlan(planId) {
    const plan = this.plans.get(planId);
    if (!plan) throw fail(404, `no plan "${planId}"`);
    return this.publicPlan(plan);
  }

  // options: { location: {lat, lon}, categories: {itemId: name}, photoUrls: {itemId: [url]} }
  approvePlan(planId, { location = null, categories = {}, photoUrls = {} } = {}) {
    const plan = this.plans.get(planId);
    if (!plan) throw fail(404, `no plan "${planId}"`);
    if (plan.approved) throw fail(409, "plan is already approved");
    const rules = this.#pendingRules.get(planId);
    plan.approved = true;
    plan.approvedAt = new Date().toISOString();
    this.#pendingRules.delete(planId);

    this.#emit({
      kind: "GOAL_SET",
      mode: plan.goal.mode,
      amountUsd: plan.targetUsd || null,
      deadline: plan.goal.deadline,
      text: plan.targetUsd ? `Goal: $${plan.targetUsd} (${plan.goal.mode.replace(/_/g, " ").toLowerCase()})` : `Goal: ${plan.goal.mode}`,
    });
    const counts = { SELL: 0, DONATE: 0, RECYCLE: 0, KEEP: 0 };
    for (const d of plan.decisions) counts[d.action] += 1;
    this.#emit({
      kind: "PLAN_APPROVED",
      amountUsd: plan.expectedUsd,
      text: `Plan approved: sell ${counts.SELL}, donate ${counts.DONATE}, recycle ${counts.RECYCLE}`,
    });

    const created = [];
    for (const decision of plan.decisions) {
      const item = plan.items.find((i) => i.id === decision.itemId);
      const base = { itemId: item.id, label: item.label, source: plan.source ?? undefined };
      this.#emit({ kind: "IDENTIFIED", ...base, amountUsd: decision.band.normalUsd });
      if (decision.action === "DONATE") {
        this.#emit({ kind: "DONATED", ...base, text: `${item.label} routed to donation` });
        continue;
      }
      if (decision.action === "RECYCLE") {
        this.#emit({ kind: "RECYCLED", ...base, text: `${item.label} routed to an e-waste drop-off` });
        continue;
      }
      if (decision.action !== "SELL") continue;

      this.#emit({ kind: "PLAN_APPROVED", ...base, amountUsd: decision.listUsd });
      const listing = {
        id: shortId("lst"),
        itemId: item.id,
        title: item.label,
        condition: item.condition,
        description: `${item.label}, ${String(item.condition ?? "good").replace(/_/g, " ")} condition. ${item.price_basis ? `Priced from: ${item.price_basis}.` : ""}`.trim(),
        photoUrl: photoUrls[item.id]?.[0] ?? plan.photoUrl ?? null,
        listUsd: decision.listUsd,
        basis: decision.band.basis,
        status: "ACTIVE",
        soldUsd: null,
        marketplace: { status: "queued", url: null, draftId: null },
      };
      this.listings.set(listing.id, listing);
      this.#rules.set(listing.id, rules.get(item.id));
      created.push(listing);

      const photos = photoUrls[item.id] ?? (plan.photoUrl ? [plan.photoUrl] : []);
      const { job } = this.#draftQueue.enqueue({
        item: { id: item.id, label: item.label, condition: item.condition, price_usd: decision.listUsd },
        photoUrls: photos,
        location,
        category: categories[item.id] ?? null,
        floorUsd: this.#rules.get(listing.id).floorUsd,
        onDone: (done) => {
          listing.marketplace.status = done.status === "done" ? "drafted" : "failed";
          listing.marketplace.url = done.url;
        },
      });
      listing.marketplace.draftId = job.id;
    }
    return { plan: this.publicPlan(plan), listings: created.map((l) => this.publicListing(l)) };
  }

  publicListing(listing) {
    // Explicit allowlist: nothing from #rules can ride along by accident.
    const { id, itemId, title, condition, description, photoUrl, listUsd, basis, status, soldUsd, marketplace } = listing;
    return { id, itemId, title, condition, description, photoUrl, listUsd, basis, status, soldUsd, marketplace: { ...marketplace } };
  }

  #listing(listingId) {
    const listing = this.listings.get(listingId);
    if (!listing) throw fail(404, `no listing "${listingId}"`);
    this.#expireHold(listing);
    return listing;
  }

  #expireHold(listing) {
    if (listing.status === "PENDING" && listing.hold && Date.now() > listing.hold.until) {
      listing.status = "ACTIVE";
      listing.hold = null;
    }
  }

  catalog() {
    const items = [];
    for (const listing of this.listings.values()) {
      this.#expireHold(listing);
      if (listing.status !== "SOLD") items.push(this.publicListing(listing));
    }
    return { store: "ReLoop", currency: "USD", listings: items };
  }

  getListing(listingId) {
    return this.publicListing(this.#listing(listingId));
  }

  // A human published the Marketplace draft (publishing needs their tap).
  markMarketplaceLive(listingId, url = null) {
    const listing = this.#listing(listingId);
    listing.marketplace.status = "live";
    if (url) listing.marketplace.url = url;
    this.#emit({
      kind: "LISTED",
      itemId: listing.itemId,
      label: listing.title,
      amountUsd: listing.listUsd,
      url: listing.marketplace.url,
      text: `${listing.title} is live on Marketplace`,
    });
    return this.publicListing(listing);
  }

  // One buyer message. body: { threadId?, buyer?, priceUsd?, text? }.
  message(listingId, { threadId = null, buyer = "buyer", priceUsd = null, text = "" } = {}) {
    const listing = this.#listing(listingId);
    if (listing.status === "SOLD") throw fail(409, "listing is sold");
    const rules = this.#rules.get(listingId);

    let thread = threadId ? this.threads.get(threadId) : null;
    if (threadId && (!thread || thread.listingId !== listingId)) throw fail(404, `no thread "${threadId}" on this listing`);
    if (!thread) {
      const open = [...this.threads.values()].filter((t) => t.listingId === listingId).length;
      if (open >= MAX_THREADS_PER_LISTING) throw fail(429, "too many threads on this listing");
      thread = { id: shortId("thr"), listingId, buyer: String(buyer).slice(0, 60), round: 0, lastCounterUsd: null, agreedUsd: null, closed: false, messages: [] };
      this.threads.set(thread.id, thread);
    }
    if (thread.closed) throw fail(409, "this negotiation is closed");
    if (listing.status === "PENDING" && listing.hold?.threadId !== thread.id) {
      throw fail(409, "another buyer has a hold on this listing");
    }

    const offer = priceUsd === null || priceUsd === undefined || priceUsd === "" ? null : Math.round(Number(priceUsd));
    if (offer !== null && (!Number.isFinite(offer) || offer < 0)) throw fail(400, "priceUsd must be a non-negative number");
    const now = new Date().toISOString();
    thread.messages.push({ frm: "BUYER", priceUsd: offer, text: String(text).slice(0, 500), ts: now });

    const reply = respond({ priceUsd: offer }, listing, rules, thread.round, thread.lastCounterUsd);
    if (offer !== null) {
      thread.round += 1;
      this.#emit({ kind: "OFFER", itemId: listing.itemId, label: listing.title, amountUsd: offer, text: `Buyer offered $${offer} for the ${listing.title}` });
    }
    if (reply.move === "COUNTER") {
      thread.lastCounterUsd = reply.priceUsd;
      this.#emit({ kind: "COUNTER", itemId: listing.itemId, label: listing.title, amountUsd: reply.priceUsd, text: `Seller countered $${reply.priceUsd}` });
    } else if (reply.move === "ACCEPT") {
      // One hold per listing: the accepted price is reserved for this thread.
      thread.agreedUsd = reply.priceUsd;
      listing.status = "PENDING";
      listing.hold = { threadId: thread.id, priceUsd: reply.priceUsd, until: Date.now() + HOLD_MS };
    } else if (reply.move === "REJECT") {
      thread.closed = true;
    }
    thread.messages.push({ frm: "SELLER", priceUsd: reply.priceUsd, text: reply.text, ts: now });
    return { threadId: thread.id, move: reply.move, priceUsd: reply.priceUsd, text: reply.text, listing: this.publicListing(listing) };
  }

  // Mock checkout: completes the held sale at the agreed price. No payment is taken.
  checkout(listingId, { threadId } = {}) {
    const listing = this.#listing(listingId);
    if (listing.status === "SOLD") throw fail(409, "listing is already sold");
    const thread = this.threads.get(threadId);
    if (!thread || thread.listingId !== listingId || thread.agreedUsd === null) {
      throw fail(409, "no agreed price on this thread; negotiate first");
    }
    if (listing.status !== "PENDING" || listing.hold?.threadId !== thread.id) {
      throw fail(409, "the hold on this listing expired; negotiate again");
    }
    listing.status = "SOLD";
    listing.soldUsd = thread.agreedUsd;
    listing.hold = null;
    thread.closed = true;
    this.#emit({
      kind: "SOLD",
      itemId: listing.itemId,
      label: listing.title,
      amountUsd: listing.soldUsd,
      text: `Sold the ${listing.title} for $${listing.soldUsd}`,
    });
    return { listing: this.publicListing(listing), paid: false, note: "Mock checkout: no payment was taken." };
  }
}
