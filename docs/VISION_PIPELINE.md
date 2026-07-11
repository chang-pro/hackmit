# Vision pipeline operating guide

This is the execution guide for the BloomKnights camera-to-insight backend. The phone is the canonical capture device until the native app is ready.

## Ownership

Our service owns everything after camera capture:

```text
phone/app camera -> direct WebRTC peer connection -> desktop capture viewer
                  \-> HTTPS tunnel carries SDP/ICE signaling only
desktop capture viewer -> bundled YOLO11n -> continuous local player/ball overlay
phone/app analysis JPEGs (only after user action) -> five-frame window -> Gemma 4 event extraction
-> automatic event-switch check -> GPT OSS/GLM prediction analysis -> presentation-ready JSON
```

The native app owns camera permissions and frame delivery. The Next.js frontend owns rendering. Neither client should implement OCR, game-state correction, probability calculation, market comparison, or sport selection. The camera feed is the selector.

## Fastest phone test

Requirements:

- The laptop and phone are on the same Wi-Fi network.
- Node.js 20 or newer.
- `CEREBRAS_API_KEY` is set in the server shell.

Start the real service:

```bash
export CEREBRAS_API_KEY="..."
export VISION_BACKEND=cerebras
npm start
```

The server prints the exact phone URL. On the current machine it will resemble:

```text
http://10.32.242.101:3000/phone
```

Open `/capture` on the desktop and `/phone` on the camera device. Choose **Start live feed** on the phone, fill most of the view with the television or monitor, and keep the scoreboard unobstructed. The latest started phone or glasses feed automatically becomes the desktop feed. Video connects directly between phone and desktop; press **Analyze** on the desktop only when you are ready to spend model requests.

Continuous **Start live feed** uses `getUserMedia`, which mobile browsers normally expose only in a secure HTTPS context. Use the photo flow until an HTTPS tunnel or the native app is available.

## University or isolated Wi-Fi

Campus networks commonly prevent two wireless clients from reaching each other, so a laptop LAN address such as `http://10.x.x.x:3000` may be unreachable from the phone. Use the outbound HTTPS tunnel instead:

```bash
npm run phone:tunnel
```

The command starts the analyzer and serves the stable demo URL:

```text
https://capture.saicharanramineni.com
```

Open `https://capture.saicharanramineni.com/capture` on the desktop and `https://capture.saicharanramineni.com/phone` on the phone, then start the camera. The public tunnel carries only WebRTC signaling and sparse analysis requests; camera media travels directly between the browser peers or through the configured TURN provider. Unlike the previous LocalTunnel and Tunnelmole paths, the public URL opens with a trusted certificate—there is no IP/password interstitial for the camera user.

The stable hostname is backed by the named `bloomknights-capture` Cloudflare Tunnel. Its credentials JSON lives only at `~/.cloudflared/<tunnel-id>.json`; never commit it. The hostname survives restarts, but the connector process must be running for the route to answer. Do not publish the URL broadly because anyone with it can submit analysis requests.

## Plumbing-only test without a model key

```bash
npm run start:fixture
```

This validates phone connectivity, image upload, frame selection, UI rendering, probability calculation, and response contracts. It does **not** inspect the uploaded image. Responses are labeled `extraction: "fixture"`, and the market remains labeled as mock data.

## Client contract

The desktop viewer follows the current active camera session:

```http
GET /api/webrtc/active
```

When the phone or glasses starts, it claims that session at `POST /api/webrtc/active`. If another provider is already live, the new one replaces it. Both pages then exchange SDP offers/answers and ICE candidates through `POST /api/webrtc/signal` plus `GET /api/webrtc/poll`. Those endpoints carry only setup metadata—never JPEGs or video bytes.

Analysis starts only after `POST /api/analysis/start`. At that point the phone also submits one high-quality JPEG every 2.4 seconds to the analysis endpoint:

```http
POST /api/frames
Content-Type: application/json
```

