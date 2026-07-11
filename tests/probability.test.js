// Behavioral tests from README §7.6 — the minimum bar for any model version.
import test from "node:test";
import assert from "node:assert/strict";
import { winProbability } from "../services/probability/index.js";

const state = (over = {}) => ({
  event_id: "nba_2026_07_11_bos_nyk",
  away_team_id: "nba_bos",
  home_team_id: "nba_nyk",
  away_score: 0,
  home_score: 0,
  period: 1,
  clock_seconds: 720,
  observed_at: "2026-07-11T20:00:00Z",
  confidence: 0.95,
  ...over,
});

test("tied game at the start is near the pregame prior", () => {
  const pHome = winProbability(state(), "nba_nyk");
  const pAway = winProbability(state(), "nba_bos");
  assert.ok(pHome > 0.5 && pHome < 0.65, `home prior with court edge, got ${pHome}`);
  assert.ok(Math.abs(pHome + pAway - 1) < 1e-9, "probabilities complement");
});

test("a lead becomes more valuable as time expires", () => {
  const lead = { away_score: 90, home_score: 85 };
  const early = winProbability(state({ ...lead, period: 3, clock_seconds: 600 }), "nba_bos");
  const late = winProbability(state({ ...lead, period: 4, clock_seconds: 60 }), "nba_bos");
  assert.ok(late > early, `late ${late} should exceed early ${early}`);
});

test("up 20 with 30 seconds left is near-certain", () => {
  const p = winProbability(
    state({ away_score: 120, home_score: 100, period: 4, clock_seconds: 30 }),
    "nba_bos"
  );
  assert.ok(p > 0.99, `got ${p}`);
});

test("swapping perspective flips the probability", () => {
  const s = state({ away_score: 104, home_score: 101, period: 4, clock_seconds: 134 });
  const pAway = winProbability(s, "nba_bos");
  const pHome = winProbability(s, "nba_nyk");
  assert.ok(pAway > 0.5, "leading team favored");
  assert.ok(Math.abs(pAway + pHome - 1) < 1e-9, "outcomes complement");
});

test("probabilities stay strictly between 0 and 1", () => {
  const blowout = state({ away_score: 160, home_score: 60, period: 4, clock_seconds: 1 });
  const p = winProbability(blowout, "nba_bos");
  assert.ok(p > 0 && p < 1);
  const done = state({ away_score: 100, home_score: 90, period: 4, clock_seconds: 0 });
  const pd = winProbability(done, "nba_bos");
  assert.ok(pd > 0 && pd < 1 && pd > 0.99);
});

test("unknown team throws instead of guessing", () => {
  assert.throws(() => winProbability(state(), "nba_lal"));
});
