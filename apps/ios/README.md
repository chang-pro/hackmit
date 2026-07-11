# BloomKnights iOS Companion App

SwiftUI iPhone app (iOS 17+, no external dependencies) that pairs with the
BloomKnights Node backend. Four tabs:

- **Home** — pick a sport (NBA, UFC, Soccer, Football, Golf), pick a famous
  demo moment, and watch the live model % vs market % comparison with gap,
  state-confidence bar, status pill, and REPLAY / MOCK tags. Polls
  `GET /api/comparison?sport=&fixture=` every 5 seconds.
- **Glasses** — two source modes:
  - **Meta glasses (SDK)** — the REAL Ray-Ban stream via Meta's Wearables
    Device Access Toolkit (same proven setup as the PokerAI app: keep-alive
    audio session for the ~85s suspension, hvc1 720p over WiFi transport,
    debounced recovery). Decodes ~1 frame/second → JPEG → POSTs to
    `/api/frames` with source `rayban_sdk`. Requires the xcodegen build (below).
  - **Phone camera** — fallback bridge: point the phone at the screen showing
    the broadcast. Samples ~1 fps, POSTs with source `ios_app`.
  Both show sent / accepted / skipped / failed counters.
- **Speak** — reads `presentation.spoken_text` aloud on demand, plus an
  auto-speak toggle that voices each new line as it arrives.
- **Settings** — backend base URL (stored in AppStorage) and a one-tap
  connection test.

## Build WITH the glasses SDK (recommended, on a Mac)

The committed `BloomKnights.xcodeproj` does NOT link the Meta SDK (it can't be
added to a hand-written project from Windows). To get the real glasses stream:

1. `brew install xcodegen`
2. `cd apps/ios/BloomKnights && xcodegen` — regenerates the project from
   `project.yml` with the `meta-wearables-dat-ios` package (0.8.0+), the
   `bloomknights://` URL scheme, background modes, and the MWDAT config.
3. Open the regenerated project, build, run on a real iPhone (the SDK needs
   a physical device + paired glasses in the Meta AI app).
4. First START: the app opens Meta AI to register, then asks for the glasses
   camera permission. If the stream ever gets stuck with "Session ended by
   device", case the glasses ~30 s and reopen — known Meta SDK quirk (#231).

All glasses-SDK code is `#if canImport(MWDATCore)`-guarded, so the plain
no-SDK project below still compiles and runs (Phone camera mode only).

## Open and build without the SDK (on a Mac)

1. Requires **Xcode 16 or newer** (the project uses the modern
   file-system-synchronized format, objectVersion 77 — source files are picked
   up automatically from the `BloomKnights/BloomKnights/` folder, no manual
   file references).
2. Open `apps/ios/BloomKnights/BloomKnights.xcodeproj`.
3. Select the **BloomKnights** scheme and any iOS 17+ simulator, then Run.
   The simulator build needs no signing at all.

## Run on a real iPhone

1. In Xcode: target **BloomKnights → Signing & Capabilities** → check
   *Automatically manage signing* and pick your **Personal Team** (a free
   Apple ID works). Xcode may ask to change the bundle id suffix if
   `com.bloomknights.app` is taken — that's fine.
2. Plug in the phone (or use Wi-Fi debugging), select it as the destination,
   Run.
3. First launch on device: iOS Settings → General → VPN & Device Management →
   trust your developer certificate.
4. The Glasses tab will ask for camera permission on first use.

## Point the app at the backend

Start the backend on your computer (zero dependencies):

```bash
node services/api/server.js
# BloomKnights demo: http://localhost:3000
```

- **Simulator**: the default `http://localhost:3000` works as-is.
- **Real iPhone**: `localhost` is the phone itself. Find your computer's LAN
  IP and enter it in the app's **Settings** tab, e.g. `http://192.168.1.20:3000`.
  - macOS: `ipconfig getifaddr en0` (or System Settings → Wi-Fi → Details)
  - Windows: `ipconfig` → the Wi-Fi adapter's IPv4 Address
  - Linux: `hostname -I`

  Phone and computer must be on the **same Wi-Fi network**, and the OS
  firewall must allow inbound connections to port 3000. Use **Test
  Connection** in Settings to verify.

The app ships an App Transport Security exception (`Info.plist`) so plain
`http://` LAN traffic works for the demo.

## Demo notes

- All five sports are live end-to-end against the backend's sports registry
  (`services/sports/*.js`), two famous moments each — fixture ids in the app
  mirror the server allowlist exactly:
  - NBA: `frame_000184` (Q4 2:14, BOS 104–101), `frame_000260` (Q4 0:30)
  - UFC 229: `ufc229_r2`, `ufc229_r4` (Khabib vs McGregor, the finish round)
  - Soccer: `wc22_final_60min`, `wc22_final_118min` (ARG–FRA World Cup Final)
  - Football: `sb51_q3_831` (28–3 hole), `sb51_q4_057` (the comeback)
  - Golf: `masters19_h12`, `masters19_h16` (Tiger, Sunday 2019)
- If the app and backend versions drift (a fixture id the server doesn't
  know), the Home tab shows a friendly "not on this backend build" card
  instead of an error wall.
- Tags are honest by design (README §7.9): **REPLAY** = fixture-sourced state,
  **LIVE FRAMES** = a live capture session is feeding the pipeline,
  **MOCK MARKET** = the market adapter is the mock provider.
