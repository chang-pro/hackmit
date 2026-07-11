import { cerebrasBackend } from "../vision/backends/cerebras.js";
import { analyzeUniversalEvent } from "../analytics/cerebras.js";

const DEFAULT_INTERVAL_MS = 12_000;
const DEFAULT_BATCH_SIZE = 5;
const WINDOW_MS = 60_000;

function publicFrame(frame) {
  const { image_base64: _image, ...safe } = frame;
  return safe;
}

export class LiveEventAnalyzer {
  constructor({
    visionBackend = cerebrasBackend,
    analyze = analyzeUniversalEvent,
    now = Date.now,
    intervalMs = Number(process.env.CEREBRAS_MODEL_INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
    batchSize = Number(process.env.CEREBRAS_FRAMES_PER_REQUEST ?? DEFAULT_BATCH_SIZE),
  } = {}) {
    if (!visionBackend || typeof visionBackend.extractEventBatch !== "function") {
      throw new Error("LiveEventAnalyzer requires visionBackend.extractEventBatch(frames)");
    }
    this.visionBackend = visionBackend;
    this.analyze = analyze;
    this.now = now;
    this.intervalMs = Math.max(DEFAULT_INTERVAL_MS, intervalMs);
    this.batchSize = Math.max(1, Math.min(5, batchSize));
    this.pendingFrames = [];
    this.latestInsight = null;
    this.lastCallAt = null;
    this.inFlight = null;
    this.visionCalls = [];
    this.analyticsCalls = [];
  }

  async submit(frame, { force = false } = {}) {
    this.pendingFrames.push(frame);
    if (this.pendingFrames.length > this.batchSize) this.pendingFrames.shift();

    const cooldownMs = this.#cooldownMs();
    const hasFullWindow = this.pendingFrames.length >= this.batchSize;
    if (this.inFlight || cooldownMs > 0 || (!force && !hasFullWindow)) {
      return {
        analysis_status: this.inFlight ? "in_flight" : "queued",
        insight: this.latestInsight,
        queue: this.status(),
      };
    }

    const batch = this.pendingFrames.splice(-this.batchSize);
    this.pendingFrames = [];
    const callStartedAt = this.now();
    this.lastCallAt = callStartedAt;
    this.visionCalls.push(callStartedAt);

    this.inFlight = this.#runBatch(batch, callStartedAt);
    let insight;
    try {
      insight = await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    this.latestInsight = insight;
    insight.rate_limit = this.status();
    return { analysis_status: "analyzed", insight, queue: this.status() };
  }

  async #runBatch(frames, callStartedAt) {
    const observation = await this.visionBackend.extractEventBatch(frames);
    let analysis = null;
    let analyticsError = null;
    try {
      analysis = await this.analyze({
        observation,
        previous_analysis: this.latestInsight?.analysis ?? null,
        frame_count: frames.length,
        captured_from: frames[0].captured_at,
        captured_to: frames.at(-1).captured_at,
      });
      if (analysis) this.analyticsCalls.push(callStartedAt);
    } catch (err) {
      analyticsError = err.message;
    }

    const eventLabel = observation.event_name ||
      `${observation.participant_a} vs ${observation.participant_b}`;
    const stateText = [observation.score_display, observation.phase, observation.clock]
      .filter(Boolean)
      .join(" · ");
    const shortText = analysis
      ? `${analysis.event_summary} ${analysis.primary_outcome}: ${Math.round(
          analysis.primary_probability * 100
        )}%.`
      : `${eventLabel}${stateText ? ` — ${stateText}` : ""}`;

    return {
      session_id: "session_phone",
      source: "live",
      extraction: `${this.visionBackend.name ?? "vision"}-batch`,
      frame_window: {
        count: frames.length,
        first_captured_at: frames[0].captured_at,
        last_captured_at: frames.at(-1).captured_at,
        frames: frames.map(publicFrame),
      },
      observation,
      analysis,
      diagnostics: { analytics_error: analyticsError },
      presentation: {
        status: analysis ? "ready" : "vision_only",
        short_text: shortText,
        spoken_text: analysis?.event_summary ?? shortText,
      },
      rate_limit: this.status(),
    };
  }

  #cooldownMs() {
    if (this.lastCallAt == null) return 0;
    return Math.max(0, this.intervalMs - (this.now() - this.lastCallAt));
  }

  #trimCalls() {
    const cutoff = this.now() - WINDOW_MS;
    this.visionCalls = this.visionCalls.filter((time) => time > cutoff);
    this.analyticsCalls = this.analyticsCalls.filter((time) => time > cutoff);
  }

  status() {
    this.#trimCalls();
    return {
      pending_frames: this.pendingFrames.length,
      frames_per_request: this.batchSize,
      model_interval_ms: this.intervalMs,
      next_analysis_ms: this.#cooldownMs(),
      analysis_in_flight: Boolean(this.inFlight),
      calls_last_minute: {
        vision: this.visionCalls.length,
        analytics: this.analyticsCalls.length,
      },
    };
  }

  reset() {
    this.pendingFrames = [];
    this.latestInsight = null;
    this.lastCallAt = null;
    this.inFlight = null;
    this.visionCalls = [];
    this.analyticsCalls = [];
  }
}
