// Follows listings after muse has drafted them on Facebook Marketplace.
//
// Facebook lets nobody but the account owner press Publish, and buyers write in
// on Facebook, not here. So the app has to ASK: muse checks the account, a
// language model reads its answer (muse-reader.js), and this turns that into
// what the status page shows -- draft, live, a buyer wrote, sold.
//
// A buyer's message is answered by the same seller policy as everywhere else
// (seller.js): the goal the person picked set the floor, and the floor is code.
// Neither muse nor the reader can move it. Replies are only SENT to the buyer
// when auto-reply is on or the person presses Send: it is their real account.

import { ask as museAsk, statusInstruction, replyInstruction } from "../../facebook-marketplace/muse-agent.js";
import { readMuseReport } from "./muse-reader.js";

const SENT = /\b(sent|replied|delivered|posted)\b/i;
const NOT_SENT = /\b(could ?n[o']t|couldn't|unable|failed|not able|did ?n[o']t|can't|cannot|no conversation|not found)\b/i;

const MAX_TRACKED = Number(process.env.MARKETPLACE_MAX_TRACKED ?? 10);

const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

export class MarketplaceTracker {
  #market;
  #ask;
  #read;
  #autoReply;
  #syncing = null;
  #last = { at: null, error: null, report: null, found: null };
  #timer = null;

  constructor({ market, ask = museAsk, read = readMuseReport, autoReply = false } = {}) {
    this.#market = market;
    this.#ask = ask;
    this.#read = read;
    this.#autoReply = autoReply;
  }

  get autoReply() {
    return this.#autoReply;
  }

  setAutoReply(on) {
    this.#autoReply = on === true;
    return this.#autoReply;
  }

  // Checks Facebook every `everyMs`. Off by default: every check is a real
  // message in the muse chat and a minute of its time.
  watch(everyMs) {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (Number(everyMs) >= 30_000) {
      this.#timer = setInterval(() => this.sync().catch(() => {}), Number(everyMs));
      this.#timer.unref?.();
    }
    return Boolean(this.#timer);
  }

  // One round trip to muse. Concurrent callers share the same check.
  sync() {
    if (!this.#syncing) this.#syncing = this.#syncOnce().finally(() => (this.#syncing = null));
    return this.#syncing;
  }

  async #syncOnce() {
    // Newest first, and only so many: the question is typed into a chat, and a
    // page-long list of titles makes muse slow and its answer hard to read.
    const listings = this.#market.listingsOnMarketplace().reverse().slice(0, MAX_TRACKED);
    const summary = { checked: listings.length, wentLive: [], sold: [], newMessages: [], replies: [], errors: [] };
    if (!listings.length) {
      this.#last = { at: new Date().toISOString(), error: null, report: null, found: summary };
      return summary;
    }
    try {
      const { reply: report } = await this.#ask(statusInstruction(listings), { timeoutMs: 240_000 });
      const reading = await this.#read(report, listings.map((l) => ({ id: l.id, title: l.title, listUsd: l.listUsd })));

      for (const seen of reading.listings) {
        const listing = listings.find((l) => l.id === seen.listingId);
        if (!listing) continue;
        try {
          if (seen.status === "live" && listing.marketplace.status !== "live") {
            this.#market.markMarketplaceLive(listing.id, seen.url);
            summary.wentLive.push(listing.title);
          } else if (seen.status === "sold") {
            this.#market.markSoldOnMarketplace(listing.id);
            summary.sold.push(listing.title);
          }
        } catch (err) {
          summary.errors.push(`${listing.title}: ${err.message}`);
        }
      }

      for (const msg of reading.messages) {
        try {
          const threads = this.#market.publicThreads(msg.listingId).filter((t) => t.channel === "facebook" && same(t.buyer, msg.buyer));
          // muse reports whoever is still waiting, so the same message comes
          // back on every check until it is answered. Once is enough.
          if (threads.some((t) => t.messages.some((m) => m.frm === "BUYER" && same(m.text, msg.text)))) continue;
          const open = threads.find((t) => !t.closed);
          const result = this.#market.message(msg.listingId, {
            threadId: open?.id ?? null,
            buyer: msg.buyer,
            priceUsd: msg.offerUsd,
            text: msg.text,
            channel: "facebook",
          });
          summary.newMessages.push({ threadId: result.threadId, buyer: msg.buyer, text: msg.text, offerUsd: msg.offerUsd, move: result.move, reply: result.text });
          if (this.#autoReply) summary.replies.push(await this.sendReply(result.threadId));
        } catch (err) {
          summary.errors.push(`${msg.buyer}: ${err.message}`);
        }
      }
      this.#last = { at: new Date().toISOString(), error: null, report: String(report).slice(0, 2000), found: summary };
      return summary;
    } catch (err) {
      this.#last = { at: new Date().toISOString(), error: err.message, report: null, found: summary };
      throw err;
    }
  }

  // Delivers the seller's latest line in a thread to the buyer, through muse.
  async sendReply(threadId) {
    const thread = this.#market.publicThreads().find((t) => t.id === threadId);
    if (!thread) {
      const err = new Error(`no thread "${threadId}"`);
      err.statusCode = 404;
      throw err;
    }
    if (thread.channel !== "facebook") {
      const err = new Error("only Facebook conversations are delivered through muse");
      err.statusCode = 409;
      throw err;
    }
    const line = [...thread.messages].reverse().find((m) => m.frm === "SELLER");
    if (!line) return { threadId, sent: false, note: "nothing to send" };
    if (line.sent) return { threadId, sent: true, note: "already sent" };
    const listing = this.#market.getListing(thread.listingId);
    const { reply } = await this.#ask(replyInstruction({ title: listing.title, buyer: thread.buyer, text: line.text }), { timeoutMs: 240_000 });
    const sent = SENT.test(reply) && !NOT_SENT.test(reply);
    this.#market.markReplySent(threadId, sent);
    return { threadId, sent, note: String(reply).slice(0, 300) };
  }

  status() {
    return { autoReply: this.#autoReply, watching: Boolean(this.#timer), checking: Boolean(this.#syncing), last: this.#last };
  }
}
