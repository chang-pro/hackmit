# BloomKnights HTTP API

Everything is served by one zero-dependency Node process: `services/api/server.js` (`npm start`, default `http://localhost:3000`, override with `PORT`). All responses are JSON (pretty-printed, 2-space) except the two HTML pages. Snapshot as of 2026-07-11 — see "Not implemented yet" at the bottom for endpoints clients already call.

Global behaviors (`server.js`):

- Any unhandled error in a request -> `500 { "error": "<message>" }`. The UI never sees a raw stack.
- Unknown path -> `404 { "error": "not found" }`.
- Request bodies are capped at **8 MiB** (`MAX_BODY_BYTES`, generous for base64 1080p JPEGs) -> `413 { "error": "request body too large" }`.
- Malformed JSON body -> `400 { "error": "invalid JSON body" }`.

---

## POST /api/frames — frame submission contract

Source-agnostic frame ingestion (README §7.1). Any capture source — iOS app, webcam page, glasses bridge, replayed clip — submits frames here. The gateway assigns the `frame_id` and buffers the frame **in memory only** (30-frame ring buffer; `image_uri` is a `memory://` reference, never a file path). The selector then decides whether the frame flows downstream; skipped frames still get their metadata back so clients can count them.

### Request

`Content-Type: application/json`

```json
{
  "source": "ios_app",
  "captured_at": "2026-07-11T20:14:32.491Z",
  "image_base64": "/9j/4AAQSkZJRgABAQAA...",
  "width": 1920,
  "height": 1080
}
```

| Field | Type | Required | Rules (from `services/capture/gateway.js`) |
|---|---|---|---|
| `source` | string | yes | Non-empty after trim. Conventional values seen in clients: `"ios_app"`, `"webcam"`, `"fixture"`, `"glasses"`. |
| `image_base64` | string | yes | Non-empty. Raw base64 of the frame image (clients send JPEG). Also the input to the duplicate-detection hash. |
| `width`, `height` | number | yes | Finite and > 0. |
| `captured_at` | string | no | ISO-8601. Unparseable or missing -> server substitutes its own current time. |
| `sport` | string | no | Sent by the iOS app for forward compatibility; **the server currently ignores it** (extra fields are not rejected). |

### Responses

`201 Created` — frame accepted by the selector (flows downstream; starts/extends a 10 s "live session"):

```json
{
  "frame": {
    "frame_id": "frame_000001",
    "captured_at": "2026-07-11T20:14:32.491Z",
    "source": "ios_app",
    "image_uri": "memory://capture/frame_000001",
    "width": 1920,
    "height": 1080
  },
  "selection": { "accepted": true, "reason": null }
}
```

`200 OK` — frame ingested but skipped by the selector (normal, not a failure):

```json
{
  "frame": { "frame_id": "frame_000002", "...": "..." },
  "selection": { "accepted": false, "reason": "rate_limited" }
}
```

`selection.reason` values (`services/capture/selector.js`):

- `"rate_limited"` — arrived less than 500 ms after the last accepted frame (~2 fps ceiling)
- `"near_duplicate"` — same byte length and sampled hash as the last accepted frame (byte-identical payloads: paused source, resent capture)
- `null` — accepted

