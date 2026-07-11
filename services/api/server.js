// API server — orchestrates the pipeline and serves the debug view.
// Zero dependencies (node:http) so the skeleton runs with `node` alone.
//
// Slice 4 adds the live-frame path: POST /api/frames routes submissions
// through the capture gateway (§7.1) and frame selector (§7.2), and GET
// /capture serves a webcam capture page. While a live session is active the
// pipeline notes source "live"; extraction itself still uses the fixture
// parse until Slice 2's OCR lands behind the seam in pipeline.js.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline } from "./pipeline.js";
import { CaptureGateway } from "../capture/gateway.js";
import { FrameSelector } from "../capture/selector.js";
import { Reconciler } from "../vision/reconciler.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "packages", "fixtures", "frames");
const DEFAULT_FIXTURE = "frame_000184"; // Q4 2:14, BOS 104–NYK 101
// Allowlist of committed demo fixtures — the fixture param never touches the
// filesystem directly. frame_000260 is the later demo moment (Q4 0:30).
const KNOWN_FIXTURES = new Set(["frame_000184", "frame_000260"]);
const PORT = process.env.PORT || 3000;

const MAX_BODY_BYTES = 8 * 1024 * 1024; // generous for base64 1080p JPEGs
const LIVE_SESSION_TTL_MS = 10_000; // no selected frame for 10 s => not live

const gateway = new CaptureGateway();
const selector = new FrameSelector();
let lastSelected = null; // { meta, at } — most recent selector-approved frame

function activeLiveFrame() {
  if (!lastSelected) return null;
  return Date.now() - lastSelected.at <= LIVE_SESSION_TTL_MS ? lastSelected.meta : null;
}

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

async function sendHtml(res, filename) {
  const html = await readFile(join(ROOT, "apps", "demo-web", filename));
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

// POST /api/frames — source-agnostic frame ingestion.
// The gateway assigns the frame_id and buffers the frame in memory; the
// selector then decides whether it flows downstream (rate limit + duplicate
// skip). Skipped frames still get metadata back so clients can count them.
async function handleFrameSubmission(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.statusCode ?? 400, { error: err.message });
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
  if (selection.accepted) lastSelected = { meta, at: Date.now() };

  sendJson(res, selection.accepted ? 201 : 200, { frame: meta, selection });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && url.pathname === "/api/frames") {
      await handleFrameSubmission(req, res);
    } else if (url.pathname === "/api/comparison") {
      const fixture = url.searchParams.get("fixture") || DEFAULT_FIXTURE;
      if (!KNOWN_FIXTURES.has(fixture)) {
        sendJson(res, 400, {
          error: `unknown fixture; known: ${[...KNOWN_FIXTURES].join(", ")}`,
        });
        return;
      }
      // Each fixture request is an independent demo moment, so it gets a
      // fresh Reconciler: §7.5 invariants compare consecutive observations,
      // and the demo moments are minutes of game time apart. The adapter is
      // left undefined so the Slice 5 registry default (MARKET_PROVIDER env)
      // applies.
      const result = await runPipeline(
        join(FIXTURES_DIR, `${fixture}.json`),
        undefined,
        activeLiveFrame(),
        new Reconciler()
      );
      sendJson(res, 200, result);
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      await sendHtml(res, "index.html");
    } else if (url.pathname === "/capture" || url.pathname === "/capture.html") {
      await sendHtml(res, "capture.html");
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    // The UI never shows a raw stack; the debug endpoint reports the failure.
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`BloomKnights demo: http://localhost:${PORT} (webcam capture: /capture)`);
});
