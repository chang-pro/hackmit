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

const MULTISPORT_ANALYTICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    event_summary: { type: "string" },
    primary_market_question: { type: "string" },
    primary_outcome: { type: "string" },
    primary_probability: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    alternate_markets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          outcome: { type: "string" },
          probability: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["question", "outcome", "probability", "confidence"],
      },
    },
    key_factors: { type: "array", items: { type: "string" } },
    what_changed: { type: "string" },
    next_probability_trigger: { type: "string" },
    risk_note: { type: "string" },
  },
  required: [
    "event_summary",
    "primary_market_question",
    "primary_outcome",
    "primary_probability",
    "confidence",
    "alternate_markets",
    "key_factors",
    "what_changed",
    "next_probability_trigger",
    "risk_note",
  ],
};

export async function analyzeUniversalEvent(context, { complete = cerebrasStructuredCompletion } = {}) {
  if (!process.env.CEREBRAS_API_KEY || process.env.CEREBRAS_ANALYTICS_ENABLED === "false") {
    return null;
  }
  const { data, meta } = await complete({
    model: CEREBRAS_ANALYTICS_MODEL,
    schema: MULTISPORT_ANALYTICS_SCHEMA,
    schemaName: "multisport_prediction_analysis",
    maxCompletionTokens: 1300,
    messages: [
      {
        role: "system",
        content: [
          "You are a real-time prediction-market analyst for any live sport.",
          "Use only the supplied visual observation, event-switch signal, and prior context when it belongs to the same event.",
          "Prioritize markets viewers care about: match or fight winner, draw where applicable, qualification or advancement, totals, next scoring event, method of victory, and round or period outcomes.",
          "For golf prioritize outright winner, top 5 or top 10 finish, make or miss cut, round leader, and head-to-head player matchup when visibly supportable.",
          "For tournaments, leaderboards, and races prefer winner, podium or placement, advancement, stage or round winner, or a visible head-to-head matchup.",
          "Choose one primary market that is both important and supported by the visible evidence.",
          "Probabilities are calibrated estimates, not guarantees or trading instructions.",
          "Do not invent injuries, lineups, cards, possession, field position, fighter damage, or prior odds.",
          "If event_switch.detected is true, treat this as a fresh event and never carry an estimate or assumptions from the prior event.",
          "If the event is unidentified or the feed is a replay, lower confidence and say so.",
        ].join(" "),
      },
      { role: "user", content: JSON.stringify(context) },
    ],
  });
  return { ...data, model: meta?.model ?? CEREBRAS_ANALYTICS_MODEL };
}

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
