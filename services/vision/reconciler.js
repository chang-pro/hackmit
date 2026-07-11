// Game-state reconciler (README §7.5).
// Owns the canonical current state; decides whether a new observation is
// plausible. Enforces basketball invariants: scores never decrease, period
// never decreases, score jumps of >3 per team per observation are suspect.
// On rejection it retains the last trusted state instead of going null.

const MIN_CONFIDENCE = 0.8;
const MAX_SCORE_JUMP = 3;

export class Reconciler {
  constructor() {
    this.state = null;
  }

  reset() {
    this.state = null;
  }

  // Returns { accepted, state, reason } — state is always the canonical
  // (possibly retained) state, never null once one observation is accepted.
  observe(event, parsed, frame) {
    const c = parsed.field_confidences;
    const confidence = Math.min(c.teams, c.scores, c.period, c.clock);
    const candidate = {
      event_id: event.event_id,
      observed_at: frame.captured_at,
      accepted_at: new Date().toISOString(),
      away_team_id: event.away_team_id,
      home_team_id: event.home_team_id,
      away_score: parsed.away_score,
      home_score: parsed.home_score,
      period: parsed.period,
      clock_seconds: parsed.clock_seconds,
      possession_team_id: null, // optional field; never blocks the flow
      confidence,
      source_frame_ids: [frame.frame_id],
    };

    const reason = this.#reject(candidate, confidence);
    if (reason) return { accepted: false, state: this.state, reason };

    this.state = candidate;
    return { accepted: true, state: this.state, reason: null };
  }

  #reject(next, confidence) {
    if (confidence < MIN_CONFIDENCE) return `confidence ${confidence} below ${MIN_CONFIDENCE}`;
    const prev = this.state;
    if (!prev) return null;
    if (next.event_id !== prev.event_id) return "event identity changed mid-session";
    if (next.away_score < prev.away_score || next.home_score < prev.home_score)
      return "score decreased (replay or OCR failure)";
    if (next.period < prev.period) return "period decreased";
    if (
      next.away_score - prev.away_score > MAX_SCORE_JUMP ||
      next.home_score - prev.home_score > MAX_SCORE_JUMP
    )
      return "implausible score jump";
    return null;
  }
}
