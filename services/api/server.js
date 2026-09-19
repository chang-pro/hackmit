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
//   POST /api/listings/draft    — queue one item for a muse.ai Marketplace draft
//   POST /api/plans             — plan the latest priced items (or body.items) for a goal
//   GET  /api/plans/:id         — a plan (never includes seller floors)
//   POST /api/plans/:id/approve — list every SELL item in the store + queue Marketplace drafts
//   GET  /api/drafts            — the sequential Marketplace draft queue
//   GET  /catalog.json          — the public store catalog (what a buyer agent reads)
//   GET  /api/listings/:id      — one public listing
//   POST /api/listings/:id/messages    — buyer message/offer; the seller agent replies
//   POST /api/listings/:id/checkout    — mock checkout of an agreed price -> SOLD
//   POST /api/listings/:id/marketplace — report the Marketplace draft published -> LISTED
//   GET  /api/photos/:id        — a stored listing photo
//   GET  /api/events            — the append-only event log
//   POST /api/events            — append one event (any lane: IDENTIFIED, SOLD, ...)
//   GET  /api/events/stream     — the event log as server-sent events
//   POST /api/events/seed       — replace the log with contracts/fixtures/events.json
//   GET  /api/dashboard         — the dashboard fold over the event log
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
//   GET  /, /live               — the glasses feed with prices on it
//   GET  /dashboard             — the event-log dashboard (goal, recovered $, listing cards)

import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { ItemAnalyzer } from "./item-analyzer.js";
import { selectedItemsBackend } from "../vision/backends/items-provider.js";
import { DraftQueue } from "../market/draft-queue.js";
import { Market } from "../market/market.js";
import { RepricingJob } from "../market/repricing.js";
import { EventLog } from "../events/event-log.js";
import { foldDashboard } from "../events/dashboard-fold.js";
import { CaptureGateway } from "../capture/gateway.js";
import { FrameSelector } from "../capture/selector.js";
import { DatasetWriter } from "../capture/dataset.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const WEBRTC_SESSION_TTL_MS = 10 * 60_000;
const MAX_WEBRTC_SIGNALS_PER_PEER = 128;
// SDP and ICE are compact setup metadata. This bound makes the tunnel unable
// to become a substitute media relay even if a client is modified.
const MAX_WEBRTC_SIGNAL_PAYLOAD_BYTES = 128 * 1024;
const MAX_PHOTOS = 200;
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);


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
        reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400, emptyBody: size === 0 }));
      }
    });
    req.on("error", reject);
  });
}

