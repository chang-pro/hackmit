// Fixture extraction backend (Slice 1 behavior behind the Slice 2 interface).
// Reads the saved parsed_scoreboard from the frame's fixture file instead of
// looking at pixels. Fully deterministic — this is the bottom rung of the demo
// resilience ladder (README §13) and what tests and offline demos run on.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const LIVE_FIXTURE = fileURLToPath(
  new URL("../../../packages/fixtures/frames/frame_000184.json", import.meta.url)
);

export const fixtureBackend = {
  name: "fixture",

  async extract(frame) {
    const fixturePath =
      frame?.fixture_path ??
      (process.env.ALLOW_FIXTURE_LIVE === "true" ? LIVE_FIXTURE : null);
    if (!fixturePath) {
      throw new Error("fixture backend requires frame.fixture_path");
    }
    const raw = JSON.parse(await readFile(fixturePath, "utf8"));
    if (!raw.parsed_scoreboard) {
      throw new Error(`Fixture has no parsed_scoreboard: ${fixturePath}`);
    }
    return raw.parsed_scoreboard;
  },
};
