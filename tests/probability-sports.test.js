// Behavioral tests for the four new per-sport probability models
// (README §7.6 bar: deterministic, bounded, explainable, monotone).
import test from "node:test";
import assert from "node:assert/strict";
import * as soccer from "../services/probability/models/soccer.js";
import * as football from "../services/probability/models/football.js";
import * as ufc from "../services/probability/models/ufc.js";
import * as golf from "../services/probability/models/golf.js";

// ── Soccer (Poisson goals, clock counts up) ─────────────────────────────────

const soccerState = (over = {}) => ({
  event_id: "soccer_2022_12_18_arg_fra",
  away_team_id: "wc_arg",
  home_team_id: "wc_fra",
  away_score: 0,
  home_score: 0,
  period: 1,
  clock_seconds: null,
  extras: { minute: 0 },
  observed_at: "2022-12-18T15:00:00Z",
  confidence: 0.95,
  ...over,
});

test("soccer: 2-0 up at 85' is above 0.95", () => {
  const p = soccer.winProbability(
    soccerState({ away_score: 2, home_score: 0, period: 2, extras: { minute: 85 } }),
    "wc_arg"
  );
  assert.ok(p > 0.95, `got ${p}`);
});

test("soccer: kickoff win probabilities leave real draw mass and a home edge", () => {
  const pHome = soccer.winProbability(soccerState(), "wc_fra");
  const pAway = soccer.winProbability(soccerState(), "wc_arg");
  assert.ok(pHome > pAway, "home scoring-rate edge favors the home side");
  assert.ok(pHome + pAway < 0.85, `draw probability must remain, got ${pHome + pAway}`);
  assert.ok(pHome > 0.3 && pHome < 0.55, `got ${pHome}`);
});

test("soccer: a one-goal lead is worth more later in the match", () => {
  const lead = { away_score: 1, home_score: 0 };
  const early = soccer.winProbability(
    soccerState({ ...lead, extras: { minute: 20 } }), "wc_arg");
  const late = soccer.winProbability(
    soccerState({ ...lead, period: 2, extras: { minute: 80 } }), "wc_arg");
  assert.ok(late > early, `late ${late} should exceed early ${early}`);
});

test("soccer: stoppage past 90' keeps a nominal minute, never claims the match over", () => {
  const p = soccer.winProbability(
    soccerState({ away_score: 1, home_score: 0, period: 2, extras: { minute: 93 } }),
    "wc_arg"
  );
  assert.ok(p > 0.9 && p < 1, `got ${p}`);
});

test("soccer: extra time uses the 120-minute total (WC final at 118')", () => {
  const tied = soccerState({ away_score: 3, home_score: 3, period: 4, extras: { minute: 118 } });
  const pArg = soccer.winProbability(tied, "wc_arg");
  const pFra = soccer.winProbability(tied, "wc_fra");
  // A 120' draw heads to penalties, which this model does not count as a win.
  assert.ok(pArg < 0.1 && pFra < 0.1, `both should be small: ${pArg}, ${pFra}`);
  assert.ok(pArg > 0 && pFra > 0, "bounded away from zero");
});

test("soccer: missing minute throws instead of guessing", () => {
  assert.throws(
    () => soccer.winProbability(soccerState({ extras: {} }), "wc_arg"),
    /extras\.minute/
  );
  assert.throws(() => soccer.winProbability(soccerState(), "wc_bra"), /not in event/);
});

// ── NFL (Brownian margin, clock counts down) ────────────────────────────────

const nflState = (over = {}) => ({
  event_id: "football_2017_02_05_ne_atl",
  away_team_id: "nfl_ne",
  home_team_id: "nfl_atl",
  away_score: 0,
  home_score: 0,
  period: 1,
  clock_seconds: 900,
  observed_at: "2017-02-05T23:30:00Z",
  confidence: 0.95,
  ...over,
});

