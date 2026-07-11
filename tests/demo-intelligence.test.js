import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisFromDemoIntelligence,
  getDemoRehearsalInsight,
  listDemoIntelligencePacks,
  selectDemoIntelligence,
} from "../services/demo/intelligence.js";
import { LiveEventAnalyzer } from "../services/api/live-event-analyzer.js";
import { createBloomServer } from "../services/api/server.js";

function observation(overrides = {}) {
  return {
    sport: "soccer",
    competition: "FIFA World Cup",
    event_name: "Argentina vs France",
    event_identity: "soccer:argentina-vs-france-world-cup-final",
    event_format: "team_event",
    participants: [{ name: "Argentina" }, { name: "France" }],
    participant_a: "Argentina",
    participant_b: "France",
    score_a: 2,
    score_b: 0,
    score_display: "ARG 2–0 FRA",
    phase: "Second half",
    clock: "60'",
    event_status: "replay",
    possession_or_control: "UNKNOWN",
    situation: "Open play",
    visible_facts: [],
    changes_across_frames: [],
    confidence: 0.94,
    ...overrides,
  };
}

const TARGETS = [
  [
    observation(),
    "world-cup-2022-final",
    "argentina-two-goal-lead",
  ],
  [
    observation({
      sport: "basketball",
      competition: "NBA Finals",
      event_name: "Cavaliers vs Warriors",
      event_identity: "nba:cavaliers-vs-warriors-finals-game-7",
      participants: [{ name: "Cleveland Cavaliers" }, { name: "Golden State Warriors" }],
      participant_a: "Cleveland Cavaliers",
      participant_b: "Golden State Warriors",
      score_a: 92,
      score_b: 89,
      score_display: "CLE 92–89 GSW",
      phase: "Q4",
      clock: "0:53",
    }),
    "nba-finals-2016-game-7",
    "irving-three",
  ],
  [
    observation({
      sport: "american_football",
      competition: "Super Bowl LI",
      event_name: "Patriots vs Falcons",
      event_identity: "nfl:patriots-vs-falcons-super-bowl-li",
      participants: [{ name: "New England Patriots" }, { name: "Atlanta Falcons" }],
      participant_a: "New England Patriots",
      participant_b: "Atlanta Falcons",
      score_a: 28,
      score_b: 28,
      score_display: "NE 28–28 ATL",
      phase: "Q4",
      clock: "0:57",
    }),
    "super-bowl-li",
    "game-tied",
  ],
  [
    observation({
      sport: "mma",
      competition: "UFC 229",
      event_name: "Khabib vs McGregor",
      event_identity: "mma:khabib-vs-mcgregor-ufc-229",
      event_format: "head_to_head",
      participants: [{ name: "Khabib Nurmagomedov" }, { name: "Conor McGregor" }],
      participant_a: "Khabib Nurmagomedov",
      participant_b: "Conor McGregor",
      score_a: 0,
      score_b: 0,
      score_display: "",
      phase: "Round 4",
      clock: "1:57",
      situation: "Back control and submission threat",
    }),
    "ufc-229",
    "round-four-finish-window",
  ],
];

const REHEARSAL_CHECKPOINTS = [
  ["world-cup-2022-final", "argentina-two-goal-lead"],
  ["world-cup-2022-final", "france-equalizer"],
  ["world-cup-2022-final", "extra-time-level"],
  ["nba-finals-2016-game-7", "halftime-deficit"],
  ["nba-finals-2016-game-7", "late-tie"],
  ["nba-finals-2016-game-7", "irving-three"],
  ["super-bowl-li", "twenty-eight-three"],
  ["super-bowl-li", "one-score-game"],
  ["super-bowl-li", "game-tied"],
  ["ufc-229", "round-two-control"],
  ["ufc-229", "round-three-reset"],
  ["ufc-229", "round-four-finish-window"],
];

test("all four funding-demo intelligence packs are published", () => {
  const packs = listDemoIntelligencePacks();
  assert.equal(packs.length, 4);
  assert.deepEqual(new Set(packs.map((pack) => pack.sport)), new Set([
    "soccer",
    "basketball",
    "american_football",
    "mma",
  ]));
  for (const pack of packs) {
    assert.ok(pack.moments >= 3, `${pack.id} has a real timeline`);
    assert.match(pack.disclosure, /illustrative|historical/i);
  }
});

test("all twelve rehearsal checkpoints resolve exactly without model calls", () => {
  assert.equal(REHEARSAL_CHECKPOINTS.length, 12);
  const catalog = new Map(
    listDemoIntelligencePacks().map((pack) => [
      pack.id,
      new Set(pack.checkpoints.map((checkpoint) => checkpoint.id)),
    ])
  );

  for (const [packId, momentId] of REHEARSAL_CHECKPOINTS) {
    assert.ok(catalog.get(packId)?.has(momentId), `${packId}/${momentId} is published`);
    const insight = getDemoRehearsalInsight(packId, momentId);
    assert.equal(insight.source, "demo_rehearsal");
    assert.equal(insight.extraction, "precollected-rehearsal");
    assert.equal(insight.rehearsal.is_rehearsal, true);
    assert.equal(insight.rehearsal.no_model_calls, true);
    assert.equal(insight.demo_intelligence.pack_id, packId);
    assert.equal(insight.demo_intelligence.moment_id, momentId);
    assert.equal(insight.market.is_mock, true);
    assert.equal(insight.demo_intelligence.market.is_mock, true);
    assert.equal(insight.analysis.model, "bloom-demo-intelligence-v1");
    assert.match(insight.presentation.short_text, /^Rehearsal only\./);
  }
});

