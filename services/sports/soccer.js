// Soccer sport config — demo replay: 2022 FIFA World Cup Final,
// Argentina vs France (Lusail, 2022-12-18). Historical match; the mock
// market data for it is labeled is_mock like every fallback (README §13).
// Clock counts UP (elapsed minutes, stoppage past 45/90); halves are periods
// 1–2 and extra time is 3–4.

import { normalizeSoccerScoreboard } from "../vision/normalize-soccer.js";
import * as soccerModel from "../probability/models/soccer.js";

const PROMPT = [
  "You are reading a broadcast score bug from a live soccer (association football) match.",
  "Extract exactly what is visible in this frame.",
  "The clock counts UP in elapsed minutes and may show stoppage time (e.g. \"67'\", \"45+2\", \"90+3\").",
  "Report the clock exactly as displayed in clock_text.",
  "Report the half in period_text: \"1st\" or \"2nd\" for regulation halves, \"ET\" or \"ET2\" for extra time.",
  "Scores are goals. Team labels are usually 3-letter codes (e.g. ARG, FRA).",
  "Report per-field confidences between 0 and 1 reflecting how clearly each field is legible.",
  "If a field is not visible, use an empty string for text fields and a low confidence.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    sport: { type: "STRING" },
    league: { type: "STRING" },
    away_team_text: { type: "STRING", description: "First/away team label as shown, e.g. ARG" },
    home_team_text: { type: "STRING", description: "Second/home team label as shown, e.g. FRA" },
    away_score: { type: "INTEGER", description: "Goals" },
    home_score: { type: "INTEGER", description: "Goals" },
    period_text: { type: "STRING", description: "Half as displayed: 1st, 2nd, ET, ET2" },
    clock_text: { type: "STRING", description: "Elapsed-minute clock as displayed, e.g. 67' or 90+3" },
    field_confidences: {
      type: "OBJECT",
      properties: {
        teams: { type: "NUMBER" },
        scores: { type: "NUMBER" },
        period: { type: "NUMBER" },
        clock: { type: "NUMBER" },
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
  id: "soccer",
  label: "Soccer (World Cup replay)",
  league: "FIFA World Cup",
  sportTag: "soccer",
  eventDate: "2022_12_18", // 2022 World Cup Final

  vision: { prompt: PROMPT, responseSchema: RESPONSE_SCHEMA },
  normalize: normalizeSoccerScoreboard,
  aliases: {
    ARG: "wc_arg",
    ARGENTINA: "wc_arg",
    FRA: "wc_fra",
    FRANCE: "wc_fra",
  },

  model: soccerModel,
  modelOptions: {},

  reconcilerRules: {
    maxScoreJump: 1, // goals arrive one at a time
    allowScoreDecrease: false,
    confidenceFields: ["teams", "scores", "period", "clock"],
  },

  fixtures: ["wc22_final_60min", "wc22_final_118min"],
  defaultFixture: "wc22_final_60min",
  demo_moments: [
    { fixture: "wc22_final_60min", label: "60' — ARG 2–0 FRA (World Cup Final)" },
    { fixture: "wc22_final_118min", label: "118' (ET) — ARG 3–3 FRA" },
  ],

  espnPath: "soccer/eng.1",
};
