// DatasetWriter: the vision-model training-data collector must be OFF by
// default (README §16 — no disk writes without DATASET_DIR) and, when
// enabled, must pair each accepted frame image with the latest reconciled
// state under DATASET_DIR/<sport>/.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatasetWriter } from "../services/capture/dataset.js";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const frame = {
  frame_id: "frame_000042",
  captured_at: "2026-07-11T20:14:32.491Z",
  source: "webcam",
  image_uri: "memory://capture/frame_000042",
  width: 1280,
  height: 720,
};
const state = {
  event_id: "ufc_2018_10_06_khabib_mcgregor",
  away_team_id: "ufc_khabib",
  home_team_id: "ufc_mcgregor",
  period: 2,
  clock_seconds: 210,
  confidence: 0.95,
};

test("disabled without DATASET_DIR: no writes, record() returns null", async () => {
  const savedEnv = process.env.DATASET_DIR;
  delete process.env.DATASET_DIR;
  try {
    const writer = new DatasetWriter();
    assert.equal(writer.enabled, false);
    const result = await writer.record({
      sport: "ufc",
      frame,
      imageBase64: JPEG_BYTES.toString("base64"),
      state,
    });
    assert.equal(result, null, "nothing is written and nothing pretends to be");
  } finally {
    if (savedEnv !== undefined) process.env.DATASET_DIR = savedEnv;
  }
});

test("enabled: decodes base64 to a .jpg and pairs it with the state label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bloomknights-dataset-"));
  try {
    const writer = new DatasetWriter({ dir });
    assert.equal(writer.enabled, true);
    const result = await writer.record({
      sport: "ufc",
      frame,
      imageBase64: JPEG_BYTES.toString("base64"),
      state,
    });
    assert.equal(result.image, join(dir, "ufc", "frame_000042.jpg"));
    assert.equal(result.label, join(dir, "ufc", "frame_000042.state.json"));

    const imageBytes = await readFile(result.image);
    assert.deepEqual([...imageBytes], [...JPEG_BYTES], "decoded bytes match the source image");

    const label = JSON.parse(await readFile(result.label, "utf8"));
    assert.equal(label.sport, "ufc");
    assert.equal(label.frame.frame_id, "frame_000042");
    assert.deepEqual(label.state, state);
    assert.ok(!Number.isNaN(Date.parse(label.labeled_at)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("data-URL prefixes are stripped before decoding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bloomknights-dataset-"));
  try {
    const writer = new DatasetWriter({ dir });
    const result = await writer.record({
      sport: "nba",
      frame,
      imageBase64: `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`,
      state: null,
    });
    const imageBytes = await readFile(result.image);
    assert.deepEqual([...imageBytes], [...JPEG_BYTES]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no reconciled state yet: image saved unlabeled, label never invented", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bloomknights-dataset-"));
  try {
    const writer = new DatasetWriter({ dir });
    const result = await writer.record({
      sport: "golf",
      frame,
      imageBase64: JPEG_BYTES.toString("base64"),
      state: null,
    });
    assert.equal(result.label, null);
    assert.ok(existsSync(result.image));
    const files = await readdir(join(dir, "golf"));
    assert.deepEqual(files, ["frame_000042.jpg"], "only the image, no fake label");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed input throws instead of writing garbage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bloomknights-dataset-"));
  try {
    const writer = new DatasetWriter({ dir });
    await assert.rejects(
      () => writer.record({ sport: "nba", frame: {}, imageBase64: "x", state: null }),
      /frame\.frame_id/
    );
    await assert.rejects(
      () => writer.record({ sport: "nba", frame, imageBase64: "", state: null }),
      /imageBase64/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
