// Team and event resolver (README §7.4).
// Broadcast labels, model labels, and market labels all resolve to stable
// internal IDs. Slice 1 covers the demo matchup; extend TEAM_ALIASES as
// fixtures are added. Resolution fails loudly rather than fuzzy-matching.

export const TEAM_ALIASES = {
  BOS: "nba_bos",
  BOSTON: "nba_bos",
  CELTICS: "nba_bos",
  NYK: "nba_nyk",
  "NEW YORK": "nba_nyk",
  KNICKS: "nba_nyk",
};

// Generic alias resolution: exact-match lookup after trim/uppercase. No fuzzy
// matching, ever — an unknown label throws with the label in the message.
export function resolveWithAliases(aliases, text) {
  const id = aliases[String(text).trim().toUpperCase()];
  if (!id) throw new Error(`Unresolved team text: ${text}`);
  return id;
}

// Internal subject id -> the short label after its sport prefix
// ("nba_bos" -> "bos", "ufc_khabib" -> "khabib").
export function subjectSlug(subjectId) {
  return subjectId.slice(subjectId.indexOf("_") + 1);
}

export function resolveTeam(teamText) {
  return resolveWithAliases(TEAM_ALIASES, teamText);
}

// Sport-aware event resolution: sport config supplies the alias table, the
// sport id (event-id prefix), and the demo game date. Same fail-loud rules.
export function resolveEventForSport(sport, parsed, gameDate = sport.eventDate) {
  const awayId = resolveWithAliases(sport.aliases, parsed.away_team_text);
  const homeId = resolveWithAliases(sport.aliases, parsed.home_team_text);
  return {
    event_id: `${sport.id}_${gameDate}_${subjectSlug(awayId)}_${subjectSlug(homeId)}`,
    league: parsed.league,
    away_team_id: awayId,
    home_team_id: homeId,
  };
}

export function resolveEvent(parsed, gameDate = "2026_07_11") {
  const awayId = resolveTeam(parsed.away_team_text);
  const homeId = resolveTeam(parsed.home_team_text);
  return {
    event_id: `nba_${gameDate}_${awayId.slice(4)}_${homeId.slice(4)}`,
    league: parsed.league,
    away_team_id: awayId,
    home_team_id: homeId,
  };
}
