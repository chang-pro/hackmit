// ReLoop API server. The mobile client and the capture viewer post
// base64 frames; each frame is identified by the item vision backend, which
// returns every resellable object it can see with a price and a normalized
// bounding box. Zero dependencies (node:http).
//
// Routes:
//   POST /api/frames            — live frame in; item identification + pricing
//   POST /api/reset             — clear live session state
//   GET  /api/health            — frame buffer + analysis queue status
//   GET  /api/items/latest      — newest priced items for the live overlay
//   POST /api/listings/draft    — hand one item to muse.ai for a Marketplace draft
//   GET  /api/live-frame        — metadata for the newest inbound camera frame
//   GET  /api/live-frame/image  — newest inbound camera JPEG/PNG bytes
//   GET  /api/webrtc/active      — single viewer's active camera session
//   POST /api/webrtc/active      — claim the active camera session (latest wins)
//   POST /api/webrtc/signal      — relay SDP/ICE signaling (never media)
//   GET  /api/webrtc/poll        — poll pending SDP/ICE signaling messages
//   GET  /api/webrtc/config      — session-bound browser-safe ICE configuration
//   POST /api/analysis/start     — explicitly enable model analysis
//   POST /api/analysis/stop      — disable model analysis
//   GET  /api/analysis/status    — whether analysis is armed, plus the queue
//   GET  /, /capture, /phone, /data, /landing, /pitch — pages

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { ItemAnalyzer } from "./item-analyzer.js";
import { RIGHTCODES_ITEMS_MODEL } from "../vision/backends/rightcodes-items.js";
import { draftListing } from "../../facebook-marketplace/muse-agent.js";
import { CaptureGateway } from "../capture/gateway.js";
import { FrameSelector } from "../capture/selector.js";
import { DatasetWriter } from "../capture/dataset.js";
import { PlaybackDirector } from "../demo/playback-director.js";
import {
  DEFAULT_DEMO_STREAMS_DIR,
  demoStreamVerifiedStatus,
  getDemoStreamDefinition,
  listDemoStreams,
} from "../demo/streams.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const WEBRTC_SESSION_TTL_MS = 10 * 60_000;
const MAX_WEBRTC_SIGNALS_PER_PEER = 128;
// SDP and ICE are compact setup metadata. This bound makes the tunnel unable
// to become a substitute media relay even if a client is modified.
const MAX_WEBRTC_SIGNAL_PAYLOAD_BYTES = 128 * 1024;
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];


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
    "X-ReLoop-API-Version": "1",
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
    sendJson(res, 404, { error: "unknown stream" });
    return;
  }
  const file = await verifyStream(streamId, mediaDir);
  if (!file.available) {
    sendJson(res, 404, {
      error: "stream media is not installed",
      stream_id: streamId,
      expected_filename: definition.filename,
    });
    return;
  }
  if (file.verified !== true) {
    sendJson(res, 409, {
      error: "stream media does not match the pinned manifest",
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


// ── Server factory ───────────────────────────────────────────────────────────

export function createBloomServer({
  gateway = new CaptureGateway(),
  selector = new FrameSelector({ minIntervalMs: 750 }),
  itemAnalyzer = new ItemAnalyzer(),
  demoStreamsDir = DEFAULT_DEMO_STREAMS_DIR,
  demoStreamStatus = demoStreamVerifiedStatus,
} = {}) {
  // Item identification is what the live camera path runs: every frame is
  // scored for resellable objects and a price, which the capture page draws
  // over the feed.
  const playbackDirector = new PlaybackDirector();
  const datasetWriter = new DatasetWriter(); // enabled only via DATASET_DIR (§16)
  let analysisEnabled = false;
  const webrtcSessions = new Map();
  let activeWebRtcSessionId = null;

  function resetAnalysisState() {
    itemAnalyzer.reset();
    gateway.clear();
    selector.reset();
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
        queue: itemAnalyzer.status(),
      });
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
        selection,
        items: itemAnalyzer.latest(),
      });
      return;
    }

    // Training-data collector (§16): writes only when DATASET_DIR is set, and
    // a dataset failure must never break frame ingestion. The label is the
    // latest set of priced items, when one exists.
    let dataset = null;
    if (datasetWriter.enabled) {
      try {
        const files = await datasetWriter.record({
          sport: "items",
          frame: meta,
          imageBase64: body.image_base64,
          state: itemAnalyzer.latest(),
        });
        dataset = { saved: true, labeled: files.label != null };
      } catch (err) {
        dataset = { saved: false, error: err.message };
      }
    }

    try {
      const frame = gateway.frame(meta.frame_id);
      const result = await itemAnalyzer.submit(frame, {
        force: body.force_analysis === true || body.source === "phone_photo",
      });
      sendJson(res, result.analysis_status === "analyzed" ? 201 : 202, {
        frame: meta,
        selection,
        analysis_status: result.analysis_status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.error ? { error: result.error } : {}),
        items: result.items,
        queue: itemAnalyzer.status(),
        ...(dataset ? { dataset } : {}),
      });
    } catch (err) {
      sendJson(res, 422, {
        frame: meta,
        selection,
        items: null,
        analysis: {
          status: "error",
          backend: "rightcodes-items",
          error: err.message,
        },
        ...(dataset ? { dataset } : {}),
      });
    }
  }

  // Hands one identified item to the muse.ai agent, which builds a Facebook
  // Marketplace DRAFT. Publishing still needs a human tap in Facebook — the
  // agent said so itself, and this route does not pretend otherwise.
  async function handleDraftListing(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { error: err.message });
      return;
    }

    // An item_id alone is resolved against the latest analysis, so the caller
    // does not have to echo a price back and risk listing a stale one.
    let item = body?.item ?? null;
    if (!item && body?.item_id) {
      item = (itemAnalyzer.latest()?.items ?? []).find((i) => i.id === body.item_id) ?? null;
      if (!item) {
        sendJson(res, 404, { error: `no identified item "${body.item_id}" in the latest analysis` });
        return;
      }
    }
    if (!item?.label) {
      sendJson(res, 400, { error: "provide item_id from the latest analysis, or a full item" });
      return;
    }

    try {
      const result = await draftListing(item, {
        photoUrls: Array.isArray(body.photo_urls) ? body.photo_urls : [],
        location: body.location ?? null,
        category: body.category ?? null,
        floorUsd: body.floor_usd ?? null,
        timeoutMs: 150_000,
      });
      sendJson(res, 201, result);
    } catch (err) {
      // A CDP failure is a setup problem (Chrome not running, wrong chat, moved
      // selector), so it returns 503 with the message that names the fix.
      sendJson(res, 503, { error: err.message, item_id: item.id ?? null });
    }
  }

  function handleLatestItems(res) {
    const latest = itemAnalyzer.latest();
    if (!latest) {
      sendJson(res, 404, {
        error: "no analyzed items yet",
        queue: itemAnalyzer.status(),
      });
      return;
    }
    sendJson(res, 200, { ...latest, queue: itemAnalyzer.status() });
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
      items: itemAnalyzer.latest(),
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
    sendJson(res, 200, { analysis_enabled: analysisEnabled, queue: itemAnalyzer.status() });
  }

  function handleAnalysisControl(res, enabled) {
    analysisEnabled = enabled;
    resetAnalysisState();
    sendJson(res, 200, { analysis_enabled: analysisEnabled, queue: itemAnalyzer.status() });
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
        resetAnalysisState();
        webrtcSessions.clear();
        activeWebRtcSessionId = null;
        const playback = playbackDirector.reset();
        sendJson(res, 200, { status: "reset", playback });
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        const demoStreams = await listDemoStreams({ mediaDir: demoStreamsDir });
        sendJson(res, 200, {
          status: "ok",
          frame_buffer_size: gateway.size,
          analysis_enabled: analysisEnabled,
          webrtc_sessions: webrtcSessions.size,
          analysis_queue: itemAnalyzer.status(),
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
      } else if (req.method === "POST" && url.pathname === "/api/listings/draft") {
        await handleDraftListing(req, res);
      } else if (req.method === "GET" && url.pathname === "/api/items/latest") {
        handleLatestItems(res);
      } else if (req.method === "GET" && url.pathname === "/api/playback") {
        sendJson(res, 200, playbackDirector.snapshot());
      } else if (req.method === "GET" && url.pathname === "/api/demo/streams") {
        sendJson(res, 200, { streams: await listDemoStreams({ mediaDir: demoStreamsDir }) });
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
  const server = createBloomServer();
  server.listen(port, host, () => {
    console.log(`ReLoop desktop: http://localhost:${port}`);
    for (const address of lanAddresses(port)) console.log(`ReLoop phone:   ${address}`);
    // Must test the SAME variable the backend reads. Checking the Claude-channel
    // key here printed "ready" while every call 401'd, and "unavailable" while
    // it worked — the banner lied in both directions.
    console.log(
      process.env.RIGHTCODES_KEY_GEMINI
        ? `Item pricing: ${RIGHTCODES_ITEMS_MODEL}`
        : "Item pricing unavailable: RIGHTCODES_KEY_GEMINI is not set"
    );
  });
}
