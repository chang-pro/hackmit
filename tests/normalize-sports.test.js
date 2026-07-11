// Sport-specific normalization: soccer up-clocks, UFC round/clock text,
// golf leaderboards (README §7.3 siblings of normalize.js).
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSoccerClockText,
  parseSoccerPeriodText,
  normalizeSoccerScoreboard,
} from "../services/vision/normalize-soccer.js";
import { normalizeFootballScoreboard } from "../services/vision/normalize-football.js";
import {
  parseRoundText,
  parseRoundClockText,
  normalizeUfcScoreboard,
} from "../services/vision/normalize-ufc.js";
import {
  parseToParText,
  parseThruText,
  normalizeGolfLeaderboard,
} from "../services/vision/normalize-golf.js";
import { UNREPORTED_CONFIDENCE } from "../services/vision/normalize.js";

// ── Soccer ──────────────────────────────────────────────────────────────────

test("soccer clock counts up: minutes with stoppage notation", () => {
  assert.equal(parseSoccerClockText("67'"), 67);
  assert.equal(parseSoccerClockText("67"), 67);
  assert.equal(parseSoccerClockText("45+2'"), 47);
  assert.equal(parseSoccerClockText("90+3"), 93);
  assert.equal(parseSoccerClockText(118), 118);
  assert.throws(() => parseSoccerClockText("2:14"), /Unparseable soccer clock/);
  assert.throws(() => parseSoccerClockText("half time"), /Unparseable soccer clock/);
});

test("soccer periods: halves and extra time", () => {
  assert.equal(parseSoccerPeriodText("1st"), 1);
  assert.equal(parseSoccerPeriodText("2nd"), 2);
  assert.equal(parseSoccerPeriodText("2H"), 2);
  assert.equal(parseSoccerPeriodText("ET"), 3);
  assert.equal(parseSoccerPeriodText("ET2"), 4);
  assert.equal(parseSoccerPeriodText(4), 4);
  assert.throws(() => parseSoccerPeriodText("Q4"), /Unparseable soccer period/);
});

test("soccer normalize lands '67 minutes' state in the typed contract", () => {
  const parsed = normalizeSoccerScoreboard({
    league: "FIFA World Cup",
    away_team_text: " arg ",
    home_team_text: "fra",
    away_score: "2",
    home_score: 0,
    period_text: "2nd",
    clock_text: "67'",
    field_confidences: { teams: 0.98, scores: 0.97, period: 0.96, clock: 0.95 },
  });
  assert.equal(parsed.sport, "soccer");
  assert.equal(parsed.away_team_text, "ARG");
  assert.equal(parsed.away_score, 2);
  assert.equal(parsed.period, 2);
  assert.equal(parsed.clock_seconds, null, "no countdown clock in soccer");
  assert.equal(parsed.extras.minute, 67);
  assert.equal(parsed.field_confidences.clock, 0.95);
});

// ── Football (delegates to the shared scoreboard normalizer) ────────────────

test("football normalize: NFL scoreboard with countdown clock and quarters", () => {
  const parsed = normalizeFootballScoreboard({
    away_team_text: "NE",
    home_team_text: "ATL",
    away_score: 3,
    home_score: 28,
    period_text: "3rd",
    clock_text: "8:31",
    field_confidences: { teams: 0.98, scores: 0.97, period: 0.98, clock: 0.95 },
  });
  assert.equal(parsed.sport, "football");
  assert.equal(parsed.league, "NFL");
  assert.equal(parsed.period, 3);
  assert.equal(parsed.clock_seconds, 511);
});

// ── UFC ─────────────────────────────────────────────────────────────────────

test("ufc round text variants", () => {
  assert.equal(parseRoundText("R3"), 3);
  assert.equal(parseRoundText("ROUND 3"), 3);
  assert.equal(parseRoundText("rd 5"), 5);
  assert.equal(parseRoundText(2), 2);
  assert.throws(() => parseRoundText("R6"), /Unparseable round/);
  assert.throws(() => parseRoundText("halftime"), /Unparseable round/);
});

