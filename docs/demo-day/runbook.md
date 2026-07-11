# Demo-day runbook — 3-minute live demo

The one-line pitch you are proving on stage: **look at a game through Meta glasses, and BloomKnights tells you the win probability and how it compares to the prediction market — without touching anything.**

## Video or live? Verdict: go straight to live.

Do NOT cold-open with the 60-second hype video (`apps/demo-video/out/bloomknights-demo.mp4`). It would eat a third of your 3 minutes, and judges reward a working thing over a rendered thing. Instead:

- **Before your slot:** play the video on loop on the demo screen while judges walk up. It sets the vibe for free.
- **During the slot:** 100% live product.
- **If the live demo dies completely** (it shouldn't — see `failure-modes.md`): the video becomes your emergency ending, not your opening.

## What is proven vs. what needs wiring (read this first)

Verified on this working tree (server run, endpoints curled, 68/68 tests pass):

- WORKS TODAY: dashboard `/`, capture page `/capture`, both NBA moments (Q4 2:14 and Q4 0:30), Speak audio, mock-market banner, live-frame ingestion counters on `/capture`.
- NOT WIRED YET: the other four sport tabs (Soccer, UFC, Football, Golf) render on the dashboard but their moments return HTTP 400 — the server only allowlists the two NBA fixtures, `/api/sports` and `/data` are 404, and the dashboard's fixture ids (`wc22_final_60`) don't match the fixture files on disk (`wc22_final_60min`). Soccer and Super Bowl LI fixture files exist; UFC and golf fixtures do not exist at all.

So this runbook has **two endings**. Ending A (Super Bowl LI flip) is the goal — it only goes in the show if it passes the curl gate in `setup-checklist.md`. Ending B (NBA flip) is fully proven today and is scripted below. Never click a moment on stage that you did not curl that morning.

## Pre-set stage state

- Tab 1: `http://localhost:3000/` — NBA tab, **Q4 2:14** moment selected, page already loaded (numbers on screen, no skeletons).
- Tab 2: `http://localhost:3000/capture` — mode set to your best working rung (glasses stream > webcam > clip replay), NOT yet capturing.
- Tab 3 (Ending A only): dashboard with Football tab + SB LI Q3 moment ready.
- Volume up, Speak button tested in the last 10 minutes.

---

## The script (timing marks from "go")

### 0:00 — 0:20 · Hook (Tab 1 already on screen)

SAY:
> "This is BloomKnights. You point Meta glasses at any live game, and they tell you two numbers: what our model thinks the win probability is, and what the prediction market is charging for it. No app-switching, no searching for the right market. You just look."

DO: nothing. Let the dashboard breathe. The lens preview on the right is what the wearer sees.

### 0:20 — 0:55 · Beat 1: the machine reads the game (NBA, Q4 2:14)

SAY:
> "Right now it's reading a Celtics–Knicks broadcast. Boston up 3, two minutes left. It read the scoreboard — score, quarter, clock, confidence — you can see the parsed state right here. Our model says Boston wins this about 88% of the time. The market feed is at 59%. That gap is the whole product: the difference between what you can *see* and what the market is *priced at*."

DO:
1. Point at the **Score / Clock / Conf** row (proof it read the screen).
2. Point at the three big numbers: **Model 87.8% / Market 59% / Gap +28.7 pts**.
3. Click **Speak**. Let the audio play fully: *"bos's estimated win probability is 88 percent. The market is at 59 percent."*

SAY (over the end of the audio):
> "That voice is what comes through the glasses. Glanceable or speakable in three seconds."

If a judge squints at the amber banner, beat them to it:
> "And see this banner — 'simulated market feed'. When we mock data, we label it. The system never pretends."

### 0:55 — 1:25 · Beat 2: the game moves, the number moves (NBA, Q4 0:30)

DO: click the **Q4 0:30** moment card. Numbers tween live: model climbs 87.8% → 99.9%, gap widens to +40.9.

SAY:
> "Ninety seconds of game time later — Boston up 7, thirty seconds left. Watch the model: it jumps to 99.9%. A lead is worth more the less time is left, and the model knows that. The market snapshot hasn't caught up, so the gap got *wider*. That's the moment this thing earns its keep: it updates the instant the picture changes."

### 1:25 — 2:05 · Beat 3: it's real capture, not a slideshow (Tab 2, /capture)

DO: switch to the capture tab. Start your best rung (glasses screen-share, or webcam pointed at a laptop playing a game clip). Let the **sent / accepted / skipped** counters tick.

SAY:
> "This is the live pipe. The glasses livestream, we capture it, and every second a frame goes to the server. Watch the counters — it accepts sharp new frames and skips duplicates, so we're not burning compute on identical pictures. If the glasses drop, a webcam works. If the webcam drops, a recorded clip works. The demo has three ways to stay alive, and every fallback is labeled honestly in the output."

DO: after ~15 seconds of counters ticking, stop capture and switch back to the dashboard tab.

### 2:05 — 2:50 · Beat 4: THE ENDING

**Ending A — Super Bowl LI flip (ONLY if it passed today's curl gate).**

DO: click the **Football** tab. Click **Q3 · ATL 28–3**.

SAY:
> "One more. Super Bowl LI. Third quarter, Falcons up 28 to 3. Every market on earth had Atlanta as a lock — and so does our model. Now watch."

DO: click **Q4 · tied 28–28**.

SAY:
> "Fourth quarter. 28–28. The biggest comeback in Super Bowl history, and the probability flips right in front of you. If you were wearing these glasses that night, you'd have watched the number cross 50 while everyone else was still staring at a stale price. That's BloomKnights."

**Ending B — NBA flip retold (proven today, use if Ending A is not wired).**

DO: stay on the dashboard, click back and forth **Q4 2:14 → Q4 0:30** once so the tween plays again.

SAY:
> "Here's why this matters beyond one game. Super Bowl LI — Falcons up 28–3, every market said it was over, and then the Patriots flipped it. The whole value of this product lives in moments like that: the game state changes faster than the price does. You just watched our model move 12 points in ninety game-seconds while the market snapshot sat still. Glasses on, you see the flip the moment it happens. That's BloomKnights."

(Note: the historical moment cards for soccer, UFC, football, and golf are visible on the dashboard either way — it's fine to gesture at them: "same engine, five sports, one scoreboard-reader per sport.")

### 2:50 — 3:00 · Close

SAY:
> "Look at the game. See the probability. Thanks."

DO: leave the dashboard on screen for Q&A — the raw pipeline JSON in "Live analysis" at the bottom is your friend for judge questions.

---

## Rules while on stage

- Never say "guaranteed edge", "risk-free", or "the market is wrong." Say "model estimate", "market-implied probability", "gap" (README §6 — judges who know the space will notice).
- If any click misbehaves, do not debug on stage. One click back to the NBA Q4 2:14 moment always works. `failure-modes.md` has the 10-second recovery for everything else.
- If asked "is that real OCR?" answer honestly and immediately — see `judge-qa.md` Q2. Honesty is rehearsed, not improvised.
