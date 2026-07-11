import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const roots = [
  "apps/ios/BloomKnights/BloomKnights",
  "apps/ios/capture/BloomKnights",
];

test("iOS glasses clients keep the Meta-supported low-latency frame path", async () => {
  for (const root of roots) {
    const streamer = await readFile(`${root}/GlassesStreamer.swift`, "utf8");
    const rtc = await readFile(`${root}/RTCPublisher.swift`, "utf8");

    assert.match(
      streamer,
      /StreamConfiguration\(videoCodec: \.raw, resolution: \.low, frameRate: 24\)/,
      `${root} must use the Meta CameraAccess sample stream profile`,
    );
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
