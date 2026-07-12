import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveEventAnalyzer,
  detectEventSwitch,
} from "../services/api/live-event-analyzer.js";

const observation = {
  sport: "mma",
  competition: "UFC",
  event_name: "Fighter A vs Fighter B",
  event_identity: "mma:ufc-fighter-a-vs-fighter-b",
  event_format: "head_to_head",
  participants: [
    { name: "Fighter A", role_or_position: "red corner", score_or_status: "", visible_rank: 0 },
    { name: "Fighter B", role_or_position: "blue corner", score_or_status: "", visible_rank: 0 },
  ],
  participant_a: "Fighter A",
  participant_b: "Fighter B",
  score_a: 0,
  score_b: 0,
  score_display: "",
  phase: "Round 3",
  clock: "2:18",
  event_status: "live",
  possession_or_control: "Fighter A",
  situation: "Clinch at fence",
  visible_facts: ["Round 3"],
  changes_across_frames: ["Clock advanced"],
  confidence: 0.9,
};

const analysis = {
  event_summary: "The fight is live in round three.",
  primary_market_question: "Who wins the fight?",
  primary_outcome: "Fighter A",
  primary_probability: 0.62,
  confidence: 0.65,
  alternate_markets: [],
  key_factors: ["Visible control"],
  what_changed: "Clock advanced",
  next_probability_trigger: "A takedown or knockdown",
  risk_note: "Limited to visible evidence",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function frame(index) {
  return {
    frame_id: `f${index}`,
    captured_at: new Date(index * 1000).toISOString(),
    source: "phone_live",
    mime_type: "image/jpeg",
    image_base64: `frame-${index}`,
    width: 1280,
    height: 720,
  };
}

test("analyzes the first frame immediately, then batches later model windows", async () => {
  let now = 0;
  const batches = [];
  const analyzer = new LiveEventAnalyzer({
    now: () => now,
    visionBackend: {
      name: "test-vision",
      async extractEventBatch(frames) {
        batches.push(frames);
        return observation;
      },
    },
    analyze: async () => analysis,
  });

  const first = await analyzer.submit(frame(1));
  assert.equal(first.analysis_status, "analyzed");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);

  for (let index = 2; index <= 5; index += 1) {
    now += 2400;
    const queued = await analyzer.submit(frame(index));
    assert.equal(queued.analysis_status, "queued");
  }
  now = 12_000;
  const result = await analyzer.submit(frame(6));
  assert.equal(result.analysis_status, "analyzed");
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 5);
  assert.equal(result.insight.observation.sport, "mma");
  assert.equal(result.insight.analysis.primary_probability, 0.62);
  assert.equal(result.queue.calls_last_minute.vision, 2);
  assert.equal(result.queue.calls_last_minute.analytics, 2);
});

test("never starts another model window before twelve seconds", async () => {
  let now = 0;
  let calls = 0;
  const analyzer = new LiveEventAnalyzer({
    now: () => now,
    visionBackend: {
      name: "test-vision",
      async extractEventBatch() {
        calls += 1;
        return observation;
      },
    },
    analyze: async () => analysis,
  });

  await analyzer.submit(frame(0), { force: true });
  assert.equal(calls, 1);
  for (let index = 1; index <= 5; index += 1) {
    now += 2000;
    await analyzer.submit(frame(index));
  }
  assert.equal(calls, 1, "five queued frames do not bypass the per-model cooldown");
  now = 12_000;
  const result = await analyzer.submit(frame(6));
  assert.equal(result.analysis_status, "analyzed");
  assert.equal(calls, 2);
  assert.equal(result.insight.frame_window.count, 5, "latest five frames are packed");
});

test("a manual photo analyzes immediately but still respects cooldown", async () => {
  let now = 0;
  const analyzer = new LiveEventAnalyzer({
    now: () => now,
    visionBackend: {
      name: "test-vision",
      async extractEventBatch() {
        return observation;
      },
    },
    analyze: async () => analysis,
  });
  const first = await analyzer.submit(frame(1), { force: true });
  assert.equal(first.analysis_status, "analyzed");
  now = 1000;
  const second = await analyzer.submit(frame(2), { force: true });
  assert.equal(second.analysis_status, "queued");
  assert.equal(second.queue.next_analysis_ms, 11_000);
});

