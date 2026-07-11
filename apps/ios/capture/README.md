# BloomKnights Glasses Capture (the WORKING app)

Minimal iPhone app that connects to the Meta Ray-Ban glasses, shows the live
stream, and publishes it to the BloomKnights viewer. The live path follows
Meta's CameraAccess sample: `.raw` 360x640 frames, `makeUIImage()` preview,
and direct CVPixelBuffer delivery to a bounded WebRTC queue.

This exists because the bigger app in `apps/ios/BloomKnights/` crashed at
launch: it touched `Wearables.shared` before `Wearables.configure()` ran, and
the Meta SDK kills the app with an assertion (SIGTRAP in MWDATCore). This app
calls `configure()` in the app init — copy that pattern when wiring the
glasses stream into anything else.

## Build + install (laptop, hands-free over SSH)

```bash
cd apps/ios/capture
xcodegen generate
security unlock-keychain -p '<login pw>' ~/Library/Keychains/login.keychain-db
xcodebuild -project BloomKnights.xcodeproj -scheme BloomKnights \
  -destination generic/platform=iOS -derivedDataPath /tmp/bloomcap-dd \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device 00008120-001815341A39A01E \
  /tmp/bloomcap-dd/Build/Products/Debug-iphoneos/BloomKnights.app
```

Signing: team `A39763Q74K`, bundle `com.bloomknights.app`. Free-account
signing = app expires after 7 days, reinstall with the same commands.

## Using it

1. Glasses paired to THIS phone in Meta AI, Developer Mode ON.
2. Glasses on your face (they sleep when folded), open app, press START.
3. First run: approve the Meta AI registration + glasses camera permission.
4. "Session ended by device" → glasses in case, lid closed 30 s, reopen.

## Hard-won rules baked into GlassesStreamer.swift (do not "simplify" away)

- `Wearables.configure()` in app init before anything touches the SDK.
- `MWDAT` Info.plist block with `MetaAppID: "0"` (dev mode registration).
- Meta-supported `.raw`/`.low`/24 fps stream profile; no custom mutation or
  second decode of SDK-owned sample buffers.
- At most one preview conversion and one WebRTC frame may be queued.
- Silent audio-session keep-alive (iOS suspends Meta AI at ~85 s otherwise).
- Don't restart on `.paused` — SDK self-recovers; debounced nudge on `.stopped` only.
