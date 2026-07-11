// NFL win-probability model — same Brownian/Stern approach as the NBA model
// in services/probability/index.js, with NFL constants: four 15-minute
// quarters (clock counts down), full-game margin SD ~13.5 points, home edge
// ~2.0 points, 10-minute overtime periods. Shares phi/probit with every other
// gaussian model via models/gaussian.js.

import { phi, probit, clampProbability, assertPrior, assertSubject } from "./gaussian.js";

export const MODEL_VERSION = "nfl-win-probability-v1";

const PERIOD_SECONDS = 900; // 15-minute quarter
const OT_PERIOD_SECONDS = 600; // NFL overtime: 10 minutes
const REGULATION_SECONDS = 4 * PERIOD_SECONDS;
const FULL_GAME_MARGIN_SD = 13.5; // full-game margin sd ≈ 13.5 pts
const SIGMA_PER_SQRT_SEC = FULL_GAME_MARGIN_SD / Math.sqrt(REGULATION_SECONDS);
const HOME_EDGE_POINTS = 2.0; // full-game home-field advantage

// Seconds left before the next decided-or-tied point, mirroring the NBA
// model: regulation periods 1–4, overtime period >= 5 leaves only the current
// OT clock. Out-of-range clocks are clamped, never thrown (§7.5 owns
// plausibility).
function secondsRemaining(state) {
  const isOvertime = state.period >= 5;
  const periodLength = isOvertime ? OT_PERIOD_SECONDS : PERIOD_SECONDS;
  const clock = Math.min(periodLength, Math.max(0, state.clock_seconds));
  const periodsLeft = isOvertime ? 0 : 4 - state.period;
  return periodsLeft * PERIOD_SECONDS + clock;
}

// P(`subjectId` wins). options.pregameProbability replaces the home edge with
// a prior-derived drift (same semantics as the NBA model): the effect decays
// linearly with time remaining, so the late-game score dominates any opinion.
export function winProbability(state, subjectId, options = {}) {
  assertSubject(state, subjectId);
  const isHome = subjectId === state.home_team_id;
  const subjectScore = isHome ? state.home_score : state.away_score;
  const oppScore = isHome ? state.away_score : state.home_score;
  const margin = subjectScore - oppScore;
  const secs = secondsRemaining(state);

  const prior = options.pregameProbability;
  let fullGameDriftPoints;
  if (prior === undefined || prior === null) {
    fullGameDriftPoints = HOME_EDGE_POINTS * (isHome ? 1 : -1);
  } else {
    assertPrior(prior);
    fullGameDriftPoints = probit(prior) * FULL_GAME_MARGIN_SD;
  }

  if (secs <= 0) {
    if (margin !== 0) return clampProbability(margin > 0 ? 1 : 0);
    return clampProbability(0.5 + fullGameDriftPoints / 100);
  }

  const drift = fullGameDriftPoints * (secs / REGULATION_SECONDS);
  const sigma = SIGMA_PER_SQRT_SEC * Math.sqrt(secs);
  return clampProbability(phi((margin + drift) / sigma));
}
