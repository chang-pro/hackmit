// Probability engine (README §7.6) — deterministic baseline, v1.
// Brownian-motion win-probability model (Stern 1994): the remaining scoring
// margin is treated as normal with sd proportional to sqrt(seconds left),
// plus a drift term for pregame strength (default: a small home-court edge).
// Consumes CanonicalGameState only — never image pixels. Small, explainable,
// and bounded by design. Constants and assumptions are recorded in
// models/metadata/nba-win-probability-v1.json.

import { phi, probit, clampProbability } from "./models/gaussian.js";

export const MODEL_VERSION = "nba-win-probability-v1";

const PERIOD_SECONDS = 720; // regulation period: 12 minutes
const OT_PERIOD_SECONDS = 300; // NBA overtime period: 5 minutes
const REGULATION_SECONDS = 4 * PERIOD_SECONDS;
const FULL_GAME_MARGIN_SD = 11.5; // full-game margin sd ≈ 11.5 pts
const SIGMA_PER_SQRT_SEC = FULL_GAME_MARGIN_SD / Math.sqrt(REGULATION_SECONDS);
const HOME_EDGE_POINTS = 2.5; // full-game home-court advantage
const POSSESSION_POINTS = 0.6; // having the ball ≈ +0.6 pts of expected margin

// Seconds of game time left before the next tie-or-win decision point.
// Regulation (period 1–4): remaining regulation time. Overtime (period >= 5):
// only the current 5-minute OT period remains — a tie at 0:00 rolls into the
// tie branch below, exactly like a tie at the end of regulation.
// Out-of-range clocks (e.g. OCR noise reporting 6:12 in OT) are clamped into
// [0, period length] rather than thrown: plausibility checks belong to the
// state reconciler (§7.5); the engine stays total and deterministic.
function secondsRemaining(state) {
  const isOvertime = state.period >= 5;
  const periodLength = isOvertime ? OT_PERIOD_SECONDS : PERIOD_SECONDS;
  const clock = Math.min(periodLength, Math.max(0, state.clock_seconds));
  const periodsLeft = isOvertime ? 0 : 4 - state.period;
  return periodsLeft * PERIOD_SECONDS + clock;
}

// phi / probit / clamp now live in models/gaussian.js so sibling sport models
// (e.g. the NFL Brownian model) share the exact same approximations.
const clamp = clampProbability;

// Probability that `teamId` wins, given canonical state.
//
// options.pregameProbability — optional pregame win probability for `teamId`,
//   strictly in (0, 1). Converted to an equivalent full-game point spread via
//   probit(p) * FULL_GAME_MARGIN_SD and applied as a drift that scales with
//   the fraction of the game remaining — exactly like the home edge, which it
//   REPLACES when provided (a market- or rating-derived prior already prices
//   in the venue). The effect decays to zero as time expires: late-game score
//   and clock dominate any pregame opinion.
//
// options.includePossession — OFF by default (README §7.6: add possession
//   only if reliably extracted). When true AND state.possession_team_id is
//   non-null, the ball is worth POSSESSION_POINTS of margin (+ for the team
//   with possession, − for its opponent).
export function winProbability(state, teamId, options = {}) {
  if (teamId !== state.away_team_id && teamId !== state.home_team_id)
    throw new Error(`Team ${teamId} is not in event ${state.event_id}`);

  const isHome = teamId === state.home_team_id;
  const teamScore = isHome ? state.home_score : state.away_score;
  const oppScore = isHome ? state.away_score : state.home_score;
  const margin = teamScore - oppScore;
  const secs = secondsRemaining(state);

  // Full-game drift in points: pregame prior when given, else home edge.
  const prior = options.pregameProbability;
  let fullGameDriftPoints;
  if (prior === undefined || prior === null) {
    fullGameDriftPoints = HOME_EDGE_POINTS * (isHome ? 1 : -1);
  } else {
    if (typeof prior !== "number" || !Number.isFinite(prior) || prior <= 0 || prior >= 1)
      throw new Error(`pregameProbability must be strictly between 0 and 1, got ${prior}`);
    fullGameDriftPoints = probit(prior) * FULL_GAME_MARGIN_SD;
  }

  if (secs <= 0) {
    // Period expired: decided games are (near-)certain; ties head to (another)
    // overtime at roughly the pregame prior, shrunk to a small edge.
    if (margin !== 0) return clamp(margin > 0 ? 1 : 0);
    return clamp(0.5 + fullGameDriftPoints / 100);
  }

  let adjustedMargin = margin;
  if (options.includePossession === true && state.possession_team_id != null) {
    const opponentId = isHome ? state.away_team_id : state.home_team_id;
    if (state.possession_team_id === teamId) adjustedMargin += POSSESSION_POINTS;
    else if (state.possession_team_id === opponentId) adjustedMargin -= POSSESSION_POINTS;
    // A possession id matching neither team is ignored — reconciler noise.
  }

  const drift = fullGameDriftPoints * (secs / REGULATION_SECONDS);
  const sigma = SIGMA_PER_SQRT_SEC * Math.sqrt(secs);
  return clamp(phi((adjustedMargin + drift) / sigma));
}

// Full ProbabilityEstimate contract (README §7.6).
export function estimate(state, teamId, options = {}) {
  return {
    event_id: state.event_id,
    outcome: `${teamId}_wins`,
    probability: Number(winProbability(state, teamId, options).toFixed(4)),
    model_version: MODEL_VERSION,
    computed_at: new Date().toISOString(),
    input_state_observed_at: state.observed_at,
    confidence: state.confidence,
  };
}
