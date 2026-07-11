# Demo-day runbook — four-stream funding demo

The one-line claim this demo proves:

> Look at a game through Meta glasses. BloomKnights identifies it, retrieves the matching event intelligence, and shows the model probability beside the prediction-market probability without a search or sport picker.

## Canonical stage setup

Run the named tunnel connector:

```bash
npm run phone:tunnel
```

Open these stable pages:

- Viewer: `https://capture.saicharanramineni.com/capture`
- Phone fallback: `https://capture.saicharanramineni.com/phone`

Use current Chrome or Edge for the viewer so YOLO uses WebGPU. The live-vision tile must eventually read `YOLO11s WebGPU`; Safari intentionally falls back to WASM.

Prepare the four teammate clips in this order:

1. 2022 World Cup Final — Argentina vs France.
2. 2016 NBA Finals Game 7 — Cavaliers vs Warriors.
3. Super Bowl LI — Patriots vs Falcons.
4. UFC 229 — Khabib Nurmagomedov vs Conor McGregor.

Those identities match the committed intelligence packs. If the extracted footage differs, update the matching JSON under `packages/fixtures/demo-intelligence/` before stage day; never silently attach one event's facts to another.

## Preflight gate

Run:

```bash
npm test
curl -fsS https://capture.saicharanramineni.com/api/health
curl -fsS https://capture.saicharanramineni.com/api/demo/intelligence
```

Pass criteria:

- All tests pass.
- Health reports `vision.selected: "cerebras"`, `vision.error: null`, and `demo_intelligence_packs: 4`.
- The pack catalog contains World Cup, NBA Finals, Super Bowl, and UFC.
- Phone and viewer establish video on separate devices.
- Pressing **Analyze** shows `Capturing temporal evidence · 1/5`; the first five-frame burst takes roughly four seconds before model latency.
- Exact target footage produces `Historical replay`, not `Sport template`.
- The probability tile shows Model, Market, Gap, and `MOCK`.

## Three-minute stage sequence

### 0:00–0:20 — Hook

Show the live viewer before analysis.

Say:

> “Prediction markets know their contracts, but they do not know what I am looking at. BloomKnights starts with the physical world. I look at a broadcast and it finds the event, state, and relevant market for me.”

### 0:20–1:05 — World Cup recognition

Play the Argentina–France clip, start the phone/glasses feed, then press **Analyze**.

Point to the right rail as it progresses:

1. Direct camera connected.
2. Five-frame temporal window collected.
3. Soccer and the World Cup Final detected.
4. Official timeline, state model, and replay market cache loaded.

When the result appears, point to Model / Market / Gap and say:

> “The vision model did not receive a sport selector. It recognized the World Cup Final, found the matching historical intelligence pack, and priced the visible state. The market value is a clearly labeled replay simulation—we are demonstrating the product loop, not pretending this old game is trading live.”

### 1:05–1:40 — Automatic NBA switch

Switch the source screen to 2016 Finals Game 7. Do not touch BloomKnights.

Say:

> “Now I only change what I am watching.”

On the next model window, the UI should show basketball detected and an event switch. At the 89–89 or 92–89 checkpoint, explain `What changed` and `Next trigger`.

### 1:40–2:15 — Super Bowl probability swing

Switch to Super Bowl LI at 28–3, then scrub or cut to 28–28.

Say:

> “This is where a visual probability layer becomes visceral. The same event moves from a three-percent comeback tail to essentially a coin flip because the score and clock changed—not because somebody searched for another market.”

The monotonic replay cursor prevents a noisy old graphic from rewinding the analysis after the later checkpoint is reached.

### 2:15–2:40 — UFC proves the abstraction

Switch to UFC 229.

Say:

> “The state representation changes with the sport. There is no basketball-style score here, so the system uses fighter identity, round, clock, and visibly supported control context. It does not invent judge scores or damage.”

The canonical terminal clock is `1:57 remaining`; `3:03` is elapsed time. Once the submission is visibly resolved, the historical checkpoint must show a closed 100% result rather than a pre-finish estimate.

### 2:40–3:00 — Close

Say:

> “Four broadcasts. No picker. No search. One interface from visible reality to a market question. With funding, the precollected replay layer becomes a live data and market infrastructure layer. Look at the game. See the probability.”

## Operator rules

- Analysis stays off until the clip is framed and ready.
- Use Chrome or Edge on the viewer.
- Keep the scoreboard unobstructed and large enough to read.
- Never remove `Historical replay`, `Sport template`, or `MOCK` labels.
- Never call the gap guaranteed profit or say the market is wrong.
- If the exact pack does not match, the UI will say `Sport template`; explain it honestly or switch to the correct clip.
- `/api/latest` contains live analyzed insight only and never silently changes to an NBA fixture.

## Fallback ladder

1. Meta glasses → native companion → viewer.
2. Phone browser → viewer.
3. Prerecorded clip displayed to either camera source.
4. `/capture?demo=1&cycle=1` for a quota-free, explicitly labeled rehearsal of the
   prediction, market, evidence, and mock-web-research UI. It does not claim
   camera detection or model calls.
5. `/capture?demo=1` for local video/UI proof only.
6. Dashboard deterministic fixture moments for Q&A.

The first three paths prove automatic event detection. The remaining paths are honest recovery tools, not substitutes for the primary demo.
