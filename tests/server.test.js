import test from "node:test";
import assert from "node:assert/strict";
import { createBloomServer } from "../services/api/server.js";
import { LiveEventAnalyzer } from "../services/api/live-event-analyzer.js";

const testVision = {
  name: "test-phone-vision",
  async extractEventBatch(frames) {
    assert.equal(frames[0].mime_type, "image/jpeg");
    assert.equal(frames[0].image_base64, "cGhvbmUtZnJhbWU=");
    return {
      sport: "soccer",
      competition: "FIFA World Cup",
      event_name: "USA vs Brazil",
      event_identity: "soccer:usa-vs-brazil-world-cup-2026",
      event_format: "team_event",
      participants: [
        { name: "USA", role_or_position: "team", score_or_status: "1", visible_rank: 0 },
        { name: "Brazil", role_or_position: "team", score_or_status: "1", visible_rank: 0 },
      ],
      participant_a: "USA",
      participant_b: "Brazil",
      score_a: 1,
      score_b: 1,
      score_display: "1-1",
      phase: "Second half",
      clock: "72:14",
      event_status: "live",
      possession_or_control: "Brazil",
      situation: "Open play",
      visible_facts: ["Score tied"],
      changes_across_frames: [],
      confidence: 0.94,
    };
  },
};

test("phone photo returns a complete multisport live insight", async (t) => {
  const liveAnalyzer = new LiveEventAnalyzer({
    visionBackend: testVision,
    analyze: async () => ({
      event_summary: "USA and Brazil are tied late in the second half.",
      primary_market_question: "Will Brazil win?",
      primary_outcome: "Brazil wins",
      primary_probability: 0.42,
      confidence: 0.7,
      alternate_markets: [],
      key_factors: ["Tied at 72 minutes"],
      what_changed: "No prior window",
      next_probability_trigger: "A goal",
      risk_note: "Visual estimate",
    }),
  });
  const server = createBloomServer({ liveAnalyzer });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/reset`, { method: "POST" });
  const response = await fetch(`${base}/api/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "phone_photo",
      captured_at: "2026-07-11T20:14:32.491Z",
      mime_type: "image/jpeg",
      image_base64: "cGhvbmUtZnJhbWU=",
      width: 1280,
      height: 720,
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.selection.accepted, true);
  assert.equal(body.insight.source, "live");
  assert.equal(body.insight.extraction, "test-phone-vision-batch");
  assert.equal(body.insight.observation.sport, "soccer");
  assert.equal(body.insight.analysis.primary_probability, 0.42);
  assert.equal(body.insight.presentation.status, "ready");

  const latest = await (await fetch(`${base}/api/latest`)).json();
  assert.equal(latest.frame_window.frames[0].frame_id, body.frame.frame_id);
  assert.equal(latest.extraction, "test-phone-vision-batch");
});