test("ufc combined 'R3 2:45' parses into round + countdown seconds", () => {
  assert.deepEqual(parseRoundClockText("R3 2:45"), { round: 3, clock_seconds: 165 });
  assert.deepEqual(parseRoundClockText("ROUND 4 3:03"), { round: 4, clock_seconds: 183 });
  assert.throws(() => parseRoundClockText("2:45"), /Unparseable round\/clock/);
});

test("ufc normalize: fighters land in subject slots, scores stay honestly null", () => {
  const parsed = normalizeUfcScoreboard({
    fighter1_text: "khabib",
    fighter2_text: " mcgregor ",
    round_clock_text: "R3 2:45",
    scheduled_rounds: 5,
    field_confidences: { fighters: 0.97, round: 0.98, clock: 0.95 },
  });
  assert.equal(parsed.sport, "mma");
  assert.equal(parsed.away_team_text, "KHABIB");
  assert.equal(parsed.home_team_text, "MCGREGOR");
  assert.equal(parsed.away_score, null, "no score is ever invented");
  assert.equal(parsed.home_score, null);
  assert.equal(parsed.period, 3);
  assert.equal(parsed.clock_seconds, 165);
  assert.equal(parsed.extras.scheduled_rounds, 5);
  assert.equal(parsed.field_confidences.teams, 0.97, "fighters confidence maps to teams");
});

test("ufc normalize rejects bad scheduled rounds", () => {
  assert.throws(
    () =>
      normalizeUfcScoreboard({
        fighter1_text: "A",
        fighter2_text: "B",
        round_text: "R1",
        clock_text: "5:00",
        scheduled_rounds: 12,
      }),
    /scheduled_rounds/
  );
});

// ── Golf ────────────────────────────────────────────────────────────────────

test("golf to-par text: negative, even, positive", () => {
  assert.equal(parseToParText("-12"), -12);
  assert.equal(parseToParText("E"), 0);
  assert.equal(parseToParText("+3"), 3);
  assert.equal(parseToParText(-14), -14);
  assert.throws(() => parseToParText("birdie"), /Unparseable to-par/);
});

test("golf thru text: hole counts and finished", () => {
  assert.equal(parseThruText("16"), 16);
  assert.equal(parseThruText("THRU 12"), 12);
  assert.equal(parseThruText("F"), 18);
  assert.throws(() => parseThruText("19"), /Unparseable thru/);
});

test("golf normalize: leader (lower to-par) takes the away slot", () => {
  const parsed = normalizeGolfLeaderboard({
    players: [
      { name_text: "BROOKS KOEPKA", score_to_par_text: "-12", thru_text: "16" },
      { name_text: "TIGER WOODS", score_to_par_text: "-14", thru_text: "16" },
    ],
    field_confidences: { players: 0.96, scores: 0.96, holes: 0.95 },
  });
  assert.equal(parsed.away_team_text, "TIGER WOODS", "listed second but leads");
  assert.equal(parsed.home_team_text, "BROOKS KOEPKA");
  assert.equal(parsed.away_score, -14);
  assert.equal(parsed.home_score, -12);
  assert.equal(parsed.period, null, "no periods in golf");
  assert.equal(parsed.clock_seconds, null, "no clock in golf");
  assert.equal(parsed.extras.holes_remaining, 2);
});

test("golf normalize: a one-player leaderboard throws, unreported confidences stay low", () => {
  assert.throws(
    () => normalizeGolfLeaderboard({ players: [{ name_text: "TIGER", score_to_par_text: "-14", thru_text: "16" }] }),
    /at least 2 players/
  );
  const parsed = normalizeGolfLeaderboard({
    players: [
      { name_text: "TIGER WOODS", score_to_par_text: "-14", thru_text: "16" },
      { name_text: "BROOKS KOEPKA", score_to_par_text: "-12", thru_text: "16" },
    ],
  });
  assert.equal(parsed.field_confidences.scores, UNREPORTED_CONFIDENCE);
});
