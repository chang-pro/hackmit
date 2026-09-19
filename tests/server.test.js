import test from "node:test";
import assert from "node:assert/strict";
import { createReLoopServer } from "../services/api/server.js";
import { ItemAnalyzer } from "../services/api/item-analyzer.js";

const PHOTO = "cGhvbmUtZnJhbWU=";

// Stands in for the Gemini call: same shape the real backend returns, so the
// server contract is tested without spending a model call.
const testItems = {
  name: "test-items",
  async identifyItems(frame) {
    assert.equal(frame.mime_type, "image/jpeg");
    assert.equal(frame.image_base64, PHOTO);
    const items = [
      {
        id: "item_001",
        label: "Sony PS4 Slim",
        condition: "good",
        price_usd: 185,
        price_basis: "used PS4 Slim consoles sell around $185",
        bbox: { x: 120, y: 340, width: 300, height: 180 },
        confidence: 0.92,
      },
      {
        id: "item_002",
        label: "Wireless gaming headset",
        condition: "fair",
        price_usd: 45,
        price_basis: "worn pads drop the usual $60",
        bbox: { x: 600, y: 210, width: 180, height: 200 },
        confidence: 0.81,
      },
    ];
    return {
      items,
      item_count: items.length,
      total_value_usd: 230,
      model: "test-model",
      generated_at: new Date().toISOString(),
    };
  },
};

function startServer(t, { intervalMs = 0 } = {}) {
  const server = createReLoopServer({
    itemAnalyzer: new ItemAnalyzer({ backend: testItems, intervalMs }),
  });
  server.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function framePayload(overrides = {}) {
  return {
    source: "phone_photo",
    captured_at: new Date().toISOString(),
    mime_type: "image/jpeg",
    image_base64: PHOTO,
    width: 960,
    height: 540,
    ...overrides,
  };
}

async function postFrame(base, payload = framePayload()) {
  const res = await fetch(`${base}/api/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test("frames are ignored until the viewer explicitly starts analysis", async (t) => {
  const base = startServer(t);

  const before = await postFrame(base);
  assert.equal(before.status, 202);
  assert.equal(before.body.analysis_status, "disabled");
  assert.equal(before.body.analysis_enabled, false);

  const latest = await fetch(`${base}/api/items/latest`);
  assert.equal(latest.status, 404);
});

test("an analyzed frame returns priced items and serves them at /api/items/latest", async (t) => {
  const base = startServer(t);
  await fetch(`${base}/api/analysis/start`, { method: "POST" });

  const { status, body } = await postFrame(base);
  assert.equal(status, 201);
  assert.equal(body.analysis_status, "analyzed");
  assert.equal(body.items.item_count, 2);
  assert.equal(body.items.total_value_usd, 230);

  const [top] = body.items.items;
  assert.equal(top.label, "Sony PS4 Slim");
  assert.equal(top.price_usd, 185);
  assert.equal(top.condition, "good");
  // The overlay draws on a 0..1000 normalized box; anything else misplaces it.
  assert.deepEqual(top.bbox, { x: 120, y: 340, width: 300, height: 180 });

  const res = await fetch(`${base}/api/items/latest`);
  assert.equal(res.status, 200);
  const served = await res.json();
  assert.equal(served.total_value_usd, 230);
  assert.equal(served.queue.analyzed_count, 1);
});

test("a near-duplicate frame is dropped by the selector before it reaches the model", async (t) => {
  const base = startServer(t, { intervalMs: 0 });
  await fetch(`${base}/api/analysis/start`, { method: "POST" });

  const first = await postFrame(base);
  assert.equal(first.body.analysis_status, "analyzed");

  const second = await postFrame(base);
  assert.equal(second.status, 200);
  assert.equal(second.body.selection.accepted, false);
  // The held result still rides along so the overlay never blanks.
  assert.equal(second.body.items.total_value_usd, 230);

  const served = await (await fetch(`${base}/api/items/latest`)).json();
  assert.equal(served.queue.analyzed_count, 1, "the model was called once");
});

test("a fresh frame inside the analyzer interval reuses the last result", async (t) => {
  const base = startServer(t, { intervalMs: 60_000 });
  await fetch(`${base}/api/analysis/start`, { method: "POST" });

  const first = await postFrame(base);
  assert.equal(first.body.analysis_status, "analyzed");

  // Past the selector's own 750ms window, and a different image, so the only
  // thing that can stop the second call is the analyzer's interval.
  await new Promise((done) => setTimeout(done, 800));
  const second = await postFrame(
    base,
    framePayload({ source: "webrtc_viewer", image_base64: "YS1kaWZmZXJlbnQtZnJhbWU=" })
  );
  assert.equal(second.status, 202);
  assert.equal(second.body.analysis_status, "skipped");
  assert.equal(second.body.reason, "interval");
  assert.equal(second.body.items.total_value_usd, 230);

  const served = await (await fetch(`${base}/api/items/latest`)).json();
  assert.equal(served.queue.analyzed_count, 1);
});

test("stopping analysis clears the held result", async (t) => {
  const base = startServer(t);
  await fetch(`${base}/api/analysis/start`, { method: "POST" });
  await postFrame(base);
  assert.equal((await fetch(`${base}/api/items/latest`)).status, 200);

  await fetch(`${base}/api/analysis/stop`, { method: "POST" });
  assert.equal((await fetch(`${base}/api/items/latest`)).status, 404);

  const status = await (await fetch(`${base}/api/analysis/status`)).json();
  assert.equal(status.analysis_enabled, false);
  assert.equal(status.queue.has_result, false);
});

test("a model failure is reported without dropping the frame", async (t) => {
  const server = createReLoopServer({
    itemAnalyzer: new ItemAnalyzer({
      backend: {
        name: "failing",
        async identifyItems() {
          throw new Error("RIGHTCODES_API_KEY is not set");
        },
      },
      intervalMs: 0,
    }),
  });
  server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/analysis/start`, { method: "POST" });

  const { status, body } = await postFrame(base);
  assert.equal(status, 202);
  assert.equal(body.analysis_status, "error");
  assert.match(body.error, /RIGHTCODES_API_KEY/);
  assert.ok(body.frame.frame_id, "the frame is still ingested");
  assert.match(body.queue.last_error, /RIGHTCODES_API_KEY/);
});

test("health reports the item queue and the frame buffer", async (t) => {
  const base = startServer(t);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.status, "ok");
  assert.equal(health.analysis_enabled, false);
  assert.equal(health.frame_buffer_size, 0);
  assert.equal(health.analysis_queue.has_result, false);
});
