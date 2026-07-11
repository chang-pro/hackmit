// Golf leaderboard normalization (sibling of normalize.js — README §7.3).
// A golf graphic is a leaderboard, not a scoreboard: player names, strokes
// relative to par ("-12", "E", "+3"), and holes completed ("THRU 16", "F").
// The top two players map onto the generic subject slots — away = leader
// (lower to-par), home = chaser — so the pipeline stays sport-generic.
// There is no period and no clock; holes remaining rides on extras.

import { normalizeTeamText, UNREPORTED_CONFIDENCE } from "./normalize.js";

const HOLES_TOTAL = 18;

// "-12" -> -12, "E" -> 0, "+3" -> 3, -12 -> -12.
export function parseToParText(text) {
  if (typeof text === "number" && Number.isInteger(text)) return text;
  const s = String(text).trim().toUpperCase();
  if (s === "E" || s === "EVEN") return 0;
  const m = s.match(/^([+-])\s*(\d{1,2})$/);
  if (m) return (m[1] === "-" ? -1 : 1) * Number(m[2]);
  const bare = s.match(/^(\d{1,2})$/); // bare number reads as over par
  if (bare) return Number(bare[1]);
  throw new Error(`Unparseable to-par text: ${JSON.stringify(text)}`);
}

// "16" / "THRU 16" -> 16, "F" / "F*" -> 18.
export function parseThruText(text) {
  if (typeof text === "number" && Number.isInteger(text) && text >= 0 && text <= HOLES_TOTAL)
    return text;
  const s = String(text).trim().toUpperCase();
  if (s === "F" || s === "F*" || s === "FINISHED") return HOLES_TOTAL;
  const m = s.match(/^(?:THRU\s*)?(\d{1,2})$/);
  if (m && Number(m[1]) <= HOLES_TOTAL) return Number(m[1]);
  throw new Error(`Unparseable thru text: ${JSON.stringify(text)}`);
}

// raw.players: top-of-leaderboard entries, each
//   { name_text, score_to_par | score_to_par_text, thru | thru_text }.
// At least two are required — a one-name leaderboard cannot price a race.
export function normalizeGolfLeaderboard(raw) {
  const conf = raw.field_confidences ?? {};
  const players = Array.isArray(raw.players) ? raw.players : [];
  if (players.length < 2) {
    throw new Error(`golf leaderboard needs at least 2 players, got ${players.length}`);
  }
  const parsedPlayers = players.slice(0, 2).map((p) => ({
    name: normalizeTeamText(p.name_text ?? p.name),
    to_par: parseToParText(p.score_to_par ?? p.score_to_par_text),
    thru: parseThruText(p.thru ?? p.thru_text),
  }));
  // Leader = lower to-par; stable on ties (first listed stays the leader).
  parsedPlayers.sort((a, b) => a.to_par - b.to_par);
  const [leader, chaser] = parsedPlayers;

  return {
    sport: "golf",
    league: raw.league ?? "PGA",
    // Subject slots: away = leader, home = chaser.
    away_team_text: leader.name,
    home_team_text: chaser.name,
    away_score: leader.to_par, // strokes relative to par — lower is better
    home_score: chaser.to_par,
    period: null, // no periods in golf
    clock_seconds: null, // no clock in golf
    extras: {
      // Remaining head-to-head holes: the race lasts until the player with
      // more golf left is done, so use the max remaining of the two.
      holes_remaining: HOLES_TOTAL - Math.min(leader.thru, chaser.thru),
      leader_thru: leader.thru,
      chaser_thru: chaser.thru,
    },
    field_confidences: {
      teams: conf.players ?? conf.teams ?? UNREPORTED_CONFIDENCE,
      scores: conf.scores ?? UNREPORTED_CONFIDENCE,
      holes: conf.holes ?? conf.thru ?? UNREPORTED_CONFIDENCE,
    },
  };
}