test("automatically detects an NBA-to-golf switch and clears prior analysis context", async () => {
  let now = 0;
  const observations = [
    {
      ...observation,
      sport: "basketball",
      competition: "NBA Regular Season",
      event_name: "Celtics vs Knicks",
      event_identity: "nba:boston-celtics-vs-new-york-knicks",
      event_format: "team_event",
      participants: [
        { name: "Boston Celtics", role_or_position: "away", score_or_status: "101", visible_rank: 0 },
        { name: "New York Knicks", role_or_position: "home", score_or_status: "101", visible_rank: 0 },
      ],
      participant_a: "Boston Celtics",
      participant_b: "New York Knicks",
      score_a: 101,
      score_b: 101,
      score_display: "101-101",
      phase: "Q4",
      clock: "2:49",
    },
    {
      ...observation,
      sport: "golf",
      competition: "The Open Championship",
      event_name: "The Open 2026",
      event_identity: "golf:the-open-2026",
      event_format: "leaderboard",
      participants: [
        { name: "Player One", role_or_position: "leader", score_or_status: "-12", visible_rank: 1 },
        { name: "Player Two", role_or_position: "second", score_or_status: "-10", visible_rank: 2 },
      ],
      participant_a: "Player One",
      participant_b: "Player Two",
      score_a: -12,
      score_b: -10,
      score_display: "1 Player One -12 · 2 Player Two -10",
      phase: "Round 4 · Hole 15",
      clock: "",
      possession_or_control: "Player One leads",
      situation: "Final round leaderboard",
    },
  ];
  const contexts = [];
  const analyzer = new LiveEventAnalyzer({
    now: () => now,
    enrichExactDemo: true,
    visionBackend: {
      name: "test-vision",
      async extractEventBatch() {
        return observations.shift();
      },
    },
    analyze: async (context) => {
      contexts.push(context);
      return analysis;
    },
  });

  await analyzer.submit(frame(1), { force: true });
  now = 12_000;
  const result = await analyzer.submit(frame(2), { force: true });

  assert.equal(result.insight.event_switch.detected, true);
  assert.equal(result.insight.event_switch.reason, "sport_changed");
  assert.equal(result.insight.event_switch.from_event.sport, "basketball");
  assert.equal(result.insight.event_switch.to_event.sport, "golf");
  assert.equal(contexts[1].previous_observation, null);
  assert.equal(contexts[1].previous_analysis, null);
  assert.equal(result.insight.presentation.status, "event_switched");
});

test("a golf leaderboard changing visible players remains the same event", () => {
  const first = {
    sport: "golf",
    competition: "The Open Championship",
    event_name: "The Open 2026",
    event_identity: "golf:the-open-2026",
    event_format: "leaderboard",
    participants: [{ name: "Player One" }],
    confidence: 0.92,
  };
  const second = {
    ...first,
    participants: [{ name: "Player Seven" }],
    participant_a: "Player Seven",
  };

  const eventSwitch = detectEventSwitch(first, second);
  assert.equal(eventSwitch.detected, false);
  assert.equal(eventSwitch.reason, "same_competition_session");
});

test("switching between two games in the same sport starts a new event", () => {
  const first = {
    sport: "basketball",
    competition: "NBA",
    event_name: "Celtics vs Knicks",
    event_identity: "nba:celtics-vs-knicks",
    event_format: "team_event",
    participants: [{ name: "Celtics" }, { name: "Knicks" }],
    confidence: 0.94,
  };
  const second = {
    ...first,
    event_name: "Lakers vs Warriors",
    event_identity: "nba:lakers-vs-warriors",
    participants: [{ name: "Lakers" }, { name: "Warriors" }],
  };

  const eventSwitch = detectEventSwitch(first, second);
  assert.equal(eventSwitch.detected, true);
  assert.equal(eventSwitch.reset_context, true);
  assert.equal(eventSwitch.reason, "participant_pair_changed");
});

