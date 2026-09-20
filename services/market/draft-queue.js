// Marketplace drafts go through one muse.ai chat in one browser, and each can
// take up to 150 s. Two at once would interleave in the same chat, so every
// draft -- from plan approval or from the single-item route -- runs through
// this queue, strictly one at a time, with one retry.

import { draftListing } from "../../facebook-marketplace/muse-agent.js";
import { publicPhotoUrl } from "../shopify/shopify-client.js";

// muse.ai downloads each photo onto its own VM and drives Facebook from there,
// which took over 150s in practice — the old limit. A timeout is not free: the
// draft is usually still being built, so a retry can create a SECOND listing
// for the same item.

const FACEBOOK_URL = /https?:\/\/(?:www\.|m\.)?facebook\.com\/\S+/;

export class DraftQueue {
  #draft;
  #host;
  #eventLog;
  #timeoutMs;
  #retries;
  #jobs = [];
  #running = false;
  #seq = 0;

  constructor({ eventLog, draft = draftListing, host = publicPhotoUrl, timeoutMs = 300_000, retries = 1 } = {}) {
    this.#eventLog = eventLog;
    this.#draft = draft;
    this.#host = host;
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

  // Injectable so tests never reach Shopify.
  async #hostPhoto(url) {
    return this.#host(url);
  }

  async #run(entry) {
    const { job, item, options } = entry;
    job.status = "running";

    // muse.ai downloads the photo on its own VM. Verified from there: our
    // localhost address is refused and the tailnet one is unreachable, so a
    // local URL silently produces a listing with no picture. Anything not
    // publicly fetchable is re-hosted first. A photo that cannot be hosted is
    // dropped rather than failing the draft — a listing without its picture
    // beats no listing, and job.photoError says what happened.
    const wanted = Array.isArray(options.photoUrls) ? options.photoUrls : [];
    if (wanted.length) {
      const hosted = await Promise.all(
        wanted.map((url) => this.#hostPhoto(url).catch(() => null)),
      );
      options.photoUrls = hosted.filter(Boolean);
      const lost = wanted.length - options.photoUrls.length;
      if (lost > 0) job.photoError = `${lost} photo${lost === 1 ? "" : "s"} could not be hosted publicly`;
    }
    while (job.attempts <= this.#retries) {
      job.attempts += 1;
      try {
        const result = await this.#draft(item, { ...options, timeoutMs: this.#timeoutMs });
        job.status = "done";
        job.reply = result.reply ?? null;
        // muse.ai answers in prose; the draft link is whatever facebook.com URL
        // it mentions. It often ends on a question ("add the location and
        // publish?") with the link in an earlier line, so the last match wins
        // over the first.
        const links = String(result.reply ?? "").match(new RegExp(FACEBOOK_URL, "g"));
        job.url = links?.[links.length - 1] ?? null;
        job.result = result;
        break;
      } catch (err) {
        job.error = err.message;
        // A timeout means muse.ai is probably still working, not that it
        // failed. Retrying would ask for the same listing twice and create a
        // duplicate, so it is reported instead.
        const timedOut = /did not reply within/i.test(err.message);
        job.status = !timedOut && job.attempts <= this.#retries ? "running" : "failed";
        if (timedOut) {
          job.error = `${err.message} — it may still be building this listing; check Marketplace before trying again`;
          break;
        }
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
