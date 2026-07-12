// Vision service — pluggable scoreboard extraction (README §7.3).
// extractScoreboard(frame, backend, sport) runs one extraction backend, then
// pushes its raw output through the sport's normalizer (NBA default:
// normalize.js) so noisy backend results (clock "2:14", period "4th") still
// land in the typed ParsedScoreboard contract. Downstream components never
// know which backend produced the fields.
//
// Backends: 'fixture' for plumbing tests and deterministic replays,
// 'cerebras' for live camera input (primary), and 'gemini' (kept as an
// alternate multimodal backend; needs GEMINI_API_KEY). A backend may also be
// passed directly as an object with { name, extract }.

import { readFile } from "node:fs/promises";
import { fixtureBackend } from "./backends/fixture.js";
import { cerebrasBackend } from "./backends/cerebras.js";
import { geminiBackend } from "./backends/gemini.js";
import { normalizeScoreboard } from "./normalize.js";
import { getSport } from "../sports/index.js";

export const BACKENDS = {
  [fixtureBackend.name]: fixtureBackend,
  [cerebrasBackend.name]: cerebrasBackend,
  [geminiBackend.name]: geminiBackend,
};

export function liveBackendName(requested = process.env.VISION_BACKEND ?? "auto") {
  const name = requested.toLowerCase();
  if (name !== "auto") {
    if (!BACKENDS[name]) throw new Error(`Unknown live vision backend: ${requested}`);
    return name;
  }
  if (process.env.CEREBRAS_API_KEY) return "cerebras";
  if (process.env.RIGHTCODES_API_KEY || process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ALLOW_FIXTURE_LIVE === "true") return "fixture";
  throw new Error("No live vision backend configured. Set CEREBRAS_API_KEY.");
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
      gemini: Boolean(process.env.RIGHTCODES_API_KEY || process.env.GEMINI_API_KEY),
      fixture: true,
    },
    error,
  };
}

// `sport` is a sports-registry config (or null for the NBA default). It may
// also ride on the frame as a sport id string (frame.sport). The sport
// supplies the extraction prompt/schema hints and the sport-specific
// normalizer; omitting it preserves the original NBA behavior exactly.
// Backends that take only (frame) simply ignore the second argument.
export async function extractScoreboard(frame, backend = "fixture", sport = null) {
  const impl = typeof backend === "string" ? BACKENDS[backend] : backend;
  if (!impl || typeof impl.extract !== "function") {
    throw new Error(`Unknown extraction backend: ${JSON.stringify(backend)}`);
  }
  const sportConfig =
    sport ?? (typeof frame?.sport === "string" ? getSport(frame.sport) : null);
  const raw = await impl.extract(frame, { sport: sportConfig });
  const normalize = sportConfig?.normalize ?? normalizeScoreboard;
  return normalize(raw);
}

// Fixture entry point used by the deterministic demo: fixture file ->
// { frame, parsed }. The fixture path rides along on the frame so the fixture
// backend can find its saved scoreboard.
export async function parseFrame(fixturePath, backend = "fixture", sport = null) {
  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  const frame = { ...raw.frame, fixture_path: fixturePath };
  const parsed = await extractScoreboard(frame, backend, sport);
  return { frame: raw.frame, parsed };
}
