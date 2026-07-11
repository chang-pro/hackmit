// Sports registry — one config module per sport, resolved by id, defaulting
// to NBA (the original primary slice, README §17.2). A sport config bundles
// everything sport-specific behind one object: vision prompt/schema for the
// gemini backend, the normalize function, the alias table, the probability
// model, reconciler invariants, and the demo fixtures. Everything else in the
// pipeline stays sport-generic.

import nba from "./nba.js";
import soccer from "./soccer.js";
import football from "./football.js";
import ufc from "./ufc.js";
import golf from "./golf.js";

const SPORTS = { nba, soccer, football, ufc, golf };

export const DEFAULT_SPORT_ID = "nba";

// Resolve a sport by id. null/undefined -> NBA (default). Unknown ids fail
// loudly — no fuzzy matching (README §7.4 spirit applies to sports too).
export function getSport(id = null) {
  if (id === null || id === undefined || id === "") return SPORTS[DEFAULT_SPORT_ID];
  const sport = SPORTS[id];
  if (!sport) {
    throw new Error(`Unknown sport "${id}". Available: ${Object.keys(SPORTS).join(", ")}`);
  }
  return sport;
}

export function listSports() {
  return Object.values(SPORTS);
}

// Full ProbabilityEstimate contract (README §7.6) via the sport's model.
// For NBA this produces exactly what services/probability estimate() always
// has; other sports swap in their own winProbability + MODEL_VERSION.
// options merge over the sport's demo modelOptions (e.g. a pregame prior).
export function estimateForSport(sport, state, subjectId, options = {}) {
  const opts = { ...(sport.modelOptions ?? {}), ...options };
  return {
    event_id: state.event_id,
    outcome: `${subjectId}_wins`,
    probability: Number(sport.model.winProbability(state, subjectId, opts).toFixed(4)),
    model_version: sport.model.MODEL_VERSION,
    computed_at: new Date().toISOString(),
    input_state_observed_at: state.observed_at,
    confidence: state.confidence,
  };
}
