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
//   GET  /api/webrtc/active      — single viewer's active camera session
//   POST /api/webrtc/active      — claim the active camera session (latest wins)
//   POST /api/webrtc/signal      — relay SDP/ICE signaling (never media)
//   GET  /api/webrtc/poll        — poll pending SDP/ICE signaling messages
//   GET  /api/webrtc/config      — session-bound browser-safe ICE configuration
//   POST /api/analysis/start     — explicitly enable model analysis
//   POST /api/analysis/stop      — disable model analysis
//   GET  /api/comparison        — ?sport=<id>&fixture=<name>, live insight, or default
//   GET  /api/latest            — latest live insight only (never fixture fallback)
//   GET  /api/demo/intelligence — precollected four-event demo pack catalog
//   GET  /api/demo/replay       — quota-free, explicitly labeled UI rehearsal insight
//   GET  /api/sports            — sport selector data for the frontends
//   GET  /api/stats             — compact summaries of saved ESPN snapshots
//   GET  /api/stats/raw?sport=  — full latest snapshot for one sport
//   GET  /, /capture, /phone, /data, /landing, /pitch — pages

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { runPipeline, resetLivePipeline } from "./pipeline.js";
import { LiveEventAnalyzer } from "./live-event-analyzer.js";
import { CaptureGateway } from "../capture/gateway.js";
import { FrameSelector } from "../capture/selector.js";
import { DatasetWriter } from "../capture/dataset.js";
import { BACKENDS, liveBackendName, visionStatus } from "../vision/index.js";
import { CEREBRAS_ANALYTICS_MODEL } from "../analytics/cerebras.js";
import { CEREBRAS_VISION_MODEL } from "../vision/backends/cerebras.js";
import { rightcodesGeminiBackend } from "../vision/backends/rightcodes-gemini.js";
import { Reconciler } from "../vision/reconciler.js";
import { getSport, listSports, DEFAULT_SPORT_ID } from "../sports/index.js";
import {
  getDemoRehearsalInsight,
  listDemoIntelligencePacks,
} from "../demo/intelligence.js";
import { PlaybackDirector } from "../demo/playback-director.js";
import {
  DEFAULT_DEMO_STREAMS_DIR,
  demoStreamVerifiedStatus,
  getDemoStreamDefinition,
  listDemoStreams,
} from "../demo/streams.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "packages", "fixtures", "frames");
const STATS_DIR = join(ROOT, "packages", "fixtures", "stats");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LIVE_SESSION_TTL_MS = 30_000;
const WEBRTC_SESSION_TTL_MS = 10 * 60_000;
const MAX_WEBRTC_SIGNALS_PER_PEER = 128;
// SDP and ICE are compact setup metadata. This bound makes the tunnel unable
// to become a substitute media relay even if a client is modified.
const MAX_WEBRTC_SIGNAL_PAYLOAD_BYTES = 128 * 1024;
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function registrySportId(value) {
  return {
    basketball: "nba",
    nba: "nba",
    soccer: "soccer",
    american_football: "football",
    football: "football",
    mma: "ufc",
    ufc: "ufc",
    golf: "golf",
  }[String(value ?? "").trim().toLowerCase()] ?? "unknown";
}

function isIceServerList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((server) => server && server.urls);
}

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

function configuredIceServers() {
  if (!process.env.WEBRTC_ICE_SERVERS_JSON) return DEFAULT_ICE_SERVERS;
  try {
    const configured = JSON.parse(process.env.WEBRTC_ICE_SERVERS_JSON);
    if (isIceServerList(configured)) {
      return configured;
    }
  } catch {
    // The public STUN default keeps the hackathon demo usable if an env value is malformed.
  }
  return DEFAULT_ICE_SERVERS;
}

function meteredTurnConfiguration() {
  const appName = process.env.METERED_TURN_APP_NAME?.trim();
  const apiKey = process.env.METERED_TURN_API_KEY?.trim();
  if (!appName || !apiKey) return null;
  if (!/^[a-z0-9-]+$/i.test(appName)) return null;
  return { appName, apiKey };
}

async function createMeteredTurnIceServers(configuration) {
  const response = await fetch(
    `https://${configuration.appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(configuration.apiKey)}`
  );
  if (!response.ok) throw new Error(`Metered TURN credentials request failed (${response.status})`);
  const body = await response.json();
  if (!isIceServerList(body)) throw new Error("Metered TURN returned an invalid ICE server list");
  return body;
}

function hasTurnServer(iceServers) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(url));
  });
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

