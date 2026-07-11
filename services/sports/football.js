// NFL sport config — demo replay: Super Bowl LI, New England Patriots vs
// Atlanta Falcons (2017-02-05), the 28–3 comeback. Falcons were the
// designated home team, so the subject slots are away = NE, home = ATL and
// the estimated demo outcome is P(Patriots win) — near zero in Q3, a coin
// flip by the Q4 tie. Historical match; mock market data is labeled is_mock.

import { normalizeFootballScoreboard } from "../vision/normalize-football.js";
import * as footballModel from "../probability/models/football.js";

const PROMPT = [
  "You are reading a broadcast scoreboard from a live NFL American football game.",
  "Extract exactly what is visible on the scoreboard in this frame.",
  "The game clock counts DOWN within each 15-minute quarter.",
  "Report the clock and quarter exactly as displayed (e.g. clock \"8:31\", quarter \"3rd\", \"Q3\", or \"OT\").",
  "Team labels are usually 2-3 letter codes (e.g. NE, ATL).",
  "Report per-field confidences between 0 and 1 reflecting how clearly each field is legible.",
  "If a field is not visible, use an empty string for text fields and a low confidence.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    sport: { type: "STRING" },
    league: { type: "STRING" },
    away_team_text: { type: "STRING", description: "Away team label as shown, e.g. NE" },
    home_team_text: { type: "STRING", description: "Home team label as shown, e.g. ATL" },
    away_score: { type: "INTEGER" },
    home_score: { type: "INTEGER" },
    period_text: { type: "STRING", description: "Quarter as displayed, e.g. 3rd, Q3, OT" },
    clock_text: { type: "STRING", description: "Game clock as displayed, e.g. 8:31" },
    possession_team_text: { type: "STRING", nullable: true },
    field_confidences: {
      type: "OBJECT",
      properties: {
        teams: { type: "NUMBER" },
        scores: { type: "NUMBER" },
        period: { type: "NUMBER" },
        clock: { type: "NUMBER" },
        possession: { type: "NUMBER" },
      },
      required: ["teams", "scores", "period", "clock"],
    },
  },
  required: [
    "away_team_text",
    "home_team_text",
    "away_score",
    "home_score",
    "period_text",
    "clock_text",
    "field_confidences",
  ],
};

export default {
  id: "football",
  label: "NFL Football (Super Bowl LI replay)",
  league: "NFL",
  sportTag: "football",
  eventDate: "2017_02_05", // Super Bowl LI

  vision: { prompt: PROMPT, responseSchema: RESPONSE_SCHEMA },
  normalize: normalizeFootballScoreboard,
  aliases: {
    NE: "nfl_ne",
    NWE: "nfl_ne",
    PATRIOTS: "nfl_ne",
    "NEW ENGLAND": "nfl_ne",
    ATL: "nfl_atl",
    FALCONS: "nfl_atl",
    ATLANTA: "nfl_atl",
  },

  model: footballModel,
  // NE closed as roughly a 3-point favorite pregame (~0.61 to win). The prior
  // applies to the away-slot subject (NE) and replaces the home edge; its
  // effect decays with time, so Q3 28–3 still crushes it.
  modelOptions: { pregameProbability: 0.61 },

  reconcilerRules: {
    maxScoreJump: 8, // TD + 2-pt conversion is the largest single jump
    allowScoreDecrease: false,
    confidenceFields: ["teams", "scores", "period", "clock"],
  },

  fixtures: ["sb51_q3_831", "sb51_q4_057"],
  defaultFixture: "sb51_q3_831",
  demo_moments: [
    { fixture: "sb51_q3_831", label: "Q3 8:31 — ATL 28–3 NE (the hole)" },
    { fixture: "sb51_q4_057", label: "Q4 0:57 — 28–28 (the comeback)" },
  ],

  espnPath: "football/nfl",
};
