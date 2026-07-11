import test from "node:test";
import assert from "node:assert/strict";
import { cerebrasStructuredCompletion } from "../services/cerebras/client.js";
import {
  CEREBRAS_VISION_MODEL,
  createCerebrasBackend,
} from "../services/vision/backends/cerebras.js";

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

test("Gemma 4 packs five ordered sports frames into one vision request", async () => {
  let request;
  const backend = createCerebrasBackend({
    complete: async (args) => {
      request = args;
      return {
        data: {
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
          changes_across_frames: ["Clock advanced"],
          confidence: 0.93,
        },
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
  assert.equal(request.schemaName, "multisport_live_event_window");
  assert.equal(imageParts.length, 5);
  assert.equal(request.schema.properties.sport.enum, undefined);
  assert.equal(request.schema.properties.event_identity.type, "string");
  assert.equal(request.schema.properties.participants.type, "array");
  assert.equal(result.sport, "soccer");
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
