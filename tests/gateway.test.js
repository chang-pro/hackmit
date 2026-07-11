// Capture gateway contract tests (README §7.1, §16).
import test from "node:test";
import assert from "node:assert/strict";
import { CaptureGateway } from "../services/capture/gateway.js";

const submission = (overrides = {}) => ({
  source: "webcam",
  captured_at: "2026-07-11T20:14:32.491Z",
  image_base64: "dGVzdC1mcmFtZS1ieXRlcw==",
  width: 1920,
  height: 1080,
  ...overrides,
});

test("ingest returns the §7.1 frame metadata contract", () => {
  const gw = new CaptureGateway();
  const meta = gw.ingest(submission());
  assert.deepEqual(Object.keys(meta).sort(), [
    "captured_at",
    "frame_id",
    "height",
    "image_uri",
    "source",
    "width",
  ]);
  assert.equal(meta.frame_id, "frame_000001");
  assert.equal(meta.captured_at, "2026-07-11T20:14:32.491Z");
  assert.equal(meta.source, "webcam");
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
  assert.match(meta.image_uri, /^memory:\/\//, "no raw footage on disk (§16)");
});

test("frame_ids are sequential and zero-padded", () => {
  const gw = new CaptureGateway();
  gw.ingest(submission());
  gw.ingest(submission());
  const third = gw.ingest(submission());
  assert.equal(third.frame_id, "frame_000003");
});

test("missing captured_at falls back to a valid server timestamp", () => {
  const gw = new CaptureGateway();
  const meta = gw.ingest(submission({ captured_at: undefined }));
  assert.ok(!Number.isNaN(Date.parse(meta.captured_at)));
});

test("malformed submissions are rejected loudly", () => {
  const gw = new CaptureGateway();
  assert.throws(() => gw.ingest(submission({ source: "" })), /source/);
  assert.throws(() => gw.ingest(submission({ image_base64: "" })), /image_base64/);
  assert.throws(() => gw.ingest(submission({ width: 0 })), /width and height/);
  assert.throws(() => gw.ingest(submission({ height: "1080" })), /width and height/);
  assert.equal(gw.size, 0, "rejected frames are not buffered");
});

test("only the latest N frames stay in memory", () => {
  const gw = new CaptureGateway({ maxFrames: 3 });
  for (let i = 0; i < 5; i += 1) gw.ingest(submission());
  assert.equal(gw.size, 3);
  assert.equal(gw.get("frame_000001"), null, "oldest frames evicted");
  assert.equal(gw.get("frame_000002"), null);
  assert.equal(gw.latest().meta.frame_id, "frame_000005");
  assert.equal(gw.get("frame_000003").meta.frame_id, "frame_000003");
});
