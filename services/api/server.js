// API server — orchestrates the pipeline and serves the debug view.
// Zero dependencies (node:http) so the skeleton runs with `node` alone.
//
// Slice 4 added the live-frame path: POST /api/frames routes submissions
// through the capture gateway (§7.1) and frame selector (§7.2), and GET
// /capture serves a webcam capture page. The multi-sport slice adds:
//   GET  /api/sports            — sport selector data for the frontend
//   GET  /api/comparison?sport=<id>&fixture=<name> — sport-aware pipeline
//   GET  /api/stats             — compact summaries of saved ESPN snapshots
//   GET  /api/stats/raw?sport=  — full latest snapshot for one sport
//   POST /api/frames            — now accepts an optional "sport" field
// plus the DatasetWriter (README §16: off unless DATASET_DIR is set), which
// pairs selector-accepted live frames with the latest reconciled state.
//
// The server is exported as a factory (createBloomServer) so tests can run it
// on an ephemeral port; it only listens when executed directly (npm start).

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline } from "./pipeline.js";
import { CaptureGateway } from "../capture/gateway.js";
import { FrameSelector } from "../capture/selector.js";
import { DatasetWriter } from "../capture/dataset.js";
import { Reconciler } from "../vision/reconciler.js";
import { getSport, listSports, DEFAULT_SPORT_ID } from "../sports/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "packages", "fixtures", "frames");
const STATS_DIR = join(ROOT, "packages", "fixtures", "stats");
const PORT = process.env.PORT || 3000;

const MAX_BODY_BYTES = 8 * 1024 * 1024; // generous for base64 1080p JPEGs
const LIVE_SESSION_TTL_MS = 10_000; // no selected frame for 10 s => not live

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

