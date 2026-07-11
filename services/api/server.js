// BloomKnights API server. The mobile client posts base64 frames; frames are
// batched through the quota-aware LiveEventAnalyzer (Cerebras vision +
// analytics, one model call per interval). The demo pages replay famous-match
// fixtures across five sports. Zero dependencies (node:http).
//
// Routes:
//   POST /api/frames            — live frame in (sport-tagged); batched analysis
//   POST /api/reset             — clear live session state
//   GET  /api/health            — vision backend + buffer + quota status
//   GET  /api/live-frame        — metadata for the newest inbound camera frame
//   GET  /api/live-frame/image  — newest inbound camera JPEG/PNG bytes
//   POST /api/live-stream        — lightweight continuous camera frame relay
//   GET  /api/live-stream        — MJPEG stream for the desktop viewer
//   GET  /api/live-stream/status — relay and analysis status
//   POST /api/analysis/start     — explicitly enable model analysis
//   POST /api/analysis/stop      — disable model analysis
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
const STREAM_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const MJPEG_BOUNDARY = "bloomknights-frame";

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

function imageBytes(imageBase64) {
  const dataUrl = String(imageBase64).match(/^data:[^;]+;base64,(.+)$/s);
  return Buffer.from(dataUrl?.[1] ?? imageBase64, "base64");
}

