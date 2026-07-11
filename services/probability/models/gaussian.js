// Shared gaussian math for Brownian/Stern-style win-probability models.
// Extracted from services/probability/index.js so the NFL model (and any
// future margin-diffusion sport) reuses the exact same, tested approximations
// instead of duplicating numeric constants.

// Abramowitz & Stegun normal CDF approximation (max error ~7.5e-8).
export function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Acklam's inverse normal CDF approximation (relative error < 1.15e-9).
// Used to convert a pregame win probability into an equivalent point spread.
export function probit(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const P_MIN = 0.001;
export const P_MAX = 0.999;

// Probabilities are clamped away from 0 and 1: the model never claims
// certainty (README §6 — honest language, no "certain win").
export const clampProbability = (p) => Math.min(P_MAX, Math.max(P_MIN, p));

// Validates an optional pregame prior. Shared across models so every sport
// rejects out-of-range priors with the same clear message.
export function assertPrior(prior) {
  if (typeof prior !== "number" || !Number.isFinite(prior) || prior <= 0 || prior >= 1)
    throw new Error(`pregameProbability must be strictly between 0 and 1, got ${prior}`);
}

// Shared guard: `subjectId` must be one of the event's two subjects.
export function assertSubject(state, subjectId) {
  if (subjectId !== state.away_team_id && subjectId !== state.home_team_id)
    throw new Error(`Team ${subjectId} is not in event ${state.event_id}`);
}
