// Fixture extraction backend (Slice 1 behavior behind the Slice 2 interface).
// Reads the saved parsed_scoreboard from the frame's fixture file instead of
// looking at pixels. Fully deterministic — this is the bottom rung of the demo
// resilience ladder (README §13) and what tests and offline demos run on.

import { readFile } from "node:fs/promises";

export const fixtureBackend = {
  name: "fixture",

  async extract(frame) {
    if (!frame?.fixture_path) {
      throw new Error("fixture backend requires frame.fixture_path");
    }
    const raw = JSON.parse(await readFile(frame.fixture_path, "utf8"));
    if (!raw.parsed_scoreboard) {
      throw new Error(`Fixture has no parsed_scoreboard: ${frame.fixture_path}`);
    }
    return raw.parsed_scoreboard;
  },
};
