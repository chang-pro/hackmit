import test from "node:test";
import assert from "node:assert/strict";
import { cerebrasStructuredCompletion } from "../services/cerebras/client.js";
import {
  CEREBRAS_VISION_MODEL,
  createCerebrasBackend,
} from "../services/vision/backends/cerebras.js";
import { selectDemoIntelligence } from "../services/demo/intelligence.js";

test("Gemma 4 backend sends a base64 phone image with strict scoreboard output", async () => {
  let request;
  const backend = createCerebrasBackend({
    complete: async (args) => {
      request = args;
      return {
        data: {
          sport: "basketball",
          league: "NBA",
          away_team_text: "BOS",
          home_team_text: "NYK",
          away_score: 104,
          home_score: 101,
          period_text: "Q4",
          clock_text: "2:14",
          field_confidences: { teams: 0.98, scores: 0.96, period: 0.99, clock: 0.94 },
        },
      };
    },
  });
  const result = await backend.extract({
    mime_type: "image/jpeg",
    image_base64: "cGhvbmUtZnJhbWU=",
  });

  assert.equal(request.model, CEREBRAS_VISION_MODEL);
  assert.equal(request.schemaName, "live_nba_scoreboard");
  assert.equal(request.schema.additionalProperties, false);
  const image = request.messages[1].content.find((part) => part.type === "image_url");
  assert.equal(image.image_url.url, "data:image/jpeg;base64,cGhvbmUtZnJhbWU=");
  assert.equal(result.clock_text, "2:14");
});

test("Gemma 4 classifies only the newest frame into one of four demo sports", async () => {
  let request;
  const backend = createCerebrasBackend({
    complete: async (args) => {
      request = args;
      return {
        data: { classification: "soccer", confidence: 0.93 },
        meta: { model: CEREBRAS_VISION_MODEL },
      };
    },
  });
  const frames = Array.from({ length: 5 }, (_, index) => ({
    mime_type: "image/jpeg",
    image_base64: `ZnJhbWUt${index}`,
  }));
  const result = await backend.extractEventBatch(frames);
  const imageParts = request.messages[1].content.filter((part) => part.type === "image_url");
  assert.equal(request.schemaName, "demo_stream_sport_classification");
  assert.equal(request.maxCompletionTokens, 80);
  assert.equal(imageParts.length, 1);
  assert.equal(imageParts[0].image_url.url, "data:image/jpeg;base64,ZnJhbWUt4");
  assert.deepEqual(request.schema.properties.classification.enum, [
    "basketball", "american_football", "soccer", "mma", "unclear",
  ]);
  assert.match(request.messages[0].content, /Do not identify teams, players, score, clock, league, or exact event/);
  assert.equal(result.sport, "soccer");
  assert.equal(result.event_identity, "world-cup-2022-final");
  assert.equal(result.classification, "soccer");
});

test("each classifier label maps directly to its one allowed replay, while unclear maps to none", async () => {
  const expected = new Map([
    ["basketball", "nba-celtics-knicks-2026"],
    ["american_football", "super-bowl-li"],
    ["soccer", "world-cup-2022-final"],
    ["mma", "ufc-229"],
  ]);
  for (const [classification, streamId] of expected) {
    const backend = createCerebrasBackend({
      complete: async () => ({ data: { classification, confidence: 0.9 } }),
    });
    const observation = await backend.extractEventBatch([{
      mime_type: "image/jpeg",
      image_base64: "c2NyZWVu",
    }]);
    const intelligence = selectDemoIntelligence(observation);
    assert.equal(intelligence.playback.stream_id, streamId);
    assert.equal(intelligence.mode, "precollected_event_replay");
  }

  const unclearBackend = createCerebrasBackend({
    complete: async () => ({ data: { classification: "unclear", confidence: 0.99 } }),
  });
  const unclear = await unclearBackend.extractEventBatch([{
    mime_type: "image/jpeg",
    image_base64: "c2NyZWVu",
  }]);
  assert.equal(selectDemoIntelligence(unclear), null);
});

test("Cerebras client uses chat completions and parses strict JSON", async () => {
  const saved = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = "test-only-key";
  let call;
  try {
    const result = await cerebrasStructuredCompletion({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "test" }],
      schemaName: "test_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      fetchImpl: async (url, options) => {
        call = { url, options };
        return {
          ok: true,
          json: async () => ({
            id: "req_test",
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        };
      },
    });
    assert.equal(call.url, "https://api.cerebras.ai/v1/chat/completions");
    const body = JSON.parse(call.options.body);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(result.data, { ok: true });
  } finally {
    if (saved === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = saved;
  }
});
