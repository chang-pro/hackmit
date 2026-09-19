// Live item analyzer. Frames arrive far faster than a vision model should be
// billed for, so this keeps one analysis in flight at a time, enforces a
// minimum interval between calls, and holds the most recent result for the
// browser live view to poll.
//
// The sports pipeline's equivalent (LiveEventAnalyzer) batches frames over a
// window because a scoreboard only makes sense as a sequence. Items do not:
// one frame is a complete observation, so this analyzes the newest frame and
// drops the rest.

import { rightcodesItemsBackend } from "../vision/backends/rightcodes-items.js";

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

  constructor({ backend = rightcodesItemsBackend, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this.#backend = backend;
    this.#intervalMs = intervalMs;
  }

  reset() {
    this.#inFlight = false;
    this.#lastStartedAt = 0;
    this.#latest = null;
    this.#latestAt = 0;
    this.#lastError = null;
    this.#analyzedCount = 0;
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

  // Returns { analysis_status: "analyzed" | "skipped" | "error", ... }. A
  // skipped frame is the normal case — it means a recent result still stands.
  async submit(frame, { force = false } = {}) {
    const now = Date.now();
    if (this.#inFlight) {
      return { analysis_status: "skipped", reason: "analysis_in_flight", items: this.#latest };
    }
    if (!force && now - this.#lastStartedAt < this.#intervalMs) {
      return { analysis_status: "skipped", reason: "interval", items: this.#latest };
    }

    this.#inFlight = true;
    this.#lastStartedAt = now;
    try {
      const result = await this.#backend.identifyItems(frame);
      this.#latest = { ...result, frame_id: frame?.frame_id ?? null };
      this.#latestAt = Date.now();
      this.#lastError = null;
      this.#analyzedCount += 1;
      return { analysis_status: "analyzed", items: this.#latest };
    } catch (err) {
      this.#lastError = err.message;
      return { analysis_status: "error", error: err.message, items: this.#latest };
    } finally {
      this.#inFlight = false;
    }
  }
}
