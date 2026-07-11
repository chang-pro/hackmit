import { cerebrasBackend } from "../vision/backends/cerebras.js";
import { analyzeUniversalEvent } from "../analytics/cerebras.js";
import {
  analysisFromDemoIntelligence,
  selectDemoIntelligence,
} from "../demo/intelligence.js";

const DEFAULT_INTERVAL_MS = 12_000;
const DEFAULT_BATCH_SIZE = 5;
const WINDOW_MS = 60_000;

function publicFrame(frame) {
  const { image_base64: _image, ...safe } = frame;
  return safe;
}

const UNKNOWN_TEXT = new Set(["", "unknown", "unidentified", "n-a", "na", "none"]);

function normalized(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function known(value) {
  return !UNKNOWN_TEXT.has(normalized(value));
}

function canonicalSport(value) {
  const sport = normalized(value);
  return {
    nba: "basketball",
    nfl: "american-football",
    football: "american-football",
    ufc: "mma",
    hockey: "ice-hockey",
  }[sport] ?? sport;
}

function participantNames(observation) {
  const names = [
    ...(Array.isArray(observation?.participants)
      ? observation.participants.map((participant) => participant?.name)
      : []),
    observation?.participant_a,
    observation?.participant_b,
  ];
  return new Set(names.filter(known).map(normalized));
}

function eventDescriptor(observation) {
  if (!observation) return null;
  return {
    event_identity: observation.event_identity || observation.event_name || "UNKNOWN",
    sport: observation.sport || "unknown",
    competition: observation.competition || "UNKNOWN",
    event_name: observation.event_name || "UNKNOWN",
  };
}

function hasParticipantOverlap(previous, next) {
  const previousNames = participantNames(previous);
  return [...participantNames(next)].some((name) => previousNames.has(name));
}

export function detectEventSwitch(previous, next) {
  const unchanged = {
    detected: false,
    from_event: eventDescriptor(previous),
    to_event: eventDescriptor(next),
    reason: previous ? "same_or_unresolved_event" : "first_observation",
  };
  if (!previous || !next || Number(next.confidence ?? 0) < 0.55) return unchanged;

  const previousSport = canonicalSport(previous.sport);
  const nextSport = canonicalSport(next.sport);
  if (known(previousSport) && known(nextSport) && previousSport !== nextSport) {
    return { ...unchanged, detected: true, reason: "sport_changed" };
  }

  const previousIdentity = normalized(previous.event_identity);
  const nextIdentity = normalized(next.event_identity);
  const sameIdentity = known(previousIdentity) && previousIdentity === nextIdentity;
  if (sameIdentity) return { ...unchanged, reason: "stable_event_identity" };

  const sameEventName =
    known(previous.event_name) && normalized(previous.event_name) === normalized(next.event_name);
  if (sameEventName) return { ...unchanged, reason: "same_event_name" };

  if (known(previousIdentity) && known(nextIdentity) && previousIdentity !== nextIdentity) {
    return { ...unchanged, detected: true, reason: "event_identity_changed" };
  }

  const sameCompetition =
    known(previous.competition) &&
    normalized(previous.competition) === normalized(next.competition);
  const persistentFormat = new Set(["tournament", "leaderboard", "race"]);
  if (
    sameCompetition &&
    (persistentFormat.has(normalized(previous.event_format).replaceAll("-", "_")) ||
      persistentFormat.has(normalized(next.event_format).replaceAll("-", "_")))
  ) {
    return { ...unchanged, reason: "same_competition_session" };
  }

  if (hasParticipantOverlap(previous, next)) {
    return { ...unchanged, reason: "participant_overlap" };
  }

  if (
    previousSport === nextSport &&
    known(previous.event_name) &&
    known(next.event_name) &&
    normalized(previous.event_name) !== normalized(next.event_name)
  ) {
    return { ...unchanged, detected: true, reason: "event_name_changed" };
  }

  return unchanged;
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
    const previousObservation = this.latestInsight?.observation ?? null;
    const eventSwitch = detectEventSwitch(previousObservation, observation);
    const demoIntelligence = selectDemoIntelligence(observation, {
      previous: eventSwitch.detected ? null : this.latestInsight?.demo_intelligence ?? null,
    });
    let modelAnalysis = null;
    let analyticsError = null;
    try {
      modelAnalysis = await this.analyze({
        observation,
        previous_observation: eventSwitch.detected ? null : previousObservation,
        previous_analysis: eventSwitch.detected ? null : this.latestInsight?.analysis ?? null,
        event_switch: eventSwitch,
        precollected_intelligence: demoIntelligence,
        frame_count: frames.length,
        captured_from: frames[0].captured_at,
        captured_to: frames.at(-1).captured_at,
      });
      if (modelAnalysis) this.analyticsCalls.push(callStartedAt);
    } catch (err) {
      analyticsError = err.message;
    }
    const analysis = analysisFromDemoIntelligence(demoIntelligence, modelAnalysis);

    const eventLabel = observation.event_name ||
      `${observation.participant_a} vs ${observation.participant_b}`;
    const stateText = [observation.score_display, observation.phase, observation.clock]
      .filter(Boolean)
      .join(" · ");
    const resultText = analysis
      ? `${analysis.event_summary} ${analysis.primary_outcome}: ${Math.round(
          analysis.primary_probability * 100
        )}%.`
      : `${eventLabel}${stateText ? ` — ${stateText}` : ""}`;
    const shortText = eventSwitch.detected
      ? `Switched to ${observation.sport || "a new event"}. ${resultText}`
      : resultText;

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
      event_switch: eventSwitch,
      demo_intelligence: demoIntelligence,
      market: demoIntelligence?.mode === "precollected_event_replay"
        ? {
            provider: demoIntelligence.market.provider,
            probability: demoIntelligence.market.market_probability,
            is_mock: demoIntelligence.market.is_mock,
            question: demoIntelligence.market.question,
            outcome: demoIntelligence.market.outcome,
          }
        : null,
      comparison: demoIntelligence?.mode === "precollected_event_replay"
        ? {
            model_probability: demoIntelligence.market.model_probability,
            market_probability: demoIntelligence.market.market_probability,
            gap_percentage_points: demoIntelligence.market.gap_percentage_points,
            direction: demoIntelligence.market.gap_percentage_points > 0
              ? "model_higher"
              : demoIntelligence.market.gap_percentage_points < 0
                ? "model_lower"
                : "aligned",
            confidence: demoIntelligence.confidence,
          }
        : null,
      analysis,
      diagnostics: { analytics_error: analyticsError },
      presentation: {
        status: eventSwitch.detected ? "event_switched" : analysis ? "ready" : "vision_only",
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
