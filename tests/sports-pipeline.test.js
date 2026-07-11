// End-to-end pipeline runs for every new sport's replay fixtures, plus the
// mock adapter's period-accurate price schedules and sport-aware guards.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline } from "../services/api/pipeline.js";
import { mockAdapter } from "../services/market/mock-adapter.js";
import { Reconciler } from "../services/vision/reconciler.js";
import { getSport } from "../services/sports/index.js";

const FRAMES = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "fixtures", "frames");
const moment = (sportId, name) =>
  runPipeline(
    join(FRAMES, `${name}.json`),
    mockAdapter,
    null,
    new Reconciler(getSport(sportId).reconcilerRules),
    sportId
  );

test("soccer replay: ARG 2-0 at 60' is a strong, ready comparison", async () => {
  const out = await moment("soccer", "wc22_final_60min");
  assert.equal(out.sport, "soccer");
  assert.equal(out.event.event_id, "soccer_2022_12_18_arg_fra");
  assert.equal(out.estimate.outcome, "wc_arg_wins");
  assert.equal(out.estimate.model_version, "soccer-win-probability-v1");
  assert.ok(out.estimate.probability > 0.85, `got ${out.estimate.probability}`);
  assert.equal(out.state.extras.minute, 60);
  assert.equal(out.market.is_mock, true, "replay market data is labeled");
  assert.equal(out.market.probability, 0.85, "period-2 scheduled price");
  assert.equal(out.presentation.status, "ready");
});

test("soccer replay: 3-3 at 118' — model prices pre-penalty win, market prices the match", async () => {
  const out = await moment("soccer", "wc22_final_118min");
  assert.equal(out.state.period, 4);
  assert.ok(out.estimate.probability < 0.1, `late-ET tie, got ${out.estimate.probability}`);
  assert.equal(out.market.probability, 0.47, "extra-time scheduled price (pens included)");
  assert.equal(out.comparison.direction, "model_lower");
});

test("nfl replay: 28-3 in Q3 crushes the Patriots' estimate and the market agrees", async () => {
  const out = await moment("football", "sb51_q3_831");
  assert.equal(out.event.event_id, "football_2017_02_05_ne_atl");
  assert.equal(out.estimate.outcome, "nfl_ne_wins");
  assert.equal(out.estimate.model_version, "nfl-win-probability-v1");
  assert.ok(out.estimate.probability < 0.05, `got ${out.estimate.probability}`);
  assert.equal(out.market.probability, 0.04, "Q3 scheduled price");
  assert.equal(out.presentation.status, "ready");
});

test("nfl replay: 28-28 with 0:57 left is near a coin flip", async () => {
  const out = await moment("football", "sb51_q4_057");
  assert.equal(out.state.away_score, 28);
  assert.equal(out.state.home_score, 28);
  assert.ok(
    out.estimate.probability > 0.45 && out.estimate.probability < 0.6,
    `got ${out.estimate.probability}`
  );
  assert.equal(out.market.probability, 0.55, "Q4 scheduled price");
});

test("ufc replay: prior-anchored estimate with null scores flows end to end", async () => {
  const r2 = await moment("ufc", "ufc229_r2");
  assert.equal(r2.event.event_id, "ufc_2018_10_06_khabib_mcgregor");
  assert.equal(r2.estimate.outcome, "ufc_khabib_wins");
  assert.equal(r2.estimate.model_version, "ufc-win-probability-v1");
  assert.equal(r2.state.away_score, null, "no invented MMA score");
  assert.equal(r2.state.extras.scheduled_rounds, 5);
  assert.equal(r2.market.probability, 0.73, "round-2 scheduled price");
  assert.equal(r2.presentation.status, "ready");

  const r4 = await moment("ufc", "ufc229_r4");
  assert.ok(
    r4.estimate.probability < r2.estimate.probability,
    "finish share of the prior is spent as rounds pass"
  );
  assert.equal(r4.market.probability, 0.86, "round-4 scheduled price");
});

test("golf replay: tied thru 12 is a coin flip; -14 vs -12 thru 16 is near-certain", async () => {
  const h12 = await moment("golf", "masters19_h12");
  assert.equal(h12.event.event_id, "golf_2019_04_14_tiger_molinari");
  assert.equal(h12.estimate.outcome, "pga_tiger_wins");
  assert.equal(h12.estimate.probability, 0.5);
  assert.equal(h12.state.period, null);
  assert.equal(h12.state.extras.holes_remaining, 6);

  const h16 = await moment("golf", "masters19_h16");
  assert.equal(h16.event.event_id, "golf_2019_04_14_tiger_koepka");
  assert.ok(h16.estimate.probability > 0.99, `got ${h16.estimate.probability}`);
  assert.equal(h16.market.probability, 0.89);
  assert.match(h16.presentation.short_text, /^TIGER /);
});

