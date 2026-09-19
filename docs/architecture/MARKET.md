# Market (Lane C)

Everything here runs in the one Node server, `services/api/server.js`.

## One server

The team chose the Node pricer (`services/vision/backends/rightcodes-items.js`,
Gemini through right.codes) as the source of truth for identification and
prices. The Python Brain (`reloop_brain/`) is **not called at runtime**. Its
deterministic routing and tier rules are ported to `services/market/planner.js`
so there is one server and one price per item. If the Brain's rules change, port
the change there too.

Differences from the Python planner, because the Node pricer returns one
condition-adjusted `price_usd` per item instead of a price-book category:

- The band is derived from `price_usd` with a fixed 15% spread (`quick`/`max`
  rounded to $5); `basis` is the pricer's `price_basis`.
- Broken items always route to RECYCLE (there is no `e_waste` flag per category).
- The online listing minimum is one number, `RELOOP_MIN_LISTABLE_USD` (default $15).
- UPGRADE needs `upgradePriceUsd` in the goal (there is no book price to look up).

## Flow

```
POST /api/plans            items from the latest analysis (or body.items) + goal
  -> plan (public: decisions, reasons, listUsd, expectedUsd; never floors)
POST /api/plans/:id/approve  { location: {lat, lon}, categories: {itemId: name}, photo_urls: {itemId: [url]} }
  -> events: GOAL_SET, PLAN_APPROVED, IDENTIFIED/DONATED/RECYCLED per item
  -> every SELL item: a ReLoop store listing (live now) + a Marketplace draft (queued)
```

Two channels per SELL item:

1. **ReLoop store** — live on approval at `/catalog.json`. Our seller agent
   negotiates here with a floor enforced in code. This is the stage demo.
2. **Facebook Marketplace** — a draft built by muse.ai (reach). muse.ai builds
   a draft only and does not negotiate. A human publishes it, then reports it
   with `POST /api/listings/:id/marketplace { url }`, which appends `LISTED`.

### Photos, location, category

A Marketplace draft cannot go live without photos, a category and a lat/lon.

- **Photos:** planning from the live feed stores a copy of the analyzed frame
  and serves it at `/api/photos/:id`. muse.ai fetches it from the internet, so
  set `PUBLIC_BASE_URL` to the server's public (tunnel) URL. Per-item photos can
  be passed as `photo_urls` on approve instead.
- **Location:** send `location: { lat, lon }` on approve (the phone knows it).
  Without it, muse.ai is told to ask rather than guess, and the draft stalls.
- **Category:** optional `categories` per item; otherwise muse.ai picks one and says which.

### Draft queue

`services/market/draft-queue.js`. One muse.ai chat in one browser, so drafts run
strictly one at a time (up to 150 s each, one retry). `POST /api/listings/draft`
uses the same queue. `GET /api/drafts` shows it. Each finished draft appends
`DRAFTED`, or `DRAFT_FAILED` with the reason.

## Negotiation

`services/market/seller.js` — the seller agent's policy.

- The floor lives in a private field on `Market` and is never serialized; every
  public object is built from an explicit allowlist.
- Every counter is clamped to `[max(offer + 1, floor), min(list, lastCounter)]`;
  nothing below the floor is ever accepted.
- Offers at or above the expected price are accepted at once. Max 4 rounds; on
  the last one it accepts at or above the floor, otherwise rejects.
- Proposals are a deterministic concession schedule, so the policy is testable
  without an LLM. An LLM could write the reply text later; it would go through the same clamp.
- An accepted price puts a 10-minute hold on the listing for that thread (one
  hold per listing). `POST /api/listings/:id/checkout { thread_id }` completes it
  and appends `SOLD`. **Checkout is a mock: no payment is taken.**

Floors: the quick price (normal − 15%), a little lower for urgent goals
(clear-out, yard sale, or a deadline under 24 h).

### Buyer agent

```bash
npm run buyer -- "ps4"
```

`scripts/buyer.js` reads `/catalog.json`, asks the price, opens at 85% of list
and closes half the gap each round, then checks out. It uses only the public
API. Point it at another machine with `RELOOP_URL`.

## Live updates

- Dashboard: `/dashboard` (see [EVENTS.md](EVENTS.md)).
- Phone: `/phone` shows a live banner with the latest event and the running
  total, and speaks sales aloud (through the glasses when they are the audio route).
- iOS app (Lane A): subscribe to `GET /api/events/stream` (server-sent events)
  the same way.

## Routes

| Route | |
|---|---|
| `POST /api/plans` | `{ goal: { mode, targetUsd?, deadline?, upgradeTo?, upgradePriceUsd?, budgetUsd? }, keep_item_ids?, items? }` |
| `GET /api/plans/:id` | Public plan |
| `POST /api/plans/:id/approve` | `{ location?, categories?, photo_urls? }` → plan, listings, draft queue |
| `GET /api/drafts` | Draft queue |
| `GET /catalog.json` | Public catalog of unsold listings |
| `GET /api/listings/:id` | One listing |
| `POST /api/listings/:id/messages` | `{ thread_id?, buyer?, price_usd?, text? }` → `{ threadId, move, priceUsd, text }` |
| `POST /api/listings/:id/checkout` | `{ thread_id }` → SOLD (mock) |
| `POST /api/listings/:id/marketplace` | `{ url? }` → LISTED |
| `GET /api/photos/:id` | Stored listing photo |

## Not done yet

- State is in memory; a restart loses plans and listings (the event log can
  persist with `RELOOP_EVENTS_FILE`, the market cannot yet).
- No LLM buyer and no repricing worker; the buyer is scripted.
- Nothing detects that a Marketplace draft was published; a human reports it.
- Marketplace buyer messages are not handled; muse.ai does not negotiate.