```json
{
  "source": "phone_app",
  "captured_at": "2026-07-11T20:14:32.491Z",
  "mime_type": "image/jpeg",
  "image_base64": "...",
  "width": 1280,
  "height": 720
}
```

The first four live-feed frames normally return HTTP `202` with `analysis_status: "queued"`. The fifth frame triggers a packed request and returns HTTP `201`:

```json
{
  "frame": {
    "frame_id": "frame_000001",
    "captured_at": "2026-07-11T20:14:32.491Z",
    "source": "phone_app",
    "mime_type": "image/jpeg",
    "image_uri": "memory://capture/frame_000001",
    "width": 1280,
    "height": 720
  },
  "selection": { "accepted": true, "reason": null },
  "analysis_status": "analyzed",
  "insight": {
    "source": "live",
    "extraction": "cerebras-batch",
    "frame_window": { "count": 5, "frames": [] },
    "observation": {
      "sport": "soccer",
      "competition": "FIFA World Cup 2026",
      "event_name": "USA vs Brazil",
      "event_identity": "soccer:usa-vs-brazil-world-cup-2026",
      "event_format": "team_event",
      "score_display": "1-1",
      "phase": "Second half",
      "clock": "72:14"
    },
    "event_switch": {
      "detected": false,
      "reason": "first_observation"
    },
    "analysis": {
      "primary_market_question": "Who will win the match?",
      "primary_outcome": "Brazil",
      "primary_probability": 0.42,
      "alternate_markets": []
    },
    "presentation": {},
    "rate_limit": {}
  }
}
```

Queued frames return HTTP `202` with queue depth, time until the next eligible request, and the latest cached insight. Rate-limited or duplicate frames return HTTP `200` with `selection.accepted: false`. Extraction failures return HTTP `422` with an `analysis.error`; clients should show that message in debug mode and continue sending later frames.

Other endpoints:

- `GET /api/health` — backend selection and readiness.
- `GET /api/latest` — most recent live insight, with fixture fallback after the live TTL.
- `GET /api/comparison` — compatibility alias for `/api/latest`.
- `POST /api/reset` — clears buffered frames and canonical game state.
- `GET /phone` — phone-first camera capture page.
- `GET /capture` — desktop WebRTC viewer and Analyze control.
- `GET /api/live-frame` — metadata for the newest inbound camera frame.
- `GET /api/webrtc/active` — read the single viewer's active camera session.
- `POST /api/webrtc/active` — claim that camera session; newest publisher wins.
- `POST /api/webrtc/signal`, `GET /api/webrtc/poll` — SDP/ICE signaling only.
- `GET /api/webrtc/config?session_id=<id>` — session-bound STUN/TURN servers for browser peers.
- `GET /api/analysis/status` — analysis-enabled state for the phone client.
- `POST /api/analysis/start` — begin quota-limited model analysis.
- `POST /api/analysis/stop` — stop model analysis while video keeps streaming.

## Frame cadence

The WebRTC peer connection carries continuous camera video directly from phone to desktop and does not traverse the public HTTP tunnel. The phone requests 4K/15fps capture with a detail-preserving 12 Mbps sender ceiling; browsers that cannot supply 4K fall back gracefully. `/capture` reports the received resolution, frame rate, and bitrate in its dock. Until the user presses **Analyze** on `/capture`, `/api/frames` rejects analysis submissions with `analysis_status: "disabled"`. After that explicit action, the phone submits one 1600-pixel JPEG every 2.4 seconds; the backend packs five ordered frames into one Gemma request every 12 seconds. That yields at most five Gemma requests and five GPT-OSS requests per minute.

The default configuration uses public STUN discovery. Some campus NATs require a TURN relay for WebRTC media fallback. The preferred demo configuration is Metered Open Relay: set `METERED_TURN_APP_NAME` and `METERED_TURN_API_KEY` on the server. For each ten-minute active session, the server retrieves the provider-issued browser ICE configuration and returns it only to callers holding that session id. Do not put the API key in frontend source code.

