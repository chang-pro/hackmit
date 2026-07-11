// API server — orchestrates the pipeline and serves the debug view.
// Zero dependencies (node:http) so the skeleton runs with `node` alone.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline } from "./pipeline.js";
import { mockAdapter } from "../market/mock-adapter.js";
import { Reconciler } from "../vision/reconciler.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "packages", "fixtures", "frames");
const DEFAULT_FIXTURE = "frame_000184"; // Q4 2:14, BOS 104–NYK 101
// Allowlist of committed demo fixtures — the fixture param never touches the
// filesystem directly. frame_000260 is the later demo moment (Q4 0:30).
const KNOWN_FIXTURES = new Set(["frame_000184", "frame_000260"]);
const PORT = process.env.PORT || 3000;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/comparison") {
      const fixture = url.searchParams.get("fixture") || DEFAULT_FIXTURE;
      if (!KNOWN_FIXTURES.has(fixture)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: `unknown fixture; known: ${[...KNOWN_FIXTURES].join(", ")}` })
        );
        return;
      }
      // Each fixture request is an independent demo moment, so it gets a
      // fresh Reconciler: §7.5 invariants compare consecutive observations,
      // and the demo moments are minutes of game time apart.
      const result = await runPipeline(
        join(FIXTURES_DIR, `${fixture}.json`),
        mockAdapter,
        new Reconciler()
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(join(ROOT, "apps", "demo-web", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (err) {
    // The UI never shows a raw stack; the debug endpoint reports the failure.
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`BloomKnights demo: http://localhost:${PORT}`);
});
