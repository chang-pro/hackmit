import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const capture = readFileSync(new URL("../apps/demo-web/capture.html", import.meta.url), "utf8");
const phone = readFileSync(new URL("../apps/demo-web/phone.html", import.meta.url), "utf8");

test("capture viewer presents detected evidence and an honest model-market comparison", () => {
  assert.match(capture, /id="detectedSport"/);
  assert.match(capture, /demo_intelligence/);
  assert.match(capture, /MARKET \$\{Math\.round\(marketProbability \* 100\)\}%/);
  assert.match(capture, /gap_percentage_points/);
  assert.match(capture, /Historical replay/);
  assert.match(capture, /object-fit: contain/);
});

test("first live analysis uses a fast five-frame burst before quota cadence", () => {
  assert.match(phone, /INITIAL_ANALYSIS_INTERVAL_MS = 800/);
  assert.match(phone, /INITIAL_ANALYSIS_FRAMES = 5/);
  assert.match(phone, /analysisBurstRemaining/);
  assert.match(phone, /ANALYSIS_INTERVAL_MS = 2400/);
});
