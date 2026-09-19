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

**Current prices are unresearched development fixtures.** They are labeled in
every price basis and disabled unless `RELOOP_ALLOW_DEMO_PRICES=1`. This is not a
market-price dataset or a Voloridge result. No real images are included yet.

## Live photo identification

Set `ANTHROPIC_API_KEY` and `RELOOP_VISION_MODEL` in your local shell before
starting the API. Choose a vision/tool-use model available in your account.
See `.env.example`; do not commit keys. There is no automatic `.env` loader.

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
Pydantic validation. Category enum is built from the book; invalid categories map
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