function parseStreamFrame({ source, captured_at, image_base64, mime_type = "image/jpeg", width, height } = {}) {
  if (typeof source !== "string" || source.trim() === "") throw new Error("source is required");
  if (typeof image_base64 !== "string" || image_base64 === "") throw new Error("image_base64 is required");
  if (!STREAM_MIME_TYPES.has(mime_type)) throw new Error(`unsupported mime_type: ${mime_type}`);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("width and height must be positive numbers");
  }
  const parsedAt = Date.parse(captured_at ?? "");
  return {
    source,
    captured_at: Number.isNaN(parsedAt) ? new Date().toISOString() : new Date(parsedAt).toISOString(),
    image_base64,
    mime_type,
    width,
    height,
  };
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
  let analysisEnabled = false;
  let latestStreamFrame = null;
  let streamFrameCounter = 0;
  const streamSubscribers = new Set();

  function resetAnalysisState() {
    analyzer.reset();
    gateway.clear();
    selector.reset();
    latestInsight = null;
    latestInsightAt = 0;
  }

  function writeMjpegFrame(res, frame) {
    const bytes = imageBytes(frame.image_base64);
    res.write(`--${MJPEG_BOUNDARY}\r\n`);
    res.write(`Content-Type: ${frame.mime_type}\r\n`);
    res.write(`Content-Length: ${bytes.length}\r\n`);
    res.write(`X-BloomKnights-Frame-Id: ${frame.frame_id}\r\n\r\n`);
    res.write(bytes);
    res.write("\r\n");
  }

  function broadcastStreamFrame(frame) {
    for (const res of streamSubscribers) {
      try {
        writeMjpegFrame(res, frame);
      } catch {
        streamSubscribers.delete(res);
      }
    }
  }

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

    if (!analysisEnabled) {
      sendJson(res, 202, {
        analysis_status: "disabled",
        analysis_enabled: false,
        queue: analyzer.status(),
      });
      return;
    }

    let requestedSport = null;
    try {
      if (body.sport != null && typeof body.sport !== "string") {
        throw new Error("sport must be a string");
      }
      const sportHint = body.sport?.trim().toLowerCase();
      if (sportHint && sportHint !== "auto") {
        requestedSport = { id: sportHint };
      }
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
      sendJson(res, 200, {
        frame: meta,
        sport: latestInsight?.observation?.sport ?? requestedSport?.id ?? "auto",
        selection,
        insight: latestInsight,
      });
      return;
    }

    // Training-data collector (§16): writes only when DATASET_DIR is set, and
    // a dataset failure must never break frame ingestion. The label is the
    // latest extracted observation for this sport, when one exists.
    let dataset = null;
    if (datasetWriter.enabled) {
      try {
        const files = await datasetWriter.record({
          sport: latestInsight?.observation?.sport ?? requestedSport?.id ?? "unknown",
          frame: meta,
          imageBase64: body.image_base64,
          state: latestInsight?.state ?? latestInsight?.observation ?? null,
        });
        dataset = { saved: true, labeled: files.label != null };
      } catch (err) {
        dataset = { saved: false, error: err.message };
      }
    }

    try {
      const frame = {
        ...gateway.frame(meta.frame_id),
        ...(requestedSport ? { requested_sport_hint: requestedSport.id } : {}),
      };
      const result = await analyzer.submit(frame, {
        force: body.force_analysis === true || body.source === "phone_photo",
      });
      if (result.analysis_status === "analyzed") {
        latestInsight = {
          ...result.insight,
          sport: result.insight.observation?.sport ?? requestedSport?.id ?? "unknown",
        };
        latestInsightAt = Date.now();
      }
      sendJson(res, result.analysis_status === "analyzed" ? 201 : 202, {
        frame: meta,
        sport:
          result.insight?.observation?.sport ??
          latestInsight?.observation?.sport ??
          requestedSport?.id ??
          "auto",
        selection,
        ...result,
        ...(dataset ? { dataset } : {}),
      });
    } catch (err) {
      sendJson(res, 422, {
        frame: meta,
        sport: requestedSport?.id ?? "auto",
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
    const requestedSportId = url.searchParams.get("sport");
    let sport;
    try {
      sport = getSport(requestedSportId);
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
    // With no explicit fixture or sport filter, the latest auto-detected event
    // wins. An explicit sport query keeps the legacy dashboard isolated.
    if (
      latestInsight &&
      (!requestedSportId || latestInsight.sport === sport.id) &&
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

  function handleLatestFrame(res) {
    const latest = gateway.latest();
    if (!latest) {
      sendJson(res, 404, { error: "no live camera frame received yet" });
      return;
    }
    sendJson(res, 200, {
      frame: latest.meta,
      age_ms: Math.max(0, Date.now() - Date.parse(latest.meta.captured_at)),
      image_url: `/api/live-frame/image?frame_id=${encodeURIComponent(latest.meta.frame_id)}`,
      insight: latestInsight,
    });
  }

  async function handleStreamSubmission(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw Object.assign(new Error("request body must be a JSON object"), { statusCode: 400 });
      }
      const parsed = parseStreamFrame(body);
      streamFrameCounter += 1;
      latestStreamFrame = {
        ...parsed,
        frame_id: `stream_${String(streamFrameCounter).padStart(8, "0")}`,
      };
      broadcastStreamFrame(latestStreamFrame);
      sendJson(res, 202, {
        status: "streaming",
        frame: {
          frame_id: latestStreamFrame.frame_id,
          captured_at: latestStreamFrame.captured_at,
          source: latestStreamFrame.source,
          mime_type: latestStreamFrame.mime_type,
          width: latestStreamFrame.width,
          height: latestStreamFrame.height,
        },
        analysis_enabled: analysisEnabled,
      });
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { error: err.message });
    }
  }

  function handleLiveStream(res, req) {
    res.writeHead(200, {
      ...responseHeaders(`multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`),
      Connection: "keep-alive",
    });
    res.flushHeaders();
    streamSubscribers.add(res);
    if (latestStreamFrame) writeMjpegFrame(res, latestStreamFrame);
    const close = () => streamSubscribers.delete(res);
    req.on("close", close);
    res.on("close", close);
  }

  function handleLiveStreamStatus(res) {
    sendJson(res, 200, {
      analysis_enabled: analysisEnabled,
      stream: latestStreamFrame
        ? {
            frame_id: latestStreamFrame.frame_id,
            captured_at: latestStreamFrame.captured_at,
            age_ms: Math.max(0, Date.now() - Date.parse(latestStreamFrame.captured_at)),
            width: latestStreamFrame.width,
            height: latestStreamFrame.height,
          }
        : null,
    });
  }

  function handleAnalysisControl(res, enabled) {
    analysisEnabled = enabled;
    resetAnalysisState();
    sendJson(res, 200, { analysis_enabled: analysisEnabled, queue: analyzer.status() });
  }

  function handleLatestFrameImage(res, url) {
    const frameId = url.searchParams.get("frame_id");
    const stored = frameId ? gateway.get(frameId) : gateway.latest();
    if (!stored) {
      sendJson(res, 404, { error: "live camera frame is unavailable" });
      return;
    }
    res.writeHead(200, responseHeaders(stored.mime_type));
    res.end(imageBytes(stored.image_base64));
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
      } else if (req.method === "POST" && url.pathname === "/api/live-stream") {
        await handleStreamSubmission(req, res);
      } else if (req.method === "POST" && url.pathname === "/api/analysis/start") {
        handleAnalysisControl(res, true);
      } else if (req.method === "POST" && url.pathname === "/api/analysis/stop") {
        handleAnalysisControl(res, false);
      } else if (req.method === "POST" && url.pathname === "/api/reset") {
        analysisEnabled = false;
        resetLivePipeline();
        resetAnalysisState();
        latestStreamFrame = null;
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
          analysis_enabled: analysisEnabled,
          analysis_queue: analyzer.status(),
        });
      } else if (req.method === "GET" && url.pathname === "/api/live-frame") {
        handleLatestFrame(res);
      } else if (req.method === "GET" && url.pathname === "/api/live-frame/image") {
        handleLatestFrameImage(res, url);
      } else if (req.method === "GET" && url.pathname === "/api/live-stream") {
        handleLiveStream(res, req);
      } else if (req.method === "GET" && url.pathname === "/api/live-stream/status") {
        handleLiveStreamStatus(res);
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
