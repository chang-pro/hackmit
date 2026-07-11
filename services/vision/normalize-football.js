// NFL field normalization (sibling of normalize.js — README §7.3).
// An NFL scoreboard is structurally the NBA one — teams, scores, a countdown
// clock ("8:31"), quarters ("Q3", "3rd", "OT") — so this delegates to the
// shared normalizeScoreboard and only fixes the sport/league defaults.
// Quarters are 15 minutes; "OT" still maps to period 5.

import { normalizeScoreboard } from "./normalize.js";

export function normalizeFootballScoreboard(raw) {
  const parsed = normalizeScoreboard({ ...raw, sport: "football", league: raw.league ?? "NFL" });
  return parsed;
}
