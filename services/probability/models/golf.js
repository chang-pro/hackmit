// Golf win-probability model — stroke lead vs holes remaining, top-2 players.
//
// The visible leaderboard gives strokes relative to par and holes completed
// for the top players. Each remaining hole swings the head-to-head margin by
// ~0.45 strokes (SD), so with H holes left the remaining swing is normal with
// sd = 0.45 × sqrt(H) and P(leader holds on) = phi(lead / sd). No clock —
// golf state has period = null and clock_seconds = null.
//
// Scope decision (documented): this is a two-player race between the top two
// visible on the leaderboard. The rest of the field is ignored, which
// overstates the leader slightly; fine for the demo, noted here honestly.
// A tie with holes still to play is exactly 0.5 by symmetry; a tie with no
// holes left means a playoff, also treated as 0.5.

import { phi, clampProbability, assertSubject } from "./gaussian.js";

export const MODEL_VERSION = "golf-win-probability-v1";

const HOLE_SWING_SD = 0.45; // sd of the two-player margin change per hole

// P(`subjectId` finishes ahead of the other tracked player).
// Golf scores are strokes RELATIVE TO PAR — lower is better. away_score /
// home_score carry the away/home slot players' to-par totals; holes remaining
// rides on state.extras.holes_remaining.
export function winProbability(state, subjectId) {
  assertSubject(state, subjectId);
  const holes = state.extras?.holes_remaining;
  if (!Number.isInteger(holes) || holes < 0 || holes > 18) {
    throw new Error(`golf model: extras.holes_remaining must be 0..18, got ${JSON.stringify(holes)}`);
  }
  const isHome = subjectId === state.home_team_id;
  const subjectToPar = isHome ? state.home_score : state.away_score;
  const oppToPar = isHome ? state.away_score : state.home_score;
  // Positive lead = subject is ahead (fewer strokes / lower to-par).
  const lead = oppToPar - subjectToPar;

  if (holes === 0) {
    // Round complete: decided unless tied; a tie means a playoff (0.5).
    if (lead !== 0) return clampProbability(lead > 0 ? 1 : 0);
    return 0.5;
  }
  if (lead === 0) return 0.5; // exact by symmetry (phi(0) carries approximation error)
  const sd = HOLE_SWING_SD * Math.sqrt(holes);
  return clampProbability(phi(lead / sd));
}
