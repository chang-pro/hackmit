// Field normalization (README §7.3, Slice 2).
// Extraction backends return noisy, loosely-typed fields — clock as "2:14",
// period as "4th" or "OT", team text with stray whitespace. These utilities
// coerce whatever a backend produced into the typed ParsedScoreboard contract
// so downstream components (resolver, reconciler, probability) never see raw
// backend output. Unparseable required fields throw with a clear message
// rather than passing garbage downstream.

// Backends that do not self-report per-field confidences get this low default
// so the reconciler's confidence gate treats their output as untrusted instead
// of us inventing a high confidence (README §17.6).
export const UNREPORTED_CONFIDENCE = 0.5;

// Game-clock text -> whole seconds remaining.
//   "2:14" -> 134, "02:14" -> 134, "1:05.3" -> 65, "14.5" -> 14, "59" -> 59
// Decision: fractional seconds are FLOORED ("14.5" -> 14). The clock never
// overstates time remaining, which keeps the probability input conservative
// for the leading team.
export function parseClockText(text) {
  if (typeof text === "number" && Number.isFinite(text) && text >= 0) {
    return Math.floor(text);
  }
  const s = String(text).trim();
  const minSec = s.match(/^(\d{1,2}):([0-5]?\d(?:\.\d+)?)$/);
  if (minSec) return Number(minSec[1]) * 60 + Math.floor(Number(minSec[2]));
  const secondsOnly = s.match(/^(\d{1,3}(?:\.\d+)?)$/);
  if (secondsOnly) return Math.floor(Number(secondsOnly[1]));
  throw new Error(`Unparseable clock text: ${JSON.stringify(text)}`);
}

// Period text -> numeric period.
//   "1st".."4th", "Q4", "4Q", "4" -> 1..4
//   "OT" -> 5, "OT2" / "2OT" -> 6 (overtime N = period 4 + N)
export function parsePeriodText(text) {
  if (typeof text === "number" && Number.isInteger(text) && text >= 1) return text;
  const s = String(text).trim().toUpperCase();
  const ot = s.match(/^(?:(\d+)\s*OT|OT\s*(\d+)?)$/);
  if (ot) return 4 + Number(ot[1] ?? ot[2] ?? 1);
  const num = s.match(/^(?:Q\s*)?(\d{1,2})\s*(?:Q|ST|ND|RD|TH)?$/);
  if (num && Number(num[1]) >= 1) return Number(num[1]);
  throw new Error(`Unparseable period text: ${JSON.stringify(text)}`);
}

// Team text -> trimmed, whitespace-collapsed, uppercased label ready for the
// alias resolver (README §7.4).
export function normalizeTeamText(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!s) throw new Error(`Empty team text: ${JSON.stringify(text)}`);
  return s;
}

function parseScore(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Unparseable score: ${JSON.stringify(value)}`);
  }
  return n;
}

// Raw backend output -> ParsedScoreboard (README §7.3). Accepts either typed
// fields (period: 4, clock_seconds: 134) or text fields (period_text: "4th",
// clock_text: "2:14"); required fields must be parseable, optional fields
// (shot clock, possession, bbox) never block the flow.
export function normalizeScoreboard(raw) {
  const conf = raw.field_confidences ?? {};
  let possession = null;
  try {
    if (raw.possession_team_text != null) {
      possession = normalizeTeamText(raw.possession_team_text);
    }
  } catch {
    possession = null; // optional field: drop it rather than fail
  }
  return {
    sport: raw.sport ?? "basketball",
    league: raw.league ?? "NBA",
    away_team_text: normalizeTeamText(raw.away_team_text),
    home_team_text: normalizeTeamText(raw.home_team_text),
    away_score: parseScore(raw.away_score),
    home_score: parseScore(raw.home_score),
    period: parsePeriodText(raw.period ?? raw.period_text),
    clock_seconds: parseClockText(raw.clock_seconds ?? raw.clock_text),
    shot_clock_seconds:
      raw.shot_clock_seconds != null && Number.isFinite(Number(raw.shot_clock_seconds))
        ? Math.floor(Number(raw.shot_clock_seconds))
        : null,
    possession_team_text: possession,
    scoreboard_bbox: raw.scoreboard_bbox ?? null,
    field_confidences: {
      teams: conf.teams ?? UNREPORTED_CONFIDENCE,
      scores: conf.scores ?? UNREPORTED_CONFIDENCE,
      period: conf.period ?? UNREPORTED_CONFIDENCE,
      clock: conf.clock ?? UNREPORTED_CONFIDENCE,
      possession: conf.possession ?? 0,
    },
  };
}
