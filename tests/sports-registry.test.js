// Sports registry: id resolution, config shape, and per-sport resolvers.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getSport,
  listSports,
  estimateForSport,
  DEFAULT_SPORT_ID,
} from "../services/sports/index.js";
import { resolveWithAliases, resolveEventForSport } from "../services/vision/resolver.js";

const FRAMES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "packages", "fixtures", "frames"
);

const SPORT_IDS = ["nba", "soccer", "football", "ufc", "golf"];

test("all five sports are registered and nba is the default", () => {
  assert.deepEqual(listSports().map((s) => s.id).sort(), [...SPORT_IDS].sort());
  assert.equal(DEFAULT_SPORT_ID, "nba");
  assert.equal(getSport().id, "nba");
  assert.equal(getSport(null).id, "nba");
  assert.equal(getSport("").id, "nba");
});

test("unknown sport ids fail loudly, never fuzzy-match", () => {
  assert.throws(() => getSport("cricket"), /Unknown sport "cricket"/);
  assert.throws(() => getSport("NBA"), /Unknown sport/); // exact ids only
});

test("every sport config has the full contract shape", () => {
  for (const sport of listSports()) {
    assert.equal(typeof sport.id, "string");
    assert.equal(typeof sport.label, "string");
    assert.equal(typeof sport.league, "string");
    assert.equal(typeof sport.sportTag, "string");
    assert.match(sport.eventDate, /^\d{4}_\d{2}_\d{2}$/);
    assert.equal(typeof sport.vision.prompt, "string", `${sport.id} vision prompt`);
    assert.ok(sport.vision.prompt.length > 50, `${sport.id} prompt is substantive`);
    assert.equal(sport.vision.responseSchema.type, "OBJECT", `${sport.id} schema`);
    assert.equal(typeof sport.normalize, "function");
    assert.ok(Object.keys(sport.aliases).length >= 2, `${sport.id} aliases`);
    assert.equal(typeof sport.model.winProbability, "function");
    assert.match(sport.model.MODEL_VERSION, /-v\d+$/);
    assert.ok(Array.isArray(sport.reconcilerRules.confidenceFields));
    assert.ok(sport.fixtures.length >= 2, `${sport.id} has 2+ fixtures`);
    assert.ok(sport.fixtures.includes(sport.defaultFixture));
    assert.equal(sport.demo_moments.length, sport.fixtures.length);
    for (const m of sport.demo_moments) {
      assert.ok(sport.fixtures.includes(m.fixture));
      assert.equal(typeof m.label, "string");
    }
  }
});

test("every declared fixture exists on disk", () => {
  for (const sport of listSports()) {
    for (const fixture of sport.fixtures) {
      assert.ok(
        existsSync(join(FRAMES, `${fixture}.json`)),
        `${sport.id} fixture missing: ${fixture}.json`
      );
    }
  }
});

test("per-sport aliases resolve the demo subjects; unknowns throw", () => {
  assert.equal(resolveWithAliases(getSport("soccer").aliases, "ARG"), "wc_arg");
  assert.equal(resolveWithAliases(getSport("soccer").aliases, "france"), "wc_fra");
  assert.equal(resolveWithAliases(getSport("football").aliases, "NE"), "nfl_ne");
  assert.equal(resolveWithAliases(getSport("football").aliases, "Falcons"), "nfl_atl");
  assert.equal(resolveWithAliases(getSport("ufc").aliases, "KHABIB"), "ufc_khabib");
  assert.equal(resolveWithAliases(getSport("ufc").aliases, "Conor McGregor"), "ufc_mcgregor");
  assert.equal(resolveWithAliases(getSport("golf").aliases, "TIGER WOODS"), "pga_tiger");
  assert.equal(resolveWithAliases(getSport("golf").aliases, "KOEPKA"), "pga_koepka");
  assert.throws(() => resolveWithAliases(getSport("soccer").aliases, "BRA"), /Unresolved/);
  assert.throws(() => resolveWithAliases(getSport("golf").aliases, "SPIETH"), /Unresolved/);
});

test("resolveEventForSport builds sport-prefixed event ids from the demo date", () => {
  const soccer = getSport("soccer");
  const event = resolveEventForSport(soccer, {
    away_team_text: "ARG",
    home_team_text: "FRA",
    league: "FIFA World Cup",
  });
  assert.equal(event.event_id, "soccer_2022_12_18_arg_fra");
  assert.equal(event.away_team_id, "wc_arg");
  assert.equal(event.home_team_id, "wc_fra");

  const ufc = getSport("ufc");
  const fight = resolveEventForSport(ufc, {
    away_team_text: "KHABIB",
    home_team_text: "MCGREGOR",
    league: "UFC",
  });
  assert.equal(fight.event_id, "ufc_2018_10_06_khabib_mcgregor");
});

test("estimateForSport produces the §7.6 contract with the sport's model version", () => {
  const golf = getSport("golf");
  const state = {
    event_id: "golf_2019_04_14_tiger_koepka",
    away_team_id: "pga_tiger",
    home_team_id: "pga_koepka",
    away_score: -14,
    home_score: -12,
    period: null,
    clock_seconds: null,
    extras: { holes_remaining: 2 },
    observed_at: "2019-04-14T18:41:50.000Z",
    confidence: 0.95,
  };
  const est = estimateForSport(golf, state, "pga_tiger");
  assert.equal(est.outcome, "pga_tiger_wins");
  assert.equal(est.model_version, "golf-win-probability-v1");
  assert.ok(est.probability > 0 && est.probability < 1);
  assert.equal(est.input_state_observed_at, state.observed_at);
  assert.equal(est.confidence, 0.95);
});
