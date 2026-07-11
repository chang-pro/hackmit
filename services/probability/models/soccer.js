// Soccer win-probability model — Poisson goals baseline.
//
// Remaining goals for each side are modeled as independent Poisson counts
// whose rates scale linearly with the minutes left. League-average total is
// ~2.7 goals per 90 minutes, split with a home edge (home 1.5 / away 1.2).
// P(team wins) sums the joint Poisson pmf over final-score outcomes where the
// team finishes ahead. A draw is NOT a win: P(win) + P(lose) + P(draw) = 1,
// so the two teams' win probabilities do not complement each other.
//
// Scope decisions (documented, honest):
// - The clock counts UP. `state.extras.minute` is the elapsed match minute
//   (0–90+, stoppage minutes exceed 90; extra time runs to 120).
// - Once the displayed minute reaches the period total (90, or 120 in extra
//   time), one nominal minute remains: a broadcast still showing a running
//   clock is in stoppage, and we never claim the match is over from a clock.
// - "Wins" means wins in open play through the end of the visible match
//   (90 or 120 minutes). A penalty shootout after a 120' draw is NOT counted
//   as a win here — a market that settles shootouts as wins will price the
//   same event higher; that gap is real and worth showing, not hiding.

import { clampProbability, assertSubject } from "./gaussian.js";

export const MODEL_VERSION = "soccer-win-probability-v1";

const REGULATION_MINUTES = 90;
const EXTRA_TIME_MINUTES = 120;
const HOME_GOALS_PER_90 = 1.5; // home share of the ~2.7 total (home edge)
const AWAY_GOALS_PER_90 = 1.2;
const STOPPAGE_FLOOR_MINUTES = 1; // running clock at/past the total => 1 min left
const MAX_GOALS = 10; // truncation for the Poisson sums (tail < 1e-9 at these rates)

function poissonPmfTable(lambda, maxK) {
  const table = new Array(maxK + 1);
  table[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxK; k += 1) table[k] = (table[k - 1] * lambda) / k;
  return table;
}

// Elapsed minute -> minutes of play left. Period >= 3 means extra time.
function minutesRemaining(state) {
  const minute = state.extras?.minute;
  if (typeof minute !== "number" || !Number.isFinite(minute) || minute < 0) {
    throw new Error(`soccer model requires state.extras.minute, got ${JSON.stringify(minute)}`);
  }
  const total = state.period >= 3 ? EXTRA_TIME_MINUTES : REGULATION_MINUTES;
  return Math.max(STOPPAGE_FLOOR_MINUTES, total - minute);
}

// P(`subjectId` is ahead when the visible match ends). Deterministic.
export function winProbability(state, subjectId) {
  assertSubject(state, subjectId);
  const isHome = subjectId === state.home_team_id;
  const subjectScore = isHome ? state.home_score : state.away_score;
  const oppScore = isHome ? state.away_score : state.home_score;
  const margin = subjectScore - oppScore;

  const remainingFraction = minutesRemaining(state) / REGULATION_MINUTES;
  const subjectRate = (isHome ? HOME_GOALS_PER_90 : AWAY_GOALS_PER_90) * remainingFraction;
  const oppRate = (isHome ? AWAY_GOALS_PER_90 : HOME_GOALS_PER_90) * remainingFraction;

  const subjectPmf = poissonPmfTable(subjectRate, MAX_GOALS);
  const oppPmf = poissonPmfTable(oppRate, MAX_GOALS);

  let pWin = 0;
  for (let s = 0; s <= MAX_GOALS; s += 1) {
    for (let o = 0; o <= MAX_GOALS; o += 1) {
      if (margin + s - o > 0) pWin += subjectPmf[s] * oppPmf[o];
    }
  }
  return clampProbability(pWin);
}