test("one shared team is a switch, while identity wording drift for the same pair is stable", () => {
  const first = {
    sport: "basketball",
    competition: "NBA Finals",
    event_name: "Cavaliers vs Warriors",
    event_identity: "nba:2016-finals-game-7-cavaliers-warriors",
    event_format: "team_event",
    participants: [{ name: "Cleveland Cavaliers" }, { name: "Golden State Warriors" }],
    participant_a: "Cleveland Cavaliers",
    participant_b: "Golden State Warriors",
    confidence: 0.94,
  };
  const wordingDrift = {
    ...first,
    event_name: "2016 NBA Finals Game Seven",
    event_identity: "nba:cavaliers-warriors-game-seven",
    participants: [...first.participants].reverse(),
    participant_a: "Golden State Warriors",
    participant_b: "Cleveland Cavaliers",
  };
  const stable = detectEventSwitch(first, wordingDrift);
  assert.equal(stable.detected, false);
  assert.equal(stable.reset_context, false);
  assert.equal(stable.reason, "stable_participant_pair");

  const changed = detectEventSwitch(first, {
    ...first,
    competition: "NBA",
    event_name: "Warriors vs Lakers",
    event_identity: "UNKNOWN",
    participants: [{ name: "Golden State Warriors" }, { name: "Los Angeles Lakers" }],
    participant_a: "Golden State Warriors",
    participant_b: "Los Angeles Lakers",
  });
  assert.equal(changed.detected, true);
  assert.equal(changed.reset_context, true);
  assert.equal(changed.reason, "participant_pair_changed");
});

test("a low-confidence cross-sport switch never receives prior-event context", async () => {
  let now = 0;
  const observations = [
    {
      ...observation,
      sport: "soccer",
      competition: "International friendly",
      event_name: "USA vs Brazil",
      event_identity: "soccer:usa-vs-brazil",
      participants: [{ name: "USA" }, { name: "Brazil" }],
      participant_a: "USA",
      participant_b: "Brazil",
    },
    {
      ...observation,
      sport: "basketball",
      competition: "NBA",
      event_name: "Celtics vs Knicks",
      event_identity: "nba:celtics-vs-knicks",
      participants: [{ name: "Celtics" }, { name: "Knicks" }],
      participant_a: "Celtics",
      participant_b: "Knicks",
      confidence: 0.54,
    },
  ];
  const contexts = [];
  const analyzer = new LiveEventAnalyzer({
    batchSize: 1,
    now: () => now,
    visionBackend: { name: "test-vision", extractEventBatch: async () => observations.shift() },
    analyze: async (context) => { contexts.push(context); return analysis; },
  });
  await analyzer.submit(frame(1), { force: true });
  now = 12_000;
  const result = await analyzer.submit(frame(2), { force: true });
  assert.equal(result.insight.event_switch.detected, false);
  assert.equal(result.insight.event_switch.reset_context, true);
  assert.equal(result.insight.event_switch.reason, "low_confidence_sport_changed");
  assert.equal(contexts[1].previous_observation, null);
  assert.equal(contexts[1].previous_analysis, null);
});

test("reset discards a pre-reset deferred vision result", async () => {
  const started = deferred();
  const completion = deferred();
  let analyticsCalls = 0;
  const analyzer = new LiveEventAnalyzer({
    batchSize: 1,
    visionBackend: {
      name: "deferred-vision",
      extractEventBatch: async () => {
        started.resolve();
        return completion.promise;
      },
    },
    analyze: async () => { analyticsCalls += 1; return analysis; },
  });
  const pending = analyzer.submit(frame(1), { force: true });
  await started.promise;
  analyzer.reset();
  completion.resolve(observation);
  const result = await pending;
  assert.equal(result.analysis_status, "discarded");
  assert.equal(result.insight, null);
  assert.equal(analyzer.latestInsight, null);
  assert.equal(analyticsCalls, 0);
  assert.deepEqual(analyzer.status().calls_last_minute, { vision: 0, analytics: 0 });
});

test("reset discards a pre-reset deferred analytics result", async () => {
  const started = deferred();
  const completion = deferred();
  const analyzer = new LiveEventAnalyzer({
    batchSize: 1,
    visionBackend: { name: "test-vision", extractEventBatch: async () => observation },
    analyze: async () => {
      started.resolve();
      return completion.promise;
    },
  });
  const pending = analyzer.submit(frame(1), { force: true });
  await started.promise;
  analyzer.reset();
  completion.resolve(analysis);
  const result = await pending;
  assert.equal(result.analysis_status, "discarded");
  assert.equal(result.insight, null);
  assert.equal(analyzer.latestInsight, null);
  assert.deepEqual(analyzer.status().calls_last_minute, { vision: 0, analytics: 0 });
});
