# BloomKnights demo script

Judge-facing demo plan per README §13. Language rules per README §6 apply
throughout: say "model estimate", "market-implied probability", and
"model-market gap" — never "guaranteed edge", "risk-free", or "the market is
wrong". A displayed difference is a signal to inspect, not proof of profit.

## Primary live demo (8 steps)

1. Show the selected NBA broadcast (BOS @ NYK) on a television or laptop.
2. Show the glasses or camera view in the debug interface (`npm start`, open
   `http://localhost:3000`).
3. Point at the scoreboard and let BloomKnights identify the game.
4. Display the structured state to prove the system read the screen — the
   "Game state" card and the raw pipeline JSON at the bottom of the debug view.
5. Display or speak the model probability — press "🔊 Speak" (or enable
   auto-speak) to deliver `presentation.spoken_text`, the glasses-audio
   stand-in per README §7.10.
6. Fetch and display the market-implied probability.
7. Highlight the difference and data freshness ("Model-market gap" card and
   `market age` readout).
8. Move to a later moment in the game and show the estimate update — click
   the "Q4 0:30" demo-moment button. The model estimate for Boston rises
   (a lead is more valuable as time expires) while the state card shows the
   later score and clock.

Demo moments available in the debug view:

| Moment | Fixture | State | What to say |
|---|---|---|---|
| Q4 2:14 | `frame_000184` | BOS 104–NYK 101 | "Up 3 with two minutes left — the model estimate is well above a coin flip, but the game is live." |
| Q4 0:30 | `frame_000260` | BOS 112–NYK 105 | "Up 7 with 30 seconds left — the model estimate is now near certainty, and the gap versus the market snapshot has widened." |

Each demo moment is processed as an independent observation (fresh
reconciler): the state reconciler's consecutive-frame invariants apply within
a moment, not across the minutes of game time between them.

## Recommended spoken narrative

> Prediction markets know their contracts, but they do not know what I am
> looking at. BloomKnights connects the physical event to the market. The
> glasses read the visible game state, our model estimates the outcome, and we
> compare it with the market in real time. I never have to search for the game
> or leave the broadcast.

## Pre-demo checklist: resilience ladder

Prepare every rung before presenting. If a rung fails mid-demo, drop to the
next one without apology — each is a working product path.

- [ ] 1. Live glasses capture with live market data.
- [ ] 2. Webcam or phone capture with live market data.
- [ ] 3. Prerecorded broadcast clip with live market data.
- [ ] 4. Prerecorded clip with timestamped mock market data.
- [ ] 5. Saved frames with deterministic expected outputs
      (`packages/fixtures/` — this rung is what the committed demo runs on
      today, and it is verified by `npm test`).

## Honest-fallback rule

Fallbacks must remain honest. Mocked or replayed market data is **always
labeled**: the mock adapter stamps every snapshot `is_mock: true`, and the
debug view shows a persistent amber "MOCK MARKET DATA" banner whenever it is
present. Never present mock values as live, and never remove the label to make
a rung look higher than it is. If asked, say plainly which rung the demo is
running on.
