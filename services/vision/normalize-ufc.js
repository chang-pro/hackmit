// UFC field normalization (sibling of normalize.js — README §7.3).
// A UFC broadcast shows two fighter names, the round ("R3", "ROUND 3"), and a
// 5-minute countdown clock ("2:45") — no score. The fighters map onto the
// generic away/home subject slots (away = first/red corner, home =
// second/blue corner) so the resolver, reconciler, and pipeline stay generic.
// Scores are null, honestly: nothing on screen counts points.

import { parseClockText, normalizeTeamText, UNREPORTED_CONFIDENCE } from "./normalize.js";

// "R3" / "ROUND 3" / "RD 3" / 3 -> 3.
export function parseRoundText(text) {
  if (typeof text === "number" && Number.isInteger(text) && text >= 1 && text <= 5) return text;
  const s = String(text).trim().toUpperCase();
  const m = s.match(/^(?:R(?:OUND|D)?\s*)?([1-5])$/);
  if (m) return Number(m[1]);
  throw new Error(`Unparseable round text: ${JSON.stringify(text)}`);
}

// Combined "R3 2:45" -> { round: 3, clock_seconds: 165 }.
export function parseRoundClockText(text) {
  const s = String(text).trim();
  const m = s.match(/^(.+?)\s+(\d{1,2}:[0-5]\d(?:\.\d+)?)$/);
  if (!m) throw new Error(`Unparseable round/clock text: ${JSON.stringify(text)}`);
  return { round: parseRoundText(m[1]), clock_seconds: parseClockText(m[2]) };
}

export function normalizeUfcScoreboard(raw) {
  const conf = raw.field_confidences ?? {};

  let round;
  let clockSeconds;
  if (raw.round_clock_text != null) {
    ({ round, clock_seconds: clockSeconds } = parseRoundClockText(raw.round_clock_text));
  } else {
    round = parseRoundText(raw.round ?? raw.round_text);
    clockSeconds = parseClockText(raw.clock_seconds ?? raw.clock_text);
  }

  // When the broadcast doesn't state the scheduled distance (the Gemini schema
  // has no such field), never let the default make the observed round
  // impossible: a live round 4 implies a 5-round fight.
  const scheduled = raw.scheduled_rounds ?? (round > 3 ? 5 : 3);
  if (!Number.isInteger(scheduled) || scheduled < 1 || scheduled > 5 || scheduled < round) {
    throw new Error(`Unparseable scheduled_rounds: ${JSON.stringify(raw.scheduled_rounds)}`);
  }

  return {
    sport: "mma",
    league: raw.league ?? "UFC",
    // Fighter slots: away = first/red corner, home = second/blue corner.
    away_team_text: normalizeTeamText(raw.fighter1_text ?? raw.away_team_text),
    home_team_text: normalizeTeamText(raw.fighter2_text ?? raw.home_team_text),
    away_score: null, // no on-screen score in MMA — never invented
    home_score: null,
    period: round,
    clock_seconds: clockSeconds,
    extras: { scheduled_rounds: scheduled },
    field_confidences: {
      teams: conf.fighters ?? conf.teams ?? UNREPORTED_CONFIDENCE,
      period: conf.round ?? conf.period ?? UNREPORTED_CONFIDENCE,
      clock: conf.clock ?? UNREPORTED_CONFIDENCE,
    },
  };
}
