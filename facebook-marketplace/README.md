# Facebook Marketplace posting, via muse.ai

ReLoop identifies an item and prices it. This bridge hands that item to the
muse.ai agent, and **muse.ai is what creates and manages the Facebook
Marketplace listing**. Nothing in this directory touches Marketplace directly.

muse.ai is behind auth and exposes no API we can call, so the only way in is the
session already logged into a browser. We drive that browser over the Chrome
DevTools Protocol.

```
ReLoop identifies item ──▶ listingInstruction() ──▶ [CDP] ──▶ muse.ai chat ──▶ Facebook Marketplace
                                                                     │
                                          reply (listing + URL) ◀────┘
```

## One-time setup

### 1. Start the CDP Chrome

```bash
./scripts/start-cdp-chrome.sh
```

This is a **separate Chrome instance with its own profile** at
`~/.reloop/cdp-profile`. That is deliberate:

- your everyday Chrome keeps running, with your tabs
- the automation session is isolated from your normal browsing
- Chrome **cannot** have a debugging port attached to an already-running
  instance, so it has to be launched with the flag

The script is idempotent — if the port is already open it exits without
launching a second copy.

Verify:

```bash
curl -s http://127.0.0.1:9222/json/version
```

### 2. Log into muse.ai

The profile starts empty, so the first launch shows the logged-out landing page
(the giveaway: `probe()` reports zero text inputs and a "Log in" button). Log in
by hand in that window. The session persists in the profile, so this is once.

> `~/.reloop/cdp-profile` holds live session cookies. It is `chmod 700` and is
> gitignored. Never commit it, and never copy it to a shared machine.

### 3. Create the posting chat

All Marketplace posting goes through **one dedicated muse.ai chat**, so listing
traffic never lands in a personal thread. In muse.ai, create a new chat and name
it exactly:

```
Post items to Facebook Marketplace
```

Matching is case- and punctuation-insensitive; override with `MUSE_CHAT` if you
name it something else.

Confirm the bridge can find it:

```bash
node -e "
import('./facebook-marketplace/cdp.js').then(async ({CdpSession,findTarget}) => {
  const {selectChat} = await import('./facebook-marketplace/muse-agent.js');
  const cdp = await CdpSession.attach(await findTarget('muse.ai'));
  console.log('switched:', await selectChat(cdp));
  cdp.close();
})"
```

