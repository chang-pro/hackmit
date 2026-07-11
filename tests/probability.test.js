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

// --- Overtime (period >= 5, NBA OT periods are 300 seconds) ---

test("tied entering overtime is near the pregame prior", () => {
  const ot = state({ away_score: 100, home_score: 100, period: 5, clock_seconds: 300 });
  const pHome = winProbability(ot, "nba_nyk");
  const pAway = winProbability(ot, "nba_bos");
  assert.ok(pHome > 0.5 && pHome < 0.58, `slight home edge only, got ${pHome}`);
  assert.ok(Math.abs(pHome + pAway - 1) < 1e-9, "probabilities complement");
});

test("a small lead late in overtime is strong", () => {
  const p = winProbability(
    state({ away_score: 110, home_score: 106, period: 5, clock_seconds: 20 }),
    "nba_bos"
  );
  assert.ok(p > 0.95, `up 4 with 20s of OT left should be strong, got ${p}`);
});

test("OT time remaining is just the OT clock — same as the equivalent Q4 moment", () => {
  const lead = { away_score: 105, home_score: 102 };
  const q4 = winProbability(state({ ...lead, period: 4, clock_seconds: 120 }), "nba_bos");
  const ot = winProbability(state({ ...lead, period: 5, clock_seconds: 120 }), "nba_bos");
  assert.equal(ot, q4, "OT clock 2:00 has the same seconds remaining as Q4 2:00");
});

test("an out-of-range OT clock is clamped to the 300-second period length", () => {
  const glitch = state({ away_score: 100, home_score: 100, period: 5, clock_seconds: 720 });
  const capped = state({ away_score: 100, home_score: 100, period: 5, clock_seconds: 300 });
  assert.equal(winProbability(glitch, "nba_nyk"), winProbability(capped, "nba_nyk"));
});

test("a tie at the end of an overtime period heads to another OT near the prior", () => {
  const p = winProbability(
    state({ away_score: 110, home_score: 110, period: 6, clock_seconds: 0 }),
    "nba_nyk"
  );
  assert.ok(p > 0.5 && p < 0.58, `got ${p}`);
});

// --- Optional pregame prior (drift adjustment, decays with time) ---

test("a 65% pregame favorite tied at halftime is still favored", () => {
  const half = state({ away_score: 50, home_score: 50, period: 2, clock_seconds: 0 });
  const p = winProbability(half, "nba_bos", { pregameProbability: 0.65 });
  assert.ok(p > 0.55 && p < 0.65, `favorite should stay favored, got ${p}`);
});

test("the pregame prior replaces the home edge and complements exactly", () => {
  const s = state({ away_score: 60, home_score: 58, period: 3, clock_seconds: 400 });
  const pAway = winProbability(s, "nba_bos", { pregameProbability: 0.65 });
  const pHome = winProbability(s, "nba_nyk", { pregameProbability: 0.35 });
  assert.ok(Math.abs(pAway + pHome - 1) < 1e-9, "complementary priors complement");
});

test("the pregame prior's effect decays to zero as time expires", () => {
  const tied = (period, clock) =>
    state({ away_score: 80, home_score: 80, period, clock_seconds: clock });
  const neutral = (s) => winProbability(s, "nba_bos");
  const favored = (s) => winProbability(s, "nba_bos", { pregameProbability: 0.65 });

  const effectHalf = favored(tied(2, 0)) - neutral(tied(2, 0));
  const effectLate = favored(tied(4, 120)) - neutral(tied(4, 120));
  const effectFinal = favored(tied(4, 2)) - neutral(tied(4, 2));
  assert.ok(effectHalf > effectLate && effectLate > effectFinal, "monotone decay");
  assert.ok(effectFinal < 0.02, `nearly gone with 2s left, got ${effectFinal}`);

  // A decided game at 0:00 ignores the prior entirely.
  const done = state({ away_score: 98, home_score: 100, period: 4, clock_seconds: 0 });
  const p = winProbability(done, "nba_bos", { pregameProbability: 0.65 });
  assert.ok(p < 0.01, `trailing favorite at the buzzer still loses, got ${p}`);
});

test("an out-of-range pregame prior throws", () => {
  assert.throws(() => winProbability(state(), "nba_bos", { pregameProbability: 0 }));
  assert.throws(() => winProbability(state(), "nba_bos", { pregameProbability: 1 }));
  assert.throws(() => winProbability(state(), "nba_bos", { pregameProbability: 65 }));
});

// --- Optional possession adjustment (flagged OFF by default) ---

test("possession is ignored unless explicitly enabled", () => {
  const s = state({
    away_score: 80,
    home_score: 80,
    period: 4,
    clock_seconds: 60,
    possession_team_id: "nba_bos",
  });
  const { possession_team_id, ...rest } = s;
  assert.equal(winProbability(s, "nba_bos"), winProbability(rest, "nba_bos"));
});

test("with the flag on, possession is worth about +0.6 points of margin", () => {
  const s = state({
    away_score: 80,
    home_score: 80,
    period: 4,
    clock_seconds: 60,
    possession_team_id: "nba_bos",
  });
  const opts = { includePossession: true };
  const pBall = winProbability(s, "nba_bos", opts);
  const pDefense = winProbability(s, "nba_nyk", opts);
  const pNoBall = winProbability(s, "nba_bos");
  assert.ok(pBall > pNoBall, "having the ball helps");
  assert.ok(Math.abs(pBall + pDefense - 1) < 1e-9, "outcomes complement");
});

test("with the flag on but possession unknown, nothing changes", () => {
  const s = state({ away_score: 80, home_score: 80, period: 4, clock_seconds: 60 });
  assert.equal(
    winProbability({ ...s, possession_team_id: null }, "nba_bos", { includePossession: true }),
    winProbability(s, "nba_bos")
  );
});