// Same as readJsonBody, but an empty body is {} (e.g. an approve with no options).
async function readOptionalJsonBody(req) {
  try {
    return (await readJsonBody(req)) ?? {};
  } catch (err) {
    if (err.message === "invalid JSON body" && err.emptyBody) return {};
    throw err;
  }
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


async function sendDashboardFold(res) {
  const asset = await readFile(join(ROOT, "services", "events", "dashboard-fold.js"));
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


// ── Saved ESPN stats snapshots (scripts/pull-stats.js) ──────────────────────
// Served from disk only — no network calls at request time.


// ── Server factory ───────────────────────────────────────────────────────────

export function createReLoopServer({
  gateway = new CaptureGateway(),
  selector = new FrameSelector({ minIntervalMs: 750 }),
  itemAnalyzer = new ItemAnalyzer(),
  eventLog = new EventLog(),
  draftQueue = new DraftQueue({ eventLog }),
  marketFile = process.env.RELOOP_MARKET_FILE ?? (process.env.NODE_ENV === "test" ? null : join(ROOT, "data", "market_state.json")),
  market: customMarket = null,
  // Shopify publisher (injectable so tests never call the live store) and the
  // opt-in Facebook Marketplace draft queue.
  publish = undefined,
  marketplaceDrafts = undefined,
  enableRepricing = process.env.ENABLE_REPRICING === "1",
} = {}) {
  const market =
    customMarket ??
    new Market({
      eventLog,
      draftQueue,
      file: marketFile,
      ...(publish ? { publish } : {}),
      ...(marketplaceDrafts === undefined ? {} : { marketplaceDrafts }),
    });
  const repricingJob = new RepricingJob({
    market,
    intervalMs: Number(process.env.REPRICING_INTERVAL_MS ?? 60_000),
    enabled: enableRepricing,
  });
  const photosDir = join(ROOT, "data", "photos");
  const photos = new Map();
  // Item identification is what the live camera path runs: every frame is
  // scored for resellable objects and a price, which the capture page draws
  // over the feed.
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

    // Ingest BEFORE the analysis gate. The gate exists to stop model calls, not
    // to stop the live view: returning early here threw the frame away, so with
    // analysis off the phone's POSTs were logged with their sizes while
    // /api/live-frame reported "no frame has arrived" and the app's counters
    // looked healthy. Nothing in the iOS app arms analysis, so every server
    // restart reproduced it.
    let meta;
    try {
      meta = gateway.ingest(body);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    if (!analysisEnabled) {
      sendJson(res, 202, {
        frame: meta,
        analysis_status: "disabled",
        analysis_enabled: false,
        queue: itemAnalyzer.status(),
      });
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
      const force = body.force_analysis === true || body.source === "phone_photo";
      const pending = itemAnalyzer.submit(frame, { force });
      pending.catch(() => {}); // submit() reports its own failures; never let one escape

      // A live stream frame must NEVER wait on the model. The phone uploads one
      // frame at a time, so awaiting a 5-15s pricing call here froze the entire
      // feed for the length of every call, once per analysis interval: a frame
      // or two, a multi-second stall, a frame or two. With a short client
      // timeout those held POSTs also timed out and tore the connection down,
      // which showed up as a new source port on every frame.
      //
      // A skip resolves without touching the network, so it settles in the
      // microtask queue and wins the race; only a real model call loses it. A
      // single photo (force) still waits, because that caller wants the answer.
      const result = force
        ? await pending
        : await Promise.race([
            pending,
            new Promise((resolve) => setImmediate(() => resolve(null))),
          ]);

      if (result === null) {
        sendJson(res, 202, {
          frame: meta,
          selection,
          analysis_status: "analyzing",
          items: itemAnalyzer.latest(),
          queue: itemAnalyzer.status(),
          ...(dataset ? { dataset } : {}),
        });
        return;
      }

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
          backend: selectedItemsBackend().name,
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

    // Through the shared queue, so it never runs alongside a plan's drafts in
    // the one muse.ai chat. The DRAFTED event is appended by the queue.
    const { done } = draftQueue.enqueue({
      item,
      photoUrls: Array.isArray(body.photo_urls) ? body.photo_urls : [],
      location: body.location ?? null,
      category: body.category ?? null,
      floorUsd: body.floor_usd ?? null,
    });
    const job = await done;
    if (job.status === "done") {
      sendJson(res, 201, { ...job.result, draft_id: job.id, url: job.url });
    } else {
      // A CDP failure is a setup problem (Chrome not running, wrong chat, moved
      // selector), so it returns 503 with the message that names the fix.
      sendJson(res, 503, { error: job.error, item_id: item.id ?? null, draft_id: job.id });
    }
  }

  // ── Market (Lane C): plan -> approve -> store + Marketplace drafts ─────────

  // Keeps a copy of the frame the plan was built from; the gateway's ring
  // buffer would otherwise evict it long before Marketplace fetches it.
  function storePhoto(frameId) {
    const stored = frameId ? gateway.get(frameId) : null;
    if (!stored) return null;
    const id = `pho_${randomUUID().slice(0, 12)}`;
    const bytes = imageBytes(stored.image_base64);
    const mime = stored.mime_type || "image/jpeg";
    photos.set(id, { bytes, mime });
    while (photos.size > MAX_PHOTOS) photos.delete(photos.keys().next().value);
    try {
      if (!existsSync(photosDir)) mkdirSync(photosDir, { recursive: true });
      writeFileSync(join(photosDir, `${id}.bin`), bytes);
      writeFileSync(join(photosDir, `${id}.meta`), JSON.stringify({ mime }));
    } catch {}
    return id;
  }

  function publicBaseUrl(req) {
    // muse.ai fetches photos from the internet, so this must be a public URL
    // (a tunnel) in a real run. The request host is only right for local use.
    return (process.env.PUBLIC_BASE_URL || `http://${req.headers.host || "localhost"}`).replace(/\/$/, "");
  }

  async function handleCreatePlan(req, res) {
    const body = await readOptionalJsonBody(req);
    const latest = itemAnalyzer.latest();
    const items = Array.isArray(body.items) ? body.items : latest?.items ?? [];
    if (!items.length) {
      sendJson(res, 409, { error: "no priced items yet: start analysis and point the camera at something, or send items" });
      return;
    }
    const photoId = Array.isArray(body.items) ? null : storePhoto(latest?.frame_id);
    const plan = market.createPlan({
      items,
      goal: body.goal ?? {},
      keepIds: Array.isArray(body.keep_item_ids) ? body.keep_item_ids : [],
      photoUrl: body.photo_url ?? (photoId ? `${publicBaseUrl(req)}/api/photos/${photoId}` : null),
      source: body.source ?? latest?.frame_source ?? null,
    });
    sendJson(res, 201, plan);
  }

  async function handleApprovePlan(req, res, planId) {
    const body = await readOptionalJsonBody(req);
    const result = market.approvePlan(planId, {
      location: body.location ?? null,
      categories: body.categories ?? {},
      photoUrls: body.photo_urls ?? {},
    });
    sendJson(res, 200, { ...result, drafts: draftQueue.status() });
  }

  async function handleListingMessage(req, res, listingId) {
    const body = await readOptionalJsonBody(req);
    sendJson(res, 200, market.message(listingId, {
      threadId: body.thread_id ?? null,
      buyer: body.buyer ?? "buyer",
      priceUsd: body.price_usd ?? null,
      text: body.text ?? "",
    }));
  }

  async function handleCheckout(req, res, listingId) {
    const body = await readOptionalJsonBody(req);
    sendJson(res, 200, market.checkout(listingId, { threadId: body.thread_id }));
  }

  async function handleMarketplaceLive(req, res, listingId) {
    const body = await readOptionalJsonBody(req);
    sendJson(res, 200, market.markMarketplaceLive(listingId, body.url ?? null));
  }

  // Routes /api/plans/:id[/approve] and /api/listings/:id[/messages|/checkout|/marketplace].
  async function routeMarket(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "plans", id, action?]
    try {
      if (req.method === "POST" && url.pathname === "/api/plans") return await handleCreatePlan(req, res);
      if (parts[1] === "plans" && parts[2]) {
        if (req.method === "GET" && parts.length === 3) return sendJson(res, 200, market.getPlan(parts[2]));
        if (req.method === "POST" && parts[3] === "approve") return await handleApprovePlan(req, res, parts[2]);
      }
      if (parts[1] === "listings" && parts[2] && parts[2] !== "draft") {
        if (req.method === "GET" && parts.length === 3) return sendJson(res, 200, market.getListing(parts[2]));
        if (req.method === "POST" && parts[3] === "messages") return await handleListingMessage(req, res, parts[2]);
        if (req.method === "POST" && parts[3] === "checkout") return await handleCheckout(req, res, parts[2]);
        if (req.method === "POST" && parts[3] === "marketplace") return await handleMarketplaceLive(req, res, parts[2]);
      }
      if (req.method === "GET" && parts[1] === "photos" && parts[2]) {
        const photoId = parts[2];
        let photo = photos.get(photoId);
        if (!photo) {
          const diskBin = join(photosDir, `${photoId}.bin`);
          const diskMeta = join(photosDir, `${photoId}.meta`);
          if (existsSync(diskBin)) {
            try {
              const bytes = readFileSync(diskBin);
              let mime = "image/jpeg";
              if (existsSync(diskMeta)) {
                try { mime = JSON.parse(readFileSync(diskMeta, "utf8")).mime || mime; } catch {}
              }
              photo = { bytes, mime };
              photos.set(photoId, photo);
            } catch {}
          }
        }
        if (!photo && (photoId.startsWith("demo_") || photoId.startsWith("pho_"))) {
          res.writeHead(200, responseHeaders("image/jpeg"));
          return res.end(TINY_JPEG);
        }
        if (!photo) return sendJson(res, 404, { error: "photo not found" });
        res.writeHead(200, responseHeaders(photo.mime));
        return res.end(photo.bytes);
      }
      return false;
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { error: err.message });
    }
  }

  async function handleAppendEvent(req, res) {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 201, eventLog.append(body));
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { error: err.message });
    }
  }

  async function handleSeedEvents(res) {
    const fixture = JSON.parse(await readFile(join(ROOT, "contracts", "fixtures", "events.json"), "utf8"));
    eventLog.clear();
    for (const event of fixture) eventLog.append(event);
    const marketSeed = market.seedDemoData();
    sendJson(res, 200, {
      seeded: fixture.length,
      market: { planId: marketSeed.plan.id, listings: marketSeed.listings.length },
    });
  }

  function handleEventStream(req, res) {
    res.writeHead(200, {
      ...responseHeaders("text/event-stream; charset=utf-8"),
      Connection: "keep-alive",
    });
    // Replay the whole log first, so a fresh dashboard needs no second request.
    res.write(`event: snapshot\ndata: ${JSON.stringify(eventLog.list())}\n\n`);
    const unsubscribe = eventLog.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
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
      // RELOOP_LOG_REQUESTS=1 prints every inbound request with its source
      // address. This is the difference between "the phone cannot reach the
      // Mac" and "the phone reaches it and the request fails" — without it
      // both look identical from the client side.
      if (process.env.RELOOP_LOG_REQUESTS) {
        const from = req.socket.remoteAddress ?? "?";
        const size = req.headers["content-length"] ?? "0";
        console.log(`[req] ${req.method} ${url.pathname} from ${from}:${req.socket.remotePort} (${size}B)`);
      }
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
        sendJson(res, 200, { status: "reset" });
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          status: "ok",
          frame_buffer_size: gateway.size,
          analysis_enabled: analysisEnabled,
          webrtc_sessions: webrtcSessions.size,
          analysis_queue: itemAnalyzer.status(),
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
      } else if (req.method === "GET" && url.pathname === "/api/events") {
        sendJson(res, 200, { events: eventLog.list() });
      } else if (req.method === "POST" && url.pathname === "/api/events") {
        await handleAppendEvent(req, res);
      } else if (req.method === "GET" && url.pathname === "/api/events/stream") {
        handleEventStream(req, res);
      } else if (req.method === "POST" && url.pathname === "/api/events/seed") {
        await handleSeedEvents(res);
      } else if (req.method === "GET" && url.pathname === "/catalog.json") {
        sendJson(res, 200, market.catalog());
      } else if (req.method === "GET" && url.pathname === "/api/drafts") {
        sendJson(res, 200, draftQueue.status());
      } else if (req.method === "POST" && url.pathname === "/api/market/reprice") {
        const body = await readOptionalJsonBody(req);
        const repriced = market.reprice({
          dropPct: body.drop_pct ? Number(body.drop_pct) : undefined,
          dropAmount: body.drop_amount ? Number(body.drop_amount) : undefined,
        });
        sendJson(res, 200, { repriced });
      } else if (
        url.pathname === "/api/plans" ||
        url.pathname.startsWith("/api/plans/") ||
        (url.pathname.startsWith("/api/listings/") && url.pathname !== "/api/listings/draft") ||
        url.pathname.startsWith("/api/photos/")
      ) {
        if ((await routeMarket(req, res, url)) === false) sendJson(res, 404, { error: "not found" });
      } else if (req.method === "GET" && url.pathname === "/api/dashboard") {
        sendJson(res, 200, foldDashboard(eventLog.list()));
      } else if (
        req.method === "GET" &&
        (url.pathname === "/dashboard" || url.pathname === "/dashboard.html")
      ) {
        await sendHtml(res, "dashboard.html");
      } else if (req.method === "GET" && url.pathname === "/dashboard-fold.js") {
        await sendDashboardFold(res);
      } else if (req.method === "GET" && url.pathname === "/api/items/latest") {
        handleLatestItems(res);
      } else if (
        req.method === "GET" &&
        ["/", "/index.html", "/live", "/live.html"].includes(url.pathname)
      ) {
        // One page. The feed and the prices on it are the whole product; every
        // other page was a different product's dashboard.
        await sendHtml(res, "live.html");
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
  const server = createReLoopServer();
  // Node's default keepAliveTimeout is 5s. On a link that stalls for longer
  // than that, Node closes the idle socket under the phone; the phone's next
  // POST goes out on a dead connection and URLSession surfaces
  // NSURLErrorNetworkConnectionLost rather than retrying, so the frame is
  // dropped and the next one pays a fresh handshake and TCP slow-start through
  // the relay. Holding the connection open across a stall removes a whole
  // class of spurious failures.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000; // must exceed keepAliveTimeout
  server.listen(port, host, () => {
    console.log(`ReLoop desktop: http://localhost:${port}`);
    for (const address of lanAddresses(port)) console.log(`ReLoop phone:   ${address}`);
    console.log(`Item pricing provider: ${selectedItemsBackend().name}`);
  });
}
