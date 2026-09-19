import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const capture = readFileSync(new URL("../apps/demo-web/capture.html", import.meta.url), "utf8");
const phone = readFileSync(new URL("../apps/demo-web/phone.html", import.meta.url), "utf8");

test("the capture viewer draws a price on every identified item", () => {
  assert.match(capture, /\/api\/items\/latest/);
  assert.match(capture, /function renderItems/);
  // The box label is the price, not a confidence percentage.
  assert.match(capture, /tag: `\$\{item\.label\.toUpperCase\(\)\}  \$\$\{item\.price_usd\}`/);
  assert.match(capture, /total_value_usd/);
  assert.match(capture, /id="itemList"/);
});

test("item boxes are colour-keyed by what the item is worth", () => {
  assert.match(capture, /item_high:/);
  assert.match(capture, /item_mid:/);
  assert.match(capture, /item_low:/);
  assert.match(capture, /function itemKind/);
  assert.match(capture, /HIGH_VALUE_USD = 100/);
  assert.match(capture, /MID_VALUE_USD = 25/);
});

test("the on-device tracker never paints over a fresh price overlay", () => {
  assert.match(capture, /ITEM_BOX_TTL_MS/);
  assert.match(capture, /source !== "items" && itemBoxesFresh\(\)/);
  // Freshness is measured from when the result was GENERATED, not from the
  // last repaint — otherwise re-rendering a cached result renews the lease
  // forever and the tracker never gets the overlay back.
  assert.match(capture, /lastItemResultAt = Date\.parse\(payload\.generated_at\)/);
});

test("priced boxes are only drawn over the image they were measured on", () => {
  assert.match(capture, /boxesMatchFeed/);
  assert.match(capture, /payload\.frame_source === "webrtc_viewer"/);
});

test("clearing the readout also drops the priced boxes and the total", () => {
  // Stopping analysis used to leave prices painted over live video.
  assert.match(capture, /lastItemSignature = ""/);
  assert.match(capture, /clearVisualDetections\(\);\n  \$\("roOutcome"\)/);
});

test("live analysis uses one frame per request and the viewer samples WebRTC for glasses", () => {
  assert.match(phone, /INITIAL_ANALYSIS_INTERVAL_MS = 800/);
  assert.match(phone, /INITIAL_ANALYSIS_FRAMES = 1/);
  assert.match(phone, /analysisBurstRemaining/);
  assert.match(phone, /ANALYSIS_INTERVAL_MS = 2400/);
  assert.match(capture, /function submitWebRtcAnalysisSnapshot/);
  assert.match(capture, /source: "webrtc_viewer"/);
  // Fast enough that the overlay tracks what the wearer is looking at.
  assert.match(capture, /ANALYSIS_SNAPSHOT_INTERVAL_MS = 3_000/);
  assert.doesNotMatch(capture, /id="analystChat"/);
  assert.doesNotMatch(capture, /api\("\/api\/chat"/);
});

test("the viewer no longer depends on any sports or prediction-market route", () => {
  for (const route of [
    "/api/comparison",
    "/api/sports",
    "/api/stats",
    "/api/demo/replay",
    "/api/demo/intelligence",
  ]) {
    assert.doesNotMatch(capture, new RegExp(route.replace(/\//g, "\\/")), `${route} is gone`);
  }
});
