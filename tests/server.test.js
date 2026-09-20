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

test("a frame is stored even when analysis is off", async (t) => {
  // The gate exists to stop model calls, not to stop the live view. Returning
  // before ingest silently threw the feed away: POSTs were logged with their
  // sizes while the viewer reported no frames at all. Nothing in the iOS app
  // arms analysis, so every server restart reproduced it.
  const base = startServer(t);

  const { status, body } = await postFrame(base);
  assert.equal(status, 202);
  assert.equal(body.analysis_status, "disabled");
  assert.ok(body.frame?.frame_id, "the frame is ingested and identified");

  const res = await fetch(`${base}/api/live-frame`);
  assert.equal(res.status, 200, "the live view can see it");
  const latest = await res.json();
  assert.equal(latest.frame.frame_id, body.frame.frame_id);

  // ...and no model call was made.
  assert.equal((await (await fetch(`${base}/api/items/latest`)).json()).error, "no analyzed items yet");
});

test("a live stream frame never waits for the model", async (t) => {
  // The phone uploads one frame at a time. Awaiting the pricing call inside
  // POST /api/frames froze the whole feed for the length of every call, once
  // per analysis interval, which is what made the stream unusably laggy on a
  // link that pinged at 2ms.
  const MODEL_MS = 1500;
  const slow = {
    name: "slow-items",
    async identifyItems() {
      await new Promise((done) => setTimeout(done, MODEL_MS));
      return {
        items: [],
        item_count: 0,
        total_value_usd: 0,
        model: "slow",
        generated_at: new Date().toISOString(),
      };
    },
  };
  const server = createReLoopServer({
    itemAnalyzer: new ItemAnalyzer({ backend: slow, intervalMs: 0 }),
  });
  server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/analysis/start`, { method: "POST" });

  const started = Date.now();
  const { status, body } = await postFrame(base, framePayload({ source: "rayban_sdk" }));
  const elapsed = Date.now() - started;

  assert.equal(status, 202);
  assert.equal(body.analysis_status, "analyzing");
  assert.ok(body.frame.frame_id, "the frame is stored immediately");
  assert.ok(elapsed < MODEL_MS / 2, `responded in ${elapsed}ms, must not wait ${MODEL_MS}ms for the model`);

  // ...and the result still lands for the viewer to poll.
  await new Promise((done) => setTimeout(done, MODEL_MS + 300));
  const latest = await fetch(`${base}/api/items/latest`);
  assert.equal(latest.status, 200, "the background analysis completed");
});

async function until(condition, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((done) => setTimeout(done, 5));
  }
}

test("a deliberate still is never dropped, is kept, and does not hold the phone's request", async (t) => {
  // Three ways a Take Picture press used to be lost:
  //  - the stream selector rejected it as rate-limited (frames arrive every 200ms)
  //  - an analysis already in flight made the analyzer skip it
  //  - the frame ring (about 30 stream frames, a few seconds) aged it out
  // The model answers only when the test lets it, so "the phone was answered
  // while the model was still thinking" is a fact, not a stopwatch reading. The
  // stopwatch version failed whenever the laptop was busy.
  const seen = [];
  const release = [];
  let finished = 0;
  const slow = {
    name: "slow-items",
    async identifyItems(frame) {
      seen.push(frame.source);
      await new Promise((done) => release.push(done));
      finished += 1;
      return { items: [], item_count: 0, total_value_usd: 0, model: "slow", generated_at: new Date().toISOString() };
    },
  };
  const server = createReLoopServer({ itemAnalyzer: new ItemAnalyzer({ backend: slow, intervalMs: 0 }) });
  server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/analysis/start`, { method: "POST" });

  // A stream frame starts an analysis...
  await postFrame(base, framePayload({ source: "rayban_sdk" }));
  // ...and the still lands 50ms later: inside the selector's window AND while
  // the analyzer is busy.
  await new Promise((done) => setTimeout(done, 50));
  const still = await postFrame(base, framePayload({
    source: "glasses_photo", force_analysis: true, image_base64: "c3RpbGwtcGhvdG8=",
  }));
  assert.equal(finished, 0, "the phone is answered while the model is still thinking, not after it");
  assert.equal(still.body.selection.accepted, true, "the stream selector does not thin a still");
  assert.match(still.body.photo_url, /^\/api\/photos\/pho_/, "the still is copied out of the frame ring immediately");

  // Its durable copy is servable, independent of the ring.
  const photo = await fetch(base + still.body.photo_url);
  assert.equal(photo.status, 200);

  // Once the first analysis finishes, the queued still runs by itself.
  assert.deepEqual(seen, ["rayban_sdk"], "the still waits its turn behind the running analysis");
  release.shift()();
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["rayban_sdk", "glasses_photo"], "the still was analyzed, not skipped");
  release.shift()();
  await until(() => finished === 2);

  const latest = await (await fetch(`${base}/api/items/latest`)).json();
  assert.equal(latest.photo?.frame_source, "glasses_photo");
  assert.equal(latest.photo?.photo_url, still.body.photo_url, "the viewer can find the still's result and its image");
});

test("another website cannot drive the API", async (t) => {
  // approve needs no body, so a plain cross-site form could publish listings
  // to the live store with no preflight. The wildcard CORS grant also let any
  // page read plans back.
  const base = startServer(t);
  const post = (headers) => fetch(`${base}/api/analysis/start`, { method: "POST", headers });

  assert.equal((await post({ Origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ Origin: "null" })).status, 403, "sandboxed frames and file:// pages");
  assert.equal((await post({})).status, 200, "the iOS app, curl and agents send no Origin");
  assert.equal((await post({ Origin: base })).status, 200, "our own pages");

  const viaProxy = await fetch(`${base}/api/analysis/start`, {
    method: "POST",
    headers: { Origin: "https://laptop.example.ts.net", "X-Forwarded-Host": "laptop.example.ts.net" },
  });
  assert.equal(viaProxy.status, 200, "the same page served through tailscale serve");

  const read = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(read.headers.get("access-control-allow-origin"), null, "no wildcard read grant");
});

test("a still is priced and kept even when stream pricing is off", async (t) => {
  // Pressing Take Picture is asking for a price. It used to fall through the
  // stream gate: not priced, not copied out of the frame ring, while the app
  // said "Photo sent".
  const base = startServer(t);
  const stream = await postFrame(base, framePayload({ source: "rayban_sdk" }));
  assert.equal(stream.body.analysis_status, "disabled", "stream frames stay gated");

  const still = await postFrame(base, framePayload({ source: "glasses_photo", force_analysis: true, image_base64: "YS1zdGlsbA==" }));
  assert.notEqual(still.body.analysis_status, "disabled");
  assert.match(still.body.photo_url, /^\/api\/photos\/pho_/);
});

test("the photo route serves only ids this server mints", async (t) => {
  const base = startServer(t);
  for (const id of ["..", "%2e%2e%2f.env", "pho_../../.env", ".env", "x"]) {
    const res = await fetch(`${base}/api/photos/${id}`);
    assert.equal(res.status, 404, id);
  }
});
