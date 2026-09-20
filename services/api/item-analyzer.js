// Live item analyzer. Frames arrive far faster than a vision model should be
// billed for, so this keeps one analysis in flight at a time, enforces a
// minimum interval between calls, and holds the most recent result for the
// browser live view to poll.
//
// The sports pipeline's equivalent (LiveEventAnalyzer) batches frames over a
// window because a scoreboard only makes sense as a sequence. Items do not:
// one frame is a complete observation, so this analyzes the newest frame and
// drops the rest.

import { selectedItemsBackend } from "../vision/backends/items-provider.js";

const DEFAULT_INTERVAL_MS = 4_000;

export class ItemAnalyzer {
  #backend;
  #intervalMs;
  #inFlight = false;
  #lastStartedAt = 0;
  #latest = null;
  #latestAt = 0;
  #lastError = null;
  #analyzedCount = 0;
  // Bumped by reset(). A call that was already in flight when the analyzer
  // was reset must not write its result back afterwards.
  #generation = 0;
  // A deliberate still that arrived while another analysis was running. It is
  // held and run next instead of being dropped: a stream frame that loses the
  // race is replaced by the next one in 200ms, a photo someone chose to take
  // is not.
  #pendingForced = null;
  // The last result that came from a deliberate still, kept apart from
  // #latest because stream analyses overwrite that every few seconds.
  #latestPhoto = null;
  // The frame #latest was identified in, image included. The capture ring keeps
  // about four seconds of stream, and a listing is made long after that, so the
  // ring could never supply the listing photo: every listing went out bare.
  #latestFrame = null;

  constructor({ backend = selectedItemsBackend(), intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this.#backend = backend;
    this.#intervalMs = intervalMs;
  }

  reset() {
    this.#generation += 1;
    this.#inFlight = false;
    this.#lastStartedAt = 0;
    this.#latest = null;
    this.#latestAt = 0;
    this.#lastError = null;
    this.#analyzedCount = 0;
    this.#pendingForced = null;
    this.#latestPhoto = null;
    this.#latestFrame = null;
  }

  status() {
    return {
      analysis_in_flight: this.#inFlight,
      interval_ms: this.#intervalMs,
      analyzed_count: this.#analyzedCount,
      has_result: this.#latest != null,
      result_age_ms: this.#latestAt ? Date.now() - this.#latestAt : null,
      last_error: this.#lastError,
    };
  }

  latest() {
    return this.#latest;
  }

  latestFrame() {
    return this.#latestFrame;
  }

  latestPhoto() {
    return this.#latestPhoto;
  }

  // Returns { analysis_status: "analyzed" | "skipped" | "error", ... }. A
  // skipped frame is the normal case — it means a recent result still stands.
  async submit(frame, { force = false } = {}) {
    const now = Date.now();
    if (this.#inFlight) {
      if (force) {
        this.#pendingForced = frame; // newest deliberate still wins
        return { analysis_status: "queued", reason: "analysis_in_flight", items: this.#latest };
      }
      return { analysis_status: "skipped", reason: "analysis_in_flight", items: this.#latest };
    }
    if (!force && now - this.#lastStartedAt < this.#intervalMs) {
      return { analysis_status: "skipped", reason: "interval", items: this.#latest };
    }

    this.#inFlight = true;
    this.#lastStartedAt = now;
    const generation = this.#generation;
    try {
      const result = await this.#backend.identifyItems(frame);
      // A reset landed while this was in flight: the result describes a
      // session the caller already ended, so it is dropped rather than
      // resurrected as the "latest" items.
      if (generation !== this.#generation) {
        return { analysis_status: "stale", reason: "reset_during_analysis", items: null };
      }
      this.#latest = {
        ...result,
        frame_id: frame?.frame_id ?? null,
        frame_source: frame?.source ?? null,
      };
      this.#latestFrame = frame ?? null;
      this.#latestAt = Date.now();
      this.#lastError = null;
      this.#analyzedCount += 1;
      if (frame?.source === "glasses_photo") this.#latestPhoto = this.#latest;
      return { analysis_status: "analyzed", items: this.#latest };
    } catch (err) {
      if (generation !== this.#generation) {
        return { analysis_status: "stale", reason: "reset_during_analysis", items: null };
      }
      this.#lastError = err.message;
      return { analysis_status: "error", error: err.message, items: this.#latest };
    } finally {
      // Only the call that still owns the slot may release it; otherwise a
      // superseded call clears the guard out from under a live one and two
      // model calls run at once.
      if (generation === this.#generation) {
        this.#inFlight = false;
        // Run the still that was waiting, now that the slot is free.
        const next = this.#pendingForced;
        this.#pendingForced = null;
        if (next) this.submit(next, { force: true }).catch(() => {});
      }
    }
  }
}
