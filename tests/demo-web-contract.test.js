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
  assert.match(capture, /get\("ops"\)\s*===\s*"1"/);
  assert.match(capture, /body\.running\.ops-mode \.ops-bar/);
});

test("capture viewer clears stale results and keeps rehearsal visually consistent", () => {
  assert.match(capture, /function clearRenderedInsight/);
  assert.match(capture, /clearRenderedInsight\(\{ queue: data\.queue \}\)/);
  assert.match(capture, /demoRehearsalInsight = insight/);
  assert.match(capture, /function demoVisualState/);
  assert.match(capture, /REHEARSAL · NO MODEL CALLS/);
  assert.match(capture, /DEFAULT_REHEARSAL_INTERVAL_MS = 10_000/);
  assert.match(capture, /MIN_REHEARSAL_INTERVAL_MS = 5_000/);
  assert.match(capture, /MAX_REHEARSAL_INTERVAL_MS = 30_000/);
  assert.match(capture, /demoParams\.get\("interval"\)/);
  assert.match(capture, /body\.running \.readout[^}]*overflow-y: auto/);
});

test("capture viewer swaps to a double-buffered local broadcast only on a newer playback command", () => {
  assert.match(capture, /id="video" class="program-video"/);
  assert.match(capture, /id="videoStandby" class="program-video"/);
  assert.match(capture, /id="remotePreview"/);
  assert.match(capture, /body\.playback-active #remotePreview/);
  assert.match(capture, /playbackDirectiveTarget/);
  assert.match(capture, /activePlaybackRevision/);
  assert.match(capture, /activePlaybackEpoch/);
  assert.match(capture, /pendingPlaybackRevision/);
  assert.match(capture, /pendingPlaybackEpoch/);
  assert.match(capture, /function applyPlaybackDirective/);
  assert.match(capture, /function clearProgramPlayback/);
  assert.match(capture, /api\("\/api\/playback"\)/);
  assert.match(capture, /get video\(\) \{ return theaterVideo\(\); \}/);
  assert.match(capture, /keeping current view/);
  assert.match(capture, /synced once/);
  assert.match(capture, /analysisRefreshInFlight/);
  assert.match(capture, /sourceGeneration: \(\) => theaterSourceGeneration/);
  assert.match(capture, /sourceVideo !== bridge\.video/);
  assert.match(capture, /event\.detail\?\.restart/);
});

test("first live analysis uses a fast five-frame burst before quota cadence", () => {
  assert.match(phone, /INITIAL_ANALYSIS_INTERVAL_MS = 800/);
  assert.match(phone, /INITIAL_ANALYSIS_FRAMES = 5/);
  assert.match(phone, /analysisBurstRemaining/);
  assert.match(phone, /ANALYSIS_INTERVAL_MS = 2400/);
});
