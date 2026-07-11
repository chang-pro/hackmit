// Field normalization for noisy backend output (README §7.3, Slice 2).
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClockText,
  parsePeriodText,
  normalizeTeamText,
  normalizeScoreboard,
  UNREPORTED_CONFIDENCE,
} from "../services/vision/normalize.js";

test("clock text minutes:seconds -> seconds", () => {
  assert.equal(parseClockText("2:14"), 134);
  assert.equal(parseClockText("02:14"), 134);
  assert.equal(parseClockText("12:00"), 720);
  assert.equal(parseClockText("0:59"), 59);
});

test("clock text under a minute is floored (documented choice)", () => {
  assert.equal(parseClockText("14.5"), 14);
  assert.equal(parseClockText("0:59.9"), 59);
  assert.equal(parseClockText("1:05.3"), 65);
});

test("numeric clock passes through, floored", () => {
  assert.equal(parseClockText(134), 134);
  assert.equal(parseClockText(14.5), 14);
});

test("garbage clock text throws clearly", () => {
  assert.throws(() => parseClockText("half time"), /Unparseable clock/);
  assert.throws(() => parseClockText(""), /Unparseable clock/);
  assert.throws(() => parseClockText("2:99"), /Unparseable clock/);
});

test("period text variants resolve to numbers", () => {
  assert.equal(parsePeriodText("1st"), 1);
  assert.equal(parsePeriodText("2nd"), 2);
  assert.equal(parsePeriodText("3rd"), 3);
  assert.equal(parsePeriodText("4th"), 4);
  assert.equal(parsePeriodText("Q4"), 4);
  assert.equal(parsePeriodText("4Q"), 4);
  assert.equal(parsePeriodText("4"), 4);
  assert.equal(parsePeriodText(4), 4);
});

test("overtime periods: OT = 5, second overtime = 6", () => {
  assert.equal(parsePeriodText("OT"), 5);
  assert.equal(parsePeriodText("ot"), 5);
  assert.equal(parsePeriodText("OT1"), 5);
  assert.equal(parsePeriodText("2OT"), 6);
  assert.equal(parsePeriodText("OT2"), 6);
});

test("garbage period text throws clearly", () => {
  assert.throws(() => parsePeriodText("halftime"), /Unparseable period/);
  assert.throws(() => parsePeriodText(""), /Unparseable period/);
});

test("team text is trimmed, whitespace-collapsed, uppercased", () => {
  assert.equal(normalizeTeamText("  bos "), "BOS");
  assert.equal(normalizeTeamText("new  york"), "NEW YORK");
  assert.throws(() => normalizeTeamText("   "), /Empty team text/);
});

test("normalizeScoreboard lands noisy backend output in the typed contract", () => {
  const parsed = normalizeScoreboard({
    away_team_text: " bos ",
    home_team_text: "nyk",
    away_score: "104",
    home_score: 101,
    period_text: "4th",
    clock_text: "2:14",
    shot_clock_seconds: 14.9,
    possession_team_text: "bos",
    field_confidences: { teams: 0.98, scores: 0.96, period: 0.99, clock: 0.94, possession: 0.61 },
  });
  assert.equal(parsed.away_team_text, "BOS");
  assert.equal(parsed.home_team_text, "NYK");
  assert.equal(parsed.away_score, 104);
  assert.equal(parsed.home_score, 101);
  assert.equal(parsed.period, 4);
  assert.equal(parsed.clock_seconds, 134);
  assert.equal(parsed.shot_clock_seconds, 14);
  assert.equal(parsed.possession_team_text, "BOS");
  assert.equal(parsed.field_confidences.clock, 0.94);
});

test("normalizeScoreboard prefers typed fields when present", () => {
  const parsed = normalizeScoreboard({
    away_team_text: "BOS",
    home_team_text: "NYK",
    away_score: 104,
    home_score: 101,
    period: 4,
    clock_seconds: 134,
    field_confidences: { teams: 1, scores: 1, period: 1, clock: 1 },
  });
  assert.equal(parsed.period, 4);
  assert.equal(parsed.clock_seconds, 134);
});

test("unreported confidences default low so the gate distrusts them", () => {
  const parsed = normalizeScoreboard({
    away_team_text: "BOS",
    home_team_text: "NYK",
    away_score: 104,
    home_score: 101,
    period: "OT",
    clock_text: "0:30",
  });
  assert.equal(parsed.period, 5);
  assert.equal(parsed.clock_seconds, 30);
  assert.equal(parsed.field_confidences.teams, UNREPORTED_CONFIDENCE);
  assert.equal(parsed.field_confidences.clock, UNREPORTED_CONFIDENCE);
});

test("unparseable required fields throw instead of passing garbage on", () => {
  assert.throws(
    () =>
      normalizeScoreboard({
        away_team_text: "BOS",
        home_team_text: "NYK",
        away_score: "a lot",
        home_score: 101,
        period: 4,
        clock_seconds: 134,
      }),
    /Unparseable score/
  );
});
