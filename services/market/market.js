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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { publishShopifyListing } from "../shopify/shopify-agent.js";
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

// What a buyer reads. One function so the text confirmed aloud before
// publishing is exactly the text that gets published.
export function describeItem(item) {
  const condition = String(item.condition ?? "good").replace(/_/g, " ");
  return `${item.label}, ${condition} condition. ${item.price_basis ? `Priced from: ${item.price_basis}.` : ""}`.trim();
}

const CHANNELS = ["shopify", "marketplace"];

export class Market {
  #eventLog;
  #draftQueue;
  #file;
  #rules = new Map(); // listingId -> { floorUsd, autoAcceptUsd, maxRounds }
  #pendingRules = new Map(); // planId -> Map(itemId -> rules), until approval
  plans = new Map();
  listings = new Map();
  threads = new Map();

  #publish;
  #marketplaceDrafts;

  constructor({
    eventLog,
    draftQueue,
    file = process.env.RELOOP_MARKET_FILE || null,
    // Shopify is the channel that actually goes live: one API call, a real
    // purchasable product, no human tap. Injectable for tests.
    publish = publishShopifyListing,
    // The muse.ai Marketplace draft needs a logged-in Chrome, a public photo
    // URL and a human tap to publish, so it is opt-in rather than the default.
    marketplaceDrafts = process.env.RELOOP_MARKETPLACE_DRAFTS === "1",
  } = {}) {
    this.#eventLog = eventLog;
    this.#draftQueue = draftQueue;
    this.#file = file;
    this.#publish = publish;
    this.#marketplaceDrafts = marketplaceDrafts;
    this.#load();
  }

