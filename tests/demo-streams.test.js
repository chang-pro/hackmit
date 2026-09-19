import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDemoPlaybackTarget,
  listDemoStreamDefinitions,
} from "../services/demo/streams.js";
import {
  PlaybackDirector,
  playbackCandidateFromInsight,
  playbackDirectiveTarget,
} from "../services/demo/playback-director.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_DIR = join(ROOT, "packages", "fixtures", "demo-intelligence");
const PACK_FILES = [
  "world-cup-2022-final.json",
  "nba-celtics-knicks-2026.json",
  "super-bowl-li.json",
  "ufc-229.json",
];
const PACKS = PACK_FILES.map((filename) => JSON.parse(readFileSync(join(PACK_DIR, filename), "utf8")));

function liveInsight({
  streamId = "world-cup-2022-final",
  momentId = "france-equalizer",
  seekSeconds = 123.5,
  confidence = 0.94,
  calibrated = true,
  mode = "precollected_event_replay",
  status = "ready",
  source = "live",
} = {}) {
  return {
    source,
    observation: { confidence },
    demo_intelligence: {
      mode,
      checkpoint_status: status,
      pack_id: streamId,
      pack_label: streamId,
      moment_id: momentId,
      match_confidence: confidence,
      confidence,
      playback: {
        stream_id: streamId,
        label: streamId,
        media_url: `/demo-streams/${streamId}`,
        mime_type: "video/mp4",
        filename: `${streamId}.mp4`,
        muted: true,
        calibrated,
        playback_start_seconds: calibrated ? seekSeconds : null,
        anchor_media_seconds: calibrated ? seekSeconds + 2 : null,
      },
    },
  };
}

test("four-stream manifest covers every intelligence checkpoint without inventing media offsets", () => {
  const streams = listDemoStreamDefinitions();
  assert.equal(streams.length, 4);
  assert.deepEqual(
    new Set(streams.map((stream) => stream.pack_id)),
    new Set(PACKS.map((pack) => pack.id))
  );
  let checkpoints = 0;
  for (const pack of PACKS) {
    const stream = streams.find((entry) => entry.pack_id === pack.id);
    assert.ok(stream, pack.id);
    assert.deepEqual(
      new Set(stream.checkpoints.map((checkpoint) => checkpoint.moment_id)),
      new Set(pack.moments.map((moment) => moment.id)),
      pack.id
    );
    assert.equal(stream.media_url, `/demo-streams/${pack.id}`);
    assert.equal(stream.switch_policy, "on_pack_change");
    assert.equal(stream.calibration_complete, true, `${pack.id} available checkpoints are calibrated`);
    for (const moment of pack.moments) {
      const target = getDemoPlaybackTarget(pack.id, moment.id);
      assert.equal(target.stream_id, pack.id);
      if (target.available_in_media) {
        assert.equal(target.calibrated, true);
        assert.ok(Number.isFinite(target.playback_start_seconds));
      } else {
        assert.equal(target.calibrated, false);
        assert.equal(target.playback_start_seconds, null);
      }
      checkpoints += 1;
    }
  }
  assert.equal(checkpoints, 27);
});

