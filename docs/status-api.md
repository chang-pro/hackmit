# Status page API

Everything the `/status` page needs comes from one read. Poll it every couple
of seconds; it never talks to muse or Facebook by itself, so it is cheap.

## `GET /api/status`

```jsonc
{
  "totals": {
    "listed": 31, "live": 29,
    "waiting_on_you": 14,     // drafted on Facebook, needs the owner to press Publish
    "conversations": 3,
    "unsent_replies": 1,      // the agent wrote an answer nobody has sent yet
    "sold": 2, "recovered_usd": 845
  },
  "listings": [{
    "id": "lst_1b4007e2", "title": "Unitree Quadruped Robot Dog",
    "listUsd": 2133, "status": "ACTIVE",        // ACTIVE | PENDING (price agreed, held) | SOLD
    "soldUsd": null, "photoUrl": "http://…/api/photos/pho_…",
    "goalMode": "CASH",                          // the button: CASH | CLEAR_OUT | ZERO_WASTE
    "shopify":     { "status": "live", "url": "https://…" },
    "marketplace": { "status": "drafted", "url": null },   // off | queued | drafted | live | sold | failed
    "threads": [{
      "id": "thr_ab12", "buyer": "Marcus T.", "channel": "facebook",   // facebook | agent
      "agreedUsd": null, "closed": false,
      "messages": [
        { "frm": "BUYER",  "priceUsd": 600, "text": "would u do 600 cash today?", "ts": "…" },
        { "frm": "SELLER", "priceUsd": 707, "text": "Sorry, I'm firm on this one. The best I can do is $707.", "sent": null }
        // sent: null = waiting for someone to press Send, false = muse could not send it, ISO time = delivered
      ]
    }]
  }],
  "tracker": { "autoReply": false, "watching": false, "checking": false,
               "last": { "at": "…", "error": null, "report": "muse's own words", "found": { … } } },
  "drafts": { … }               // the muse draft queue, same as GET /api/drafts
}
```

## Buttons

| Button | Call | What it does |
| --- | --- | --- |
| Check Facebook now | `POST /api/status/sync` | Asks muse where the listings stand and who wrote in (30-90 s). Returns `{ found, …status }`. Show a spinner while `tracker.checking`. |
| Send (on an unsent reply) | `POST /api/status/threads/:threadId/send` | muse delivers the agent's exact words to that buyer. `{ sent: true|false, note }` |
| Auto-reply toggle | `POST /api/status/auto-reply` `{ "on": true }` | The agent answers Facebook buyers without waiting for Send. |
| Keep checking | `POST /api/status/watch` `{ "on": true, "every_s": 120 }` | Re-checks Facebook on a timer. |

## How a reply is decided

The goal button sets how far below the list price the agent may go: Max cash
10%, Clear out fast 25%, Waste nothing 50%. Below that it says it is firm and
counters inside the limit. That number is never in any response, and neither
muse nor the model that reads muse's report is ever told it.

To demo it without Facebook, post a buyer message straight in:
`POST /api/listings/:id/messages` `{ "buyer": "Jake", "price_usd": 600, "text": "600 cash?" }`.
