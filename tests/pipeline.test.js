// End-to-end slice-1 test: fixture frame -> full §8 contract.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline } from "../services/api/pipeline.js";
import { mockAdapter } from "../services/market/mock-adapter.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "packages", "fixtures", "frames", "frame_000184.json"
);

test("fixture frame produces a complete, gated comparison", async () => {
  const out = await runPipeline(FIXTURE);
  assert.equal(out.event.event_id, "nba_2026_07_11_bos_nyk");
  assert.equal(out.state.away_score, 104);
  assert.equal(out.estimate.outcome, "nba_bos_wins");
  assert.ok(out.estimate.probability > 0.5, "leading team favored");
  assert.equal(out.market.is_mock, true, "mock data is labeled");
  assert.equal(
    Number(
      (
        (out.comparison.model_probability - out.comparison.market_probability) * 100
      ).toFixed(1)
    ),
    out.comparison.gap_percentage_points,
    "gap is percentage points, mathematically consistent"
  );
  assert.equal(out.presentation.status, "ready");
  assert.match(out.presentation.short_text, /BOS \d+%\. Market \d+%\./);
});

test("a live frame flows through the extraction seam and is labeled honestly", async () => {
  const liveFrame = {
    frame_id: "frame_000042",
    captured_at: new Date().toISOString(),
    source: "webcam",
    image_uri: "memory://capture/frame_000042",
    width: 1280,
    height: 720,
  };
  const out = await runPipeline(FIXTURE, undefined, liveFrame);
  assert.equal(out.source, "live");
  assert.equal(out.extraction, "fixture_parse", "no real OCR claimed before Slice 2");
  assert.equal(out.state.observed_at, liveFrame.captured_at);

  const fixtureOut = await runPipeline(FIXTURE);
  assert.equal(fixtureOut.source, "fixture");
});

test("market adapter requires a unique contract match", () => {
  assert.throws(() => mockAdapter.find_market("nba_2026_07_11_bos_nyk", "nba_lal_wins"));
  const id = mockAdapter.find_market("nba_2026_07_11_bos_nyk", "nba_bos_wins");
  assert.equal(id, "market_123");
});
