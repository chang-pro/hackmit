# Vision pipeline operating guide

This is the execution guide for the BloomKnights camera-to-insight backend. The phone is the canonical capture device until the native app is ready.

## Ownership

Our service owns everything after camera capture:

```text
phone/app JPEG -> capture gateway -> frame selection -> scoreboard extraction
-> team/event resolution -> temporal reconciliation -> win probability
-> market lookup -> confidence/freshness gate -> presentation-ready JSON
```

The native app owns camera permissions and frame delivery. The Next.js frontend owns rendering. Neither client should implement OCR, game-state correction, probability calculation, or market comparison.

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
http://10.32.242.101:3000/capture
```

Open that URL on the phone and choose **Take photo**. This invokes the phone's rear camera through the file-capture control and works on an ordinary local HTTP connection. Fill most of the photo with the television or monitor, keep the scoreboard unobstructed, and avoid glare.

Continuous **Start live feed** uses `getUserMedia`, which mobile browsers normally expose only in a secure HTTPS context. Use the photo flow until an HTTPS tunnel or the native app is available.

## University or isolated Wi-Fi

Campus networks commonly prevent two wireless clients from reaching each other, so a laptop LAN address such as `http://10.x.x.x:3000` may be unreachable from the phone. Use the outbound HTTPS tunnel instead:

```bash
brew install cloudflared
npm run phone:tunnel
```

The command starts the analyzer and prints a random public URL similar to:

```text
https://random-words.trycloudflare.com
```

Open `https://random-words.trycloudflare.com/capture` on the phone. Because this is a public HTTPS origin, continuous camera capture works and no local-network connection is required. The glasses/native app can use the same origin as its API base and send frames to `POST /api/frames`.

Quick Tunnel URLs are temporary development endpoints: the URL changes when the command restarts and the process must remain running. Do not publish the URL broadly because anyone with it can submit analysis requests.

## Plumbing-only test without a model key

```bash
npm run start:fixture
```

This validates phone connectivity, image upload, frame selection, UI rendering, probability calculation, and response contracts. It does **not** inspect the uploaded image. Responses are labeled `extraction: "fixture"`, and the market remains labeled as mock data.

## Client contract

Submit a JPEG frame:

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

An accepted frame returns HTTP `201`:

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
  "insight": {
    "source": "live",
    "extraction": "cerebras",
    "event": {},
    "parsed_scoreboard": {},
    "state": {},
    "estimate": {},
    "market": {},
    "comparison": {},
    "presentation": {}
  }
}
```

Rate-limited or duplicate frames return HTTP `200` with `selection.accepted: false` and the latest insight when one exists. Extraction failures return HTTP `422` with an `analysis.error`; clients should show that message in debug mode and continue sending later frames.

Other endpoints:

- `GET /api/health` — backend selection and readiness.
- `GET /api/latest` — most recent live insight, with fixture fallback after the live TTL.
- `GET /api/comparison` — compatibility alias for `/api/latest`.
- `POST /api/reset` — clears buffered frames and canonical game state.
- `GET /capture` — phone-first capture and result page.

## Frame cadence

Do not stream full video to the service. Send one compressed JPEG every 2-3 seconds and wait for the previous request to finish. Meaningful scoreboard changes matter more than raw frame rate. The phone page resizes images to a maximum 1600-pixel edge and serializes analysis requests to control cost and concurrency.

## Cerebras models

The live provider is intentionally simple:

1. `gemma-4-31b` receives the phone JPEG as a base64 image input and emits a strict scoreboard schema.
2. The deterministic NBA probability model converts the reconciled score and clock into a numerical baseline.
3. `gpt-oss-120b` receives the trusted state, baseline probability, and market context and emits concise structured analysis.

Set `CEREBRAS_ANALYTICS_MODEL=zai-glm-4.7` to use GLM 4.7 for the second pass. Set `CEREBRAS_ANALYTICS_ENABLED=false` to run only Gemma 4 plus the deterministic probability engine. The API key stays server-side and must never be sent by the phone or frontend.

## Honest failure behavior

- An unreadable scoreboard becomes an unresolved or low-confidence result.
- An unknown team label never gets fuzzy-matched to a likely team.
- A score decrease or implausible jump is rejected while the last trusted state is retained.
- A missing market still returns the vision result and model estimate.
- Mock and fixture data are always labeled.
- Raw frames stay in a bounded in-memory ring buffer and are not written to disk.

## Native app handoff

The app team only needs to reproduce the `/api/frames` request. Recommended app behavior:

1. Capture rear-camera JPEG at 720p or 1080p.
2. Downscale so the longest edge is at most 1600 pixels.
3. Send every 2-3 seconds while the user is analyzing a screen.
4. Never overlap analysis requests.
5. Speak or render `insight.presentation`.
6. Expose the remaining fields only in a developer/debug panel.
