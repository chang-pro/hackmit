#!/usr/bin/env node
// Model evaluation for the probability engine (README §11, Slice 3).
//
// 1. Always prints a scenario table (home margin × time remaining -> home win
//    probability) so a human can eyeball monotonicity and sanity.
// 2. Optionally runs a calibration harness against historical data:
//        node scripts/evaluate-model.js path/to/history.csv
//    CSV format is documented in models/metadata/nba-win-probability-v1.json.
//    Without a CSV, no calibration numbers are printed — never invented.

import { readFileSync } from "node:fs";
import { winProbability, MODEL_VERSION } from "../services/probability/index.js";

const state = (period, clock, homeMargin) => ({
  event_id: "eval_scenario",
  away_team_id: "away",
  home_team_id: "home",
  away_score: 100,
  home_score: 100 + homeMargin,
  period,
  clock_seconds: clock,
});

// --- Scenario table -------------------------------------------------------

const checkpoints = [
  { label: "Q1 12:00", period: 1, clock: 720 },
  { label: "Q2 06:00", period: 2, clock: 360 },
  { label: "Half", period: 2, clock: 0 },
  { label: "Q3 06:00", period: 3, clock: 360 },
  { label: "Q4 06:00", period: 4, clock: 360 },
  { label: "Q4 02:00", period: 4, clock: 120 },
  { label: "Q4 00:30", period: 4, clock: 30 },
  { label: "OT 02:00", period: 5, clock: 120 },
  { label: "OT 00:30", period: 5, clock: 30 },
];
const margins = [-15, -10, -5, -2, 0, 2, 5, 10, 15];

const pct = (p) => `${(p * 100).toFixed(1)}%`.padStart(8);

console.log(`Model: ${MODEL_VERSION}`);
console.log("Home team win probability by home margin (rows) and game time (columns).");
console.log("No pregame prior (default home edge), possession off.\n");
console.log(["margin".padStart(6), ...checkpoints.map((c) => c.label.padStart(8))].join(" "));
for (const m of margins) {
  const row = checkpoints.map((c) => pct(winProbability(state(c.period, c.clock, m), "home")));
  console.log([String(m).padStart(6), ...row].join(" "));
}
console.log(
  "\nSanity: each row should rise left to right when margin > 0 and fall when" +
    "\nmargin < 0 (leads harden as time expires); each column should rise top to bottom."
);

// --- Optional calibration harness -----------------------------------------

const csvPath = process.argv[2];
if (!csvPath) {
  console.log(
    "\nNo historical CSV provided — calibration skipped (this model is uncalibrated)." +
      "\nTo run: node scripts/evaluate-model.js path/to/history.csv" +
      "\nCSV format: see models/metadata/nba-win-probability-v1.json -> calibration.csv_format"
  );
  process.exit(0);
}

const text = readFileSync(csvPath, "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
const header = lines[0].split(",").map((h) => h.trim());
const col = (name) => header.indexOf(name);
for (const required of ["period", "clock_seconds", "away_score", "home_score", "home_won"]) {
  if (col(required) === -1) {
    console.error(`CSV is missing required column "${required}". Header: ${header.join(", ")}`);
    process.exit(1);
  }
}

const rows = lines.slice(1).map((line) => {
  const parts = line.split(",").map((p) => p.trim());
  const num = (name) => Number(parts[col(name)]);
  const opt = (name) => (col(name) === -1 ? undefined : parts[col(name)]);
  return {
    state: {
      event_id: "history",
      away_team_id: "away",
      home_team_id: "home",
      away_score: num("away_score"),
      home_score: num("home_score"),
      period: num("period"),
      clock_seconds: num("clock_seconds"),
      possession_team_id:
        opt("possession") === "home" ? "home" : opt("possession") === "away" ? "away" : null,
    },
    homeWon: num("home_won"),
    homePregameProb: opt("home_pregame_prob") ? Number(opt("home_pregame_prob")) : undefined,
  };
});

function report(name, predict) {
  const buckets = Array.from({ length: 10 }, () => ({ n: 0, pSum: 0, wins: 0 }));
  let brier = 0;
  let logLoss = 0;
  for (const r of rows) {
    const p = predict(r);
    const b = buckets[Math.min(9, Math.floor(p * 10))];
    b.n += 1;
    b.pSum += p;
    b.wins += r.homeWon;
    brier += (p - r.homeWon) ** 2;
    logLoss += -(r.homeWon * Math.log(p) + (1 - r.homeWon) * Math.log(1 - p));
  }
  console.log(`\nCalibration — ${name} (${rows.length} snapshots from ${csvPath})`);
  console.log("bucket      n   mean predicted   observed home-win rate");
  buckets.forEach((b, i) => {
    const range = `${(i * 10).toString().padStart(2)}-${(i + 1) * 10}%`;
    const pred = b.n ? pct(b.pSum / b.n) : "     n/a";
    const obs = b.n ? pct(b.wins / b.n) : "     n/a";
    console.log(`${range.padEnd(8)} ${String(b.n).padStart(6)}  ${pred.padStart(14)}  ${obs.padStart(21)}`);
  });
  console.log(`Brier score: ${(brier / rows.length).toFixed(4)}   Log loss: ${(logLoss / rows.length).toFixed(4)}`);
}

report("baseline (default home edge, possession off)", (r) =>
  winProbability(r.state, "home")
);
if (rows.some((r) => r.homePregameProb !== undefined)) {
  report("with pregame prior", (r) =>
    winProbability(r.state, "home", { pregameProbability: r.homePregameProb })
  );
}
if (rows.some((r) => r.state.possession_team_id !== null)) {
  report("with possession adjustment", (r) =>
    winProbability(r.state, "home", { includePossession: true })
  );
}
console.log(
  "\nIf results look systematically biased, see models/metadata/nba-win-probability-v1.json" +
    "\n-> calibration.procedure before changing constants."
);
