// Backend selection for pluggable scoreboard extraction (Slice 2).
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractScoreboard, parseFrame, BACKENDS } from "../services/vision/index.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "packages", "fixtures", "frames", "frame_000184.json"
);

test("fixture backend produces the typed ParsedScoreboard contract", async () => {
  const parsed = await extractScoreboard({ fixture_path: FIXTURE }, "fixture");
  assert.equal(parsed.away_team_text, "BOS");
  assert.equal(parsed.home_team_text, "NYK");
  assert.equal(parsed.away_score, 104);
  assert.equal(parsed.home_score, 101);
  assert.equal(parsed.period, 4);
  assert.equal(parsed.clock_seconds, 134);
  assert.equal(typeof parsed.field_confidences.clock, "number");
});

test("parseFrame keeps the Slice 1 entry point working", async () => {
  const { frame, parsed } = await parseFrame(FIXTURE);
  assert.equal(frame.frame_id, "frame_000184");
  assert.equal(parsed.away_score, 104);
});

test("unknown backend name throws", async () => {
  await assert.rejects(
    () => extractScoreboard({ fixture_path: FIXTURE }, "tesseract"),
    /Unknown extraction backend/
  );
});

test("cerebras backend without CEREBRAS_API_KEY fails with an actionable message", async () => {
  const saved = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  try {
    await assert.rejects(
      () => extractScoreboard({ image_base64: "dGVzdA==", mime_type: "image/jpeg" }, "cerebras"),
      /CEREBRAS_API_KEY is not set/
    );
  } finally {
    if (saved !== undefined) process.env.CEREBRAS_API_KEY = saved;
  }
});

test("all named backends are registered", () => {
  assert.ok(BACKENDS.fixture, "fixture backend registered");
  assert.ok(BACKENDS.cerebras, "cerebras backend registered");
  assert.equal(typeof BACKENDS.cerebras.extract, "function");
});

test("a custom backend object is accepted and its noisy output is normalized", async () => {
  const noisyBackend = {
    name: "test-noisy",
    async extract() {
      return {
        away_team_text: " bos ",
        home_team_text: "nyk ",
        away_score: "104",
        home_score: "101",
        period_text: "Q4",
        clock_text: "2:14",
        field_confidences: { teams: 0.9, scores: 0.9, period: 0.9, clock: 0.9 },
      };
    },
  };
  const parsed = await extractScoreboard({ frame_id: "f1" }, noisyBackend);
  assert.equal(parsed.away_team_text, "BOS");
  assert.equal(parsed.period, 4);
  assert.equal(parsed.clock_seconds, 134, "normalization ran on backend output");
});
