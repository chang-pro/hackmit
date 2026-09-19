# muse.ai bridge

ReLoop identifies an item and prices it. This bridge hands that item to the
muse.ai agent, which is what actually creates and manages the Facebook
Marketplace listing. **Nothing in this directory touches Marketplace directly** —
it only talks to muse.ai.

muse.ai is behind auth and exposes no API we can call, so the only way in is the
session already logged in inside Chrome. We attach to that tab over the Chrome
DevTools Protocol.

## Setup

Chrome cannot have a debugging port attached to an already-running instance, so
it must be launched with the flag. **Quit Chrome completely first** (⌘Q — closing
the window is not enough), then:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome" &
```

Passing your normal `--user-data-dir` is what keeps you logged into muse.ai. A
fresh profile would come up signed out.

Confirm it worked:

```bash
curl -s http://127.0.0.1:9222/json/version
```

## Finding the selectors

A chat UI's markup moves without notice, so the selectors are configuration
rather than constants. With muse.ai open in that Chrome, run:

```bash
node -e "import('./services/muse/muse-agent.js').then(m=>m.probe()).then(r=>console.log(JSON.stringify(r,null,2)))"
```

It prints every text input and button on the page with its tag, role, test id,
placeholder, aria-label and classes. Pick the composer input, the send button
and the repeating message node, then set:

```bash
MUSE_INPUT_SELECTOR='...'
MUSE_SEND_SELECTOR='...'     # optional; omit to submit with Enter
MUSE_MESSAGE_SELECTOR='...'  # must match EVERY message bubble, not just the last
```

`MUSE_MESSAGE_SELECTOR` is the one that matters most: the reply is detected by
watching that node count grow past its pre-send value, then waiting for the last
node's text to stop changing. A selector matching only one element can never
report a new message.

## Usage

```js
import { publishListing } from "./services/muse/muse-agent.js";

await publishListing({
  id: "item_001",
  label: "Sony PS4 Slim",
  condition: "good",
  price_usd: 185,
});
```

The instruction states a hard price floor (85% of asking by default) and tells
muse.ai never to reveal it to a buyer. The floor is ours, not the buyer's.

## Known limits

- **Streaming replies.** `ask()` waits for the reply text to stay unchanged for
  `settleMs` before returning, so a slow stream is not truncated mid-sentence. A
  stream that never settles returns whatever arrived rather than throwing.
- **One tab, one conversation.** The bridge reuses the first tab whose URL
  matches `muse.ai`. If several are open it may not pick the one you expect.
- **No verification.** Whatever muse.ai says it did is taken at its word. The
  bridge does not independently confirm a listing exists.
