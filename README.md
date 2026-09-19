# ReLoop

> Look at your stuff. See what it's worth.

ReLoop is a wearable visual-intelligence system for physical resale. A user wearing camera-enabled smart glasses looks around a room. The system identifies every object in view that could realistically be resold, estimates what each one would sell for secondhand, and draws that price on the live feed as you look at it.

The hackathon version is focused on one experience:

> Walk through a room wearing Meta glasses and watch a price appear on everything worth selling.

No item list to fill in, no photographing things one at a time, no searching for comparable listings. You look, and the prices are there.

Example live view:

```text
8 items in view
$647
ESTIMATED RESALE VALUE
8 ITEMS                TOP $185

Sony PS4 Slim            GOOD      $185
27in 1440p monitor       GOOD      $150
Mechanical keyboard      LIKE NEW  $95
Wireless gaming headset  FAIR      $45
...
```

This README is the source of truth for humans and AI coding tools working on the project. Read it before making architectural or product decisions.

---

## Quickstart

```bash
npm start   # zero-dependency Node server on http://localhost:3000
npm test    # full node:test suite, no install needed
```

Set `RIGHTCODES_KEY_GEMINI` in a `.env` at the repo root, or item identification will fail on every frame and the overlay will stay empty. right.codes issues **a separate key per model channel** — the Gemini channel does not accept `RIGHTCODES_API_KEY` (that is the Claude channel), and using the wrong one fails as a 401 that looks like a dead key.

Pages served by `npm start` (see `services/api/server.js`):

- `/` — judge-facing dashboard
- `/capture` — the live view: camera feed with the price overlay
- `/phone` — phone camera capture client
- `/data` — data dashboard
- `/landing` — marketing landing page
- `/pitch` — pitch deck

API routes: `POST /api/frames`, `GET /api/items/latest`, `GET /api/analysis/status`, `POST /api/analysis/start`, `POST /api/analysis/stop`, `GET /api/health`, `GET /api/live-frame`.

The iOS companion app lives at `apps/ios/` — see its README for build and glasses-streaming instructions.

## How it works

Three stages, joined by plain JSON.

**1. Frames in.** The glasses stream to the iOS app over the Meta Wearables Device Access Toolkit (DAT 0.9.0); the app relays to the browser over WebRTC. The capture page samples a JPEG every 3 seconds and posts it to `POST /api/frames`. The phone camera path (`/phone`) posts to the same route, so nothing downstream knows or cares which camera it came from.

**2. Identification and pricing.** `services/vision/backends/rightcodes-items.js` sends the frame to `gemini-3.8-flash` with a strict `json_schema` response format. It goes through right.codes' OpenAI-compatible route (`/v1/chat/completions`) rather than the native `/gemini/v1beta` one, because 3.8 is only reachable there — the native path 404s on it and still serves 3.6 and gets back, for each item: a label a buyer would search for, a condition grade, an estimated secondhand price in USD, a one-line basis for that number, a confidence, and a bounding box.

Boxes are **0..1000 normalized** — the same convention the capture page's overlay already used for its on-device detections, which is why the model's output can be drawn directly with no coordinate translation. Boxes that are off-image, inverted, or zero-area are dropped in `sanitizedItem()` before they can reach the page or inflate the total.

**3. The overlay.** `GET /api/items/latest` serves the newest result. The capture page draws one box per item labeled `PS4 SLIM  $185`, colour-keyed by worth (green ≥$100, amber ≥$25, grey below), and totals the room in the readout panel with a per-item list.

### Cost control

Frames arrive far faster than a vision model should be billed for, so two independent throttles sit in front of it:

- `FrameSelector` (`services/capture/selector.js`) drops near-duplicate frames and enforces a 750ms floor. A viewer holding still does not pay for the same photo twice.
- `ItemAnalyzer` (`services/api/item-analyzer.js`) keeps **one call in flight at a time** and enforces a 4s minimum interval. A skipped frame is the normal case, and the held result rides along in the response so the overlay never blanks between passes.

Unlike a scoreboard, a room is a complete observation in a single frame, so the analyzer does not batch a frame window — it analyzes the newest frame and drops the rest.

### Nothing is analyzed until you ask

`POST /api/frames` returns `202 analysis_status: "disabled"` until `POST /api/analysis/start` is called. The capture page's **Analyze** button is the only thing that arms it. This matters for a camera worn on someone's face in a shared space: frames are not sent to a model because the app happens to be open.

## Repository map

- `apps/demo-web/` — dashboard, capture, phone, and data pages served by the API server
- `apps/landing/` — landing page
- `apps/pitch/` — pitch deck
- `apps/ios/` — SwiftUI iPhone companion app (iOS 17+, Meta glasses streaming via DAT 0.9.0)
- `apps/demo-video/` — demo-video project; rendered output in `out/`
- `services/api/` — the HTTP server and the item analyzer
- `services/vision/backends/` — the item identification + pricing backend
- `services/capture/` — frame gateway, frame selector, dataset writer
- `services/demo/` — local stream playback for demos
- `tests/` — node:test coverage for the server, gateway, selector, and page contracts

## Rules for contributors and AI agents

- **The phone and the glasses are interchangeable.** Anything that assumes glasses belongs in the iOS app, never on the server. The server must work with a frame from any source.
- **Prices come from the model, and the model says why.** Every item carries a `price_basis`. If you cannot explain a number on stage, do not show it.
- **Never let a bad box through.** A box that fails validation is dropped, not clamped into something plausible. A phantom item in the total is worse than a missing one.
- **Keep the analysis gate.** Do not add a code path that sends frames to a model without an explicit start.
- **Run `npm test` before you push.** `main` must stay green.

## Honest scope and limitations

- **Prices are single-shot LLM estimates.** They are not drawn from a researched price book or live sold-listing data, and they will vary between runs on the same object. Say this plainly rather than implying market data.
- **The overlay lags a moving camera.** Boxes refresh on a ~3–4s cadence, so they track a room you are scanning deliberately, not a head turning quickly.
- **Identification is only as good as the view.** A partially occluded or badly lit object gets a low confidence and a vaguer label; the model is told not to invent a model number it cannot see.
- **`RIGHTCODES_KEY_GEMINI` is required.** Without it every pass fails and `queue.last_error` on `/api/analysis/status` will say so.

## The pitch

People don't throw usable things away because they have no value. They throw them away because finding out what they're worth is work — photographing, searching comparable listings, guessing at condition. ReLoop removes the work. You look at the room, and the room is priced.
