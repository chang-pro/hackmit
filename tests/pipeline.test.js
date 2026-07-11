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

test("market adapter requires a unique contract match", () => {
  assert.throws(() => mockAdapter.find_market("nba_2026_07_11_bos_nyk", "nba_lal_wins"));
  const id = mockAdapter.find_market("nba_2026_07_11_bos_nyk", "nba_bos_wins");
  assert.equal(id, "market_123");
});
