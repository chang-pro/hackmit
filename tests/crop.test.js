import test from "node:test";
import assert from "node:assert/strict";
import { cropRect, cropItem } from "../services/api/crop.js";

const FRAME = { width: 640, height: 480 };

test("an item's box becomes a padded pixel rectangle inside the frame", () => {
  // 0..1000 box in the middle of the frame.
  const rect = cropRect({ x: 250, y: 250, width: 500, height: 500 }, FRAME, 0.1);
  assert.deepEqual(rect, { left: 128, top: 96, width: 384, height: 288 });
});

test("padding never reaches outside the frame", () => {
  const rect = cropRect({ x: 0, y: 0, width: 300, height: 300 }, FRAME);
  assert.equal(rect.left, 0);
  assert.equal(rect.top, 0);
  const corner = cropRect({ x: 800, y: 800, width: 200, height: 200 }, FRAME);
  assert.equal(corner.left + corner.width, FRAME.width);
  assert.equal(corner.top + corner.height, FRAME.height);
});

test("boxes that cannot make a useful picture are refused", () => {
  assert.equal(cropRect(null, FRAME), null);
  assert.equal(cropRect({ x: 10, y: 10, width: 2, height: 2 }, FRAME), null, "a speck");
  assert.equal(cropRect({ x: "a", y: 0, width: 100, height: 100 }, FRAME), null, "not numbers");
  assert.equal(cropRect({ x: 0, y: 0, width: 1000, height: 1000 }, FRAME), null, "the whole frame already");
});

test("an unreadable image falls back quietly instead of failing the plan", async () => {
  assert.equal(await cropItem(Buffer.from("not an image"), { x: 100, y: 100, width: 300, height: 300 }), null);
});

test("when the first pricing provider fails, the second answers the same frame", async () => {
  const { withFallback } = await import("../services/vision/backends/items-provider.js");
  const down = { name: "a", identifyItems: async () => { throw new Error("HTTP 429"); } };
  const up = { name: "b", identifyItems: async (frame) => ({ items: [], from: "b", frame }) };
  assert.equal((await withFallback(down, up).identifyItems("f")).from, "b");
  assert.equal((await withFallback(up, down).identifyItems("f")).from, "b", "a healthy primary is not second-guessed");
  await assert.rejects(withFallback(down, down).identifyItems("f"), /429/);
});
