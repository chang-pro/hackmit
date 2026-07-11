// Probability engine (README §7.6) — deterministic baseline, v1.
// Brownian-motion win-probability model (Stern 1994): the remaining scoring
// margin is treated as normal with sd proportional to sqrt(seconds left),
// plus a small home-court drift. Consumes CanonicalGameState only — never
// image pixels. Small, explainable, and bounded by design.

export const MODEL_VERSION = "nba-win-probability-v1";

const REGULATION_SECONDS = 4 * 720;
const SIGMA_PER_SQRT_SEC = 11.5 / Math.sqrt(REGULATION_SECONDS); // full-game margin sd ≈ 11.5 pts
const HOME_EDGE_POINTS = 2.5; // full-game home-court advantage
const P_MIN = 0.001;
const P_MAX = 0.999;

function secondsRemaining(state) {
  const periodsLeft = Math.max(0, 4 - state.period);
  return periodsLeft * 720 + state.clock_seconds;
}

// Abramowitz & Stegun normal CDF approximation (max error ~7.5e-8).
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const clamp = (p) => Math.min(P_MAX, Math.max(P_MIN, p));

// Probability that `teamId` wins, given canonical state.
// `pregamePrior` is the team's pregame win probability (default: coin flip
// before home edge); used only to anchor the early-game drift.
export function winProbability(state, teamId) {
  if (teamId !== state.away_team_id && teamId !== state.home_team_id)
    throw new Error(`Team ${teamId} is not in event ${state.event_id}`);

  const isHome = teamId === state.home_team_id;
  const teamScore = isHome ? state.home_score : state.away_score;
  const oppScore = isHome ? state.away_score : state.home_score;
  const margin = teamScore - oppScore;
  const secs = secondsRemaining(state);

  if (secs <= 0) {
    // Regulation expired: decided games are (near-)certain; ties head to OT
    // at roughly the pregame prior.
    if (margin !== 0) return clamp(margin > 0 ? 1 : 0);
    return clamp(isHome ? 0.5 + HOME_EDGE_POINTS / 100 : 0.5 - HOME_EDGE_POINTS / 100);
  }

  const drift = HOME_EDGE_POINTS * (secs / REGULATION_SECONDS) * (isHome ? 1 : -1);
  const sigma = SIGMA_PER_SQRT_SEC * Math.sqrt(secs);
  return clamp(phi((margin + drift) / sigma));
}

// Full ProbabilityEstimate contract (README §7.6).
export function estimate(state, teamId) {
  return {
    event_id: state.event_id,
    outcome: `${teamId}_wins`,
    probability: Number(winProbability(state, teamId).toFixed(4)),
    model_version: MODEL_VERSION,
    computed_at: new Date().toISOString(),
    input_state_observed_at: state.observed_at,
    confidence: state.confidence,
  };
}
