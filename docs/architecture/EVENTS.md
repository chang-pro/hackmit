# Event log and dashboard

The dashboard stores nothing. It is a fold over an append-only event log, so
replaying the log rebuilds the demo (plan v2, section 4). Every lane reports
what happened by appending an event; nobody asks another lane for state.

- Log: `services/events/event-log.js` (in memory; set `RELOOP_EVENTS_FILE` to
  also persist JSONL and replay it on restart)
- Fold: `services/events/dashboard-fold.js` (runs on the server and in the browser)
- Page: `apps/demo-web/dashboard.html`, served at `/dashboard`
- Demo events: `contracts/fixtures/events.json` (the plan's stage story:
  $300 goal, PS4 sold for $175, $125 left, agent still working on 5)

## Routes

| Route | What it does |
|---|---|
| `GET /api/events` | `{ events: Event[] }` |
| `POST /api/events` | Append one event. `201` with the stored event, `400` on an unknown `kind` or bad `amountUsd` |
| `GET /api/events/stream` | Server-sent events. First an `event: snapshot` with the whole log, then one `data:` message per new event. A `{ "kind": "RESET" }` message means the log was cleared |
| `POST /api/events/seed` | Replace the log with `contracts/fixtures/events.json` |
| `GET /api/dashboard` | The folded dashboard state as JSON |

## Event shape

```json
{ "kind": "SOLD", "itemId": "item_ps4", "label": "Sony PS4 Slim", "amountUsd": 175, "text": "Sold the PS4 for $175" }
```

The server adds `id` and `ts`. Optional fields: `itemId`, `listingId`, `label`,
`amountUsd` (whole dollars, 0 to 1,000,000), `text` (shown in the activity feed),
`url`, `source` (`PHONE` / `GLASSES` / `DOG`), `spot`, `mode`, `deadline`, `missionId`.
Cards are keyed by `itemId` (falling back to `listingId`), so use the same id
across every event for one item.

Kinds: `GOAL_SET`, `IDENTIFIED`, `PLAN_APPROVED`, `DRAFTED`, `LISTED`, `OFFER`,
`COUNTER`, `SOLD`, `DONATED`, `RECYCLED`, `REPRICED`, `DOG_STARTED`, `DOG_FOUND`, `DOG_DONE`.

A card's status only moves forward (approved → drafted → live → sold), so an
out-of-order event never demotes an item.

## What each lane needs to do

Already wired: `POST /api/listings/draft` appends a `DRAFTED` event on success.

- **C (Market):** when a Marketplace listing actually goes live or sells, append
  a `LISTED` or `SOLD` event through `POST /api/events`. Nothing does that yet,
  so after real drafts are created the cards stop at "Drafted".
- **A (App) / B (Brain):** append a `GOAL_SET` event when the user picks a goal
  (`mode`, and the target as `amountUsd`), and a `PLAN_APPROVED` event per item on
  Approve (`itemId`). An optional `PLAN_APPROVED` with no `itemId` and the plan's
  expected total as `amountUsd` records the expected value.
- **Contracts:** the Python contracts don't define an Event model yet. If the
  Brain API should share this format, it needs adding to `contracts/schema.py`.
