import { cerebrasBackend } from "../vision/backends/cerebras.js";
import { analyzeUniversalEvent } from "../analytics/cerebras.js";
import {
  analysisFromDemoIntelligence,
  selectDemoIntelligence,
} from "../demo/intelligence.js";

const DEFAULT_INTERVAL_MS = 12_000;
const DEFAULT_BATCH_SIZE = 1;
const WINDOW_MS = 60_000;

function publicFrame(frame) {
  const { image_base64: _image, ...safe } = frame;
  return safe;
}

const UNKNOWN_TEXT = new Set(["", "unknown", "unidentified", "n-a", "na", "none"]);

function normalized(value) {
  const tokens = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const collapsed = [];
  for (let index = 0; index < tokens.length;) {
    if (tokens[index].length !== 1) {
      collapsed.push(tokens[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < tokens.length && tokens[end].length === 1) end += 1;
    const run = tokens.slice(index, end);
    collapsed.push(run.length >= 2 ? run.join("") : run[0]);
    index = end;
  }
  return collapsed.join("-");
}

function known(value) {
  return !UNKNOWN_TEXT.has(normalized(value));
}

function canonicalSport(value) {
  const sport = normalized(value);
  return {
    nba: "basketball",
    "nba-basketball": "basketball",
    nfl: "american-football",
    football: "american-football",
    "nfl-football": "american-football",
    "american-football": "american-football",
    ufc: "mma",
    "ufc-mma": "mma",
    "mixed-martial-arts": "mma",
    "association-football": "soccer",
    hockey: "ice-hockey",
  }[sport] ?? sport;
}

function primaryParticipantPair(observation) {
  const direct = [observation?.participant_a, observation?.participant_b]
    .filter(known)
    .map(normalized);
  const names = direct.length > 0
    ? direct
    : (Array.isArray(observation?.participants) ? observation.participants : [])
      .slice(0, 2)
      .map((participant) => participant?.name)
      .filter(known)
      .map(normalized);
  return names.length >= 2 ? names.slice(0, 2).sort() : null;
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

function samePair(previous, next) {
  const prior = primaryParticipantPair(previous);
  const current = primaryParticipantPair(next);
  return prior && current && prior[0] === current[0] && prior[1] === current[1];
}

function yearsIn(value) {
  return new Set(String(value ?? "").match(/\b(?:19|20)\d{2}\b/g) ?? []);
}

function explicitlyChangedMetadata(previous, next) {
  const previousText = [previous?.competition, previous?.event_name, previous?.event_identity]
    .filter(known)
    .join(" ");
  const nextText = [next?.competition, next?.event_name, next?.event_identity]
    .filter(known)
    .join(" ");
  const priorYears = yearsIn(previousText);
  const nextYears = yearsIn(nextText);
  if (priorYears.size > 0 && nextYears.size > 0 &&
      ![...priorYears].some((year) => nextYears.has(year))) return true;

  if (known(previous?.competition) && known(next?.competition)) {
    const priorCompetition = normalized(previous.competition);
    const nextCompetition = normalized(next.competition);
    if (priorCompetition !== nextCompetition &&
        !priorCompetition.includes(nextCompetition) &&
        !nextCompetition.includes(priorCompetition)) return true;
  }
  return false;
}

export function detectEventSwitch(previous, next) {
  const unchanged = {
    detected: false,
    reset_context: false,
    from_event: eventDescriptor(previous),
    to_event: eventDescriptor(next),
    reason: previous ? "same_or_unresolved_event" : "first_observation",
  };
  if (!previous || !next) return unchanged;
  const confident = Number(next.confidence ?? 0) >= 0.55;
  const changed = (reason) => ({
    ...unchanged,
    detected: confident,
    reset_context: true,
    reason: confident ? reason : `low_confidence_${reason}`,
  });

  const previousSport = canonicalSport(previous.sport);
  const nextSport = canonicalSport(next.sport);
  if (known(previousSport) && known(nextSport) && previousSport !== nextSport) {
    return changed("sport_changed");
  }

  const previousIdentity = normalized(previous.event_identity);
  const nextIdentity = normalized(next.event_identity);
  const sameIdentity = known(previousIdentity) && previousIdentity === nextIdentity;

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

  const previousPair = primaryParticipantPair(previous);
  const nextPair = primaryParticipantPair(next);
  if (previousPair && nextPair) {
    if (samePair(previous, next)) {
      return explicitlyChangedMetadata(previous, next)
        ? changed("event_metadata_changed")
        : { ...unchanged, reason: "stable_participant_pair" };
    }
    return changed("participant_pair_changed");
  }

  if (sameIdentity) return { ...unchanged, reason: "stable_event_identity" };

  const sameEventName =
    known(previous.event_name) && normalized(previous.event_name) === normalized(next.event_name);
  if (sameEventName) return { ...unchanged, reason: "same_event_name" };

  if (known(previousIdentity) && known(nextIdentity) && previousIdentity !== nextIdentity) {
    return changed("event_identity_changed");
  }

  if (
    previousSport === nextSport &&
    known(previous.event_name) &&
    known(next.event_name) &&
    normalized(previous.event_name) !== normalized(next.event_name)
  ) {
    return changed("event_name_changed");
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
    enrichExactDemo = process.env.CEREBRAS_EXACT_DEMO_ENRICHMENT === "true",
  } = {}) {
    if (!visionBackend || typeof visionBackend.extractEventBatch !== "function") {
      throw new Error("LiveEventAnalyzer requires visionBackend.extractEventBatch(frames)");
    }
    this.visionBackend = visionBackend;
    this.analyze = analyze;
    this.now = now;
    this.intervalMs = Math.max(DEFAULT_INTERVAL_MS, intervalMs);
    this.batchSize = Math.max(1, Math.min(5, batchSize));
    this.enrichExactDemo = enrichExactDemo === true;
    this.pendingFrames = [];
    this.latestInsight = null;
    this.lastCallAt = null;
    this.inFlight = null;
    this.visionCalls = [];
    this.analyticsCalls = [];
    this.generation = 0;
  }

  async submit(frame, { force = false } = {}) {
    this.pendingFrames.push(frame);
    if (this.pendingFrames.length > this.batchSize) this.pendingFrames.shift();

    const cooldownMs = this.#cooldownMs();
    const hasFullWindow = this.pendingFrames.length >= this.batchSize;
    const fastCameraSource = new Set(["phone_live", "phone_photo", "ios_app", "rayban_sdk", "webrtc_viewer"])
      .has(frame?.source);
    const firstDetection = fastCameraSource && this.lastCallAt == null && this.latestInsight == null;
    if (this.inFlight || cooldownMs > 0 || (!force && !firstDetection && !hasFullWindow)) {
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

    const callGeneration = this.generation;
    const runPromise = this.#runBatch(batch, callStartedAt, callGeneration);
    this.inFlight = runPromise;
    let insight;
    try {
      insight = await runPromise;
    } finally {
      if (this.inFlight === runPromise) this.inFlight = null;
    }
    if (callGeneration !== this.generation) {
      return { analysis_status: "discarded", insight: this.latestInsight, queue: this.status() };
    }
    this.latestInsight = insight;
    insight.rate_limit = this.status();
    return { analysis_status: "analyzed", insight, queue: this.status() };
  }

  async #runBatch(frames, callStartedAt, callGeneration) {
    const observation = await this.visionBackend.extractEventBatch(frames);
    if (callGeneration !== this.generation) return null;
    const previousObservation = this.latestInsight?.observation ?? null;
    const eventSwitch = detectEventSwitch(previousObservation, observation);
    const resetContext = eventSwitch.reset_context === true || eventSwitch.detected;
    const demoIntelligence = selectDemoIntelligence(observation, {
      previous: resetContext ? null : this.latestInsight?.demo_intelligence ?? null,
    });
    let modelAnalysis = null;
    let analyticsError = null;
    const exactReady = demoIntelligence?.mode === "precollected_event_replay";
    const checkpointPending = demoIntelligence?.mode === "precollected_event_pending";
    const shouldAnalyze = !checkpointPending && (!exactReady || this.enrichExactDemo);
    const analyticsSkipReason = shouldAnalyze
      ? null
      : exactReady
        ? "exact_deterministic_pack"
        : "checkpoint_pending";
    if (shouldAnalyze) {
      try {
        modelAnalysis = await this.analyze({
          observation,
          previous_observation: resetContext ? null : previousObservation,
          previous_analysis: resetContext ? null : this.latestInsight?.analysis ?? null,
          event_switch: eventSwitch,
          precollected_intelligence: demoIntelligence,
          frame_count: frames.length,
          captured_from: frames[0].captured_at,
          captured_to: frames.at(-1).captured_at,
        });
        if (modelAnalysis && callGeneration === this.generation) {
          this.analyticsCalls.push(callStartedAt);
        }
      } catch (err) {
        analyticsError = err.message;
      }
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
      diagnostics: {
        analytics_error: analyticsError,
        analytics_skipped: !shouldAnalyze,
        analytics_skip_reason: analyticsSkipReason,
      },
      presentation: {
        status: demoIntelligence?.mode === "precollected_event_pending"
          ? "checkpoint_pending"
          : eventSwitch.detected ? "event_switched" : analysis ? "ready" : "vision_only",
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
    this.generation += 1;
    this.pendingFrames = [];
    this.latestInsight = null;
    this.lastCallAt = null;
    this.inFlight = null;
    this.visionCalls = [];
    this.analyticsCalls = [];
  }
}
