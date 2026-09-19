// Marketplace drafts go through one muse.ai chat in one browser, and each can
// take up to 150 s. Two at once would interleave in the same chat, so every
// draft -- from plan approval or from the single-item route -- runs through
// this queue, strictly one at a time, with one retry.

import { draftListing } from "../../facebook-marketplace/muse-agent.js";

const FACEBOOK_URL = /https?:\/\/(?:www\.|m\.)?facebook\.com\/\S+/;

export class DraftQueue {
  #draft;
  #eventLog;
  #timeoutMs;
  #retries;
  #jobs = [];
  #running = false;
  #seq = 0;

  constructor({ eventLog, draft = draftListing, timeoutMs = 150_000, retries = 1 } = {}) {
    this.#eventLog = eventLog;
    this.#draft = draft;
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
  }

  // job: { item, photoUrls, location, category, floorUsd, onDone? }.
  // Returns { job, done } where `done` resolves with the job when it finishes.
  enqueue({ item, photoUrls = [], location = null, category = null, floorUsd = null, onDone = null }) {
    this.#seq += 1;
    const job = {
      id: `draft_${String(this.#seq).padStart(3, "0")}`,
      itemId: item.id ?? item.label,
      label: item.label,
      status: "queued",
      attempts: 0,
      url: null,
      reply: null,
      error: null,
      queuedAt: new Date().toISOString(),
      finishedAt: null,
    };
    let settle;
    const done = new Promise((resolveDone) => (settle = resolveDone));
    this.#jobs.push({ job, item, options: { photoUrls, location, category, floorUsd }, onDone, settle });
    this.#pump();
    return { job, done };
  }

  status() {
    return {
      running: this.#running,
      jobs: this.#jobs.map(({ job }) => ({ ...job })),
    };
  }

  async #pump() {
    if (this.#running) return;
    this.#running = true;
    try {
      let next;
      while ((next = this.#jobs.find(({ job }) => job.status === "queued"))) {
        await this.#run(next);
      }
    } finally {
      this.#running = false;
    }
  }

  async #run(entry) {
    const { job, item, options } = entry;
    job.status = "running";
    while (job.attempts <= this.#retries) {
      job.attempts += 1;
      try {
        const result = await this.#draft(item, { ...options, timeoutMs: this.#timeoutMs });
        job.status = "done";
        job.reply = result.reply ?? null;
        // muse.ai answers in prose; the draft link is whatever facebook.com URL it mentions.
        job.url = String(result.reply ?? "").match(FACEBOOK_URL)?.[0] ?? null;
        job.result = result;
        break;
      } catch (err) {
        job.error = err.message;
        job.status = job.attempts <= this.#retries ? "running" : "failed";
      }
    }
    job.finishedAt = new Date().toISOString();

    if (job.status === "done") {
      this.#eventLog?.append({
        kind: "DRAFTED",
        itemId: job.itemId,
        label: job.label,
        amountUsd: Number(item.price_usd) || null,
        url: job.url,
        text: `Marketplace draft ready: ${job.label}`,
      });
    } else {
      this.#eventLog?.append({
        kind: "DRAFT_FAILED",
        itemId: job.itemId,
        label: job.label,
        text: `Marketplace draft failed for ${job.label}: ${job.error}`,
      });
    }
    entry.onDone?.(job);
    entry.settle(job);
  }
}