test("nfl: tie game at kickoff sits near the ~2.0-point home edge", () => {
  const pHome = football.winProbability(nflState(), "nfl_atl");
  const pAway = football.winProbability(nflState(), "nfl_ne");
  assert.ok(pHome > 0.5 && pHome < 0.6, `small home edge, got ${pHome}`);
  assert.ok(Math.abs(pHome + pAway - 1) < 1e-9, "outcomes complement");
});

test("nfl: down 28-3 in Q3 is a very deep hole", () => {
  const p = football.winProbability(
    nflState({ away_score: 3, home_score: 28, period: 3, clock_seconds: 511 }),
    "nfl_ne"
  );
  assert.ok(p < 0.05, `got ${p}`);
});

test("nfl: a lead is worth more as time expires", () => {
  const lead = { away_score: 20, home_score: 17 };
  const early = football.winProbability(nflState({ ...lead, period: 2, clock_seconds: 600 }), "nfl_ne");
  const late = football.winProbability(nflState({ ...lead, period: 4, clock_seconds: 120 }), "nfl_ne");
  assert.ok(late > early, `late ${late} should exceed early ${early}`);
});

test("nfl: pregame prior replaces the home edge and decays with time", () => {
  const tiedLate = nflState({ away_score: 28, home_score: 28, period: 4, clock_seconds: 57 });
  const withPrior = football.winProbability(tiedLate, "nfl_ne", { pregameProbability: 0.61 });
  const neutral = football.winProbability(tiedLate, "nfl_ne");
  assert.ok(withPrior > 0.5, "favorite keeps a sliver in a late tie");
  assert.ok(withPrior - 0.5 < 0.1, `mostly decayed with 57s left, got ${withPrior}`);
  assert.ok(withPrior > neutral, "prior beats being the road team");
  assert.throws(() => football.winProbability(nflState(), "nfl_ne", { pregameProbability: 1 }));
});

test("nfl: bounded and total — decided at 0:00, OT clamps out-of-range clocks", () => {
  const done = football.winProbability(
    nflState({ away_score: 34, home_score: 28, period: 4, clock_seconds: 0 }), "nfl_ne");
  assert.ok(done > 0.99 && done < 1);
  const glitch = football.winProbability(
    nflState({ away_score: 28, home_score: 28, period: 5, clock_seconds: 900 }), "nfl_atl");
  const capped = football.winProbability(
    nflState({ away_score: 28, home_score: 28, period: 5, clock_seconds: 600 }), "nfl_atl");
  assert.equal(glitch, capped, "OT clock clamps to the 600-second period");
  assert.throws(() => football.winProbability(nflState(), "nfl_kc"), /not in event/);
});

// ── UFC (prior-anchored, no on-screen score) ────────────────────────────────

const ufcState = (over = {}) => ({
  event_id: "ufc_2018_10_06_khabib_mcgregor",
  away_team_id: "ufc_khabib",
  home_team_id: "ufc_mcgregor",
  away_score: null,
  home_score: null,
  period: 1,
  clock_seconds: 300,
  extras: { scheduled_rounds: 5 },
  observed_at: "2018-10-07T04:00:00Z",
  confidence: 0.95,
  ...over,
});

test("ufc: with no prior the estimate is exactly 0.5 at every moment", () => {
  for (const [round, clock] of [[1, 300], [2, 210], [4, 183], [5, 0]]) {
    const p = ufc.winProbability(ufcState({ period: round, clock_seconds: clock }), "ufc_khabib");
    assert.equal(p, 0.5, `round ${round} clock ${clock}`);
  }
});

test("ufc: at the opening bell the full prior passes through", () => {
  const p = ufc.winProbability(ufcState(), "ufc_khabib", { pregameProbability: 0.62 });
  assert.ok(Math.abs(p - 0.62) < 1e-9, `got ${p}`);
});

