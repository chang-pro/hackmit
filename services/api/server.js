// BloomKnights phone-camera test server. The mobile client posts base64 frames
// and receives the complete camera-to-insight result in the same response.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { runFramePipeline, runPipeline, resetLivePipeline } from "./pipeline.js";
import { CaptureGateway } from "../capture/gateway.js";
import { FrameSelector } from "../capture/selector.js";
import { visionStatus } from "../vision/index.js";
import { CEREBRAS_ANALYTICS_MODEL } from "../analytics/cerebras.js";
import { CEREBRAS_VISION_MODEL } from "../vision/backends/cerebras.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(ROOT, "packages", "fixtures", "frames", "frame_000184.json");
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

async function sendHtml(res, filename) {
  const html = await readFile(join(ROOT, "apps", "demo-web", filename));
  res.writeHead(200, responseHeaders("text/html; charset=utf-8"));
  res.end(html);
}

export function createBloomServer({
  gateway = new CaptureGateway(),
  selector = new FrameSelector({ minIntervalMs: 750 }),
  visionBackend = undefined,
} = {}) {
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

    let meta;
    try {
      meta = gateway.ingest(body);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const selection = selector.consider(body.image_base64);
    if (!selection.accepted) {
      sendJson(res, 200, { frame: meta, selection, insight: latestInsight });
      return;
    }

    try {
      const insight = await runFramePipeline(gateway.frame(meta.frame_id), { visionBackend });
      latestInsight = insight;
      latestInsightAt = Date.now();
      sendJson(res, 201, { frame: meta, selection, insight });
    } catch (err) {
      sendJson(res, 422, {
        frame: meta,
        selection,
        insight: null,
        analysis: {
          status: "error",
          backend: visionStatus().selected,
          error: err.message,
        },
      });
    }
  }

  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, responseHeaders());
        res.end();
      } else if (req.method === "POST" && req.url === "/api/frames") {
        await handleFrameSubmission(req, res);
      } else if (req.method === "POST" && req.url === "/api/reset") {
        resetLivePipeline();
        gateway.clear();
        selector.reset();
        latestInsight = null;
        latestInsightAt = 0;
        sendJson(res, 200, { status: "reset" });
      } else if (req.method === "GET" && req.url === "/api/health") {
        sendJson(res, 200, {
          status: "ok",
          vision: visionStatus(),
          cerebras_models: {
            vision: CEREBRAS_VISION_MODEL,
            analytics: CEREBRAS_ANALYTICS_MODEL,
          },
          frame_buffer_size: gateway.size,
          has_live_insight: Boolean(latestInsight),
        });
      } else if (
        req.method === "GET" &&
        (req.url === "/api/comparison" || req.url === "/api/latest")
      ) {
        if (latestInsight && Date.now() - latestInsightAt <= LIVE_SESSION_TTL_MS) {
          sendJson(res, 200, latestInsight);
        } else {
          sendJson(res, 200, await runPipeline(FIXTURE));
        }
      } else if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        await sendHtml(res, "index.html");
      } else if (
        req.method === "GET" &&
        (req.url === "/capture" || req.url === "/capture.html")
      ) {
        await sendHtml(res, "capture.html");
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
        addresses.push(`http://${entry.address}:${port}/capture`);
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