test("playback director switches only when a different exact stream is detected", () => {
  let now = Date.parse("2026-07-11T20:00:00Z");
  const director = new PlaybackDirector({ now: () => now, epoch: 100 });

  const argentina = liveInsight();
  const missing = director.consider(argentina, { assetAvailable: false });
  assert.equal(missing.status, "candidate");
  assert.equal(missing.revision, 0);
  assert.equal(missing.reason, "detected_stream_media_unavailable");

  const first = director.consider(argentina, { assetAvailable: true });
  assert.equal(first.status, "locked");
  assert.equal(first.revision, 1);
  assert.equal(first.stream_id, "world-cup-2022-final");
  assert.equal(first.initial_seek_seconds, 123.5);

  now += 12_000;
  const sameGameLater = director.consider(liveInsight({ momentId: "messi-extra-time-goal", seekSeconds: 456 }), {
    assetAvailable: true,
  });
  assert.equal(sameGameLater.revision, 1, "same stream never creates a new playback command");
  assert.equal(sameGameLater.initial_moment_id, "france-equalizer");
  assert.equal(sameGameLater.initial_seek_seconds, 123.5, "same stream never reseeks");
  assert.equal(sameGameLater.reason, "same_stream_continues_without_reseek");

  const pending = director.consider(liveInsight({ mode: "precollected_event_pending", status: "pending" }), {
    assetAvailable: true,
  });
  assert.equal(pending.revision, 1);
  assert.equal(pending.stream_id, "world-cup-2022-final");

  const nba = director.consider(liveInsight({
    streamId: "nba-celtics-knicks-2026",
    momentId: "late-tie",
    seekSeconds: 900,
  }), { assetAvailable: true });
  assert.equal(nba.revision, 2);
  assert.equal(nba.stream_id, "nba-celtics-knicks-2026");
  assert.equal(nba.reason, "new_stream_detected");

  const backToArgentina = director.consider(liveInsight({ seekSeconds: 321 }), { assetAvailable: true });
  assert.equal(backToArgentina.revision, 3, "returning to a prior stream is a real switch");
  assert.equal(backToArgentina.stream_id, "world-cup-2022-final");
  assert.equal(backToArgentina.initial_seek_seconds, 321);
});

test("a 70%-confidence exact stream match switches immediately", () => {
  const director = new PlaybackDirector({ epoch: 200 });
  const insight = liveInsight({ confidence: 0.70 });
  const first = director.consider(insight, { assetAvailable: true });
  assert.equal(first.status, "locked");
  assert.equal(first.stream_id, "world-cup-2022-final");
  assert.equal(first.revision, 1);
});

test("uncalibrated, low-confidence, and rehearsal observations cannot command playback", () => {
  const director = new PlaybackDirector();
  const uncalibrated = director.consider(liveInsight({ calibrated: false }), { assetAvailable: true });
  assert.equal(uncalibrated.status, "candidate");
  assert.equal(uncalibrated.reason, "detected_stream_checkpoint_not_calibrated");
  assert.equal(uncalibrated.revision, 0);
  assert.equal(playbackCandidateFromInsight(liveInsight({ confidence: 0.69 })), null);
  assert.ok(playbackCandidateFromInsight(liveInsight({ confidence: 0.70 })));
  assert.equal(playbackCandidateFromInsight(liveInsight({ source: "rehearsal" })), null);
  assert.equal(playbackCandidateFromInsight(liveInsight({ status: "held_previous" })), null);
});

test("browser playback policy is revision-idempotent and ignores stale directives", () => {
  const director = new PlaybackDirector({ epoch: 300 });
  const locked = director.consider(liveInsight(), { assetAvailable: true });
  const target = playbackDirectiveTarget(locked);
  assert.equal(target.epoch, 300);
  assert.equal(target.revision, 1);
  assert.equal(target.streamId, "world-cup-2022-final");
  assert.equal(playbackDirectiveTarget(locked, { activeEpoch: 300, activeRevision: 1 }), null);
  assert.equal(playbackDirectiveTarget(locked, { pendingEpoch: 300, pendingRevision: 1 }), null);
  assert.equal(playbackDirectiveTarget({ ...locked, revision: 1 }, {
    activeEpoch: 300,
    activeRevision: 2,
  }), null, "older same-epoch revisions are stale");
  assert.equal(playbackDirectiveTarget({ ...locked, epoch: 299, revision: 99 }, {
    activeEpoch: 300,
    activeRevision: 2,
  }), null, "older server epochs are stale");
  assert.equal(playbackDirectiveTarget({ ...locked, epoch: 301, revision: 1 }, {
    activeEpoch: 300,
    activeRevision: 2,
  }).epoch, 301, "a restarted server can begin a fresh revision sequence");
  assert.equal(playbackDirectiveTarget({ ...locked, status: "candidate" }), null);
  assert.equal(playbackDirectiveTarget({ ...locked, initial_seek_seconds: null }), null);
  const reset = director.reset();
  assert.equal(reset.status, "camera");
  assert.equal(reset.epoch, 300);
  assert.equal(reset.revision, 2, "reset is a monotonic control revision");
  assert.equal(reset.reason, "explicit_reset");
});
