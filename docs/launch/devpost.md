# ReLoop — Devpost Submission

> Look at the game. See the probability.

## Inspiration

Prediction markets are powerful, but using one during a live game is a terrible experience. You're watching the fourth quarter, something big just happened, and now you have to pull out your phone, find the right contract, and mentally convert what you just saw into a probability — all while missing the next play.

We flipped it. The screen you're already watching **is** the input. Point Meta Ray-Ban glasses at the broadcast, and ReLoop reads the scoreboard, estimates the outcome with a deterministic probability model, pulls the market-implied probability from Polymarket, and whispers the comparison back — without you ever leaving the game.

The moment that sold us: Super Bowl LI. Atlanta up 28–3 in the third quarter. The market had all but called it. Anyone watching that game through ReLoop would have seen the model estimate and the market price diverge in real time as New England came back. That's the product in one sentence: **connecting what you can see to what the market believes.**

## What it does

1. You look at a live sports broadcast through camera-enabled glasses (or a phone/webcam stand-in).
2. Vision extracts structured game state from the scoreboard — teams, score, period, clock — as schema-constrained JSON, never prose.
3. A state reconciler enforces temporal invariants (scores don't decrease, clocks run down, no 14-point jumps from an OCR glitch) so replays and commercials can't poison the state.
4. A deterministic probability engine turns that state into a win probability.
5. A market adapter fetches the matching Polymarket contract's implied probability, timestamped.
6. A confidence-and-freshness gate decides whether the comparison is trustworthy enough to show.
7. The result is delivered as a glanceable card or a short spoken line: *"Boston 68%. Market 59%. Model is 9 points higher."*

**Five sports** run through one sport-generic pipeline via a sports registry: NBA, NFL, soccer, UFC, and golf — each with its own vision prompt, normalizer, alias table, reconciler invariants, and probability model.

**Famous-match demo moments** (clearly labeled as replays, per our product-language rules):

- 2022 World Cup Final, Argentina–France — 60' and 118' fixtures
- UFC 229
- Super Bowl LI — the Q3 8:31 "28–3 hole" and the Q4 0:57 "28–28 comeback"
- 2019 Masters, Tiger's final round
- NBA BOS–NYK — Q4 2:14 and Q4 0:30

**Plus:**

- A **SwiftUI iOS companion app** with a demo catalog for all five sports, live polling of `GET /api/comparison` every 5 seconds, camera streaming, and spoken output.
- A **judge-facing web debug view** (`apps/demo-web/index.html`), a live capture page, and a `/data` analytics dashboard.
- A **60-second hype film** rendered from HTML with HyperFrames (`apps/demo-video/out/bloomknights-demo.mp4`).
- A **vision-training data flywheel**: an opt-in `DatasetWriter` that pairs selector-accepted live frames with their reconciled state labels — off by default, writes nothing unless `DATASET_DIR` is explicitly set, and never invents a label.

## How we built it

**Zero-dependency Node ESM.** The entire backend — capture gateway, frame selector, vision, reconciler, probability, market, pipeline, HTTP server — is plain Node with `"type": "module"` and an empty dependency list. `npm start` runs the server; `node --test` runs the suite. Nothing to install, nothing to break on a judge's machine.

**Vision behind a pluggable seam.** The extraction backend is an interface with two implementations:

- `gemini.js` — sends the frame to Gemini 2.0 Flash with `responseMimeType: application/json` and a `responseSchema` mirroring our ParsedScoreboard contract, so the model must return typed fields with per-field confidences, not prose.
- `fixture.js` — a fully deterministic backend that reads committed fixture JSON. This is the bottom rung of the demo resilience ladder and what tests run on.

Both feed the same normalizer, so swapping the vision model touches one file.

**Deterministic, explainable probability models — one per sport:**

- **NBA & NFL:** Brownian-motion win probability (Stern 1994) — remaining margin is normal with sd proportional to √(seconds left), plus drift terms for home edge and pregame strength. Full-game margin sd ≈ 11.5 points (NBA), home edge 2.5.
- **Soccer:** Poisson goals baseline (~2.7 goals/90, home/away split). Draws are a first-class outcome — win probabilities deliberately don't sum to 1, and a shootout after a 120' draw is *not* counted as a win, which is honestly documented because markets that settle shootouts differently will price the same event differently.
- **UFC:** a prior-anchored model with a finish component that decays as rounds elapse and a decision component that doesn't. With a neutral prior it outputs exactly 0.5 forever — no fake confidence is ever invented from an unreadable fight.
- **Golf:** stroke lead vs. holes remaining between the top two on the visible leaderboard, ~0.45-stroke swing per hole.

Every model consumes canonical state only — never pixels — and is bounded, monotone-tested, and versioned in `models/metadata/`.

**Polymarket Gamma adapter with an honest mock fallback.** Provider-specific slug grammar, moneyline outcome mapping, and home/away ordering all live inside one adapter file. "No matching market" and "ambiguous market" are first-class typed errors with user-presentable safe messages — never a guess between candidate contracts. The mock adapter keeps every demo runnable offline, and every snapshot carries `is_mock` so replayed or mocked data is always labeled.

**iOS companion in SwiftUI.** DemoCatalog declares all five sports and their famous moments, an observable store polls the comparison endpoint, and a Speaker delivers the spoken line — the glasses-audio stand-in.

**Promo video from code.** The 60-second film is an HTML composition rendered deterministically with HyperFrames.

## Challenges we ran into

- **Single-frame OCR is a liar.** Replays, cuts, and camera shake produce garbage state. The fix was architectural: a reconciler that owns canonical state, requires consecutive-frame agreement for low-confidence updates, enforces sport-specific invariants, and retains the last trusted state instead of nulling out.
- **Market contract resolution is correctness, not plumbing.** Fuzzy team-text matching across broadcast labels, internal IDs, and Polymarket slugs is exactly how you show the price of the wrong game. We made ambiguity a hard error and required unique resolution before any comparison is shown.
- **Sports don't share a shape.** Basketball clocks count down, soccer clocks count up into stoppage, UFC has no score at all, golf has no clock at all. The sports registry pattern (one config object per sport, everything else sport-generic) is what let five sports fit one pipeline.
- **Being honest is a design constraint.** A model-market gap is *not* an expected return, and we gate, label, and phrase everything accordingly — which meant building the confidence/freshness gate and safe-fallback messages as real components, not disclaimers.

## Accomplishments we're proud of

- A complete camera-to-comparison pipeline with **zero runtime dependencies**.
- **Five sports, five documented probability models**, each with scenario tests (a 20-point lead with 30 seconds left is near-certain; swapping home/away flips the label; probabilities stay in [0,1]).
- A **real market integration** (Polymarket Gamma, public, no auth) with a mock fallback that keeps the entire demo reproducible offline.
- A **demo resilience ladder** with five rungs, from live glasses capture down to deterministic committed fixtures — every rung honest about what's live and what's replayed.
- Recreating three of the most famous probability swings in sports history — 28–3, the Argentina–France final, Tiger at the 2019 Masters — as labeled, replayable fixtures.
- Privacy by default: raw camera frames are never written to disk unless the operator explicitly opts in.

## What we learned

- **Structured extraction beats end-to-end video understanding** for reliability: give the vision model one narrow job (read the scoreboard into a schema) and put all the intelligence in deterministic code you can test.
- **A small explainable model with clean inputs beats a fancy model fed noisy state.** The Brownian baseline passes every sanity scenario and every judge can understand it in one sentence.
- **Adapters are how a hackathon project survives contact with hardware and providers.** Because capture, vision, and market are all seams, we could develop everything on fixtures and swap in the glasses, Gemini, and Polymarket without touching the pipeline.
- Honest product language ("model estimate vs. market-implied probability," never "guaranteed edge") isn't just compliance — it made the demo *more* convincing, because the system visibly declines to answer when its inputs are weak.

## What's next

- Live glasses capture as the primary rung (it's currently the top of the resilience ladder, developed against the hardware-agnostic capture gateway).
- Historical calibration of the NBA baseline with play-by-play data.
- The training-data flywheel at scale: every opted-in session produces labeled scoreboard frames, which trains a smaller, faster, on-device vision model — which makes sessions better, which produces more data.
- More broadcast scoreboard layouts per sport, then a second market provider behind the same adapter interface.
- Threshold notifications: only speak up when the model-market gap crosses a configured line.

**What ReLoop is not:** it does not execute trades, and it never claims a guaranteed edge. A displayed difference between the model estimate and the market-implied probability is a signal to inspect, not proof of profit. All famous-match demos are clearly labeled replays with mock market snapshots.

---

**Built with:** Node.js (zero-dependency ESM), Gemini 2.0 Flash (schema-constrained vision), Polymarket Gamma API, SwiftUI, HyperFrames.

**Run it:** `npm start`, open `http://localhost:3000`. Tests: `npm test`. Fixture evaluation: `npm run evaluate`.
