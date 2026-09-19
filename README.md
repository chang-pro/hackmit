<<<<<<< HEAD
# ReLoop - Lane B

Python implementation of the **v2** plan: photo identification, clarification,
condition-adjusted pricing, deterministic routing/planning, and listing drafts.
Lane C owns the main server, persistence, approval, seller policy, events, and checkout.
Lane A owns iOS/glasses. Lane B does not publish or mark anything sold.

## Run now

Python 3.11+ (3.12 recommended for the shared project):

```sh
python3.11 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m reloop_brain.demo
.venv/bin/python -m pytest -q
RELOOP_ALLOW_DEMO_PRICES=1 .venv/bin/uvicorn reloop_brain.api:app --reload --port 8001
```

`requirements-dev.lock` records the exact dependency versions used for the passing
tests. Teammates can reproduce them with
`.venv/bin/python -m pip install -r requirements-dev.lock -e .`.

Open http://127.0.0.1:8001/docs for interactive API requests. Test planning without
credentials or photos:

```sh
curl http://127.0.0.1:8001/plan \
  -H 'Content-Type: application/json' \
  --data-binary @contracts/fixtures/plan_request.json
```

**Most prices are unresearched development fixtures.** Ray-Ban regular and Meta charging cases now have sourced estimates; see [Lane B pricing](docs/lane-b-pricing.md). Fixture prices are labeled in
every price basis and disabled unless `RELOOP_ALLOW_DEMO_PRICES=1`. This is not a
market-price dataset or a Voloridge result. No real images are included yet.

## Live photo identification

### Gemini

