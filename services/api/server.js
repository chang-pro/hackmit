// BloomKnights API server. The mobile client posts base64 frames; frames are
// batched through the quota-aware LiveEventAnalyzer (Cerebras vision +
// analytics, one model call per interval). The demo pages replay famous-match
// fixtures across five sports. Zero dependencies (node:http).
//
// Routes:
//   POST /api/frames            — live frame in (sport-tagged); batched analysis
//   POST /api/reset             — clear live session state
//   GET  /api/health            — vision backend + buffer + quota status
//   GET  /api/comparison        — ?sport=<id>&fixture=<name>, live insight, or default
//   GET  /api/latest            — alias of /api/comparison
//   GET  /api/sports            — sport selector data for the frontends
//   GET  /api/stats             — compact summaries of saved ESPN snapshots
//   GET  /api/stats/raw?sport=  — full latest snapshot for one sport
//   GET  /, /capture, /phone, /data, /landing, /pitch — pages

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { runPipeline, resetLivePipeline } from "./pipeline.js";
import { LiveEventAnalyzer } from "./live-event-analyzer.js";
import { CaptureGateway } from "../capture/gateway.js";
import { FrameSelector } from "../capture/selector.js";
import { DatasetWriter } from "../capture/dataset.js";
import { visionStatus } from "../vision/index.js";
import { CEREBRAS_ANALYTICS_MODEL } from "../analytics/cerebras.js";
import { CEREBRAS_VISION_MODEL } from "../vision/backends/cerebras.js";
import { Reconciler } from "../vision/reconciler.js";
import { getSport, listSports, DEFAULT_SPORT_ID } from "../sports/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "packages", "fixtures", "frames");
const STATS_DIR = join(ROOT, "packages", "fixtures", "stats");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LIVE_SESSION_TTL_MS = 30_000;

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
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
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function responseHeaders(contentType = "application/json") {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "X-BloomKnights-API-Version": "1",
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, responseHeaders());
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
  res.writeHead(200, responseHeaders("text/html; charset=utf-8"));
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