The bridge switches to this chat before every send and **refuses to send** if it
cannot get there. Every muse.ai chat shares the same URL (`https://muse.ai/`),
so the sidebar row is the only handle — a silent failure would post a
Marketplace listing into whatever personal thread happened to be open. The open
chat is identified by `aria-current="page"` on its sidebar row; the page header
is unreliable (it shows the agent's name, or nothing, depending on layout).

## Usage

Over HTTP, against the latest identified items:

```bash
curl -X POST http://localhost:3000/api/listings/draft \
  -H "Content-Type: application/json" \
  -d '{"item_id":"item_001","location":{"lat":28.60,"lon":-81.20}}'
```

An `item_id` is resolved against the latest analysis, so the caller never echoes
a price back and cannot list a stale one. Pass a full `item` object instead when
driving it outside the live pipeline.

Or directly:

```js
import { draftListing } from "./facebook-marketplace/muse-agent.js";

await draftListing(
  { id: "item_001", label: "Sony PS4 Slim", condition: "good", price_usd: 185 },
  { photoUrls: ["https://…/ps4.jpg"], location: { lat: 28.60, lon: -81.20 } }
);
```

### What the agent actually does — asked directly, 2026-09-19

It **builds a draft and stops**. It does not publish. Verified end to end: the
call above produced a real draft with a listing ID and a
`facebook.com/marketplace/item/…` URL, not live.

| It will | It will not |
|---|---|
| Build a draft from title, condition, price | Publish anything — that needs your tap, every time |
| Add photos, category, location when given | Invent a location |
| Edit, delete, or publish a draft later on request | Message buyers, haggle, or manage a live listing |

Two consequences the code reflects:

- The function is called **`draftListing`, not `publishListing`**. Naming it
  "publish" would misdescribe what happens and set the wrong expectation.
- **No negotiation instruction is sent.** The agent has said it will not haggle,
  so telling it a price floor would be theatre. The floor is still returned on
  the result (`floor_usd`, 85% of asking) for whatever handles negotiation
  later.

### A listing cannot go live without

- **Photos.** Not optional. Missing photos are reported as the blocker.
- **Location as lat/lon.** Facebook needs coordinates; a typed city name is not
  enough. The instruction explicitly tells the agent **not to guess one**, so a
  missing location stalls the draft on a question rather than going live
  somewhere wrong.
- **Category.** The agent picks the closest fit and says which it chose.

## Recording a browser flow

Guessing selectors from a DOM dump is slow and wrong. Do the flow by hand and
read back what you touched:

```bash
node facebook-marketplace/record.js recording.json 120   # record for 120s
```

It writes raw `events` and a replayable `steps` list. Notes:

- It records on `change`, not `input`, so you get one entry per field when you
  leave it rather than one per keystroke.
- Password fields and anything matching `pass|secret|token|card|cvv` are
  recorded as `***REDACTED***`.
- Selectors prefer `data-testid`, then `aria-label`, then `id`, and only fall
  back to `nth-child` position — so a recording survives a re-render.
- Real pauses over 400ms are preserved as `wait` steps. A flow that works by
  hand usually fails when replayed with no waits.

## Re-finding the selectors

muse.ai is a Tailwind app with no stable test ids on chat bubbles, so the
selectors are **class-based and will break** when the markup changes. When that
happens:

```bash
node -e "import('./facebook-marketplace/muse-agent.js').then(m=>m.probe()).then(r=>console.log(JSON.stringify(r,null,2)))"
```

Known good as of 2026-09-19:

| Purpose | Selector |
|---|---|
| composer | `textarea[aria-label="Message"]` |
| agent reply bubbles | `.hatch-chat-groupable-bubble:not(.bg-chat-user-bubble)` |
| your own bubbles | `.bg-chat-user-bubble` |
| chat sidebar rows | `[data-testid="hatch-thread-row"]` |
| send | none — Enter submits |

Override any of them with `MUSE_INPUT_SELECTOR`, `MUSE_MESSAGE_SELECTOR`,
`MUSE_SEND_SELECTOR`.

The reply selector **excludes your own bubble on purpose**. Matching every
bubble makes reply detection return the echo of what was just sent.

## Things that will bite you

- **`el.value = "..."` does not work.** A React-backed composer ignores a value
  assignment that fires no key events — the box looks filled and submits empty.
  Typing goes through `Input.insertText`.
- **Backgrounded tabs get throttled.** Chrome slows timers in background
  renderers, and `Runtime.evaluate` times out whenever the window is not in
  front. `start-cdp-chrome.sh` passes `--disable-background-timer-throttling`,
  `--disable-renderer-backgrounding` and
  `--disable-backgrounding-occluded-windows` to prevent it. If you launch Chrome
  by hand without those flags, the bridge only works while you are looking at it.
- **A reply is detected by waiting for it to settle**, not by grabbing the first
  text that appears, so a streaming answer is not truncated mid-sentence. A
  stream that never settles returns whatever arrived rather than throwing.
- **No verification.** Whatever muse.ai says it did is taken at its word. The
  bridge does not open Facebook to confirm the draft exists.
- **Escaping in injected page scripts.** Page-side code is built as a JS
  template literal, so a `\n` inside it becomes a real newline and produces
  `SyntaxError: Invalid or unexpected token` in the page. Write `\\n`.
- **It posts under the personal Facebook account, not a throwaway.** The agent
  told us this unprompted: the integration is bound to whichever account is
  connected in muse.ai, and it is the personal one. So the "just use a burner"
  mitigation does not apply unless that account is reconnected inside muse.ai
  first.
- **Account risk.** Automating Marketplace can get a Facebook account
  restricted. If that account is also the Meta account your glasses developer
  registration is tied to, a flag costs you the glasses demo too. Since drafts
  never auto-publish, the exposure is smaller than it would be for a fully
  autonomous poster — but it is not zero.
