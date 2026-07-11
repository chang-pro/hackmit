// Frame selector tests (README §7.2): rate limiting and duplicate skipping.
import test from "node:test";
import assert from "node:assert/strict";
import { FrameSelector, sampledHash } from "../services/capture/selector.js";

// Deterministic, injectable clock.
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const FRAME_A = "a".repeat(4000) + "unique-tail-A";
const FRAME_B = "b".repeat(4000) + "unique-tail-B";

test("first frame is always selected", () => {
  const s = new FrameSelector({ minIntervalMs: 500, now: fakeClock() });
  assert.deepEqual(s.consider(FRAME_A), { accepted: true, reason: null });
});

test("frames arriving faster than the min interval are rate-limited", () => {
  const now = fakeClock();
  const s = new FrameSelector({ minIntervalMs: 500, now });
  assert.equal(s.consider(FRAME_A).accepted, true);

  now.advance(100); // 10 fps burst — too fast
  assert.deepEqual(s.consider(FRAME_B), { accepted: false, reason: "rate_limited" });

  now.advance(400); // 500 ms since last selection — allowed again
  assert.equal(s.consider(FRAME_B).accepted, true);
});

test("rate-limited frames do not reset the interval window", () => {
  const now = fakeClock();
  const s = new FrameSelector({ minIntervalMs: 500, now });
  s.consider(FRAME_A);
  now.advance(300);
  assert.equal(s.consider(FRAME_B).accepted, false);
  now.advance(200); // 500 ms after the *selected* frame, not the rejected one
  assert.equal(s.consider(FRAME_B).accepted, true);
});

test("a byte-identical frame is skipped as a near-duplicate", () => {
  const now = fakeClock();
  const s = new FrameSelector({ minIntervalMs: 500, now });
  assert.equal(s.consider(FRAME_A).accepted, true);
  now.advance(1000);
  assert.deepEqual(s.consider(FRAME_A), { accepted: false, reason: "near_duplicate" });
  now.advance(1000);
  assert.equal(s.consider(FRAME_B).accepted, true, "a changed frame is selected");
});

test("duplicate skip compares against the last selected frame", () => {
  const now = fakeClock();
  const s = new FrameSelector({ minIntervalMs: 500, now });
  s.consider(FRAME_A);
  now.advance(1000);
  s.consider(FRAME_B);
  now.advance(1000);
  // FRAME_A differs from the last *selected* frame (B), so it is selected.
  assert.equal(s.consider(FRAME_A).accepted, true);
});

test("sampledHash distinguishes same-length payloads and is stable", () => {
  const x = "x".repeat(5000);
  const y = "x".repeat(2500) + "y".repeat(2500);
  assert.equal(x.length, y.length);
  assert.notEqual(sampledHash(x), sampledHash(y));
  assert.equal(sampledHash(x), sampledHash(x));
});
