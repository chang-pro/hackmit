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
      competition: "NBA Regular Season",
      event_name: "Boston Celtics at New York Knicks",
      event_identity: "nba:2026-04-09-boston-celtics-new-york-knicks",
      participants: [{ name: "Boston Celtics" }, { name: "New York Knicks" }],
      participant_a: "Boston Celtics",
      participant_b: "New York Knicks",
      score_a: 104,
      score_b: 109,
      score_display: "BOS 104–109 NYK",
      phase: "Q4",
      clock: "0:41",
    }),
    "nba-celtics-knicks-2026",
    "hart-clutch-lead",
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
    "submission-finish",
  ],
];

const REHEARSAL_CHECKPOINTS = listDemoIntelligencePacks().flatMap((pack) =>
  pack.checkpoints.map((checkpoint) => [pack.id, checkpoint.id])
);

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

test("every catalog rehearsal checkpoint resolves exactly without model calls", () => {
  assert.ok(REHEARSAL_CHECKPOINTS.length >= 4);
  const catalog = new Map(
    listDemoIntelligencePacks().map((pack) => [
      pack.id,
      new Set(pack.checkpoints.map((checkpoint) => checkpoint.id)),
    ])
  );

  for (const [packId, momentId] of REHEARSAL_CHECKPOINTS) {
    assert.ok(catalog.get(packId)?.has(momentId), `${packId}/${momentId} is published`);
    const insight = getDemoRehearsalInsight(packId, momentId);
    assert.equal(insight.source, "rehearsal");
    assert.equal(insight.extraction, "precollected-rehearsal");
    assert.equal(insight.rehearsal.is_rehearsal, true);
    assert.equal(insight.rehearsal.no_model_calls, true);
    assert.equal(insight.demo_intelligence.pack_id, packId);
    assert.equal(insight.demo_intelligence.moment_id, momentId);
    assert.equal(insight.market.is_mock, true);
    assert.equal(insight.demo_intelligence.market.is_mock, true);
    assert.equal(insight.analysis.model, "bloom-replay-intelligence-v1");
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

test("one target side, ticker pollution, and conflicting metadata never unlock exact markets", () => {
  const unrelated = [
    observation({
      sport: "basketball",
      competition: "NBA",
      event_name: "Warriors vs Lakers",
      event_identity: "nba:warriors-vs-lakers",
      participants: [{ name: "Golden State Warriors" }, { name: "Los Angeles Lakers" }],
      participant_a: "Golden State Warriors",
      participant_b: "Los Angeles Lakers",
      score_a: 92,
      score_b: 89,
      phase: "Q4",
      clock: "0:53",
    }),
    observation({
      sport: "american_football",
      competition: "NFL",
      event_name: "Patriots vs Jets",
      event_identity: "nfl:patriots-vs-jets",
      participants: [{ name: "New England Patriots" }, { name: "New York Jets" }],
      participant_a: "New England Patriots",
      participant_b: "New York Jets",
      score_a: 3,
      score_b: 28,
      phase: "Q3",
      clock: "8:31",
    }),
    observation({
      sport: "mma",
      competition: "UFC",
      event_name: "Khabib vs Poirier",
      event_identity: "mma:khabib-vs-poirier",
      event_format: "head_to_head",
      participants: [{ name: "Khabib Nurmagomedov" }, { name: "Dustin Poirier" }],
      participant_a: "Khabib Nurmagomedov",
      participant_b: "Dustin Poirier",
      score_a: 0,
      score_b: 0,
      phase: "Round 4",
      clock: "1:57",
    }),
    observation({
      competition: "FIFA World Cup",
      event_name: "Argentina vs Mexico",
      event_identity: "soccer:argentina-vs-mexico",
      participants: [{ name: "Argentina" }, { name: "Mexico" }],
      participant_a: "Argentina",
      participant_b: "Mexico",
    }),
  ];
  for (const visible of unrelated) {
    const intelligence = selectDemoIntelligence(visible);
    assert.notEqual(intelligence?.mode, "precollected_event_replay", visible.event_name);
    assert.equal(intelligence?.market ?? null, null, visible.event_name);
    assert.equal(intelligence?.moment_id ?? null, null, visible.event_name);
    assert.deepEqual(intelligence?.evidence ?? [], [], visible.event_name);
    assert.deepEqual(intelligence?.research ?? [], [], visible.event_name);
    assert.deepEqual(intelligence?.checkpoints ?? [], [], visible.event_name);
  }

  const tickerPollution = selectDemoIntelligence(observation({
    sport: "basketball",
    competition: "NBA",
    event_name: "Lakers vs Celtics",
    event_identity: "nba:lakers-vs-celtics",
    participants: [
      { name: "Los Angeles Lakers" },
      { name: "Golden State Warriors" },
      { name: "Boston Celtics", role_or_position: "ticker" },
      { name: "New York Knicks", role_or_position: "ticker" },
    ],
    participant_a: "Los Angeles Lakers",
    participant_b: "Golden State Warriors",
    score_a: 89,
    score_b: 89,
    phase: "Q4",
    clock: "4:39",
  }));
  assert.notEqual(tickerPollution.mode, "precollected_event_replay");
  assert.equal(tickerPollution.market, null);
  assert.equal(tickerPollution.moment_id, null);
  assert.deepEqual(tickerPollution.research, []);

  const conflicting = selectDemoIntelligence(observation({
    sport: "basketball",
    competition: "NBA Regular Season",
    event_name: "Celtics at Knicks 2025",
    event_identity: "nba:2025-bos-nyk",
    participants: [{ name: "Boston Celtics" }, { name: "New York Knicks" }],
    participant_a: "Boston Celtics",
    participant_b: "New York Knicks",
    score_a: 42,
    score_b: 49,
    phase: "Halftime",
    clock: "0:00",
  }));
  assert.equal(conflicting.match_basis, "conflicting_metadata");
  assert.notEqual(conflicting.mode, "precollected_event_replay");
  assert.equal(conflicting.market, null);
  assert.equal(conflicting.moment_id, null);
  assert.deepEqual(conflicting.research, []);
});

test("unique identity wording and dotted primary abbreviations survive normalization", () => {
  const identityOnly = selectDemoIntelligence(observation({
    sport: "NBA Basketball",
    competition: "NBA Regular Season",
    event_name: "",
    event_identity: "NBA:2026.04.09.BOSTON.CELTICS.NEW.YORK.KNICKS",
    participants: [],
    participant_a: "",
    participant_b: "",
    score_a: 104,
    score_b: 109,
    phase: "4Q",
    clock: "O:41",
  }));
  assert.equal(identityOnly.mode, "precollected_event_replay");
  assert.equal(identityOnly.pack_id, "nba-celtics-knicks-2026");
  assert.equal(identityOnly.moment_id, "hart-clutch-lead");
  assert.equal(identityOnly.match_basis, "identity_token");

  const dotted = selectDemoIntelligence(observation({
    sport: "NBA Basketball",
    competition: "NBA Regular Season",
    event_name: "",
    event_identity: "",
    participants: [{ name: "B.O.S." }, { name: "N.Y.K." }],
    participant_a: "B.O.S.",
    participant_b: "N.Y.K.",
    score_a: 104,
    score_b: 109,
    phase: "4Q",
    clock: "O:41",
  }));
  assert.equal(dotted.mode, "precollected_event_replay");
  assert.equal(dotted.moment_id, "hart-clutch-lead");
});

test("deterministic matching clamps confidence and stays pending below 0.72", () => {
  const pending = selectDemoIntelligence(observation({ confidence: 0.71 }));
  assert.equal(pending.mode, "precollected_event_pending");
  assert.equal(pending.match_confidence, 0.71);
  assert.equal(pending.market, null);
  assert.equal(analysisFromDemoIntelligence(pending, null), null);

  const ready = selectDemoIntelligence(observation({ confidence: 0.72 }));
  assert.equal(ready.mode, "precollected_event_replay");
  assert.equal(ready.match_confidence, 0.72);
  assert.ok(ready.market);
});

test("unknown states stay pending while visible in-between moments use the historical timeline", () => {
  const unresolved = selectDemoIntelligence(observation({
    score_a: null,
    score_b: null,
    score_display: "UNKNOWN",
    phase: "UNKNOWN",
    clock: "UNKNOWN",
    situation: "UNKNOWN",
    visible_facts: [],
    changes_across_frames: [],
  }));
  assert.equal(unresolved.mode, "precollected_event_pending");
  assert.equal(unresolved.moment_id, null);
  assert.equal(unresolved.market, null);
  assert.equal(analysisFromDemoIntelligence(unresolved, { primary_probability: 0.99 }), null);

  const offCheckpoint = selectDemoIntelligence(observation({
    sport: "basketball",
    competition: "NBA",
    event_name: "Boston Celtics at New York Knicks",
    event_identity: "nba-celtics-knicks-2026",
    participants: [{ name: "Boston Celtics" }, { name: "New York Knicks" }],
    participant_a: "Boston Celtics",
    participant_b: "New York Knicks",
    score_a: 17,
    score_b: 12,
    score_display: "17-12",
    phase: "1st Quarter",
    clock: "4:10",
  }));
  assert.equal(offCheckpoint.mode, "precollected_event_replay");
  assert.equal(offCheckpoint.checkpoint_status, "interpolated");
  assert.equal(offCheckpoint.pending_reason, null);
  assert.equal(offCheckpoint.moment_selection_reason, "historical_timeline_interpolation");
  assert.equal(offCheckpoint.moment_id, null);
  assert.equal(offCheckpoint.playback.match_mode, "approximate_event_sync");
  assert.equal(offCheckpoint.playback.stream_id, "nba-celtics-knicks-2026");
  assert.ok(Math.abs(offCheckpoint.playback.playback_start_seconds - 176.54) < 1);
  assert.ok(offCheckpoint.market.model_probability > 0.5);
  assert.ok(offCheckpoint.market.model_probability < 0.53);
  assert.ok(offCheckpoint.market.market_probability >= 0.5);
  assert.match(offCheckpoint.summary, /Backtested point-in-time estimate/);
  assert.match(offCheckpoint.summary, /final result is not injected/i);
  assert.equal(offCheckpoint.timeline_interpolation.left_anchor_id, "opening-tip");
  assert.equal(offCheckpoint.timeline_interpolation.right_anchor_id, "second-quarter-tie");
  assert.equal(
    analysisFromDemoIntelligence(offCheckpoint).primary_probability,
    offCheckpoint.market.model_probability
  );

  const mma = selectDemoIntelligence(observation({
    sport: "mma",
    competition: "UFC 229",
    event_name: "Khabib vs McGregor",
    event_identity: "mma:ufc-229-khabib-nurmagomedov-vs-conor-mcgregor",
    event_format: "head_to_head",
    participants: [{ name: "Khabib" }, { name: "McGregor" }],
    participant_a: "Khabib",
    participant_b: "McGregor",
    score_a: 0,
    score_b: 0,
    score_display: "",
    phase: "RD 4",
    clock: "UNKNOWN",
    situation: "",
  }));
  assert.equal(mma.mode, "precollected_event_pending");
  assert.equal(mma.moment_id, null);
  assert.equal(mma.market, null);
});

test("ambiguous observations hold a trusted checkpoint instead of inventing another", () => {
  const previous = getDemoRehearsalInsight("ufc-229", "round-four-control").demo_intelligence;
  const held = selectDemoIntelligence(observation({
    sport: "mma",
    competition: "UFC 229",
    event_name: "Khabib vs McGregor",
    event_identity: "mma:ufc-229-khabib-nurmagomedov-vs-conor-mcgregor",
    event_format: "head_to_head",
    participants: [{ name: "Khabib" }, { name: "McGregor" }],
    participant_a: "Khabib",
    participant_b: "McGregor",
    score_a: 0,
    score_b: 0,
    score_display: "",
    phase: "RD 4",
    clock: "UNKNOWN",
    situation: "",
  }), { previous });
  assert.equal(held.mode, "precollected_event_replay");
  assert.equal(held.checkpoint_status, "held_previous");
  assert.equal(held.moment_id, "round-four-control");
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
  assert.equal(intelligence.moment_id, null);
  assert.equal(intelligence.market, null);
  assert.deepEqual(intelligence.evidence, []);
  assert.deepEqual(intelligence.research, []);
  assert.deepEqual(intelligence.checkpoints, []);
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
  let analyticsCalls = 0;
  const analyzer = new LiveEventAnalyzer({
    batchSize: 1,
    visionBackend: { name: "test-vision", extractEventBatch: async () => visible },
    analyze: async () => { analyticsCalls += 1; throw new Error("analytics offline"); },
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
  assert.equal(
    result.insight.analysis.primary_probability,
    result.insight.demo_intelligence.market.model_probability
  );
  assert.equal(result.insight.market.is_mock, true);
  assert.equal(
    result.insight.comparison.gap_percentage_points,
    result.insight.demo_intelligence.market.gap_percentage_points
  );
  assert.equal(analyticsCalls, 0, "exact ready packs skip optional GPT enrichment by default");
  assert.equal(result.insight.diagnostics.analytics_error, null);
  assert.equal(result.insight.diagnostics.analytics_skipped, true);
  assert.equal(result.insight.diagnostics.analytics_skip_reason, "exact_deterministic_pack");
});

test("exact pack summary remains deterministic when GPT enrichment conflicts", async () => {
  const visible = TARGETS[0][0];
  const expected = selectDemoIntelligence(visible).summary;
  const analyzer = new LiveEventAnalyzer({
    batchSize: 1,
    enrichExactDemo: true,
    visionBackend: { name: "test-vision", extractEventBatch: async () => visible },
    analyze: async () => ({
      event_summary: "Wrong game and wrong score.",
      primary_market_question: "Wrong question?",
      primary_outcome: "Wrong outcome",
      primary_probability: 0.01,
      confidence: 0.1,
      alternate_markets: [],
      key_factors: ["Untrusted enrichment"],
      what_changed: "Wrong",
      next_probability_trigger: "Wrong",
      risk_note: "Wrong",
    }),
  });
  const result = await analyzer.submit({
    frame_id: "frame_conflict",
    source: "phone_live",
    captured_at: "2026-07-11T20:00:00.000Z",
    mime_type: "image/jpeg",
    image_base64: "ZGVtbw==",
    width: 1280,
    height: 720,
  }, { force: true });
  assert.equal(result.insight.analysis.event_summary, expected);
  assert.notEqual(result.insight.analysis.primary_probability, 0.01);
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
  assert.equal(
    submitted.insight.market.probability,
    submitted.insight.demo_intelligence.market.market_probability
  );
  assert.equal(
    submitted.insight.comparison.gap_percentage_points,
    submitted.insight.demo_intelligence.market.gap_percentage_points
  );
  const latest = await (await fetch(`${base}/api/latest`)).json();
  assert.equal(latest.demo_intelligence.moment_id, "game-tied");
  assert.equal(latest.sport, "football");
});
