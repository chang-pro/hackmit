import test from "node:test";
import assert from "node:assert/strict";
import { createBloomServer } from "../services/api/server.js";

const testVision = {
  name: "test-phone-vision",
  async extract(frame) {
    assert.equal(frame.mime_type, "image/jpeg");
    assert.equal(frame.image_base64, "cGhvbmUtZnJhbWU=");
    return {
      away_team_text: "BOS",
      home_team_text: "NYK",
      away_score: 104,
      home_score: 101,
      period_text: "Q4",
      clock_text: "2:14",
      field_confidences: { teams: 0.98, scores: 0.96, period: 0.99, clock: 0.94 },
    };
  },
};

test("phone frame upload returns a complete live insight", async (t) => {
  const server = createBloomServer({ visionBackend: testVision });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/reset`, { method: "POST" });
  const response = await fetch(`${base}/api/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "phone_test",
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
  assert.equal(body.insight.extraction, "test-phone-vision");
  assert.equal(body.insight.state.away_score, 104);
  assert.equal(body.insight.estimate.outcome, "nba_bos_wins");
  assert.equal(body.insight.presentation.status, "ready");

  const latest = await (await fetch(`${base}/api/latest`)).json();
  assert.equal(latest.frame.frame_id, body.frame.frame_id);
  assert.equal(latest.extraction, "test-phone-vision");
});