export function createBloomServer({
  gateway = new CaptureGateway(),
  selector = new FrameSelector({ minIntervalMs: 750 }),
  visionBackend = undefined,
  liveAnalyzer = undefined,
} = {}) {
  const analyzer = liveAnalyzer ?? new LiveEventAnalyzer({ visionBackend });
  const datasetWriter = new DatasetWriter(); // enabled only via DATASET_DIR (§16)
  let latestInsight = null;
  let latestInsightAt = 0;

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
    if (!selection.accepted) {
      sendJson(res, 200, { frame: meta, sport: sport.id, selection, insight: latestInsight });
      return;
    }

    // Training-data collector (§16): writes only when DATASET_DIR is set, and
    // a dataset failure must never break frame ingestion. The label is the
    // latest extracted observation for this sport, when one exists.
    let dataset = null;
    if (datasetWriter.enabled) {
      try {
        const files = await datasetWriter.record({
          sport: sport.id,
          frame: meta,
          imageBase64: body.image_base64,
          state:
            latestInsight?.sport === sport.id
              ? latestInsight?.state ?? latestInsight?.observation ?? null
              : null,
        });
        dataset = { saved: true, labeled: files.label != null };
      } catch (err) {
        dataset = { saved: false, error: err.message };
      }
    }

    try {
      const frame = { ...gateway.frame(meta.frame_id), sport: sport.id };
      const result = await analyzer.submit(frame, {
        force: body.force_analysis === true || body.source === "phone_photo",
      });
      if (result.analysis_status === "analyzed") {
        latestInsight = { ...result.insight, sport: result.insight.sport ?? sport.id };
        latestInsightAt = Date.now();
      }
      sendJson(res, result.analysis_status === "analyzed" ? 201 : 202, {
        frame: meta,
        sport: sport.id,
        selection,
        ...result,
        ...(dataset ? { dataset } : {}),
      });
    } catch (err) {
      sendJson(res, 422, {
        frame: meta,
        sport: sport.id,
        selection,
        insight: null,
        analysis: {
          status: "error",
          backend: visionStatus().selected,
          error: err.message,
        },
        ...(dataset ? { dataset } : {}),
      });
    }
  }

  async function handleComparison(res, url) {
    let sport;
    try {
      sport = getSport(url.searchParams.get("sport"));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const requestedFixture = url.searchParams.get("fixture");
    // Allowlist per sport — the fixture param never touches the filesystem
    // directly, and a fixture can only be served under its own sport.
    if (requestedFixture && !sport.fixtures.includes(requestedFixture)) {
      sendJson(res, 400, {
        error: `unknown fixture for sport "${sport.id}"; known: ${sport.fixtures.join(", ")}`,
      });
      return;
    }
    if (requestedFixture) {
      // Each fixture request is an independent demo moment, so it gets a
      // fresh Reconciler with the sport's §7.5 invariants.
      sendJson(
        res,
        200,
        await runPipeline(join(FIXTURES_DIR, `${requestedFixture}.json`), undefined, null, {
          reconciler: new Reconciler(sport.reconcilerRules),
          sportId: sport.id,
        })
      );
      return;
    }
    // Live insights only count for the sport they were tagged with — NBA
    // frames must never make a golf comparison claim "live".
    if (
      latestInsight &&
      latestInsight.sport === sport.id &&
      Date.now() - latestInsightAt <= LIVE_SESSION_TTL_MS
    ) {
      sendJson(res, 200, latestInsight);
      return;
    }
    sendJson(
      res,
      200,
      await runPipeline(join(FIXTURES_DIR, `${sport.defaultFixture}.json`), undefined, null, {
        reconciler: new Reconciler(sport.reconcilerRules),
        sportId: sport.id,
      })
    );
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
      if (req.method === "OPTIONS") {
        res.writeHead(204, responseHeaders());
        res.end();
      } else if (req.method === "POST" && url.pathname === "/api/frames") {
        await handleFrameSubmission(req, res);
      } else if (req.method === "POST" && url.pathname === "/api/reset") {
        resetLivePipeline();
        analyzer.reset();
        gateway.clear();
        selector.reset();
        latestInsight = null;
        latestInsightAt = 0;
        sendJson(res, 200, { status: "reset" });
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          status: "ok",
          vision: visionStatus(),
          cerebras_models: {
            vision: CEREBRAS_VISION_MODEL,
            analytics: CEREBRAS_ANALYTICS_MODEL,
          },
          frame_buffer_size: gateway.size,
          has_live_insight: Boolean(latestInsight),
          analysis_queue: analyzer.status(),
        });
      } else if (
        req.method === "GET" &&
        (url.pathname === "/api/comparison" || url.pathname === "/api/latest")
      ) {
        await handleComparison(res, url);
      } else if (req.method === "GET" && url.pathname === "/api/sports") {
        handleSports(res);
      } else if (req.method === "GET" && url.pathname === "/api/stats/raw") {
        await handleStatsRaw(res, url.searchParams.get("sport"));
      } else if (req.method === "GET" && url.pathname === "/api/stats") {
        await handleStats(res);
      } else if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        await sendHtml(res, "index.html");
      } else if (
        req.method === "GET" &&
        (url.pathname === "/capture" || url.pathname === "/capture.html")
      ) {
        await sendHtml(res, "capture.html");
      } else if (
        req.method === "GET" &&
        (url.pathname === "/phone" || url.pathname === "/phone.html")
      ) {
        await sendHtml(res, "phone.html");
      } else if (req.method === "GET" && (url.pathname === "/data" || url.pathname === "/data.html")) {
        await sendHtml(res, "data.html");
      } else if (req.method === "GET" && url.pathname === "/landing") {
        await sendHtml(res, "index.html", "landing");
      } else if (req.method === "GET" && url.pathname === "/pitch") {
        await sendHtml(res, "index.html", "pitch");
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
}

function lanAddresses(port) {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(`http://${entry.address}:${port}/phone`);
      }
    }
  }
  return addresses;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createBloomServer();
  server.listen(port, host, () => {
    console.log(`BloomKnights desktop: http://localhost:${port}`);
    for (const address of lanAddresses(port)) console.log(`BloomKnights phone:   ${address}`);
    const status = visionStatus();
    console.log(
      status.selected
        ? `Vision backend: ${status.selected}`
        : `Vision backend unavailable: ${status.error}`
    );
  });
}
