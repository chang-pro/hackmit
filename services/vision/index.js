// Vision service — Slice 1 implementation.
// Contract: takes a Frame reference, returns a ParsedScoreboard (README §7.3).
// In Slice 1 this reads a saved fixture instead of running OCR, but every
// downstream component consumes it through the same interface, so swapping in
// real scoreboard extraction (Slice 2) changes nothing outside this file.

import { readFile } from "node:fs/promises";

export async function parseFrame(fixturePath) {
  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  return { frame: raw.frame, parsed: raw.parsed_scoreboard };
}
