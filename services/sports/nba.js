// NBA sport config — the original, default sport. Everything here points at
// the pre-existing single-sport implementations so the registry introduces
// zero behavior change for NBA (README §17.3: the primary slice stays whole).

import { NBA_PROMPT, NBA_RESPONSE_SCHEMA } from "../vision/backends/gemini.js";
import { normalizeScoreboard } from "../vision/normalize.js";
import { TEAM_ALIASES } from "../vision/resolver.js";
import * as nbaModel from "../probability/models/nba.js";

export default {
  id: "nba",
  label: "NBA Basketball",
  league: "NBA",
  sportTag: "basketball", // ParsedScoreboard.sport value this config expects
  eventDate: "2026_07_11", // demo game date used in event ids

  vision: { prompt: NBA_PROMPT, responseSchema: NBA_RESPONSE_SCHEMA },
  normalize: normalizeScoreboard,
  aliases: TEAM_ALIASES,

  model: nbaModel, // { winProbability, MODEL_VERSION }
  modelOptions: {},

  // §7.5 invariants for the reconciler (NBA = the Reconciler defaults).
  reconcilerRules: {
    maxScoreJump: 3,
    allowScoreDecrease: false,
    confidenceFields: ["teams", "scores", "period", "clock"],
  },

  fixtures: ["frame_000184", "frame_000260"],
  defaultFixture: "frame_000184",
  demo_moments: [
    { fixture: "frame_000184", label: "Q4 2:14 — BOS 104–101 NYK" },
    { fixture: "frame_000260", label: "Q4 0:30 — BOS 112–105 NYK" },
  ],

  espnPath: "basketball/nba", // ESPN scoreboard path segment (stats puller)
};
