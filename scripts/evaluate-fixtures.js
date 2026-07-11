#!/usr/bin/env node
// Fixture evaluation (README §10 scripts/evaluate-fixtures, §12 vision track).
// Runs scoreboard extraction on every fixture in packages/fixtures/frames/
// and diffs the required fields — teams, scores, period, clock (README §7.3)
// — against packages/fixtures/expected/. Prints per-field accuracy.
//
// The fixture backend always runs and is deterministic. The Cerebras backend is
// attempted only when CEREBRAS_API_KEY is set AND the fixture has a real image
// file on disk; otherwise it is reported as skipped — accuracy is measured,
// never invented (README §17.6).

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { extractScoreboard } from "../services/vision/index.js";
import { resolveWithAliases } from "../services/vision/resolver.js";
import { getSport } from "../services/sports/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES_DIR = join(ROOT, "packages", "fixtures", "frames");
const EXPECTED_DIR = join(ROOT, "packages", "fixtures", "expected");

const REQUIRED_FIELDS = ["teams", "scores", "period", "clock"];

async function loadFixtures() {
  const files = (await readdir(FRAMES_DIR)).filter((f) => f.endsWith(".json")).sort();
  const fixtures = [];
  for (const file of files) {
    const fixturePath = join(FRAMES_DIR, file);
    const raw = JSON.parse(await readFile(fixturePath, "utf8"));
    const frameId = raw.frame.frame_id;
    const expectedPath = join(EXPECTED_DIR, `${frameId}.state.json`);
    if (!existsSync(expectedPath)) {
      console.warn(`warn: no expected state for ${frameId}, skipping`);
      continue;
    }
    fixtures.push({
      frameId,
      fixturePath,
      frame: raw.frame,
      // Multi-sport fixtures carry a top-level sport id; legacy NBA ones don't.
      sport: getSport(raw.sport ?? null),
      expected: JSON.parse(await readFile(expectedPath, "utf8")),
    });
  }
  return fixtures;
}

// Diff one parsed scoreboard against expected state. Returns a map of
// required field -> boolean (correct).
function diffFields(parsed, expected, sport) {
  let awayId = null;
  let homeId = null;
  try {
    awayId = resolveWithAliases(sport.aliases, parsed.away_team_text);
    homeId = resolveWithAliases(sport.aliases, parsed.home_team_text);
  } catch {
    // unresolvable team text counts as a teams miss
  }
  return {
    teams: awayId === expected.away_team_id && homeId === expected.home_team_id,
    scores:
      parsed.away_score === expected.away_score &&
      parsed.home_score === expected.home_score,
    period: parsed.period === expected.period,
    clock: parsed.clock_seconds === expected.clock_seconds,
  };
}

async function evaluateBackend(backendName, fixtures, frameForFixture) {
  const totals = Object.fromEntries(REQUIRED_FIELDS.map((f) => [f, { ok: 0, n: 0 }]));
  for (const fixture of fixtures) {
    let result;
    try {
      const parsed = await extractScoreboard(frameForFixture(fixture), backendName, fixture.sport);
      result = diffFields(parsed, fixture.expected, fixture.sport);
    } catch (err) {
      console.log(`  ${fixture.frameId}: extraction failed — ${err.message}`);
      result = Object.fromEntries(REQUIRED_FIELDS.map((f) => [f, false]));
    }
    const misses = REQUIRED_FIELDS.filter((f) => !result[f]);
    console.log(
      `  ${fixture.frameId}: ${misses.length === 0 ? "all required fields correct" : `mismatch in ${misses.join(", ")}`}`
    );
    for (const field of REQUIRED_FIELDS) {
      totals[field].n += 1;
      if (result[field]) totals[field].ok += 1;
    }
  }

  console.log(`  per-field accuracy (${backendName} backend):`);
  let allCorrect = true;
  for (const field of REQUIRED_FIELDS) {
    const { ok, n } = totals[field];
    const pct = n === 0 ? "n/a" : `${((ok / n) * 100).toFixed(1)}%`;
    console.log(`    ${field.padEnd(7)} ${ok}/${n}  ${pct}`);
    if (ok !== n) allCorrect = false;
  }
  return allCorrect;
}

const fixtures = await loadFixtures();
if (fixtures.length === 0) {
  console.error("No fixtures with expected state found.");
  process.exit(1);
}
console.log(`Evaluating ${fixtures.length} fixture(s) from ${FRAMES_DIR}\n`);

// --- fixture backend: always runs, deterministic ---
console.log("Backend: fixture");
const fixtureBackendClean = await evaluateBackend("fixture", fixtures, (f) => ({
  ...f.frame,
  fixture_path: f.fixturePath,
}));
if (!fixtureBackendClean) process.exitCode = 1;

// --- Cerebras Gemma 4 backend: only with a key and a real image on disk ---
console.log("\nBackend: cerebras");
const haveKey = Boolean(process.env.CEREBRAS_API_KEY);
const withImages = fixtures.filter((f) => {
  const imagePath = f.frame.image_uri ? resolve(ROOT, f.frame.image_uri) : null;
  if (imagePath && existsSync(imagePath)) {
    f.imagePath = imagePath;
    return true;
  }
  return false;
});

if (!haveKey) {
  console.log("  skipped: CEREBRAS_API_KEY is not set");
} else if (withImages.length === 0) {
  console.log("  skipped: no fixture has an image file on disk");
} else {
  console.log(
    `  running on ${withImages.length}/${fixtures.length} fixture(s) that have image files`
  );
  await evaluateBackend("cerebras", withImages, (f) => ({
    ...f.frame,
    image_path: f.imagePath,
  }));
}