test("ufc: the favorite's edge shrinks as rounds elapse but never vanishes", () => {
  const opts = { pregameProbability: 0.62 };
  const r1 = ufc.winProbability(ufcState(), "ufc_khabib", opts);
  const r2 = ufc.winProbability(ufcState({ period: 2, clock_seconds: 210 }), "ufc_khabib", opts);
  const r4 = ufc.winProbability(ufcState({ period: 4, clock_seconds: 183 }), "ufc_khabib", opts);
  const finalBell = ufc.winProbability(ufcState({ period: 5, clock_seconds: 0 }), "ufc_khabib", opts);
  assert.ok(r1 > r2 && r2 > r4 && r4 > finalBell, `monotone: ${r1} ${r2} ${r4} ${finalBell}`);
  // Decision share survives: 0.5 + 0.12 * 0.6 = 0.572 at the final bell.
  assert.ok(Math.abs(finalBell - 0.572) < 1e-9, `judges keep the edge, got ${finalBell}`);
});

test("ufc: complementary priors give complementary fighters", () => {
  const s = ufcState({ period: 3, clock_seconds: 100 });
  const pK = ufc.winProbability(s, "ufc_khabib", { pregameProbability: 0.62 });
  const pM = ufc.winProbability(s, "ufc_mcgregor", { pregameProbability: 0.38 });
  assert.ok(Math.abs(pK + pM - 1) < 1e-9);
});

test("ufc: invalid rounds, priors, and fighters throw", () => {
  assert.throws(() => ufc.winProbability(ufcState({ period: 6 }), "ufc_khabib"), /round/);
  assert.throws(
    () => ufc.winProbability(ufcState({ extras: { scheduled_rounds: 7 } }), "ufc_khabib"),
    /scheduled_rounds/
  );
  assert.throws(() => ufc.winProbability(ufcState(), "ufc_khabib", { pregameProbability: 0 }));
  assert.throws(() => ufc.winProbability(ufcState(), "ufc_jones"), /not in event/);
});

// ── Golf (stroke lead vs holes remaining) ───────────────────────────────────

const golfState = (over = {}) => ({
  event_id: "golf_2019_04_14_tiger_koepka",
  away_team_id: "pga_tiger",
  home_team_id: "pga_koepka",
  away_score: -14,
  home_score: -12,
  period: null,
  clock_seconds: null,
  extras: { holes_remaining: 2 },
  observed_at: "2019-04-14T18:41:50Z",
  confidence: 0.95,
  ...over,
});

test("golf: a 3-stroke lead with 2 holes left is near-certain", () => {
  const p = golf.winProbability(
    golfState({ away_score: -14, home_score: -11 }), "pga_tiger");
  assert.ok(p > 0.99, `got ${p}`);
});

test("golf: tied is exactly 0.5, with holes left or in a playoff", () => {
  assert.equal(
    golf.winProbability(golfState({ away_score: -11, home_score: -11, extras: { holes_remaining: 6 } }), "pga_tiger"),
    0.5
  );
  assert.equal(
    golf.winProbability(golfState({ away_score: -11, home_score: -11, extras: { holes_remaining: 0 } }), "pga_tiger"),
    0.5
  );
});

test("golf: the same lead is worth more with fewer holes remaining", () => {
  const wide = golf.winProbability(golfState({ extras: { holes_remaining: 12 } }), "pga_tiger");
  const tight = golf.winProbability(golfState({ extras: { holes_remaining: 2 } }), "pga_tiger");
  assert.ok(tight > wide, `2-shot lead: thru-16 ${tight} > thru-6 ${wide}`);
});

test("golf: perspectives complement and a finished round is decided but bounded", () => {
  const s = golfState();
  const pT = golf.winProbability(s, "pga_tiger");
  const pK = golf.winProbability(s, "pga_koepka");
  assert.ok(Math.abs(pT + pK - 1) < 1e-9);
  const done = golf.winProbability(golfState({ extras: { holes_remaining: 0 } }), "pga_tiger");
  assert.ok(done > 0.99 && done < 1, "clamped, never a claimed certainty");
});

test("golf: missing holes_remaining or unknown player throws", () => {
  assert.throws(() => golf.winProbability(golfState({ extras: {} }), "pga_tiger"), /holes_remaining/);
  assert.throws(() => golf.winProbability(golfState(), "pga_spieth"), /not in event/);
});
