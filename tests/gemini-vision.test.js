import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiBackend, GEMINI_MODEL } from "../services/vision/backends/gemini.js";
import { selectDemoIntelligence } from "../services/demo/intelligence.js";

test("Gemini Flash Lite classifies one WebRTC snapshot and selects the matching replay", async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only-key";
  let request;
  try {
    const backend = createGeminiBackend({
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "Possible labels: basketball, american_football, soccer, mma, or unclear. Final answer: mma." }] } }],
          }),
        };
      },
    });
    const observation = await backend.extractEventBatch([
      { mime_type: "image/jpeg", image_base64: "b2xk" },
      { mime_type: "image/jpeg", image_base64: "bmV3" },
    ]);

    assert.match(request.url, new RegExp(`/models/${GEMINI_MODEL}:generateContent$`));
    assert.equal(request.body.contents[0].parts.filter((part) => part.inline_data).length, 1);
    assert.equal(request.body.contents[0].parts[0].inline_data.data, "bmV3");
    assert.equal(request.body.generationConfig.maxOutputTokens, 256);
    assert.equal(observation.event_identity, "ufc-229");
    assert.equal(selectDemoIntelligence(observation).playback.stream_id, "ufc-229");
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  }
});
