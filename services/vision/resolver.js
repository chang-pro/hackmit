// Team and event resolver (README §7.4).
// Broadcast labels, model labels, and market labels all resolve to stable
// internal IDs. Slice 1 covers the demo matchup; extend TEAM_ALIASES as
// fixtures are added. Resolution fails loudly rather than fuzzy-matching.

const TEAM_ALIASES = {
  BOS: "nba_bos",
  BOSTON: "nba_bos",
  CELTICS: "nba_bos",
  NYK: "nba_nyk",
  "NEW YORK": "nba_nyk",
  KNICKS: "nba_nyk",
};

export function resolveTeam(teamText) {
  const id = TEAM_ALIASES[String(teamText).trim().toUpperCase()];
  if (!id) throw new Error(`Unresolved team text: ${teamText}`);
  return id;
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