async function sendDemoAsset(res, filename, contentType) {
  const asset = await readFile(join(ROOT, "apps", "demo-web", filename));
  res.writeHead(200, responseHeaders(contentType));
  res.end(asset);
}

async function sendPlaybackPolicy(res) {
  const asset = await readFile(join(ROOT, "services", "demo", "playback-director.js"));
  res.writeHead(200, responseHeaders("text/javascript; charset=utf-8"));
  res.end(asset);
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function sendDemoStream(req, res, streamId, mediaDir, verifyStream = demoStreamVerifiedStatus) {
  const definition = getDemoStreamDefinition(streamId);
  if (!definition) {
    sendJson(res, 404, { error: "unknown demo stream" });
    return;
  }
  const file = await verifyStream(streamId, mediaDir);
  if (!file.available) {
    sendJson(res, 404, {
      error: "demo stream media is not installed",
      stream_id: streamId,
      expected_filename: definition.filename,
    });
    return;
  }
  if (file.verified !== true) {
    sendJson(res, 409, {
      error: "demo stream media does not match the pinned manifest",
      stream_id: streamId,
      expected_filename: definition.filename,
      reason: file.bytes !== definition.expected_size_bytes
        ? "media_file_size_mismatch"
        : "media_file_hash_mismatch",
    });
    return;
  }
  const range = parseByteRange(req.headers.range, file.bytes);
  if (range === false) {
    res.writeHead(416, {
      ...responseHeaders("application/json"),
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${file.bytes}`,
    });
    res.end(JSON.stringify({ error: "invalid byte range" }));
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.bytes - 1;
  const statusCode = range ? 206 : 200;
  res.writeHead(statusCode, {
    ...responseHeaders(definition.mime_type),
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.bytes}` } : {}),
    "Content-Disposition": `inline; filename="${definition.filename}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file.path, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
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
  demoStreamsDir = DEFAULT_DEMO_STREAMS_DIR,
  demoStreamStatus = demoStreamVerifiedStatus,
} = {}) {
  const configuredVisionBackend = visionBackend ??
    (process.env.VISION_BACKEND ? BACKENDS[liveBackendName()] : undefined);
  const analyzer = liveAnalyzer ?? new LiveEventAnalyzer({ visionBackend: configuredVisionBackend });
  const playbackDirector = new PlaybackDirector();
  const datasetWriter = new DatasetWriter(); // enabled only via DATASET_DIR (§16)
  let latestInsight = null;
  let latestInsightAt = 0;
  let analysisEnabled = false;
  const webrtcSessions = new Map();
  let activeWebRtcSessionId = null;

  function resetAnalysisState() {
    analyzer.reset();
    gateway.clear();
    selector.reset();
    latestInsight = null;
    latestInsightAt = 0;
  }

  function pruneWebRtcSessions() {
    const now = Date.now();
    for (const [sessionId, session] of webrtcSessions) {
      if (session.expires_at <= now) webrtcSessions.delete(sessionId);
    }
    if (activeWebRtcSessionId && !webrtcSessions.has(activeWebRtcSessionId)) {
      activeWebRtcSessionId = null;
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
      let responseResult = result;
      if (result.analysis_status === "analyzed") {
        const streamId = result.insight?.demo_intelligence?.playback?.stream_id;
        const streamFile = streamId
          ? await demoStreamStatus(streamId, demoStreamsDir)
          : { available: false };
        const playback = playbackDirector.consider(result.insight, {
          assetAvailable: streamFile.verified === true,
        });
        latestInsight = {
          ...result.insight,
          sport: registrySportId(result.insight.observation?.sport ?? requestedSport?.id),
          playback,
        };
        latestInsightAt = Date.now();
        responseResult = { ...result, insight: latestInsight };
      }
      sendJson(res, result.analysis_status === "analyzed" ? 201 : 202, {
        frame: meta,
        sport:
          result.insight?.observation?.sport ??
          latestInsight?.observation?.sport ??
          requestedSport?.id ??
          "auto",
        selection,
        ...responseResult,
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

  function handleLatestInsight(res) {
    if (!latestInsight) {
      sendJson(res, 404, { error: "no analyzed live camera insight yet" });
      return;
    }
    sendJson(res, 200, latestInsight);
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

  function newWebRtcSession() {
    const session = {
      session_id: randomUUID(),
      created_at: Date.now(),
      expires_at: Date.now() + WEBRTC_SESSION_TTL_MS,
      phone_joined: false,
      signals: { phone: [], viewer: [] },
    };
    webrtcSessions.set(session.session_id, session);
    return session;
  }

  function activeWebRtcSession({ create = true } = {}) {
    pruneWebRtcSessions();
    let session = activeWebRtcSessionId ? webrtcSessions.get(activeWebRtcSessionId) : null;
    if (!session && create) {
      session = newWebRtcSession();
      activeWebRtcSessionId = session.session_id;
    }
    return session ?? null;
  }

  function publicWebRtcSession(session) {
    return {
      session_id: session.session_id,
      expires_at: new Date(session.expires_at).toISOString(),
      provider_active: session.phone_joined === true,
    };
  }

  // The demo has one viewer and one camera at a time. The viewer follows this
  // room automatically; a newly started phone/glasses feed replaces the old
  // provider instead of asking anyone to copy a code or URL.
  function getActiveWebRtcSession(res) {
    const session = activeWebRtcSession();
    sendJson(res, 200, publicWebRtcSession(session));
  }

  function claimActiveWebRtcSession(res) {
    let session = activeWebRtcSession();
    if (session.phone_joined) {
      for (const peer of ["phone", "viewer"]) session.signals[peer].push({ kind: "hangup", payload: null });
      session = newWebRtcSession();
      activeWebRtcSessionId = session.session_id;
    }
    session.phone_joined = true;
    session.provider_started_at = Date.now();
    sendJson(res, 200, publicWebRtcSession(session));
  }

  async function relayWebRtcSignal(req, res) {
    try {
      const body = await readJsonBody(req);
      const session = webrtcSessions.get(body?.session_id);
      const from = body?.from;
      const kind = body?.kind;
      if (!session || session.expires_at <= Date.now()) {
        if (session) webrtcSessions.delete(session.session_id);
        sendJson(res, 404, { error: "WebRTC session is invalid or expired" });
        return;
      }
      if (!["phone", "viewer"].includes(from)) {
        sendJson(res, 400, { error: "from must be phone or viewer" });
        return;
      }
      if (!["offer", "answer", "ice", "hangup"].includes(kind)) {
        sendJson(res, 400, { error: "invalid WebRTC signal kind" });
        return;
      }
      const payload = body?.payload ?? null;
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_WEBRTC_SIGNAL_PAYLOAD_BYTES) {
        sendJson(res, 413, { error: "WebRTC signaling payload is too large" });
        return;
      }
      const target = from === "phone" ? "viewer" : "phone";
      if (from === "phone" && kind === "hangup") session.phone_joined = false;
      const queue = session.signals[target];
      if (queue.length >= MAX_WEBRTC_SIGNALS_PER_PEER) queue.shift();
      queue.push({ kind, payload });
      sendJson(res, 202, { status: "queued" });
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { error: err.message });
    }
  }

  function pollWebRtcSignals(res, url) {
    pruneWebRtcSessions();
    const session = webrtcSessions.get(url.searchParams.get("session_id"));
    const peer = url.searchParams.get("peer");
    if (!session) {
      sendJson(res, 404, { error: "WebRTC session is invalid or expired" });
      return;
    }
    if (!["phone", "viewer"].includes(peer)) {
      sendJson(res, 400, { error: "peer must be phone or viewer" });
      return;
    }
    const signals = session.signals[peer].splice(0);
    sendJson(res, 200, { signals, expires_at: new Date(session.expires_at).toISOString() });
  }

  async function handleWebRtcConfig(res, url) {
    pruneWebRtcSessions();
    const session = webrtcSessions.get(url.searchParams.get("session_id"));
    if (!session) {
      sendJson(res, 404, { error: "WebRTC session is invalid or expired" });
      return;
    }
    try {
      if (!session.ice_servers) {
        const turnConfiguration = meteredTurnConfiguration();
        session.ice_servers = turnConfiguration
          ? await createMeteredTurnIceServers(turnConfiguration)
          : configuredIceServers();
      }
      sendJson(res, 200, {
        ice_servers: session.ice_servers,
        // A relay-only policy makes a configured TURN service the dependable
        // path on client-isolated campus networks instead of waiting on a
        // direct ICE candidate that can never succeed.
        ice_transport_policy: hasTurnServer(session.ice_servers) ? "relay" : "all",
      });
    } catch (err) {
      sendJson(res, 502, { error: `Unable to configure WebRTC relay: ${err.message}` });
    }
  }

  function handleAnalysisStatus(res) {
    sendJson(res, 200, { analysis_enabled: analysisEnabled, queue: analyzer.status() });
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
      } else if (req.method === "GET" && url.pathname === "/api/webrtc/active") {
        getActiveWebRtcSession(res);
      } else if (req.method === "POST" && url.pathname === "/api/webrtc/active") {
        claimActiveWebRtcSession(res);
      } else if (req.method === "POST" && url.pathname === "/api/webrtc/signal") {
        await relayWebRtcSignal(req, res);
      } else if (req.method === "POST" && url.pathname === "/api/analysis/start") {
        handleAnalysisControl(res, true);
      } else if (req.method === "POST" && url.pathname === "/api/analysis/stop") {
        handleAnalysisControl(res, false);
      } else if (req.method === "POST" && url.pathname === "/api/reset") {
        analysisEnabled = false;
        resetLivePipeline();
        resetAnalysisState();
        webrtcSessions.clear();
        activeWebRtcSessionId = null;
        const playback = playbackDirector.reset();
        sendJson(res, 200, { status: "reset", playback });
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        const demoStreams = await listDemoStreams({ mediaDir: demoStreamsDir });
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
          webrtc_sessions: webrtcSessions.size,
          analysis_queue: analyzer.status(),
          demo_intelligence_packs: listDemoIntelligencePacks().length,
          demo_streams: {
            total: demoStreams.length,
            files_available: demoStreams.filter((stream) => stream.file_available).length,
            ready: demoStreams.filter((stream) => stream.ready).length,
            complete_coverage: demoStreams.filter((stream) => stream.coverage_status === "complete").length,
            partial_coverage: demoStreams.filter((stream) => stream.coverage_status === "partial").length,
          },
          playback: playbackDirector.snapshot(),
        });
      } else if (req.method === "GET" && url.pathname === "/api/live-frame") {
        handleLatestFrame(res);
      } else if (req.method === "GET" && url.pathname === "/api/live-frame/image") {
        handleLatestFrameImage(res, url);
      } else if (req.method === "GET" && url.pathname === "/api/webrtc/poll") {
        pollWebRtcSignals(res, url);
      } else if (req.method === "GET" && url.pathname === "/api/webrtc/config") {
        await handleWebRtcConfig(res, url);
      } else if (req.method === "GET" && url.pathname === "/api/analysis/status") {
        handleAnalysisStatus(res);
      } else if (req.method === "GET" && url.pathname === "/api/comparison") {
        await handleComparison(res, url);
      } else if (req.method === "GET" && url.pathname === "/api/latest") {
        handleLatestInsight(res);
      } else if (req.method === "GET" && url.pathname === "/api/playback") {
        sendJson(res, 200, playbackDirector.snapshot());
      } else if (req.method === "GET" && url.pathname === "/api/demo/intelligence") {
        sendJson(res, 200, { packs: listDemoIntelligencePacks() });
      } else if (req.method === "GET" && url.pathname === "/api/demo/streams") {
        sendJson(res, 200, { streams: await listDemoStreams({ mediaDir: demoStreamsDir }) });
      } else if (req.method === "GET" && url.pathname === "/api/demo/replay") {
        try {
          sendJson(
            res,
            200,
            getDemoRehearsalInsight(
              url.searchParams.get("pack"),
              url.searchParams.get("moment")
            )
          );
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
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
      } else if (req.method === "GET" && url.pathname === "/sunglasses.svg") {
        await sendDemoAsset(res, "sunglasses.svg", "image/svg+xml");
      } else if (req.method === "GET" && url.pathname === "/models/yolo11n.onnx") {
        await sendDemoAsset(res, "models/yolo11n.onnx", "application/octet-stream");
      } else if (req.method === "GET" && url.pathname === "/models/yolo11s.onnx") {
        await sendDemoAsset(res, "models/yolo11s.onnx", "application/octet-stream");
      } else if (req.method === "GET" && url.pathname === "/playback-policy.js") {
        await sendPlaybackPolicy(res);
      } else if (["GET", "HEAD"].includes(req.method) && url.pathname.startsWith("/demo-streams/")) {
        const streamId = decodeURIComponent(url.pathname.slice("/demo-streams/".length));
        await sendDemoStream(req, res, streamId, demoStreamsDir, demoStreamStatus);
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
  // VISION_BACKEND=rightcodes-gemini runs the live classifier on gemini-3.5-flash
  // via the right.codes gateway instead of Cerebras gemma-4-31b.
  const liveVisionBackend =
    process.env.VISION_BACKEND === "rightcodes-gemini" ? rightcodesGeminiBackend : undefined;
  const server = createBloomServer({ visionBackend: liveVisionBackend });
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
