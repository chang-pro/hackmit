import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBloomServer } from "../services/api/server.js";

const BYTES = Buffer.from("0123456789abcdef");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("demo stream server reports and refuses a file that does not match the manifest", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "bloom-streams-"));
  await writeFile(join(mediaDir, "wc22_final_arg_fra__soccer_2022_12_18.mp4"), BYTES);
  const server = createBloomServer({ demoStreamsDir: mediaDir });
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(mediaDir, { recursive: true, force: true });
  });

  const catalogResponse = await fetch(`${base}/api/demo/streams`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.streams.length, 4);
  const worldCup = catalog.streams.find((stream) => stream.stream_id === "world-cup-2022-final");
  assert.equal(worldCup.file_available, true);
  assert.equal(worldCup.bytes, BYTES.length);
  assert.equal(worldCup.ready, false, "a file from a different edit never becomes ready");
  assert.equal(worldCup.readiness_reason, "media_file_size_mismatch");

  const head = await fetch(`${base}/demo-streams/world-cup-2022-final`, { method: "HEAD" });
  assert.equal(head.status, 409);
  const rejected = await fetch(`${base}/demo-streams/world-cup-2022-final`);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).reason, "media_file_size_mismatch");
  assert.equal((await fetch(`${base}/demo-streams/not-a-stream`)).status, 404);
  assert.equal((await fetch(`${base}/demo-streams/%2e%2e%2fsecret`)).status, 404);
  const policy = await fetch(`${base}/playback-policy.js`);
  assert.equal(policy.status, 200);
  assert.match(await policy.text(), /export function playbackDirectiveTarget/);
});

test("verified demo stream routes support seekable allowlisted byte ranges", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "bloom-stream-ranges-"));
  const mediaPath = join(mediaDir, "wc22_final_arg_fra__soccer_2022_12_18.mp4");
  await writeFile(mediaPath, BYTES);
  const server = createBloomServer({
    demoStreamsDir: mediaDir,
    demoStreamStatus: async (streamId) => streamId === "world-cup-2022-final"
      ? { available: true, verified: true, bytes: BYTES.length, path: mediaPath }
      : { available: false, verified: false, bytes: null, path: null },
  });
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(mediaDir, { recursive: true, force: true });
  });

  const head = await fetch(`${base}/demo-streams/world-cup-2022-final`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("content-length"), String(BYTES.length));

  const range = await fetch(`${base}/demo-streams/world-cup-2022-final`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 2-5/${BYTES.length}`);
  assert.equal(await range.text(), "2345");

  const suffix = await fetch(`${base}/demo-streams/world-cup-2022-final`, {
    headers: { Range: "bytes=-4" },
  });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), "cdef");

  const invalid = await fetch(`${base}/demo-streams/world-cup-2022-final`, {
    headers: { Range: "bytes=99-100" },
  });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${BYTES.length}`);

});

test("server playback revision survives analysis stop and clears only on explicit reset", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "bloom-director-"));
  await writeFile(join(mediaDir, "wc22_final_arg_fra__soccer_2022_12_18.mp4"), BYTES);
  const insight = {
    source: "live",
    observation: { sport: "soccer", confidence: 0.96 },
    demo_intelligence: {
      mode: "precollected_event_replay",
      checkpoint_status: "ready",
      pack_id: "world-cup-2022-final",
      pack_label: "2022 FIFA World Cup Final",
      moment_id: "france-equalizer",
      match_confidence: 0.96,
      confidence: 0.94,
      playback: {
        stream_id: "world-cup-2022-final",
        label: "2022 FIFA World Cup Final",
        media_url: "/demo-streams/world-cup-2022-final",
        mime_type: "video/mp4",
        filename: "wc22_final_arg_fra__soccer_2022_12_18.mp4",
        muted: true,
        calibrated: true,
        playback_start_seconds: 12.5,
        anchor_media_seconds: 14.5,
      },
    },
    analysis: null,
    presentation: { status: "ready", short_text: "ready" },
  };
  const analyzer = {
    reset() {},
    status() {
      return { pending_frames: 0, frames_per_request: 5, model_interval_ms: 12_000, next_analysis_ms: 0, analysis_in_flight: false, calls_last_minute: { vision: 0, analytics: 0 } };
    },
    async submit() {
      return { analysis_status: "analyzed", insight, queue: this.status() };
    },
  };
  const server = createBloomServer({
    liveAnalyzer: analyzer,
    demoStreamsDir: mediaDir,
    demoStreamStatus: async () => ({ available: true, bytes: 48790901, verified: true }),
  });
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(mediaDir, { recursive: true, force: true });
  });

  await fetch(`${base}/api/analysis/start`, { method: "POST" });
  const frame = await fetch(`${base}/api/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "phone_photo",
      captured_at: "2026-07-11T20:14:32.491Z",
      mime_type: "image/jpeg",
      image_base64: "cGhvbmUtZnJhbWU=",
      width: 1280,
      height: 720,
    }),
  });
  assert.equal(frame.status, 201);
  const frameBody = await frame.json();
  assert.equal(frameBody.insight.playback.status, "locked");
  assert.equal(frameBody.insight.playback.revision, 1);
  assert.equal(frameBody.insight.playback.initial_seek_seconds, 12.5);

  await fetch(`${base}/api/analysis/stop`, { method: "POST" });
  const held = await (await fetch(`${base}/api/playback`)).json();
  assert.equal(held.status, "locked");
  assert.equal(held.revision, 1);

  await fetch(`${base}/api/reset`, { method: "POST" });
  const reset = await (await fetch(`${base}/api/playback`)).json();
  assert.equal(reset.status, "camera");
  assert.equal(reset.revision, 2);
  assert.equal(reset.reason, "explicit_reset");
});
