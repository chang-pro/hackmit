// Soccer field normalization (sibling of normalize.js — README §7.3).
// Soccer clocks count UP and are displayed in elapsed minutes, often with
// stoppage notation: "67'", "45+2'", "90+3". Periods are halves (1, 2) and
// extra time (3 = ET first half, 4 = ET second half; "ET" alone -> 3).
// Output shape matches the ParsedScoreboard contract with clock_seconds = null
// (there is no countdown clock) and the elapsed minute on extras.minute.

import { normalizeTeamText, UNREPORTED_CONFIDENCE } from "./normalize.js";

// "67'" -> 67, "45+2'" -> 47, "90+3" -> 93, 118 -> 118.
export function parseSoccerClockText(text) {
  if (typeof text === "number" && Number.isFinite(text) && text >= 0) {
    return Math.floor(text);
  }
  const s = String(text).trim();
  const m = s.match(/^(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*'?$/);
  if (m) return Number(m[1]) + Number(m[2] ?? 0);
  throw new Error(`Unparseable soccer clock text: ${JSON.stringify(text)}`);
}

// "1st"/"1H"/"H1"/1 -> 1, "2nd"/"2H" -> 2, "ET" -> 3, "ET2" -> 4.
export function parseSoccerPeriodText(text) {
  if (typeof text === "number" && Number.isInteger(text) && text >= 1 && text <= 4) return text;
  const s = String(text).trim().toUpperCase();
  const et = s.match(/^ET\s*(\d)?$/);
  if (et) {
    const n = Number(et[1] ?? 1);
    if (n === 1 || n === 2) return 2 + n;
  }
  const half = s.match(/^(?:H\s*)?([12])\s*(?:H|ST|ND)?$/);
  if (half) return Number(half[1]);
  throw new Error(`Unparseable soccer period text: ${JSON.stringify(text)}`);
}

function parseGoals(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Unparseable soccer score: ${JSON.stringify(value)}`);
  }
  return n;
}

export function normalizeSoccerScoreboard(raw) {
  const conf = raw.field_confidences ?? {};
  const minute = parseSoccerClockText(raw.minute ?? raw.clock_text);
  return {
    sport: "soccer",
    league: raw.league ?? "FIFA World Cup",
    away_team_text: normalizeTeamText(raw.away_team_text),
    home_team_text: normalizeTeamText(raw.home_team_text),
    away_score: parseGoals(raw.away_score),
    home_score: parseGoals(raw.home_score),
    period: parseSoccerPeriodText(raw.period ?? raw.period_text),
    clock_seconds: null, // soccer has no countdown clock
    extras: { minute },
    field_confidences: {
      teams: conf.teams ?? UNREPORTED_CONFIDENCE,
      scores: conf.scores ?? UNREPORTED_CONFIDENCE,
      period: conf.period ?? UNREPORTED_CONFIDENCE,
      clock: conf.clock ?? UNREPORTED_CONFIDENCE,
    },
  };
}
