// State-reconciliation invariants from README §7.5.
import test from "node:test";
import assert from "node:assert/strict";
import { Reconciler } from "../services/vision/reconciler.js";

const event = {
  event_id: "nba_2026_07_11_bos_nyk",
  away_team_id: "nba_bos",
  home_team_id: "nba_nyk",
};
const frame = (id) => ({ frame_id: id, captured_at: "2026-07-11T20:14:32.491Z" });
const parsed = (over = {}) => ({
  away_score: 104,
  home_score: 101,
  period: 4,
  clock_seconds: 134,
  field_confidences: { teams: 0.98, scores: 0.96, period: 0.99, clock: 0.94, possession: 0.61 },
  ...over,
});

test("accepts a clean observation", () => {
  const r = new Reconciler();
  const { accepted, state } = r.observe(event, parsed(), frame("f1"));
  assert.ok(accepted);
  assert.equal(state.away_score, 104);
});

test("rejects score decrease but retains last trusted state", () => {
  const r = new Reconciler();
  r.observe(event, parsed(), frame("f1"));
  const { accepted, state, reason } = r.observe(
    event,
    parsed({ away_score: 98 }),
    frame("f2")
  );
  assert.equal(accepted, false);
  assert.match(reason, /decreased/);
  assert.equal(state.away_score, 104, "retains previous state, never null");
});

test("rejects implausible score jump", () => {
  const r = new Reconciler();
  r.observe(event, parsed(), frame("f1"));
  const { accepted, reason } = r.observe(event, parsed({ away_score: 112 }), frame("f2"));
  assert.equal(accepted, false);
  assert.match(reason, /jump/);
});

test("rejects low-confidence frames", () => {
  const r = new Reconciler();
  const bad = parsed({
    field_confidences: { teams: 0.98, scores: 0.4, period: 0.99, clock: 0.94, possession: 0.6 },
  });
  const { accepted, state } = r.observe(event, bad, frame("f1"));
  assert.equal(accepted, false);
  assert.equal(state, null, "no trusted state yet");
});

test("accepts a normal 3-point progression", () => {
  const r = new Reconciler();
  r.observe(event, parsed(), frame("f1"));
  const { accepted, state } = r.observe(
    event,
    parsed({ away_score: 107, clock_seconds: 110 }),
    frame("f2")
  );
  assert.ok(accepted);
  assert.equal(state.away_score, 107);
});
