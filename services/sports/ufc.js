// UFC sport config — demo replay: UFC 229, Khabib Nurmagomedov vs Conor
// McGregor (2018-10-06, lightweight title, 5 rounds; Khabib won by
// submission in round 4). Fighter slots: away = Khabib (red corner),
// home = McGregor (blue corner). Historical fight; mock market data is
// labeled is_mock. No on-screen score exists in MMA — the model is a
// prior-anchored estimate, and with no prior it stays at 0.5 honestly.

import { normalizeUfcScoreboard } from "../vision/normalize-ufc.js";
import * as ufcModel from "../probability/models/ufc.js";

const PROMPT = [
  "You are reading a broadcast overlay from a live UFC mixed martial arts fight.",
  "Extract exactly what is visible in this frame.",
  "There is no score. Report the two fighter names as displayed (fighter1 = red corner, fighter2 = blue corner).",
  "The round clock counts DOWN from 5:00 within each round.",
  "Report the round and clock exactly as displayed (e.g. round \"R3\" or \"ROUND 3\", clock \"2:45\").",
  "Report per-field confidences between 0 and 1 reflecting how clearly each field is legible.",
  "If a field is not visible, use an empty string for text fields and a low confidence.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    sport: { type: "STRING" },
    league: { type: "STRING" },
    fighter1_text: { type: "STRING", description: "Red-corner fighter name as shown" },
    fighter2_text: { type: "STRING", description: "Blue-corner fighter name as shown" },
    round_text: { type: "STRING", description: "Round as displayed, e.g. R3 or ROUND 3" },
    clock_text: { type: "STRING", description: "Round clock as displayed, e.g. 2:45" },
    field_confidences: {
      type: "OBJECT",
      properties: {
        fighters: { type: "NUMBER" },
        round: { type: "NUMBER" },
        clock: { type: "NUMBER" },
      },
      required: ["fighters", "round", "clock"],
    },
  },
  required: ["fighter1_text", "fighter2_text", "round_text", "clock_text", "field_confidences"],
};

export default {
  id: "ufc",
  label: "UFC (UFC 229 replay)",
  league: "UFC",
  sportTag: "mma",
  eventDate: "2018_10_06", // UFC 229

  vision: { prompt: PROMPT, responseSchema: RESPONSE_SCHEMA },
  normalize: normalizeUfcScoreboard,
  aliases: {
    KHABIB: "ufc_khabib",
    NURMAGOMEDOV: "ufc_khabib",
    "KHABIB NURMAGOMEDOV": "ufc_khabib",
    MCGREGOR: "ufc_mcgregor",
    CONOR: "ufc_mcgregor",
    "CONOR MCGREGOR": "ufc_mcgregor",
  },

  model: ufcModel,
  // Khabib closed around −160 pregame ≈ 0.62 implied. Applies to the
  // away-slot subject (Khabib); with rounds elapsed the finish share of that
  // edge is spent while the decision share persists (see the model).
  modelOptions: { pregameProbability: 0.62 },

  reconcilerRules: {
    // No scores on screen — score invariants are skipped for null scores;
    // the round (period) still never decreases.
    maxScoreJump: 0,
    allowScoreDecrease: false,
    confidenceFields: ["teams", "period", "clock"],
  },

  fixtures: ["ufc229_r2", "ufc229_r4"],
  defaultFixture: "ufc229_r2",
  demo_moments: [
    { fixture: "ufc229_r2", label: "R2 3:30 — Khabib vs McGregor" },
    { fixture: "ufc229_r4", label: "R4 3:03 — the finish round" },
  ],

  espnPath: "mma/ufc",
};
