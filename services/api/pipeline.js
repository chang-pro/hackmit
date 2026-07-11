// Camera-to-insight orchestration. A live frame is parsed by a configured
// structured-vision backend, normalized, reconciled over time, converted into
// a win probability, and compared with a market when a matching contract is
// available.

import { extractScoreboard, liveBackendName, parseFrame } from "../vision/index.js";
import { resolveEvent } from "../vision/resolver.js";
import { Reconciler } from "../vision/reconciler.js";
import { estimate } from "../probability/index.js";
import { marketAdapter } from "../market/index.js";
import { analyzeGameContext } from "../analytics/cerebras.js";

const MIN_STATE_CONFIDENCE = 0.8;
const MAX_MARKET_AGE_MS = 30_000;

const fixtureReconciler = new Reconciler();
const liveReconciler = new Reconciler();

function backendLabel(backend) {
  return typeof backend === "string" ? backend : backend?.name ?? "custom";
}

async function marketSnapshot(adapter, eventId, outcome) {
  try {
    const marketId = await adapter.find_market(eventId, outcome);
    return { snapshot: await adapter.get_market_snapshot(marketId), error: null };
  } catch (err) {
    return { snapshot: null, error: err.message };
  }
}

async function buildInsight({
  frame,
  parsed,
  extraction,
  source,
  adapter,
  reconciler,
  sessionId,
}) {
  let event;
  try {
    event = resolveEvent(parsed, frame.captured_at);
  } catch (err) {
    return {
      session_id: sessionId,
      source,
      extraction,
      frame: publicFrame(frame),
      parsed_scoreboard: parsed,
      presentation: {
        status: "unresolved_event",
        short_text: "I can read part of the scoreboard, but I cannot identify the NBA matchup yet.",
        reason: err.message,
      },
    };
  }

  const { state, accepted, reason } = reconciler.observe(event, parsed, frame);
  if (!state || state.event_id !== event.event_id) {
    return {
      session_id: sessionId,
      source,
      extraction,
      frame: publicFrame(frame),
      event,
      parsed_scoreboard: parsed,
      presentation: {
        status: "no_state",
        short_text: "I can see the game, but the scoreboard is not clear enough yet.",
        reason,
      },
    };
  }

  const teamId = state.away_team_id;
  const est = estimate(state, teamId);
  const { snapshot, error: marketError } = await marketSnapshot(adapter, event.event_id, est.outcome);

  let market = null;
  let comparison = null;
  if (snapshot) {
    const gapPts = Number(((est.probability - snapshot.display_probability) * 100).toFixed(1));
    const freshnessMs = Date.now() - Date.parse(snapshot.provider_timestamp);
    market = {
      provider: snapshot.provider,
      market_id: snapshot.market_id,
      probability: snapshot.display_probability,
      is_mock: snapshot.is_mock,
      provider_timestamp: snapshot.provider_timestamp,
    };
    comparison = {
      event_id: event.event_id,
      outcome: est.outcome,
      model_probability: est.probability,
      market_probability: snapshot.display_probability,
      gap_percentage_points: gapPts,
      direction: gapPts > 0 ? "model_higher" : gapPts < 0 ? "model_lower" : "aligned",
      state_confidence: state.confidence,
      freshness_ms: freshnessMs,
      generated_at: new Date().toISOString(),
    };
  }

  let analytics = null;
  let analyticsError = null;
  if (extraction === "cerebras") {
    try {
      analytics = await analyzeGameContext({
        event,
        game_state: {
          away_team_id: state.away_team_id,
          home_team_id: state.home_team_id,
          away_score: state.away_score,
          home_score: state.home_score,
          period: state.period,
          clock_seconds: state.clock_seconds,
        },
        baseline_outcome: est.outcome,
        baseline_probability: est.probability,
        state_confidence: state.confidence,
        market,
        comparison,
      });
    } catch (err) {
      analyticsError = err.message;
    }
  }

  const team = teamId.slice(4).toUpperCase();
  let status = "ready";
  let shortText;
  if (state.confidence < MIN_STATE_CONFIDENCE) {
    status = "low_confidence";
    shortText = "I can see the game, but the scoreboard is not clear enough yet.";
  } else if (!comparison) {
    status = "market_unavailable";
    shortText = `${team} model estimate ${Math.round(est.probability * 100)}%. No matching market is available.`;
  } else if (comparison.freshness_ms > MAX_MARKET_AGE_MS) {
    status = "stale_market";
    shortText = "Game identified. Current market data is stale, so no comparison is available.";
  } else {
    const direction = comparison.direction === "model_higher" ? "higher" : "lower";
    shortText = `${team} ${Math.round(est.probability * 100)}%. Market ${Math.round(
      comparison.market_probability * 100
    )}%. Model is ${Math.abs(comparison.gap_percentage_points)} points ${direction}.`;
  }

  return {
    session_id: sessionId,
    source,
    extraction,
    frame: publicFrame(frame),
    event,
    parsed_scoreboard: parsed,
    state: {
      away_team_id: state.away_team_id,
      home_team_id: state.home_team_id,
      away_score: state.away_score,
      home_score: state.home_score,
      period: state.period,
      clock_seconds: state.clock_seconds,
      confidence: state.confidence,
      observed_at: state.observed_at,
      accepted,
      rejection_reason: reason,
    },
    estimate: {
      outcome: est.outcome,
      probability: est.probability,
      model_version: est.model_version,
      confidence: est.confidence,
    },
    analytics,
    market,
    comparison,
    diagnostics: { market_error: marketError, analytics_error: analyticsError },
    presentation: {
      status,
      short_text: shortText,
      analyst_text: analytics?.summary ?? null,
      spoken_text:
        comparison && status === "ready"
          ? `${team}'s estimated win probability is ${Math.round(
              est.probability * 100
            )} percent. The market is at ${Math.round(comparison.market_probability * 100)} percent.`
          : shortText,
    },
  };
}

function publicFrame(frame) {
  const { image_base64: _image, fixture_path: _fixture, ...safe } = frame;
  return safe;
}

export async function runFramePipeline(
  frame,
  {
    adapter = marketAdapter,
    visionBackend = liveBackendName(),
    reconciler = liveReconciler,
    sessionId = "session_phone",
  } = {}
) {
  const parsed = await extractScoreboard(frame, visionBackend);
  return buildInsight({
    frame,
    parsed,
    extraction: backendLabel(visionBackend),
    source: "live",
    adapter,
    reconciler,
    sessionId,
  });
}

// Backward-compatible fixture entry point used by the deterministic demo and
// existing tests. Passing liveFrame delegates to the real camera pipeline.
export async function runPipeline(
  fixturePath,
  adapter = marketAdapter,
  liveFrame = null,
  options = {}
) {
  // Slice 5/6 callers passed a Reconciler directly as the fourth argument.
  // Keep that contract while also supporting the newer options object.
  const legacyReconciler = typeof options?.observe === "function" ? options : null;
  if (liveFrame) {
    return runFramePipeline(liveFrame, {
      adapter,
      visionBackend: options.visionBackend ?? liveBackendName(),
      reconciler: legacyReconciler ?? options.reconciler ?? liveReconciler,
      sessionId: options.sessionId ?? "session_phone",
    });
  }
  const { frame, parsed } = await parseFrame(fixturePath);
  return buildInsight({
    frame,
    parsed,
    extraction: "fixture",
    source: "fixture",
    adapter,
    reconciler: legacyReconciler ?? options.reconciler ?? fixtureReconciler,
    sessionId: options.sessionId ?? "session_fixture",
  });
}

export function resetLivePipeline() {
  liveReconciler.reset();
}
