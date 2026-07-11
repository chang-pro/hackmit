// Vision service — Slice 2: pluggable scoreboard extraction (README §7.3).
// extractScoreboard(frame, backend) runs one extraction backend, then pushes
// its raw output through normalize.js so noisy backend results (clock "2:14",
// period "4th") still land in the typed ParsedScoreboard contract. Downstream
// components never know which backend produced the fields.
//
// Backends: 'fixture' for plumbing tests and 'cerebras' for live camera input.
// A backend may also be passed directly as an object with { name, extract }.

import { readFile } from "node:fs/promises";
import { fixtureBackend } from "./backends/fixture.js";
import { cerebrasBackend } from "./backends/cerebras.js";
import { normalizeScoreboard } from "./normalize.js";

export const BACKENDS = {
  [fixtureBackend.name]: fixtureBackend,
  [cerebrasBackend.name]: cerebrasBackend,
};

export function liveBackendName(requested = process.env.VISION_BACKEND ?? "auto") {
  const name = requested.toLowerCase();
  if (name !== "auto") {
    if (!BACKENDS[name]) throw new Error(`Unknown live vision backend: ${requested}`);
    return name;
  }
  if (process.env.CEREBRAS_API_KEY) return "cerebras";
  if (process.env.ALLOW_FIXTURE_LIVE === "true") return "fixture";
  throw new Error(
    "No live vision backend configured. Set CEREBRAS_API_KEY."
  );
}

export function visionStatus() {
  let selected = null;
  let error = null;
  try {
    selected = liveBackendName();
  } catch (err) {
    error = err.message;
  }
  return {
    requested: process.env.VISION_BACKEND ?? "auto",
    selected,
    available: {
      cerebras: Boolean(process.env.CEREBRAS_API_KEY),
      fixture: true,
    },
    error,
  };
}

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
