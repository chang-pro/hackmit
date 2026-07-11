// Game-state reconciler (README §7.5).
// Owns the canonical current state; decides whether a new observation is
// plausible. Invariants are now rule-configurable per sport (the defaults are
// the original basketball rules, so `new Reconciler()` behaves exactly as
// before): scores never decrease (unless the sport allows it — golf to-par
// scores drop with birdies), period/round never decreases, per-observation
// score jumps beyond the sport's maximum are suspect. Sports with no
// on-screen score (UFC) carry null scores, which skip the score invariants
// honestly instead of inventing zeros.
// On rejection it retains the last trusted state instead of going null.

const DEFAULT_RULES = {
  minConfidence: 0.8,
  maxScoreJump: 3,
  allowScoreDecrease: false,
  // Confidence = min over these parsed field_confidences keys.
  confidenceFields: ["teams", "scores", "period", "clock"],
};

export class Reconciler {
  constructor(rules = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.state = null;
  }

  // Returns { accepted, state, reason } — state is always the canonical
  // (possibly retained) state, never null once one observation is accepted.
  observe(event, parsed, frame) {
    const c = parsed.field_confidences;
    const confidence = Math.min(...this.rules.confidenceFields.map((f) => c[f] ?? 0));
    const candidate = {
      event_id: event.event_id,
      observed_at: frame.captured_at,
      accepted_at: new Date().toISOString(),
      away_team_id: event.away_team_id,
      home_team_id: event.home_team_id,
      away_score: parsed.away_score ?? null,
      home_score: parsed.home_score ?? null,
      period: parsed.period ?? null,
      clock_seconds: parsed.clock_seconds ?? null,
      possession_team_id: null, // optional field; never blocks the flow
      // Sport-specific state (soccer elapsed minute, UFC scheduled rounds,
      // golf holes remaining) rides along untouched.
      extras: parsed.extras ?? null,
      confidence,
      source_frame_ids: [frame.frame_id],
    };

    const reason = this.#reject(candidate, confidence);
    if (reason) return { accepted: false, state: this.state, reason };

    this.state = candidate;
    return { accepted: true, state: this.state, reason: null };
  }

  #reject(next, confidence) {
    const { minConfidence, maxScoreJump, allowScoreDecrease } = this.rules;
    if (confidence < minConfidence) return `confidence ${confidence} below ${minConfidence}`;
    const prev = this.state;
    if (!prev) return null;
    if (next.event_id !== prev.event_id) return "event identity changed mid-session";

    const scoresComparable =
      next.away_score != null && next.home_score != null &&
      prev.away_score != null && prev.home_score != null;
    if (scoresComparable) {
      if (
        !allowScoreDecrease &&
        (next.away_score < prev.away_score || next.home_score < prev.home_score)
      )
        return "score decreased (replay or OCR failure)";
      if (
        Math.abs(next.away_score - prev.away_score) > maxScoreJump ||
        Math.abs(next.home_score - prev.home_score) > maxScoreJump
      )
        return "implausible score jump";
    }

    if (next.period != null && prev.period != null && next.period < prev.period)
      return "period decreased";
    return null;
  }
}
