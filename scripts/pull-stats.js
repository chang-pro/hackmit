#!/usr/bin/env node
// Pulls recent/live game data for the four non-NBA sports from ESPN's public
// scoreboard JSON endpoints (no API key required) and saves timestamped
// snapshots to packages/fixtures/stats/<sport>-<date>.json. A compact summary
// (matchups, scores, status) is printed to stdout and stored alongside the
// raw payload so GET /api/stats can serve it without re-parsing ESPN's shape.
//
// Honesty rules (README §17.6): network failures and empty scoreboards are
// recorded as exactly that — a failed pull writes an { ok: false } snapshot
// with the error and exits nonzero; an off-season empty response is saved
// as the real (empty) response, never padded with invented games.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATS_DIR = join(ROOT, "packages", "fixtures", "stats");

const ESPN_BASE = "http://site.api.espn.com/apis/site/v2/sports";

const SPORTS = [
  { id: "soccer", path: "soccer/eng.1" },
  { id: "football", path: "football/nfl" },
  { id: "ufc", path: "mma/ufc" },
  { id: "golf", path: "golf/pga" },
];

const FETCH_TIMEOUT_MS = 15_000;

// ESPN scoreboard -> compact summary. Defensive: every field is optional
// because ESPN's shape varies by sport (MMA nests cards, golf has no
// home/away). Unknown shapes yield fewer fields, never a crash.
function summarize(sportId, payload) {
  const events = [];
  const rawEvents = Array.isArray(payload?.events) ? payload.events : [];
  for (const ev of rawEvents) {
    const entry = {
      name: ev?.name ?? ev?.shortName ?? null,
      date: ev?.date ?? null,
      status: ev?.status?.type?.description ?? null,
    };
    const competitions = Array.isArray(ev?.competitions) ? ev.competitions : [];
    const competitors = Array.isArray(competitions[0]?.competitors)
      ? competitions[0].competitors
      : [];
    if (competitors.length > 0) {
      entry.competitors = competitors.slice(0, 6).map((c) => ({
        name: c?.team?.abbreviation ?? c?.team?.displayName ?? c?.athlete?.displayName ?? null,
        home_away: c?.homeAway ?? null,
        score: c?.score ?? null,
      }));
    }
    events.push(entry);
  }
  return {
    sport: sportId,
    league: payload?.leagues?.[0]?.name ?? null,
    season_day: payload?.day?.date ?? null,
    event_count: events.length,
    events,
  };
}

async function fetchScoreboard(path) {
  const url = `${ESPN_BASE}/${path}/scoreboard`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`ESPN request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return { url, payload: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  await mkdir(STATS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  let failures = 0;

  for (const { id, path } of SPORTS) {
    const file = join(STATS_DIR, `${id}-${date}.json`);
    try {
      const { url, payload } = await fetchScoreboard(path);
      const summary = summarize(id, payload);
      const snapshot = {
        ok: true,
        sport: id,
        source: url,
        pulled_at: new Date().toISOString(),
        summary,
        raw: payload,
      };
      await writeFile(file, JSON.stringify(snapshot, null, 2));
      console.log(`\n=== ${id} (${summary.league ?? path}) — ${summary.event_count} event(s) ===`);
      if (summary.event_count === 0) {
        console.log("  (no games listed right now — empty response recorded honestly)");
      }
      for (const ev of summary.events.slice(0, 10)) {
        const score = (ev.competitors ?? [])
          .map((c) => `${c.name ?? "?"} ${c.score ?? ""}`.trim())
          .join(" vs ");
        console.log(`  ${ev.name ?? "(unnamed)"} | ${score || "no competitors"} | ${ev.status ?? "?"}`);
      }
      console.log(`  saved -> ${file}`);
    } catch (err) {
      failures += 1;
      const reason = err.name === "AbortError" ? "request timed out" : err.message;
      console.error(`\n=== ${id} — PULL FAILED: ${reason}`);
      const snapshot = {
        ok: false,
        sport: id,
        source: `${ESPN_BASE}/${path}/scoreboard`,
        pulled_at: new Date().toISOString(),
        error: reason,
      };
      await writeFile(file, JSON.stringify(snapshot, null, 2));
      console.error(`  failure recorded -> ${file}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${SPORTS.length} pulls failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`pull-stats: fatal: ${err.message}`);
  process.exit(1);
});