test("every rehearsal pack exposes at least four explicitly mocked research categories", () => {
  for (const pack of listDemoIntelligencePacks()) {
    assert.ok(Array.isArray(pack.research_categories), `${pack.id} publishes research categories`);
    assert.ok(pack.research_categories.length >= 4, `${pack.id} has at least four research categories`);
    assert.equal(
      new Set(pack.research_categories).size,
      pack.research_categories.length,
      `${pack.id} research categories are unique`
    );

    const insight = getDemoRehearsalInsight(pack.id, pack.checkpoints[0].id);
    const research = insight.demo_intelligence.research;
    assert.ok(research.length >= 4, `${pack.id} returns at least four research results`);
    assert.deepEqual(
      new Set(research.map((item) => item.category)),
      new Set(pack.research_categories),
      `${pack.id} rehearsal result covers its published categories`
    );
    for (const item of research) {
      assert.equal(item.is_mock, true, `${pack.id}/${item.category} is explicitly mock`);
      assert.equal(item.status, "ready");
      assert.ok(item.query?.trim(), `${pack.id}/${item.category} has a query`);
      assert.match(item.source, /mock/i, `${pack.id}/${item.category} labels its source as mock`);
      assert.ok(item.result?.trim(), `${pack.id}/${item.category} has a result`);
    }
  }
});

test("Cerebras-style observations resolve all four events and timeline moments", () => {
  for (const [visible, packId, momentId] of TARGETS) {
    const intelligence = selectDemoIntelligence(visible);
    assert.equal(intelligence.pack_id, packId);
    assert.equal(intelligence.moment_id, momentId);
    assert.equal(intelligence.mode, "precollected_event_replay");
    assert.ok(intelligence.evidence.length >= 3);
    assert.equal(intelligence.market.is_mock, true);
    assert.ok(intelligence.market.model_probability >= 0 && intelligence.market.model_probability <= 1);
  }
});

test("low-confidence vision never receives a demo pack", () => {
  assert.equal(selectDemoIntelligence(observation({ confidence: 0.4 })), null);
});

test("sport-only fallback is labeled and does not overwrite a real model answer", () => {
  const intelligence = selectDemoIntelligence(observation({
    event_name: "USA vs Brazil",
    event_identity: "soccer:usa-vs-brazil",
    participants: [{ name: "USA" }, { name: "Brazil" }],
    participant_a: "USA",
    participant_b: "Brazil",
    score_a: 1,
    score_b: 1,
    competition: "FIFA World Cup",
  }));
  assert.equal(intelligence.mode, "illustrative_sport_template");
  assert.equal(intelligence.moment_id, "argentina-two-goal-lead");
  const realModel = { primary_probability: 0.42, risk_note: "Visual model" };
  assert.equal(analysisFromDemoIntelligence(intelligence, realModel).primary_probability, 0.42);
  assert.equal(analysisFromDemoIntelligence(intelligence, null), null);
});

test("timeline selection cannot rewind after a noisy later observation", () => {
  const tied = selectDemoIntelligence(TARGETS[2][0]);
  const stale = selectDemoIntelligence(observation({
    sport: "american_football",
    competition: "Super Bowl LI",
    event_name: "Patriots vs Falcons",
    participants: [{ name: "Patriots" }, { name: "Falcons" }],
    participant_a: "Patriots",
    participant_b: "Falcons",
    score_a: 3,
    score_b: 28,
    phase: "Q3",
    clock: "8:31",
  }), { previous: tied });
  assert.equal(stale.moment_id, "game-tied");
});

test("known event remains deterministic when the analytics model is unavailable", async () => {
  const visible = TARGETS[0][0];
  const analyzer = new LiveEventAnalyzer({
    batchSize: 1,
    visionBackend: { name: "test-vision", extractEventBatch: async () => visible },
    analyze: async () => { throw new Error("analytics offline"); },
  });
  const result = await analyzer.submit({
    frame_id: "frame_demo",
    source: "phone_live",
    captured_at: "2026-07-11T20:00:00.000Z",
    mime_type: "image/jpeg",
    image_base64: "ZGVtbw==",
    width: 1280,
    height: 720,
  }, { force: true });
  assert.equal(result.insight.demo_intelligence.pack_id, "world-cup-2022-final");
  assert.equal(result.insight.analysis.primary_probability, 0.96);
  assert.equal(result.insight.market.is_mock, true);
  assert.equal(result.insight.comparison.gap_percentage_points, 11);
  assert.equal(result.insight.diagnostics.analytics_error, "analytics offline");
});

test("detected event flows through the server into the stable latest-live contract", async (t) => {
  const visible = TARGETS[2][0];
  const server = createBloomServer({
    liveAnalyzer: new LiveEventAnalyzer({
      batchSize: 1,
      visionBackend: { name: "test-vision", extractEventBatch: async () => visible },
      analyze: async () => null,
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/analysis/start`, { method: "POST" });
  const response = await fetch(`${base}/api/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "phone_photo",
      captured_at: "2026-07-11T20:00:00.000Z",
      mime_type: "image/jpeg",
      image_base64: "ZGVtbw==",
      width: 1280,
      height: 720,
    }),
  });
  assert.equal(response.status, 201);
  const submitted = await response.json();
  assert.equal(submitted.insight.demo_intelligence.pack_id, "super-bowl-li");
  assert.equal(submitted.insight.market.probability, 0.55);
  assert.equal(submitted.insight.comparison.gap_percentage_points, -1);
  const latest = await (await fetch(`${base}/api/latest`)).json();
  assert.equal(latest.demo_intelligence.moment_id, "game-tied");
  assert.equal(latest.sport, "football");
});
