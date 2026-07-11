// Vision service — Slice 2: pluggable scoreboard extraction (README §7.3).
// extractScoreboard(frame, backend) runs one extraction backend, then pushes
// its raw output through normalize.js so noisy backend results (clock "2:14",
// period "4th") still land in the typed ParsedScoreboard contract. Downstream
// components never know which backend produced the fields.
//
// Backends: 'fixture' (deterministic saved JSON, Slice 1 behavior) and
// 'gemini' (multimodal schema-constrained JSON; needs GEMINI_API_KEY).
// A backend may also be passed directly as an object with { name, extract }.

import { readFile } from "node:fs/promises";
import { fixtureBackend } from "./backends/fixture.js";
import { geminiBackend } from "./backends/gemini.js";
import { normalizeScoreboard } from "./normalize.js";

export const BACKENDS = {
  [fixtureBackend.name]: fixtureBackend,
  [geminiBackend.name]: geminiBackend,
};

export async function extractScoreboard(frame, backend = "fixture") {
  const impl = typeof backend === "string" ? BACKENDS[backend] : backend;
  if (!impl || typeof impl.extract !== "function") {
    throw new Error(`Unknown extraction backend: ${JSON.stringify(backend)}`);
  }
  const raw = await impl.extract(frame);
  return normalizeScoreboard(raw);
}

// Slice 1 entry point, unchanged for callers (the pipeline): fixture file ->
// { frame, parsed }. The fixture path rides along on the frame so the fixture
// backend can find its saved scoreboard.
export async function parseFrame(fixturePath, backend = "fixture") {
  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  const frame = { ...raw.frame, fixture_path: fixturePath };
  const parsed = await extractScoreboard(frame, backend);
  return { frame: raw.frame, parsed };
}
