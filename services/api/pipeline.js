// Pipeline orchestration: frame -> parsed state -> canonical state ->
// probability -> market -> comparison -> gated presentation (README §7.8–§8).

import { parseFrame } from "../vision/index.js";
import { resolveEvent } from "../vision/resolver.js";
import { Reconciler } from "../vision/reconciler.js";
import { estimate } from "../probability/index.js";
import { marketAdapter } from "../market/index.js";

const MIN_STATE_CONFIDENCE = 0.8;
const MAX_MARKET_AGE_MS = 30_000;

const defaultReconciler = new Reconciler();

// ── Extraction seam ─────────────────────────────────────────────────────────
// Slice 2 (real OCR) replaces the body of this function only: given a live
// frame it should run scoreboard detection + parsing on that frame's image
// instead of reading the fixture. Nothing outside this function changes when
// it lands.
// Until then, live frames flow through the gateway/selector (Slice 4) but the
// parsed scoreboard still comes from the committed fixture, and the returned
// payload marks extraction as "fixture_parse" so nobody mistakes it for OCR.
async function extractState(fixturePath, liveFrame) {
  const { frame, parsed } = await parseFrame(fixturePath);
  if (!liveFrame) return { frame, parsed, extraction: "fixture_parse" };
  return { frame: liveFrame, parsed, extraction: "fixture_parse" };
}

// Default adapter comes from the Slice 5 registry (MARKET_PROVIDER env,
// default "mock"); tests may inject any adapter directly.
// `reconciler` is injectable so callers can scope reconciliation to a session.
// The demo server passes a fresh Reconciler per fixture request: the demo
// fixtures are minutes of game time apart, and §7.5 invariants (max score
// jump per observation) apply to consecutive frames, not across demo moments.
export async function runPipeline(
  fixturePath,
  adapter = marketAdapter,
  liveFrame = null,
  reconciler = defaultReconciler
) {
  const { frame, parsed, extraction } = await extractState(fixturePath, liveFrame);
  const event = resolveEvent(parsed);
  const { state, accepted, reason } = reconciler.observe(event, parsed, frame);

  if (!state) {
    return {
      presentation: {
        status: "no_state",
        short_text: "I can see the game, but the scoreboard is not clear enough yet.",
        reason,
      },
    };
  }

  // Slice 1 convention: estimate the away team's win probability (matches the
  // demo fixture's BOS outcome). The estimated outcome becomes configurable
  // when the UX layer lands.
  const teamId = state.away_team_id;
  const est = estimate(state, teamId);

  // Awaits are no-ops for the sync mock; real adapters are async.
  const marketId = await adapter.find_market(event.event_id, est.outcome);
  const snapshot = await adapter.get_market_snapshot(marketId);

  const gapPts = Number(((est.probability - snapshot.display_probability) * 100).toFixed(1));
  const freshnessMs = Date.now() - Date.parse(snapshot.provider_timestamp);

  const comparison = {
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

  // Confidence and freshness gate (README §7.9): decline to present a precise
  // comparison when inputs are unreliable.
  let status = "ready";
  let shortText;
  if (state.confidence < MIN_STATE_CONFIDENCE) {
    status = "low_confidence";
    shortText = "I can see the game, but the scoreboard is not clear enough yet.";
  } else if (freshnessMs > MAX_MARKET_AGE_MS) {
    status = "stale_market";
    shortText = "Game identified. Current market data is stale, so no comparison is available.";
  } else {
    const team = teamId.slice(4).toUpperCase();
    const dir = comparison.direction === "model_higher" ? "higher" : "lower";
    shortText = `${team} ${Math.round(est.probability * 100)}%. Market ${Math.round(
      snapshot.display_probability * 100
    )}%. Model is ${Math.abs(gapPts)} points ${dir}.`;
  }

  // One complete update through the system (README §8).
  return {
    session_id: "session_slice1",
    source: liveFrame ? "live" : "fixture",
    extraction, // "fixture_parse" until Slice 2's real OCR replaces the seam
    event,
    state: {
      away_score: state.away_score,
      home_score: state.home_score,
      period: state.period,
      clock_seconds: state.clock_seconds,
      confidence: state.confidence,
      observed_at: state.observed_at,
      accepted,
      rejection_reason: reason,
    },
    estimate: { outcome: est.outcome, probability: est.probability, model_version: est.model_version },
    market: {
      provider: snapshot.provider,
      market_id: snapshot.market_id,
      probability: snapshot.display_probability,
      is_mock: snapshot.is_mock,
      provider_timestamp: snapshot.provider_timestamp,
    },
    comparison,
    presentation: {
      status,
      short_text: shortText,
      spoken_text:
        status === "ready"
          ? `${teamId.slice(4)}'s estimated win probability is ${Math.round(
              est.probability * 100
            )} percent. The market is at ${Math.round(snapshot.display_probability * 100)} percent.`
          : shortText,
    },
  };
}
