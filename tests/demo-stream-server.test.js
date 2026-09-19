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

