// NBA team/event normalization. Broadcast abbreviations, city names, and team
// names resolve to stable IDs. We intentionally do not fuzzy-match unknown
// strings: attaching a frame to the wrong event is worse than returning an
// actionable resolution error.

const TEAMS = [
  ["atl", ["ATL", "ATLANTA", "HAWKS", "ATLANTA HAWKS"]],
  ["bos", ["BOS", "BOSTON", "CELTICS", "BOSTON CELTICS"]],
  ["bkn", ["BKN", "BROOKLYN", "NETS", "BROOKLYN NETS"]],
  ["cha", ["CHA", "CHARLOTTE", "HORNETS", "CHARLOTTE HORNETS"]],
  ["chi", ["CHI", "CHICAGO", "BULLS", "CHICAGO BULLS"]],
  ["cle", ["CLE", "CLEVELAND", "CAVALIERS", "CAVS", "CLEVELAND CAVALIERS"]],
  ["dal", ["DAL", "DALLAS", "MAVERICKS", "MAVS", "DALLAS MAVERICKS"]],
  ["den", ["DEN", "DENVER", "NUGGETS", "DENVER NUGGETS"]],
  ["det", ["DET", "DETROIT", "PISTONS", "DETROIT PISTONS"]],
  ["gsw", ["GS", "GSW", "GOLDEN STATE", "WARRIORS", "GOLDEN STATE WARRIORS"]],
  ["hou", ["HOU", "HOUSTON", "ROCKETS", "HOUSTON ROCKETS"]],
  ["ind", ["IND", "INDIANA", "PACERS", "INDIANA PACERS"]],
  ["lac", ["LAC", "LA CLIPPERS", "CLIPPERS", "LOS ANGELES CLIPPERS"]],
  ["lal", ["LAL", "LA LAKERS", "LAKERS", "LOS ANGELES LAKERS"]],
  ["mem", ["MEM", "MEMPHIS", "GRIZZLIES", "MEMPHIS GRIZZLIES"]],
  ["mia", ["MIA", "MIAMI", "HEAT", "MIAMI HEAT"]],
  ["mil", ["MIL", "MILWAUKEE", "BUCKS", "MILWAUKEE BUCKS"]],
  ["min", ["MIN", "MINNESOTA", "TIMBERWOLVES", "WOLVES", "MINNESOTA TIMBERWOLVES"]],
  ["nop", ["NO", "NOP", "NEW ORLEANS", "PELICANS", "NEW ORLEANS PELICANS"]],
  ["nyk", ["NY", "NYK", "NEW YORK", "KNICKS", "NEW YORK KNICKS"]],
  ["okc", ["OKC", "OKLAHOMA CITY", "THUNDER", "OKLAHOMA CITY THUNDER"]],
  ["orl", ["ORL", "ORLANDO", "MAGIC", "ORLANDO MAGIC"]],
  ["phi", ["PHI", "PHILADELPHIA", "76ERS", "SIXERS", "PHILADELPHIA 76ERS"]],
  ["phx", ["PHO", "PHX", "PHOENIX", "SUNS", "PHOENIX SUNS"]],
  ["por", ["POR", "PORTLAND", "TRAIL BLAZERS", "BLAZERS", "PORTLAND TRAIL BLAZERS"]],
  ["sac", ["SAC", "SACRAMENTO", "KINGS", "SACRAMENTO KINGS"]],
  ["sas", ["SA", "SAS", "SAN ANTONIO", "SPURS", "SAN ANTONIO SPURS"]],
  ["tor", ["TOR", "TORONTO", "RAPTORS", "TORONTO RAPTORS"]],
  ["uta", ["UTA", "UTAH", "JAZZ", "UTAH JAZZ"]],
  ["was", ["WAS", "WSH", "WASHINGTON", "WIZARDS", "WASHINGTON WIZARDS"]],
];

const TEAM_ALIASES = new Map();
for (const [slug, aliases] of TEAMS) {
  for (const alias of aliases) TEAM_ALIASES.set(alias, `nba_${slug}`);
}

function clean(text) {
  return String(text ?? "").trim().replace(/[.]/g, "").replace(/\s+/g, " ").toUpperCase();
}

export function resolveTeam(teamText) {
  const normalized = clean(teamText);
  const id = TEAM_ALIASES.get(normalized);
  if (!id) throw new Error(`Unresolved NBA team text: ${JSON.stringify(teamText)}`);
  return id;
}

export function resolveEvent(parsed, gameDate = new Date().toISOString().slice(0, 10)) {
  const awayId = resolveTeam(parsed.away_team_text);
  const homeId = resolveTeam(parsed.home_team_text);
  if (awayId === homeId) throw new Error("Away and home team resolved to the same team");
  const date = String(gameDate).slice(0, 10).replaceAll("-", "_");
  return {
    event_id: `nba_${date}_${awayId.slice(4)}_${homeId.slice(4)}`,
    league: parsed.league,
    away_team_id: awayId,
    home_team_id: homeId,
  };
}
