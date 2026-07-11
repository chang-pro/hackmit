// API server — orchestrates the pipeline and serves the debug view.
// Zero dependencies (node:http) so the skeleton runs with `node` alone.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline } from "./pipeline.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(ROOT, "packages", "fixtures", "frames", "frame_000184.json");
const PORT = process.env.PORT || 3000;

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/api/comparison") {
      const result = await runPipeline(FIXTURE);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
    } else if (req.url === "/" || req.url === "/index.html") {
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
  console.log(`BloomKnights slice-1 demo: http://localhost:${PORT}`);
});