Create an API key in [Google AI Studio](https://aistudio.google.com/apikey).
If a key was shared in chat, revoke it and create a replacement. Enter the new
key privately in your local terminal; it is not needed in any source file.
Stop the running server with Ctrl+C, then in zsh:

```sh
read -s "GEMINI_API_KEY?New Gemini API key: "
export GEMINI_API_KEY
echo
export RELOOP_VISION_PROVIDER=gemini
export RELOOP_VISION_MODEL=gemini-3.6-flash
RELOOP_ALLOW_DEMO_PRICES=1 .venv/bin/uvicorn reloop_brain.api:app --port 8001
```

Choose a model with image input and JSON output. This adapter uses
Google's `generateContent` REST endpoint in JSON mode with the schema in the prompt,
then validates the returned JSON with Pydantic. Schema adherence is enforced locally,
not guaranteed by constrained generation. See [Google's structured output documentation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).
Credentials go in an HTTP header, never in a URL. Automated tests mock the provider. A live smoke test with `gemini-3.6-flash`
successfully identified a generated blank image as containing no items. Real-product
accuracy still needs testing. `gemini-2.5-flash` rejected this account as a new user.

### Anthropic (original default)

Set `ANTHROPIC_API_KEY` and `RELOOP_VISION_MODEL` in your local shell before
starting the API. Choose a vision/tool-use model available in your account.
See `.env.example`; do not commit keys. There is no automatic `.env` loader.
Set `RELOOP_VISION_PROVIDER=anthropic` if switching back from Gemini.

### Send a photo (either provider)

With the API running, send your own photo:

```sh
.venv/bin/python -m reloop_brain.scan /path/to/photo.jpg --out tmp/first-scan.json
.venv/bin/python -m reloop_brain.scan /path/to/second-angle.jpg \
  --existing tmp/first-scan.json --out tmp/second-scan.json
```

For a dog-angle photo add `--source DOG --spot desk`. Use a fresh scope for each
different spot; never reuse one spot's `--existing` file in another spot.

`POST /identify` takes JSON with:

```json
{
  "capture": {
    "id": "cap_001", "ts": "2026-09-19T12:00:00Z",
    "source": "PHONE", "uri": "blob://cap_001.jpg",
    "spot": null, "missionId": null
  },
  "imageBase64": "RAW_BASE64_JPEG_PNG_OR_WEBP",
  "existingItems": []
}
```

The capture URI is a reference owned by Lane C; Lane B never fetches it. Pass
image bytes explicitly (max 5 MiB, 20 MP; convert HEIC). No arbitrary URL fetching.
Response: `items`, `pricedItems` (`item` + nullable `band`), `dropped`, `warnings`.
Missing credentials return 503; provider failures return 502; invalid inputs 422.
Live failures never silently return fixtures.

The provider uses the Anthropic Messages API with a forced structured tool and
Pydantic validation. Category enum includes recognizable categories even without price coverage; invalid categories map
to `other.unknown`, have no price, and require correction. The model never prices
or routes. References: [vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).

## Integration for your teammates

Contracts: `contracts/schema.py` mirrors the Lane B subset of the PDF's camelCase
JSON shapes, with `PHONE`, `GLASSES`, `DOG`, `FIXTURE` source strings. Lane C can add
its own listing/negotiation/event types. Example payloads: `contracts/fixtures/`.
All money is whole USD; dates include a timezone.

Lane C can mount this router inside its existing FastAPI application:

```python
from reloop_brain.api import create_router

app.include_router(create_router())
```

Or invoke the Python functions directly from `/captures` without another HTTP hop:
`items_from_observations`, `merge_scan_items`, `price_items`, and `build_plan`.
Inject a `PriceBook` and `VisionProvider` into `create_router(book, vision)` for tests
or a different AI provider. Backend must resolve session-owned items from storage
before using these functions in a public service. The standalone API trusts its
development caller and is intended for local integration, not public deployment.

| Route | Input | Result |
| --- | --- | --- |
| `POST /identify` | Capture, imageBase64, existingItems | Observations + provisional bands |
| `POST /items/confirm` | item, corrected label/category/condition, confirmed=true | Confirmed item + band |
| `POST /price` | Item | Sourced price band, evidence, status, suggested ask |
| `POST /plan` | items, goal, optional keepItemIds | Unapproved Plan with reasons |
| `POST /listing-draft` | Confirmed Item | title, description, priceBasis, itemId |

**Flow:** capture -> identify -> owner correction/confirmation -> plan -> Lane C's
approval -> Shopify publishing. `Not sure` leaves a question unresolved; do not
translate it to `confirmed=true`. The owner must supply a known category to price
an unknown item. Keep IDs let them explicitly exclude an item.

Owner confirmation and plan approval are different actions. Every plan returns
`approved=false`; Lane C must enforce approval and calculate/enforce its private
seller floors. No seller rules or floors exist in this public module.
Listing drafts never invent battery tests, specifications, accessories, or warranties.

## Rules and intentional choices

- Condition multipliers match the PDF. Dollar bands round half up to $5.
- Keep overrides every routing rule. Broken electronics go to proposed recycling;
  low-value usable items to proposed donation. Neither means a real drop-off happened.
- Yard sale bypasses online listing minimums and sells rounded-value items >= $2.
- Clear-out, yard sale, or deadlines <24 hours use quick prices. Otherwise a positive
  target with >=30% normal-value headroom uses max prices; remaining goals use normal.
- Listing ask is estimated tier +3%, rounded up to a dollar. `expectedUsd` excludes
  headroom, is gross (no fees/shipping), and is an estimate, not guaranteed proceeds.
- Upgrade target = book price of upgrade minus budget, floored at zero. The starter
  PS5 price is only a fixture; replace it with a sourced replacement-cost estimate.
- All eligible items are included; this version does not minimize the number sold.
- Unknown/low-confidence/unresolved items block planning unless explicitly kept.
- IDs are deterministic for capture/index and effective plan payloads.

## Dedupe and dog frames

Pass `existingItems` from **one scan and one physical spot**, not a global catalog.
Same-category near-identical labels merge across captures, one-to-one, retaining
photo references and owner corrections. Two identical objects in a single image
stay separate. Matching remains a heuristic: use separate spot scopes for identical
products in different locations and allow manual review. No physical object tracker
is claimed.
Persist the whole returned item list atomically. Capture IDs are immutable; replaying
an already-processed capture is ignored. To re-run inference use a new capture ID.

Dog frames flagged as containing people produce `dropped=true` and no new items.
This check happens **within the vision call**, not before sending the image to the
provider, and is not guaranteed person detection. Lane C must quarantine flagged
captures and keep them out of Shopify/public image storage. If pre-provider filtering
is required, add a local detector in the capture ingestion path before calling Lane B.

## Remaining Lane B work

1. Photograph the actual demo items, including floor-height dog angles; evaluate
   identity and question quality using a live configured model. No live call has been
   verified by the automated tests.
2. Research model-specific sold comparables; replace fixture values and sources,
   fill `researched`, set `is_demo=false`, then turn off the demo flag. Generic phone,
   headset and monitor categories need narrowing to the actual models.
3. Verify the JSON fixtures decode in iOS and the router integrates with Lane C.
4. Add sourced local donation/recycling sites, clearly labeled time-saving estimates,
   and UI integration with the relevant teammates.
5. Only afterward add public-dataset analysis for Voloridge. Amazon historical retail
   metadata is not evidence of current secondhand prices.

Regenerate fixture JSON after a deliberate contract change:
`.venv/bin/python -m reloop_brain.demo --write-fixtures`.
=======
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
- `services/events/` — append-only event log and the dashboard fold ([docs/architecture/EVENTS.md](docs/architecture/EVENTS.md))
- `services/market/` — planner, approval, store, seller agent with a code-enforced floor, Marketplace draft queue ([docs/architecture/MARKET.md](docs/architecture/MARKET.md))
- `tests/` — node:test coverage for the server, gateway, selector, and page contracts

## Rules for contributors and AI agents

- **The phone and the glasses are interchangeable.** Anything that assumes glasses belongs in the iOS app, never on the server. The server must work with a frame from any source.
- **Prices come from the model, and the model says why.** Every item carries a `price_basis`. If you cannot explain a number on stage, do not show it.
- **Never let a bad box through.** A box that fails validation is dropped, not clamped into something plausible. A phantom item in the total is worse than a missing one.
- **Keep the analysis gate.** Do not add a code path that sends frames to a model without an explicit start.
- **One server: the Node one.** The app, dashboard and agents talk only to `services/api/server.js`, priced by the Node pricer. The Python `reloop_brain` API is not called at runtime; its routing rules are ported in `services/market/planner.js`. See [docs/architecture/MARKET.md](docs/architecture/MARKET.md).
- **Report progress as events.** The dashboard (`/dashboard`) is a fold over `POST /api/events`. Before building anything that sets a goal, approves a plan, lists or sells, read [docs/architecture/EVENTS.md](docs/architecture/EVENTS.md) — it says which events each lane owes.
- **Run `npm test` before you push.** `main` must stay green.

## Honest scope and limitations

- **Prices are single-shot LLM estimates.** They are not drawn from a researched price book or live sold-listing data, and they will vary between runs on the same object. Say this plainly rather than implying market data.
- **The overlay lags a moving camera.** Boxes refresh on a ~3–4s cadence, so they track a room you are scanning deliberately, not a head turning quickly.
- **Identification is only as good as the view.** A partially occluded or badly lit object gets a low confidence and a vaguer label; the model is told not to invent a model number it cannot see.
- **`RIGHTCODES_KEY_GEMINI` is required.** Without it every pass fails and `queue.last_error` on `/api/analysis/status` will say so.

## The pitch

People don't throw usable things away because they have no value. They throw them away because finding out what they're worth is work — photographing, searching comparable listings, guessing at condition. ReLoop removes the work. You look at the room, and the room is priced.
>>>>>>> a88508c6ecdc560901ddfd6d33d8b06b484e73a4
