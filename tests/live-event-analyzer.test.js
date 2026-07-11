import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventAnalyzer } from "../services/api/live-event-analyzer.js";

const observation = {
  sport: "mma",
  competition: "UFC",
  event_name: "Fighter A vs Fighter B",
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

test("queues four frames and packs the fifth into one model request", async () => {
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

  for (let index = 1; index <= 4; index += 1) {
    const result = await analyzer.submit(frame(index));
    assert.equal(result.analysis_status, "queued");
    now += 2400;
  }
  const result = await analyzer.submit(frame(5));
  assert.equal(result.analysis_status, "analyzed");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 5);
  assert.equal(result.insight.observation.sport, "mma");
  assert.equal(result.insight.analysis.primary_probability, 0.62);
  assert.equal(result.queue.calls_last_minute.vision, 1);
  assert.equal(result.queue.calls_last_minute.analytics, 1);
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