  #load() {
    if (!this.#file || !existsSync(this.#file)) return;
    try {
      const raw = readFileSync(this.#file, "utf8");
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.plans)) this.plans = new Map(data.plans);
      if (Array.isArray(data.listings)) this.listings = new Map(data.listings);
      if (Array.isArray(data.rules)) this.#rules = new Map(data.rules);
      if (Array.isArray(data.pendingRules)) {
        this.#pendingRules = new Map(data.pendingRules.map(([pid, entries]) => [pid, new Map(entries)]));
      }
      if (Array.isArray(data.threads)) this.threads = new Map(data.threads);
    } catch (err) {
      console.error(`Failed to load market state from ${this.#file}:`, err.message);
    }
  }

  #save() {
    if (!this.#file) return;
    try {
      const data = {
        plans: [...this.plans.entries()],
        listings: [...this.listings.entries()],
        rules: [...this.#rules.entries()],
        pendingRules: [...this.#pendingRules.entries()].map(([pid, rMap]) => [pid, [...rMap.entries()]]),
        threads: [...this.threads.entries()],
      };
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error(`Failed to persist market state to ${this.#file}:`, err.message);
    }
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
    for (const decision of plan.decisions) {
      const item = keyed.find((i) => i.id === decision.itemId);
      if (item) decision.description = describeItem(item);
    }
    const stored = { ...plan, id: planId, createdAt: new Date().toISOString(), photoUrl, source, items: keyed };
    this.plans.set(planId, stored);
    this.#pendingRules.set(planId, rules);
    this.#save();
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

  // A correction made while the plan is being confirmed, before anything is
  // listed: a different price, title or condition, or keeping an item after all.
  // Every change bumps plan.revision, so an approval given for an earlier
  // readback cannot publish numbers the person never heard.
  revisePlan(planId, { itemId, listUsd, title, condition, action, description } = {}) {
    const plan = this.plans.get(planId);
    if (!plan) throw fail(404, `no plan "${planId}"`);
    if (plan.approved) throw fail(409, "plan is already approved");
    const decision = plan.decisions.find((d) => d.itemId === itemId);
    const item = plan.items.find((i) => i.id === itemId);
    if (!decision || !item) throw fail(404, `no item "${itemId}" in plan "${planId}"`);
    const rules = this.#pendingRules.get(planId);

    if (action !== undefined) {
      if (action !== "KEEP" && action !== "SELL") throw fail(400, 'action must be "KEEP" or "SELL"');
      if (action === "SELL" && !rules?.has(itemId)) throw fail(409, `"${item.label}" was never priced to sell`);
      decision.action = action;
      // A kept item holds on to its list price, so selling it after all
      // needs nothing recomputed.
      decision.reason = action === "KEEP" ? "You kept this item." : "You decided to sell this after all.";
    }
    if (listUsd !== undefined) {
      const next = Math.round(Number(listUsd));
      if (!Number.isFinite(next) || next < 1) throw fail(400, "listUsd must be a positive number");
      if (decision.action !== "SELL") throw fail(409, `"${item.label}" is not being sold`);
      // The floor and auto-accept were derived from the old list price. Scale
      // them with it and never leave either above what the item is listed at.
      const rule = rules?.get(itemId);
      if (rule && decision.listUsd) {
        const ratio = next / decision.listUsd;
        rule.floorUsd = Math.min(next, Math.max(1, Math.round(rule.floorUsd * ratio)));
        rule.autoAcceptUsd = Math.min(next, Math.max(rule.floorUsd, Math.round(rule.autoAcceptUsd * ratio)));
      }
      decision.listUsd = next;
      decision.reason = `You set the price to $${next}.`;
    }
    if (title !== undefined) {
      const next = String(title).trim();
      if (!next) throw fail(400, "title must not be empty");
      item.label = next;
      decision.label = next;
    }
    if (condition !== undefined) {
      const next = String(condition).trim().toLowerCase().replace(/\s+/g, "_");
      if (!next) throw fail(400, "condition must not be empty");
      item.condition = next;
      decision.condition = next;
    }

    if (description !== undefined) {
      const next = String(description).trim();
      if (!next) throw fail(400, "description must not be empty");
      decision.description = next.slice(0, 600);
      decision.descriptionCustom = true;
    } else if ((title !== undefined || condition !== undefined) && !decision.descriptionCustom) {
      // The generated text quotes the title and condition, so it follows them.
      // Words the person chose themselves are never overwritten.
      decision.description = describeItem(item);
    }

    // expectedUsd is what the items should sell for, not what they are listed
    // at: the planner lists above the estimate for negotiating room. Each
    // item's autoAcceptUsd is that estimate, scaled above with its price.
    plan.expectedUsd = plan.decisions
      .filter((d) => d.action === "SELL")
      .reduce((sum, d) => sum + (rules?.get(d.itemId)?.autoAcceptUsd ?? d.listUsd ?? 0), 0);
    plan.goalGapUsd = Math.max(0, (plan.targetUsd ?? 0) - plan.expectedUsd);
    plan.revision = (plan.revision ?? 0) + 1;
    this.#save();
    return this.publicPlan(plan);
  }

  // options: { location: {lat, lon}, categories: {itemId: name}, photoUrls: {itemId: [url]} }
  // keepIds: items the person unticked while reviewing. They are approved as
  // KEEP -- nothing is listed, published or drafted for them.
  setPlanChannels(planId, channels) {
    const plan = this.plans.get(planId);
    if (!plan) throw fail(404, `no plan "${planId}"`);
    if (plan.approved) throw fail(409, "plan is already approved");
    const asked = [...new Set((Array.isArray(channels) ? channels : []).map((c) => String(c).toLowerCase()))];
    if (!asked.length || asked.some((c) => !CHANNELS.includes(c))) {
      throw fail(400, `channels must be one or both of: ${CHANNELS.join(", ")}`);
    }
    plan.channels = asked;
    plan.revision = (plan.revision ?? 0) + 1;
    this.#save();
    return this.publicPlan(plan);
  }

  // channels: which storefronts this approval publishes to. Defaults to
  // Shopify plus Marketplace when the muse.ai bridge is switched on.
  #channelsFor(requested) {
    const asked = Array.isArray(requested) && requested.length
      ? requested.map((c) => String(c).toLowerCase())
      : ["shopify", ...(this.#marketplaceDrafts ? ["marketplace"] : [])];
    return { shopify: asked.includes("shopify"), marketplace: asked.includes("marketplace") };
  }

  approvePlan(planId, { location = null, categories = {}, photoUrls = {}, keepIds = [], channels = null, expectedRevision = null } = {}) {
    const plan = this.plans.get(planId);
    if (!plan) throw fail(404, `no plan "${planId}"`);
    if (plan.approved) throw fail(409, "plan is already approved");
    if (expectedRevision !== null && expectedRevision !== (plan.revision ?? 0)) {
      throw fail(409, `plan changed since it was confirmed (revision ${plan.revision ?? 0}, confirmed ${expectedRevision})`);
    }
    const want = this.#channelsFor(channels ?? plan.channels ?? null);
    const kept = new Set(keepIds);
    for (const decision of plan.decisions) {
      if (!kept.has(decision.itemId)) continue;
      decision.action = "KEEP";
      decision.listUsd = null;
      decision.reason = "You kept this item.";
    }
    if (kept.size) {
      plan.expectedUsd = plan.decisions
        .filter((d) => d.action === "SELL")
        .reduce((sum, d) => sum + (d.band?.[plan.tier ?? "normalUsd"] ?? d.listUsd ?? 0), 0);
      plan.goalGapUsd = Math.max(0, (plan.targetUsd ?? 0) - plan.expectedUsd);
    }
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
        description: decision.description ?? describeItem(item),
        photoUrl: photoUrls[item.id]?.[0] ?? plan.photoUrl ?? null,
        listUsd: decision.listUsd,
        basis: decision.band.basis,
        status: "ACTIVE",
        soldUsd: null,
        shopify: {
          status: want.shopify ? "publishing" : "off",
          url: null, productId: null, dryRun: null, error: null,
        },
        marketplace: { status: want.marketplace ? "queued" : "off", url: null, draftId: null, error: null },
      };
      this.listings.set(listing.id, listing);
      this.#rules.set(listing.id, rules.get(item.id));
      created.push(listing);

      // Go live on Shopify. Each publish resolves on its own; one failure
      // never blocks the rest of the approved plan.
      if (want.shopify) {
        this.#publishToShopify(listing, { item, decision, category: categories[item.id] ?? null });
      }

      if (!want.marketplace) continue;
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
          listing.marketplace.error = done.error ?? null;
          this.#save();
        },
      });
      listing.marketplace.draftId = job.id;
    }
    this.#save();
    return { plan: this.publicPlan(plan), listings: created.map((l) => this.publicListing(l)) };
  }

  // Publishes one approved listing to Shopify and records the outcome. Awaited
  // only by tests; approval returns as soon as the listings exist, and the page
  // learns the product URL from the LISTED event.
  async #publishToShopify(listing, { item, decision, category = null }) {
    try {
      const result = await this.#publish({
        id: listing.itemId,
        label: listing.title,
        listUsd: listing.listUsd,
        condition: listing.condition,
        category,
        price_basis: item?.price_basis ?? decision?.band?.basis ?? null,
        foundBy: item?.source ?? null,
        photoUrl: listing.photoUrl,
      });
      listing.shopify = {
        status: "live",
        url: result?.product?.url ?? null,
        productId: result?.product?.id ?? null,
        dryRun: Boolean(result?.dry_run),
        error: null,
      };
      this.#emit({
        kind: "LISTED",
        itemId: listing.itemId,
        label: listing.title,
        amountUsd: listing.listUsd,
        url: listing.shopify.url,
        text: `${listing.title} is live at $${listing.listUsd}${result?.dry_run ? " (dry run)" : ""}`,
      });
    } catch (err) {
      listing.shopify = { status: "failed", url: null, productId: null, dryRun: null, error: err.message };
      this.#emit({
        kind: "PUBLISH_FAILED",
        itemId: listing.itemId,
        label: listing.title,
        text: `Could not publish ${listing.title}: ${err.message}`,
      });
    }
    this.#save();
    return listing.shopify;
  }

  publicListing(listing) {
    // Explicit allowlist: nothing from #rules can ride along by accident.
    const { id, itemId, title, condition, description, photoUrl, listUsd, basis, status, soldUsd, shopify, marketplace } = listing;
    return {
      id, itemId, title, condition, description, photoUrl, listUsd, basis, status, soldUsd,
      shopify: { ...(shopify ?? { status: "off", url: null }) },
      marketplace: { ...marketplace },
    };
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
    // Rendered as a link on the dashboard. esc() stops markup, but not a
    // javascript: URL, so only a real Facebook address is ever stored.
    if (url) {
      if (!/^https:\/\/(www\.|m\.)?facebook\.com\//i.test(String(url))) throw fail(400, "url must be a facebook.com link");
      listing.marketplace.url = String(url);
    }
    this.#emit({
      kind: "LISTED",
      itemId: listing.itemId,
      label: listing.title,
      amountUsd: listing.listUsd,
      url: listing.marketplace.url,
      text: `${listing.title} is live on Marketplace`,
    });
    this.#save();
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
    this.#save();
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
    this.#save();
    return { listing: this.publicListing(listing), paid: false, note: "Mock checkout: no payment was taken." };
  }

  reprice({ dropPct = 0.05, dropAmount = 5 } = {}) {
    const repriced = [];
    for (const listing of this.listings.values()) {
      if (listing.status !== "ACTIVE") continue;
      const rules = this.#rules.get(listing.id);
      if (!rules || typeof rules.floorUsd !== "number") continue;
      if (listing.listUsd <= rules.floorUsd) continue;

      const drop = Math.max(dropAmount, Math.round(listing.listUsd * dropPct));
      const newPrice = Math.max(rules.floorUsd, listing.listUsd - drop);
      if (newPrice < listing.listUsd) {
        const oldPrice = listing.listUsd;
        listing.listUsd = newPrice;
        this.#emit({
          kind: "REPRICED",
          itemId: listing.itemId,
          listingId: listing.id,
          label: listing.title,
          amountUsd: newPrice,
          text: `Repriced ${listing.title} from $${oldPrice} to $${newPrice}`,
        });
        repriced.push({ id: listing.id, title: listing.title, oldPrice, newPrice });
      }
    }
    if (repriced.length > 0) this.#save();
    return repriced;
  }

  seedDemoData() {
    this.plans.clear();
    this.listings.clear();
    this.#rules.clear();
    this.#pendingRules.clear();
    this.threads.clear();

    const planId = "plan_demo_01";
    const demoItems = [
      {
        id: `${planId}_01`,
        label: "Sony PS4 Slim",
        condition: "good",
        price_usd: 185,
        price_basis: "used PS4 Slim consoles sell around $185",
        sourceItemId: "item_001",
      },
      {
        id: `${planId}_02`,
        label: "27in 1440p monitor",
        condition: "good",
        price_usd: 150,
        price_basis: "1440p 144Hz monitors sell around $150",
        sourceItemId: "item_002",
      },
      {
        id: `${planId}_03`,
        label: "Wireless gaming headset",
        condition: "fair",
        price_usd: 45,
        price_basis: "worn pads drop the usual $60",
        sourceItemId: "item_003",
      },
      {
        id: `${planId}_04`,
        label: "Mechanical keyboard",
        condition: "like_new",
        price_usd: 95,
        price_basis: "recent sold listings average $95",
        sourceItemId: "item_004",
      },
    ];

    const plan = {
      id: planId,
      goal: { mode: "CASH", targetUsd: 300, deadline: null },
      expectedUsd: 475,
      goalGapUsd: 0,
      approved: true,
      approvedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      photoUrl: "/api/photos/demo_room",
      source: "rayban_sdk",
      items: demoItems,
      decisions: [
        {
          itemId: `${planId}_01`,
          action: "SELL",
          band: { quickUsd: 160, normalUsd: 185, maxUsd: 215, basis: "used PS4 Slim consoles sell around $185" },
          listUsd: 190,
          reason: "Cash mode: list high, negotiate down",
        },
        {
          itemId: `${planId}_02`,
          action: "SELL",
          band: { quickUsd: 130, normalUsd: 150, maxUsd: 175, basis: "1440p 144Hz monitors sell around $150" },
          listUsd: 155,
          reason: "Cash mode: list high, negotiate down",
        },
        {
          itemId: `${planId}_03`,
          action: "SELL",
          band: { quickUsd: 40, normalUsd: 45, maxUsd: 55, basis: "worn pads drop the usual $60" },
          listUsd: 45,
          reason: "Cash mode: list at normal price",
        },
        {
          itemId: `${planId}_04`,
          action: "SELL",
          band: { quickUsd: 80, normalUsd: 95, maxUsd: 110, basis: "recent sold listings average $95" },
          listUsd: 100,
          reason: "Cash mode: list high, negotiate down",
        },
      ],
    };
    this.plans.set(planId, plan);

    const listings = [
      {
        id: "lst_demo_ps4",
        itemId: `${planId}_01`,
        title: "Sony PS4 Slim",
        condition: "good",
        description: "Sony PS4 Slim, good condition. Priced from: used PS4 Slim consoles sell around $185.",
        photoUrl: "/api/photos/demo_ps4",
        listUsd: 190,
        basis: "used PS4 Slim consoles sell around $185",
        status: "ACTIVE",
        soldUsd: null,
        marketplace: {
          status: "drafted",
          url: "https://www.facebook.com/marketplace/item/1029384756",
          draftId: "draft_001",
        },
      },
      {
        id: "lst_demo_monitor",
        itemId: `${planId}_02`,
        title: "27in 1440p monitor",
        condition: "good",
        description: "27in 1440p monitor, good condition. Priced from: 1440p 144Hz monitors sell around $150.",
        photoUrl: "/api/photos/demo_monitor",
        listUsd: 155,
        basis: "1440p 144Hz monitors sell around $150",
        status: "ACTIVE",
        soldUsd: null,
        marketplace: {
          status: "drafted",
          url: "https://www.facebook.com/marketplace/item/2938475610",
          draftId: "draft_002",
        },
      },
      {
        id: "lst_demo_headset",
        itemId: `${planId}_03`,
        title: "Wireless gaming headset",
        condition: "fair",
        description: "Wireless gaming headset, fair condition. Priced from: worn pads drop the usual $60.",
        photoUrl: "/api/photos/demo_headset",
        listUsd: 45,
        basis: "worn pads drop the usual $60",
        status: "ACTIVE",
        soldUsd: null,
        marketplace: {
          status: "drafted",
          url: "https://www.facebook.com/marketplace/item/3847561029",
          draftId: "draft_003",
        },
      },
      {
        id: "lst_demo_keyboard",
        itemId: `${planId}_04`,
        title: "Mechanical keyboard",
        condition: "like_new",
        description: "Mechanical keyboard, like new condition. Priced from: recent sold listings average $95.",
        photoUrl: "/api/photos/demo_keyboard",
        listUsd: 100,
        basis: "recent sold listings average $95",
        status: "ACTIVE",
        soldUsd: null,
        marketplace: {
          status: "drafted",
          url: "https://www.facebook.com/marketplace/item/4857201938",
          draftId: "draft_004",
        },
      },
    ];

    for (const listing of listings) {
      this.listings.set(listing.id, listing);
    }
    this.#rules.set("lst_demo_ps4", { floorUsd: 160, autoAcceptUsd: 185, maxRounds: 4 });
    this.#rules.set("lst_demo_monitor", { floorUsd: 130, autoAcceptUsd: 150, maxRounds: 4 });
    this.#rules.set("lst_demo_headset", { floorUsd: 35, autoAcceptUsd: 45, maxRounds: 4 });
    this.#rules.set("lst_demo_keyboard", { floorUsd: 80, autoAcceptUsd: 95, maxRounds: 4 });

    this.#save();
    return { plan, listings };
  }

  clear() {
    this.plans.clear();
    this.listings.clear();
    this.#rules.clear();
    this.#pendingRules.clear();
    this.threads.clear();
    this.#save();
  }
}
