import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const roots = [
  "apps/ios/BloomKnights/BloomKnights",
];

test("iOS glasses clients keep the Meta-supported low-latency frame path", async () => {
  for (const root of roots) {
    const streamer = await readFile(`${root}/GlassesStreamer.swift`, "utf8");
    const rtc = await readFile(`${root}/RTCPublisher.swift`, "utf8");

    // The proven profile, from poker-eye's VariantA: "the proven BloomKnights
    // config, untouched. The baseline." The .raw/.low/24 this used to assert is
    // that project's labelled CONTROL GROUP — uncompressed video over a
    // Bluetooth link that cannot carry it.
    assert.match(
      streamer,
      /StreamConfiguration\(videoCodec: \.hvc1, resolution: \.high, frameRate: 15\)/,
      `${root} must use the proven compressed glasses profile`,
    );
    assert.match(streamer, /import VideoToolbox/);
    assert.match(streamer, /maxQueuedFrames = 4/);
    assert.match(streamer, /waitForKeyframe/);
    // The recording is the network-independent backup: passthrough HEVC
    // straight to disk, so it must never be re-encoded or gated on the uplink.
    assert.match(streamer, /AVAssetWriterInput\(mediaType: \.video, outputSettings: nil/);
    assert.doesNotMatch(
      streamer,
      /CFDictionarySetValue/,
      `${root} must not mutate SDK-owned VideoFrame sample attachments`,
    );
    assert.match(
      rtc,
      /adaptOutputFormat\(toWidth: 360, height: 640, fps: 12\)/,
      `${root} must bound WebRTC output`,
    );
    assert.match(
      rtc,
      /guard !framePending/,
      `${root} must bound the WebRTC delivery queue`,
    );
  }
});

test("the primary iOS app configures and reconnects the Meta SDK", async () => {
  const app = await readFile(
    "apps/ios/BloomKnights/BloomKnights/BloomKnightsApp.swift",
    "utf8",
  );

  assert.match(app, /try Wearables\.configure\(\)/);
  assert.match(app, /Wearables\.shared\.handleUrl\(url\)/);
});