async function sendHtml(res, filename, appDir = "demo-web") {
  let html;
  try {
    html = await readFile(join(ROOT, "apps", appDir, filename));
  } catch (err) {
    if (err.code === "ENOENT") {
      sendJson(res, 404, { error: `${filename} is not built yet` });
      return;
    }
    throw err;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

// ── Saved ESPN stats snapshots (scripts/pull-stats.js) ──────────────────────
// Served from disk only — no network calls at request time.

const STATS_SPORTS = ["soccer", "football", "ufc", "golf"];

async function latestSnapshotFile(sportId) {
  let files;
  try {
    files = await readdir(STATS_DIR);
  } catch {
    return null; // stats dir doesn't exist yet — no snapshots pulled
  }
  const matches = files
    .filter((f) => f.startsWith(`${sportId}-`) && f.endsWith(".json"))
    .sort(); // names embed the date, so lexicographic sort is chronological
  return matches.length > 0 ? join(STATS_DIR, matches.at(-1)) : null;
}

async function loadLatestSnapshot(sportId) {
  const file = await latestSnapshotFile(sportId);
  if (!file) return null;
  return JSON.parse(await readFile(file, "utf8"));
}

async function handleStats(res) {
  const sports = {};
  for (const sportId of STATS_SPORTS) {
    const snapshot = await loadLatestSnapshot(sportId);
    if (!snapshot) {
      sports[sportId] = {
        data: null,
        reason: "no snapshot pulled yet — run scripts/pull-stats.js",
      };
    } else if (snapshot.ok === false) {
      sports[sportId] = {
        data: null,
        reason: `last pull failed: ${snapshot.error}`,
        pulled_at: snapshot.pulled_at,
      };
    } else {
      sports[sportId] = { data: snapshot.summary, pulled_at: snapshot.pulled_at };
    }
  }
  sendJson(res, 200, { sports });
}

async function handleStatsRaw(res, sportId) {
  if (!STATS_SPORTS.includes(sportId)) {
    sendJson(res, 400, { error: `unknown stats sport; known: ${STATS_SPORTS.join(", ")}` });
    return;
  }
  const snapshot = await loadLatestSnapshot(sportId);
  if (!snapshot) {
    sendJson(res, 404, {
      error: `no snapshot saved for ${sportId} — run scripts/pull-stats.js`,
    });
    return;
  }
  sendJson(res, 200, snapshot);
}

// ── Server factory ───────────────────────────────────────────────────────────

export function createBloomServer() {
  const gateway = new CaptureGateway();
  const selector = new FrameSelector();
  const datasetWriter = new DatasetWriter(); // enabled only via DATASET_DIR (§16)
  let lastSelected = null; // { meta, at, sport } — most recent selector-approved frame
  const lastStateBySport = new Map(); // sport id -> latest reconciled state

  // Only frames tagged with the SAME sport count as the live session for a
  // comparison — NBA frames must never make a golf comparison claim "live".
  function activeLiveFrame(sportId) {
    if (!lastSelected) return null;
    if (sportId != null && lastSelected.sport !== sportId) return null;
    return Date.now() - lastSelected.at <= LIVE_SESSION_TTL_MS ? lastSelected.meta : null;
  }

  // POST /api/frames — source-agnostic frame ingestion.
  // The gateway assigns the frame_id and buffers the frame in memory; the
  // selector then decides whether it flows downstream (rate limit + duplicate
  // skip). Skipped frames still get metadata back so clients can count them.
  // Optional body field "sport" tags the frame's sport (default nba).
  async function handleFrameSubmission(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { error: err.message });
      return;
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { error: "request body must be a JSON object" });
      return;
    }

    let sport;
    try {
      if (body.sport != null && typeof body.sport !== "string") {
        throw new Error("sport must be a string");
      }
      sport = getSport(body.sport ?? null);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    let meta;
    try {
      meta = gateway.ingest(body);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const selection = selector.consider(body.image_base64);
    let dataset = null;
    if (selection.accepted) {
      lastSelected = { meta, at: Date.now(), sport: sport.id };
      // Training-data collector (§16): writes only when DATASET_DIR is set.
      // A dataset failure must never break frame ingestion.
      if (datasetWriter.enabled) {
        try {
          const files = await datasetWriter.record({
            sport: sport.id,
            frame: meta,
            imageBase64: body.image_base64,
            state: lastStateBySport.get(sport.id) ?? null,
          });
          dataset = { saved: true, labeled: files.label != null };
        } catch (err) {
          dataset = { saved: false, error: err.message };
        }
      }
    }

    sendJson(res, selection.accepted ? 201 : 200, {
      frame: meta,
      sport: sport.id,
      selection,
      ...(dataset ? { dataset } : {}),
    });
  }

  async function handleComparison(res, url) {
    let sport;
    try {
      sport = getSport(url.searchParams.get("sport"));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    // Allowlist per sport — the fixture param never touches the filesystem
    // directly, and a fixture can only be served under its own sport.
    const fixture = url.searchParams.get("fixture") || sport.defaultFixture;
    if (!sport.fixtures.includes(fixture)) {
      sendJson(res, 400, {
        error: `unknown fixture for sport "${sport.id}"; known: ${sport.fixtures.join(", ")}`,
      });
      return;
    }
    // Each fixture request is an independent demo moment, so it gets a fresh
    // Reconciler with the sport's §7.5 invariants: those compare consecutive
    // observations, and demo moments are minutes of game time apart. The
    // adapter stays undefined so the Slice 5 registry default applies.
    const result = await runPipeline(
      join(FIXTURES_DIR, `${fixture}.json`),
      undefined,
      activeLiveFrame(sport.id),
      new Reconciler(sport.reconcilerRules),
      sport.id
    );
    if (result.state) {
      // Remember the latest reconciled state per sport for dataset labeling.
      lastStateBySport.set(sport.id, result.state);
    }
    sendJson(res, 200, result);
  }

  function handleSports(res) {
    sendJson(
      res,
      200,
      listSports().map((s) => ({
        id: s.id,
        label: s.label,
        league: s.league,
        default: s.id === DEFAULT_SPORT_ID,
        default_fixture: s.defaultFixture,
        fixtures: [...s.fixtures],
        demo_moments: s.demo_moments.map((m) => ({ ...m })),
      }))
    );
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "POST" && url.pathname === "/api/frames") {
        await handleFrameSubmission(req, res);
      } else if (url.pathname === "/api/comparison") {
        await handleComparison(res, url);
      } else if (url.pathname === "/api/sports") {
        handleSports(res);
      } else if (url.pathname === "/api/stats/raw") {
        await handleStatsRaw(res, url.searchParams.get("sport"));
      } else if (url.pathname === "/api/stats") {
        await handleStats(res);
      } else if (url.pathname === "/" || url.pathname === "/index.html") {
        await sendHtml(res, "index.html");
      } else if (url.pathname === "/capture" || url.pathname === "/capture.html") {
        await sendHtml(res, "capture.html");
      } else if (url.pathname === "/data" || url.pathname === "/data.html") {
        await sendHtml(res, "data.html");
      } else if (url.pathname === "/landing") {
        await sendHtml(res, "index.html", "landing");
      } else if (url.pathname === "/pitch") {
        await sendHtml(res, "index.html", "pitch");
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    } catch (err) {
      // The UI never shows a raw stack; the debug endpoint reports the failure.
      sendJson(res, 500, { error: err.message });
    }
  });
}

// Listen only when run directly (npm start) — importing for tests stays silent.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createBloomServer().listen(PORT, () => {
    console.log(`BloomKnights demo: http://localhost:${PORT} (webcam capture: /capture)`);
  });
}
