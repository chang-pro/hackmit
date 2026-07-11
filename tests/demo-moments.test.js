// Slice 6: the two demo moments (README §13 step 8 — "move to a later moment
// in the game and show the estimate update"). Each moment gets a fresh
// Reconciler, mirroring the server: §7.5 invariants compare consecutive
// observations, and the demo fixtures are minutes of game time apart.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline } from "../services/api/pipeline.js";
import { mockAdapter } from "../services/market/mock-adapter.js";
import { Reconciler } from "../services/vision/reconciler.js";

const FRAMES = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "fixtures", "frames");
const moment = (name) => runPipeline(join(FRAMES, name), mockAdapter, null, new Reconciler());

test("later-game fixture produces a complete, ready comparison", async () => {
  const out = await moment("frame_000260.json");
  assert.equal(out.event.event_id, "nba_2026_07_11_bos_nyk");
  assert.equal(out.state.away_score, 112);
  assert.equal(out.state.home_score, 105);
  assert.equal(out.state.period, 4);
  assert.equal(out.state.clock_seconds, 30);
  assert.equal(out.estimate.outcome, "nba_bos_wins");
  assert.equal(out.market.is_mock, true, "mock data is labeled");
  assert.equal(out.presentation.status, "ready");
  assert.ok(out.presentation.spoken_text.length > 0, "audio delivery has text to speak");
});

test("estimate rises from Q4 2:14 (+3) to Q4 0:30 (+7): lead more valuable as time expires", async () => {
  const early = await moment("frame_000184.json");
  const late = await moment("frame_000260.json");
  assert.ok(
    late.estimate.probability > early.estimate.probability,
    `expected p(0:30)=${late.estimate.probability} > p(2:14)=${early.estimate.probability}`
  );
  assert.ok(late.estimate.probability > 0.9, "up 7 with 30s left is a very high probability");
  assert.ok(early.estimate.probability < 1 && late.estimate.probability < 1, "bounded");
});