An external TURN provider can instead be supplied through `WEBRTC_ICE_SERVERS_JSON`, for example `[{"urls":"turn:turn.example.edu:3478","username":"...","credential":"..."}]`. When a TURN URL is configured, BloomKnights uses relay-only WebRTC so client-isolated Wi-Fi does not waste time attempting a direct media candidate. TURN is independent from the public HTTP tunnel, which carries only active-session signaling and gated analysis snapshots.

## Browser-only UI demo

To iterate on `/capture` without a phone, glasses, TURN relay, or any video bandwidth, open the capture page and run this in the browser console:

```js
bloomDemo.start()
```

It renders a local animated synthetic broadcast through a canvas `MediaStream` and activates the same connected-video UI state as a real camera. Stop it with `bloomDemo.stop()`. It never sends a frame to the backend; model analysis remains off unless you explicitly enable it.

For a shareable UI-review link, open `/capture?demo=1` instead.

### Continuous player overlay

The capture page runs bundled YOLO11s directly in the desktop browser against the received WebRTC video. To detect distant broadcast players, it analyzes three overlapping 640px field tiles rather than shrinking the whole 16:9 frame into one small detector input. It recognizes COCO `person` and `sports ball` classes, merges tile results with local NMS, and maps normalized boxes over the cover-cropped video. Dense mode intentionally trades update rate for small-player recall. The first live stream downloads the bundled 36 MB ONNX model to the viewer; after that, tracking creates no Cerebras call, backend frame upload, or tunnel media traffic. The local demo uses an explicitly labeled synthetic tracker so UI work never consumes model quota.

Gemma remains deliberately user-gated behind **Analyze** for the job YOLO cannot do: reading scoreboards, identifying the event, and assembling prediction context from sparse five-frame windows.

## Cerebras models

The live provider is intentionally simple:

1. `gemma-4-31b` receives up to five ordered JPEGs and emits a strict universal event schema. Sport is open-ended; head-to-head games, tournaments, leaderboards, and races share one contract.
2. The backend compares stable `event_identity`, sport, competition, and participants with the last trusted observation. A real event change clears the old context; a leaderboard showing another player does not.
3. `gpt-oss-120b` receives the trusted event observation plus same-event context and emits the primary prediction-market question, probability, alternate markets, key factors, changes, and the next probability-moving trigger.

Set `CEREBRAS_ANALYTICS_MODEL=zai-glm-4.7` to use GLM 4.7 for the second pass. `CEREBRAS_MODEL_INTERVAL_MS` may be increased but is clamped to a minimum of 12,000 ms, and `CEREBRAS_FRAMES_PER_REQUEST` is capped at five. The API key stays server-side and must never be sent by the phone or frontend.

## Honest failure behavior

- An unreadable scoreboard becomes an unresolved or low-confidence result.
- An unknown team label never gets fuzzy-matched to a likely team.
- A score decrease or implausible jump is rejected while the last trusted state is retained.
- A missing market still returns the vision result and model estimate.
- Mock and fixture data are always labeled.
- Raw frames stay in a bounded in-memory ring buffer and are not written to disk.

## Native app handoff

The app team needs to establish the direct media peer connection and send gated analysis snapshots. Recommended behavior:

1. Capture rear-camera JPEG at 720p or 1080p.
2. Downscale so the longest edge is at most 1600 pixels.
3. Claim the active session with `POST /api/webrtc/active`, then exchange SDP/ICE through the WebRTC signaling endpoints; add the camera track to the resulting peer connection.
4. Read `analysis_enabled` from `GET /api/analysis/status`. Send a 1600-pixel JPEG to `POST /api/frames` every 2.4 seconds only when it is `true`.
5. Do not send a sport selector value; detection and event switching are server-owned.
6. Never overlap analysis requests.
7. Speak or render `insight.presentation`.
8. Expose the remaining fields only in a developer/debug panel.
