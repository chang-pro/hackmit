# Demo-day runbook — camera-guided four-stream theater

The one-line claim this demo proves:

> Look at a game through Meta glasses. ReLoop identifies the exact broadcast and moment, replaces the camera view with its synchronized local stream, and shows the model probability beside the prediction-market probability without a search or sport picker.

## Canonical stage setup

Run the named tunnel connector:

```bash
npm run phone:tunnel
```

Open:

- Desktop viewer: `http://localhost:3000/capture`
- Phone/glasses fallback: `https://capture.saicharanramineni.com/phone`

The desktop uses localhost so the large predownloaded MP4s remain on the laptop. The phone still uses the stable public endpoint for page delivery, signaling, and sparse analysis frames.

Install and calibrate these exact files:

1. `wc22_final_arg_fra__soccer_2022_12_18.mp4` — Argentina vs France.
2. `nba_bos_nyk__celtics_at_knicks_2026.mp4` — Celtics at Knicks, April 9, 2026.
3. `sb51_ne_atl__football_2017_02_05.mp4` — Patriots vs Falcons.
4. `ufc229_khabib_mcgregor__ufc_2018_10_06.mp4` — Khabib Nurmagomedov vs Conor McGregor.

The compressed files are committed under `demo-footage/`; `DEMO_STREAMS_DIR` can override that location. Their exact hashes, durations, and offsets live in `packages/fixtures/demo-streams/manifest.json`. Never infer file time from the game clock and never attach one event's facts to another edit.

## Preflight gate

Run:

```bash
npm test
curl -fsS https://capture.saicharanramineni.com/api/health | jq .
curl -fsS http://localhost:3000/api/demo/streams | jq .
curl -fsS http://localhost:3000/api/playback | jq .
```

Pass criteria:

- All tests pass.
- Health reports `vision.selected: "cerebras"`, no vision error, four intelligence packs, and four ready demo streams.
- Every stream reports `file_available: true`, `calibration_complete: true`, and `ready: true`; the World Cup edit separately reports `coverage_status: "partial"` and two omitted checkpoints.
- Phone and viewer establish the camera detector preview on separate devices.
- Pressing **Analyze** fills the first five-frame window.
- Exact footage produces `Historical replay`, then crossfades to its local MP4.
- `/api/playback.revision` increments once per changed game and never for a later detection from the same game.
- The probability tile shows Model, Market, Gap, and `MOCK`.

## Three-minute stage sequence

### 0:00–0:20 — Hook

Show the camera detector preview before analysis.

Say:

> “Prediction markets know their contracts, but they do not know what I am looking at. I look at a broadcast, ReLoop identifies the exact moment, and then the clean broadcast takes over automatically.”

### 0:20–1:05 — World Cup recognition and handoff

Show the calibrated Argentina–France checkpoint to the phone/glasses, then press **Analyze**.

Point to the stages:

1. Camera detector connected.
2. Five-frame temporal window collected.
3. Soccer, both teams, and the World Cup Final detected.
4. The exact checkpoint resolved.
5. The local World Cup MP4 loaded, sought once, and replaced the camera view.
6. Historical prediction, mock market, and research pack loaded.

Say:

> “There was no sport selector. The model recognized the World Cup Final and this checkpoint, then the clean local broadcast replaced the camera view. From here it plays normally; later detections from this same game cannot restart it.”

### 1:05–1:40 — Automatic NBA switch

Change only the source screen seen by the glasses to the Celtics–Knicks clip.

On the next model window, playback revision increments once and the NBA file replaces the World Cup file. Point to `What changed` and `Next trigger`.

Say:

> “I changed what I was watching, not a setting. A new exact event creates one new playback command; repeated NBA observations only update the analysis.”

### 1:40–2:15 — Super Bowl

Switch the source to the chosen calibrated Super Bowl checkpoint. Do not scrub the source again after lock: same-stream detections deliberately never reseek the local playback.

Say:

> “The old stream remains stable until the model proves which new stream and moment should replace it. That prevents noisy scorebugs and replay graphics from jerking the player around.”

### 2:15–2:40 — UFC proves the abstraction

Switch to the calibrated UFC 229 checkpoint.

Say:

> “There is no basketball-style score here. The system uses fighter identity, round, clock, and visibly supported control context, then selects the UFC file through the same playback contract.”

The canonical finish is `1:57 remaining` in round four. A visibly resolved submission must show the historical 100% terminal result.

### 2:40–3:00 — Close

Say:

> “Four broadcasts. No picker. No search. The camera identifies what I chose, then gets out of the way so the clean stream and its probability take over. Look at the game. See the probability.”

## Operator rules

- Analysis stays off until the source scorebug is framed.
- Use Chrome or Edge on the desktop.
- Keep both primary participants, score, phase, and clock readable.
- Never remove `Historical replay`, `Sport template`, or `MOCK` labels.
- Never call the gap guaranteed profit or say the market is wrong.
- `/api/latest` is live analyzed insight only.
- `/api/playback` is authoritative: the same `(epoch, revision)` means never reload or seek.
- Stopping analysis or losing the detector must not stop a locked local replay.

## Fallback ladder

1. Meta glasses → native companion → local viewer.
2. Phone browser → local viewer.
3. Another calibrated checkpoint from the four installed MP4s.
4. `/capture?demo=1&cycle=1` for an explicitly labeled, quota-free rehearsal. It does not claim camera recognition, local-file synchronization, live search, or model calls.
5. Dashboard deterministic fixtures for Q&A.

The first three paths prove automatic event and playback selection. The remaining paths are honest recovery tools.
