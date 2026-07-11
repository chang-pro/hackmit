// Optional second Cerebras pass. Gemma 4 handles image perception; GPT OSS
// (or GLM 4.7 via env) turns the trusted structured state, baseline model, and
// market snapshot into a concise user-facing analysis.

import { cerebrasStructuredCompletion } from "../cerebras/client.js";

export const CEREBRAS_ANALYTICS_MODEL =
  process.env.CEREBRAS_ANALYTICS_MODEL ?? "gpt-oss-120b";

const ANALYTICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    estimated_win_probability: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    key_factors: { type: "array", items: { type: "string" } },
    market_read: { type: "string" },
    risk_note: { type: "string" },
  },
  required: [
    "summary",
    "estimated_win_probability",
    "confidence",
    "key_factors",
    "market_read",
    "risk_note",
  ],
};

export async function analyzeGameContext(context) {
  if (!process.env.CEREBRAS_API_KEY || process.env.CEREBRAS_ANALYTICS_ENABLED === "false") {
    return null;
  }
  const { data, meta } = await cerebrasStructuredCompletion({
    model: CEREBRAS_ANALYTICS_MODEL,
    schema: ANALYTICS_SCHEMA,
    schemaName: "live_sports_analysis",
    maxCompletionTokens: 900,
    messages: [
      {
        role: "system",
        content: [
          "You are a concise live NBA probability analyst.",
          "Use only the supplied structured state and market data.",
          "Do not invent players, injuries, possession, or events.",
          "Treat baseline_probability as the quantitative anchor and do not move more than 0.10 without explicit supplied evidence.",
          "A model-market gap is not guaranteed profit or financial advice.",
        ].join(" "),
      },
      { role: "user", content: JSON.stringify(context) },
    ],
  });
  return { ...data, model: meta.model };
}
