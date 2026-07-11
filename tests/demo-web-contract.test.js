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

test("capture viewer exposes quota-free rehearsal controls and explicit data provenance", () => {
  assert.match(capture, /\/api\/demo\/replay/);
  assert.match(capture, /show:\s*showDemoRehearsal/);
  assert.match(capture, /cycle:\s*cycleDemoRehearsal/);
  assert.match(capture, /stopCycle:/);
  assert.match(capture, /DEMO_REHEARSAL_SEQUENCE/);
  assert.match(capture, /rehearsal[^\n]*no model calls/i);
  assert.match(capture, /intelligence\.research/);
  assert.match(capture, /live prediction/i);
  assert.match(capture, /mock web (?:research|search)/i);
  assert.match(capture, /get\("ops"\)\s*!==\s*"0"/);
  assert.match(capture, /body\.running\.ops-mode \.ops-bar/);
});

test("first live analysis uses a fast five-frame burst before quota cadence", () => {
  assert.match(phone, /INITIAL_ANALYSIS_INTERVAL_MS = 800/);
  assert.match(phone, /INITIAL_ANALYSIS_FRAMES = 5/);
  assert.match(phone, /analysisBurstRemaining/);
  assert.match(phone, /ANALYSIS_INTERVAL_MS = 2400/);
});