Errors:

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "invalid JSON body" }` | Body is not JSON |
| 400 | `{ "error": "source is required" }` | Missing/empty `source` |
| 400 | `{ "error": "image_base64 is required" }` | Missing/empty image |
| 400 | `{ "error": "width and height must be positive numbers" }` | Bad dimensions |
| 413 | `{ "error": "request body too large" }` | > 8 MiB |

### Live-session semantics

An accepted frame marks the pipeline "live" for **10 seconds** (`LIVE_SESSION_TTL_MS`). While live, `GET /api/comparison` reports `source: "live"` and carries the live frame's metadata — but extraction still comes from the committed fixture (`extraction: "fixture_parse"`) until Slice 2's real OCR lands behind the seam in `services/api/pipeline.js`.

---

## GET /api/comparison — the full pipeline result

Runs the whole pipeline for one demo moment and returns the README §8 payload. This endpoint is the integration contract every slice must keep working (ADR 0001).

### Query parameters

| Param | Default | Rules |
|---|---|---|
| `fixture` | `frame_000184` | Must be in the server allowlist: `frame_000184` (Q4 2:14, BOS 104–101) or `frame_000260` (Q4 0:30, BOS 112–105). The value never touches the filesystem directly. |
| `sport` | — | **Sent by the web and iOS clients but not read by the server yet** (multi-sport routing is in flight; `runPipeline` already accepts a `sportId`). |

Unknown fixture -> `400`:

```json
{ "error": "unknown fixture; known: frame_000184, frame_000260" }
```

### 200 response — ready

Real shape from `services/api/pipeline.js runPipeline()` (values from the default fixture with the default mock adapter):

```json
{
  "session_id": "session_slice1",
  "sport": "nba",
  "source": "fixture",
  "extraction": "fixture_parse",
  "event": {
    "event_id": "nba_2026_07_11_bos_nyk",
    "league": "NBA",
    "away_team_id": "nba_bos",
    "home_team_id": "nba_nyk"
  },
  "state": {
    "away_score": 104,
    "home_score": 101,
    "period": 4,
    "clock_seconds": 134,
    "confidence": 0.94,
    "observed_at": "2026-07-11T20:14:32.491Z",
    "accepted": true,
    "rejection_reason": null
  },
  "estimate": {
    "outcome": "nba_bos_wins",
    "probability": 0.6802,
    "model_version": "nba-win-probability-v1"
  },
  "market": {
    "provider": "mock",
    "market_id": "market_123",
    "probability": 0.59,
    "is_mock": true,
    "provider_timestamp": "2026-07-11T20:14:31.900Z"
  },
  "comparison": {
    "event_id": "nba_2026_07_11_bos_nyk",
    "outcome": "nba_bos_wins",
    "model_probability": 0.6802,
    "market_probability": 0.59,
    "gap_percentage_points": 9,
    "direction": "model_higher",
    "state_confidence": 0.94,
    "freshness_ms": 930,
    "generated_at": "2026-07-11T20:14:32.840Z"
  },
  "presentation": {
    "status": "ready",
    "short_text": "BOS 68%. Market 59%. Model is 9 points higher.",
    "spoken_text": "bos's estimated win probability is 68 percent. The market is at 59 percent."
  }
}
```

Field notes:

- `source`: `"fixture"` or `"live"` (a live session is active — see POST /api/frames).
- `extraction`: always `"fixture_parse"` today; changes when real OCR replaces the seam.
- `state.confidence`: the min over the sport's confidence fields; `state.accepted` / `state.rejection_reason` report the reconciler's verdict for *this* observation (the state itself may be retained from an earlier accepted one). `state.extras` appears for sports that carry extra fields (soccer minute, UFC scheduled rounds, golf holes remaining).
- `market.probability` = adapter's `display_probability` = bid/ask midpoint (mock always; Polymarket falls back to labeled last-trade).
- `comparison.gap_percentage_points` = `(model − market) × 100`, one decimal. `direction` ∈ `"model_higher" | "model_lower" | "aligned"`.
- `presentation.status` and its gates (`services/api/pipeline.js`):

| Status | Trigger | `short_text` |
|---|---|---|
| `ready` | Passed all gates | `"BOS 68%. Market 59%. Model is 9 points higher."` |
| `low_confidence` | `state.confidence < 0.8` | `"I can see the game, but the scoreboard is not clear enough yet."` |
| `stale_market` | snapshot older than 30 000 ms | `"Game identified. Current market data is stale, so no comparison is available."` |
| `no_state` | reconciler has never accepted a state | see below |

### 200 response — no state

When the reconciler holds no acceptable state, the payload is presentation-only (clients must treat every other top-level key as optional):

```json
{
  "presentation": {
    "status": "no_state",
    "short_text": "I can see the game, but the scoreboard is not clear enough yet.",
    "reason": "confidence 0.5 below 0.8"
  }
}
```

### Errors

- `400` unknown fixture (above).
- `500 { "error": "<message>" }` — anything thrown inside the pipeline surfaces here: unresolvable team text, sport/fixture tag mismatch, ambiguous or missing market match, adapter/network failures.

---

## HTML pages

| Route | File | Purpose |
|---|---|---|
| `GET /` or `/index.html` | `apps/demo-web/index.html` | Judge-facing dashboard: sport tabs, demo-moment cards, model-vs-market panel, glasses HUD lens preview, raw-payload debug console, Web Speech "Speak". Polls `/api/comparison` every 5 s. |
| `GET /capture` or `/capture.html` | `apps/demo-web/capture.html` | Webcam capture page: samples ~1 fps and POSTs to `/api/frames`. |

`apps/demo-web/data.html` (fixture/stats explorer) exists but **has no route** — serving it is an open in-flight item.

## Not implemented yet (called by clients)

These appear in `apps/demo-web/index.html`, `data.html`, `capture.html`, and the iOS `ApiClient.swift`, and currently return `404`. All clients degrade gracefully (fallback catalogs / hidden panels):

| Endpoint | Expected by | Expected shape (inferred from client code) |
|---|---|---|
| `GET /api/sports` | index, capture, data, iOS | Array of sport configs: `[{ id, label, league, match?, fixtures?, demo_moments: [{ fixture, label, historical? }] }]` — the registry in `services/sports/index.js` already holds this data |
| `GET /api/comparison?sport=<id>&...` | index, data, iOS | Same payload, routed to the named sport's fixtures |
| `GET /api/stats` | data | Live stat snapshots |
| `GET /api/dataset/summary` | data | DatasetWriter counts per sport |