test("a fixture served under the wrong sport fails loudly", async () => {
  // The NFL fixture normalizes fine under NBA rules (same scoreboard shape),
  // so the sport-tag mismatch guard is what must catch it.
  await assert.rejects(
    () => moment("nba", "sb51_q3_831"),
    /does not match requested sport "nba"/
  );
  // Structurally different fixtures (soccer up-clock) die in extraction —
  // also loud, never a silently wrong comparison.
  await assert.rejects(() => moment("nba", "wc22_final_60min"));
});

test("mock adapter: unique-match rule holds across sports; schedules fall back to base prices", () => {
  assert.throws(() => mockAdapter.find_market("ufc_2018_10_06_khabib_mcgregor", "wc_arg_wins"));
  const id = mockAdapter.find_market("soccer_2022_12_18_arg_fra", "wc_arg_wins");
  // No state passed -> the base (unscheduled) price applies.
  const snap = mockAdapter.get_market_snapshot(id);
  assert.equal(snap.display_probability, 0.56);
  assert.equal(snap.is_mock, true);
  // A state that matches no schedule entry also falls back to the base price.
  const off = mockAdapter.get_market_snapshot(id, { period: 1 });
  assert.equal(off.display_probability, 0.56);
});

test("reconciler sport rules: golf to-par may decrease, soccer goals may not", () => {
  const golfR = new Reconciler(getSport("golf").reconcilerRules);
  const golfEvent = {
    event_id: "golf_2019_04_14_tiger_koepka",
    away_team_id: "pga_tiger",
    home_team_id: "pga_koepka",
  };
  const golfParsed = (away, home) => ({
    away_score: away,
    home_score: home,
    period: null,
    clock_seconds: null,
    extras: { holes_remaining: 3 },
    field_confidences: { teams: 0.96, scores: 0.96, holes: 0.95 },
  });
  const f = (id) => ({ frame_id: id, captured_at: "2019-04-14T18:00:00Z" });
  golfR.observe(golfEvent, golfParsed(-13, -12), f("g1"));
  const birdie = golfR.observe(golfEvent, golfParsed(-14, -12), f("g2"));
  assert.equal(birdie.accepted, true, "a birdie lowers to-par and is accepted");

  const soccerR = new Reconciler(getSport("soccer").reconcilerRules);
  const soccerEvent = {
    event_id: "soccer_2022_12_18_arg_fra",
    away_team_id: "wc_arg",
    home_team_id: "wc_fra",
  };
  const soccerParsed = (away, home) => ({
    away_score: away,
    home_score: home,
    period: 2,
    clock_seconds: null,
    extras: { minute: 60 },
    field_confidences: { teams: 0.98, scores: 0.97, period: 0.96, clock: 0.95 },
  });
  soccerR.observe(soccerEvent, soccerParsed(2, 0), f("s1"));
  const ghostGoal = soccerR.observe(soccerEvent, soccerParsed(1, 0), f("s2"));
  assert.equal(ghostGoal.accepted, false);
  assert.match(ghostGoal.reason, /decreased/);
  const doubleJump = soccerR.observe(soccerEvent, soccerParsed(2, 2), f("s3"));
  assert.equal(doubleJump.accepted, false, "two goals in one observation is suspect");
  assert.match(doubleJump.reason, /jump/);
});

test("reconciler with null scores (ufc) skips score invariants but keeps round order", () => {
  const r = new Reconciler(getSport("ufc").reconcilerRules);
  const event = {
    event_id: "ufc_2018_10_06_khabib_mcgregor",
    away_team_id: "ufc_khabib",
    home_team_id: "ufc_mcgregor",
  };
  const parsed = (round, clock) => ({
    away_score: null,
    home_score: null,
    period: round,
    clock_seconds: clock,
    extras: { scheduled_rounds: 5 },
    field_confidences: { teams: 0.97, period: 0.98, clock: 0.95 },
  });
  const f = (id) => ({ frame_id: id, captured_at: "2018-10-07T04:00:00Z" });
  assert.equal(r.observe(event, parsed(2, 210), f("u1")).accepted, true);
  assert.equal(r.observe(event, parsed(3, 290), f("u2")).accepted, true, "null scores never block");
  const rewind = r.observe(event, parsed(2, 100), f("u3"));
  assert.equal(rewind.accepted, false);
  assert.match(rewind.reason, /period decreased/);
});
