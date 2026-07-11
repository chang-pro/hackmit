// UFC win-probability model — prior-anchored, no on-screen score.
//
// An MMA broadcast shows no running score, so a vision-only system observes
// just the round and round clock. This model is deliberately simple,
// explainable, and deterministic:
//
//   p(subject) = 0.5 + (prior − 0.5) × (W_DECISION + W_FINISH × remainingFraction)
//
// Interpretation: a favorite's edge has two components. The finish component
// (W_FINISH) is spent as fight time elapses — every completed round is a
// finish opportunity that did not happen, so the surviving underdog's chances
// improve. The decision component (W_DECISION) never decays: if the fight
// reaches a round-R or full-distance decision, judges still favor the better
// fighter. With the default prior of 0.5 the output is exactly 0.5 at every
// moment — no fake confidence is ever invented from an unreadable fight.
//
// Rounds are 5 minutes, clock counts DOWN, scheduled_rounds is 3 (regular
// card) or 5 (title/main event), carried on state.extras.

import { clampProbability, assertPrior, assertSubject } from "./gaussian.js";

export const MODEL_VERSION = "ufc-win-probability-v1";

const ROUND_SECONDS = 300; // 5-minute rounds
const DEFAULT_SCHEDULED_ROUNDS = 3;
const W_DECISION = 0.6; // prior share that survives to any decision
const W_FINISH = 0.4; // prior share spent as finish opportunities pass

function remainingFraction(state) {
  const scheduled = state.extras?.scheduled_rounds ?? DEFAULT_SCHEDULED_ROUNDS;
  if (!Number.isInteger(scheduled) || scheduled < 1 || scheduled > 5) {
    throw new Error(`ufc model: scheduled_rounds must be 1..5, got ${JSON.stringify(scheduled)}`);
  }
  const round = state.period; // period carries the round number (1..5)
  if (!Number.isInteger(round) || round < 1 || round > scheduled) {
    throw new Error(`ufc model: round must be 1..${scheduled}, got ${JSON.stringify(round)}`);
  }
  const clock = Math.min(ROUND_SECONDS, Math.max(0, state.clock_seconds));
  const remaining = (scheduled - round) * ROUND_SECONDS + clock;
  return remaining / (scheduled * ROUND_SECONDS);
}

// P(`subjectId` wins). options.pregameProbability is the pregame prior FOR
// THE SUBJECT (default 0.5 — a coin flip when nothing is known). Passing
// complementary priors for the two fighters yields complementary outputs.
export function winProbability(state, subjectId, options = {}) {
  assertSubject(state, subjectId);
  let prior = options.pregameProbability;
  if (prior === undefined || prior === null) {
    prior = 0.5;
  } else {
    assertPrior(prior);
  }
  const weight = W_DECISION + W_FINISH * remainingFraction(state);
  return clampProbability(0.5 + (prior - 0.5) * weight);
}
