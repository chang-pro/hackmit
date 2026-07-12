import test from "node:test";
import assert from "node:assert/strict";
import { askGeminiAnalyst, GEMINI_CHAT_MODEL } from "../services/analytics/gemini-chat.js";

test("askGeminiAnalyst rejects empty questions and missing keys", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(
    () => askGeminiAnalyst({ question: "What changed?" }),
    /GEMINI_API_KEY/
  );
  process.env.GEMINI_API_KEY = "test-only-key";
  await assert.rejects(
    () => askGeminiAnalyst({ question: "   " }),
    /question is required/
  );
  if (saved === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved;
});

test("askGeminiAnalyst posts grounded Gemini chat and returns the answer", async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only-key";
  let seen = null;
  const result = await askGeminiAnalyst({
    question: "Why is the gap open?",
    insight: {
      observation: { sport: "american_football", event_name: "Super Bowl LI", score_display: "28-3" },
      analysis: { primary_probability: 0.03, market_probability: 0.04, gap_percentage_points: -1 },
      market: { is_mock: true, probability: 0.04 },
    },
    history: [{ role: "user", text: "Earlier question" }, { role: "model", text: "Earlier answer" }],
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            candidates: [{ content: { parts: [{ text: "The model sees a deeper deficit than the mock market." }] } }],
          });
        },
      };
    },
  });

  assert.equal(result.answer, "The model sees a deeper deficit than the mock market.");
  assert.equal(result.model, GEMINI_CHAT_MODEL);
  assert.equal(result.grounded, true);
  assert.match(seen.url, /models\/gemini-3\.1-flash-lite:generateContent/);
  assert.equal(seen.options.headers["x-goog-api-key"], "test-only-key");
  const body = JSON.parse(seen.options.body);
  assert.match(body.systemInstruction.parts[0].text, /BloomKnights Analyst/);
  assert.equal(body.contents.at(-1).role, "user");
  assert.match(body.contents.at(-1).parts[0].text, /Super Bowl LI/);
  assert.match(body.contents.at(-1).parts[0].text, /Why is the gap open\?/);

  if (saved === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved;
});
