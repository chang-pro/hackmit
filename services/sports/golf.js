// Golf sport config — demo replay: 2019 Masters final round, Tiger Woods's
// comeback win (2019-04-14). Two leaderboard moments: tied with Molinari
// after Molinari's double bogey at 12, then a two-shot lead over the chasing
// pack (Koepka) with two holes to play. Subject slots: away = leader,
// home = chaser. Historical round; mock market data is labeled is_mock.
// Note: the two moments track different chasers, so they resolve to
// different two-player event ids — both have mock markets.

import { normalizeGolfLeaderboard } from "../vision/normalize-golf.js";
import * as golfModel from "../probability/models/golf.js";

const PROMPT = [
  "You are reading a broadcast leaderboard graphic from a live professional golf tournament.",
  "Extract the top two players exactly as displayed.",
  "For each player report the name, the score relative to par as displayed (e.g. \"-12\", \"E\", \"+3\"),",
  "and the holes completed as displayed (a number 1-18, or \"F\" if finished).",
  "There is no game clock in golf.",
  "Report per-field confidences between 0 and 1 reflecting how clearly each field is legible.",
  "If a field is not visible, use an empty string for text fields and a low confidence.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    sport: { type: "STRING" },
    league: { type: "STRING" },
    players: {
      type: "ARRAY",
      description: "Top two leaderboard rows, in displayed order",
      items: {
        type: "OBJECT",
        properties: {
          name_text: { type: "STRING", description: "Player name as shown, e.g. TIGER WOODS" },
          score_to_par_text: { type: "STRING", description: "Score to par as shown, e.g. -12, E, +3" },
          thru_text: { type: "STRING", description: "Holes completed as shown, e.g. 16 or F" },
        },
        required: ["name_text", "score_to_par_text", "thru_text"],
      },
    },
    field_confidences: {
      type: "OBJECT",
      properties: {
        players: { type: "NUMBER" },
        scores: { type: "NUMBER" },
        holes: { type: "NUMBER" },
      },
      required: ["players", "scores", "holes"],
    },
  },
  required: ["players", "field_confidences"],
};

export default {
  id: "golf",
  label: "Golf (2019 Masters replay)",
  league: "PGA",
  sportTag: "golf",
  eventDate: "2019_04_14", // Masters final round

  vision: { prompt: PROMPT, responseSchema: RESPONSE_SCHEMA },
  normalize: normalizeGolfLeaderboard,
  aliases: {
    TIGER: "pga_tiger",
    "TIGER WOODS": "pga_tiger",
    WOODS: "pga_tiger",
    MOLINARI: "pga_molinari",
    "FRANCESCO MOLINARI": "pga_molinari",
    KOEPKA: "pga_koepka",
    "BROOKS KOEPKA": "pga_koepka",
  },

  model: golfModel,
  modelOptions: {},

  reconcilerRules: {
    // To-par scores go DOWN with birdies — decreases are normal in golf.
    maxScoreJump: 5,
    allowScoreDecrease: true,
    confidenceFields: ["teams", "scores", "holes"],
  },

  fixtures: ["masters19_h12", "masters19_h16"],
  defaultFixture: "masters19_h12",
  demo_moments: [
    { fixture: "masters19_h12", label: "Thru 12 — Tiger ties Molinari at -11" },
    { fixture: "masters19_h16", label: "Thru 16 — Tiger -14, two clear of Koepka" },
  ],

  espnPath: "golf/pga",
};
