# Demo-day setup checklist

Work top to bottom. Every box is checkable without judges in the room. The whole point: by T-2 minutes, nothing on stage is being tried for the first time.

## T-60 min · Machine and server

- [ ] Laptop on wall power. Sleep/screensaver OFF. Notifications OFF (Windows Focus Assist / macOS Do Not Disturb).
- [ ] Fresh pull is NOT required — demo runs the tree you rehearsed. Do not `git pull` on demo day.
- [ ] `npm test` → expect **68 pass, 0 fail**. If anything fails, you changed something; revert it.
- [ ] Port 3000 free? Check first, never blanket-kill:
  - Windows: `Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue`
  - If taken by something you can't stop: run `PORT=3001 npm start` and use `:3001` in every tab. The server reads `PORT` from env (`services/api/server.js`).
- [ ] `npm start` → console prints `BloomKnights demo: http://localhost:3000 (webcam capture: /capture)`.
- [ ] Keep that terminal visible on a second monitor if you have one — it's your server heartbeat.

## T-45 min · Endpoint smoke test (the click gate)

Curl every moment you plan to click on stage. **A moment that doesn't return `"status": "ready"` here does not go in the show.**

- [ ] `curl http://localhost:3000/api/comparison?fixture=frame_000184` → ready, model ~0.878, gap +28.7
- [ ] `curl http://localhost:3000/api/comparison?fixture=frame_000260` → ready, model 0.999, gap +40.9
- [ ] Ending A gate: `curl "http://localhost:3000/api/comparison?sport=football&fixture=<sb51 id from the dashboard>"`
  - Returns 200 + ready → Ending A (Super Bowl LI flip) is GO.
  - Returns 400 (`unknown fixture`) → **Ending A is OFF. Use Ending B.** As of this writing the server allowlists only the two NBA fixtures; SB LI needs the multi-sport wiring merged first. Do not "hope" — this exact click on stage shows an error card.
- [ ] Known 404s that are fine to ignore: `/api/sports` and `/data` (dashboard falls back to its built-in catalog; the analytics page is not routed).

## T-30 min · Browser and tabs

- [ ] One browser window, exactly these tabs, in order:
  1. `http://localhost:3000/` — NBA tab, Q4 2:14 selected
  2. `http://localhost:3000/capture` — best working capture mode selected
  3. (Ending A only) second dashboard tab parked on Football / SB LI Q3
  4. `apps/demo-video/out/bloomknights-demo.mp4` — for looping BEFORE the slot and as emergency ending
- [ ] Close every other tab and window. Bookmark bar hidden. Full screen (F11) rehearsed once.
- [ ] Zoom: on the projector, set so the three big numbers + the lens preview fit without scrolling (usually 100–110%; check on the *actual* projector, not your screen — projectors are often 1280×720).
- [ ] The dashboard is dark-themed — ask for room lights near the screen to be dimmed if possible.
- [ ] Hard-refresh tab 1 once and confirm: numbers load, skeleton shimmer clears, status pill says **ready**, amber "Simulated market feed" banner shows.
- [ ] Offline venue note: the dashboard pulls Google Fonts (Outfit / JetBrains Mono) from the internet. No wifi → system fonts load instead. Purely cosmetic; do not panic, do not fix.

## T-20 min · Capture fallback chain (test ALL rungs, top down)

The demo NEVER dies — because every rung below was tested this hour, and the bottom rung needs no camera at all.

- [ ] **Rung 1 — Glasses stream:** Start a livestream from the Ray-Bans (Meta AI app / WhatsApp video call), open that stream on this laptop, then on `/capture` pick "Ray-Ban stream" → browser asks to share a screen/window → share the stream window. Counters tick: sent / accepted / skipped.
- [ ] **Rung 2 — Webcam at a screen:** second laptop (or phone) plays a game clip; this laptop's webcam points at it. `/capture` → webcam mode → counters tick. Position and focus the webcam NOW and tape it down.
- [ ] **Rung 3 — Clip replay:** a game-clip video file saved locally on the demo laptop (know the exact folder). `/capture` → clip replay → choose file → counters tick.
- [ ] **Rung 4 — Pure fixture:** close/ignore capture entirely. The dashboard's demo moments run on committed fixtures and need zero camera. This is the floor and it cannot break.
- [ ] Honesty check: whatever rung you use, the pipeline output labels extraction `fixture_parse` and mock market data `is_mock: true` with the amber banner. Never remove or hide the labels — they're a talking point, not a bug (see judge-qa.md).

## T-10 min · Audio

- [ ] System output = the venue speaker / HDMI audio, not the laptop's dead speaker. Volume ~80%.
- [ ] On the dashboard, click **Speak**. You must clearly hear "…estimated win probability is 88 percent…" from the back of the room.
- [ ] Speech is browser `speechSynthesis` — works offline, but voice choice depends on the OS. Whatever voice you hear now is what judges hear. If it's silent: check tab mute (right-click tab), check OS output device.
- [ ] Leave **auto-speak on update** UNCHECKED for the demo (you control when it talks; auto-speak mid-sentence steps on you).

## T-2 min · Final state

- [ ] Tab 1 front and center: NBA / Q4 2:14 / status **ready**.
- [ ] Server terminal shows no errors.
- [ ] Hype video looping until you're introduced, then Alt-Tab to tab 1.
- [ ] Phone on silent. Breathe. First line: "This is BloomKnights."

## Offline mode (no venue internet) — summary

- Market data: the **mock adapter is the default** (`MARKET_PROVIDER` unset → mock). Fully offline, deterministic, labeled with the amber banner. This is the recommended demo config even WITH internet — live Polymarket (`MARKET_PROVIDER=polymarket`) adds a network dependency for zero stage value.
- Fixtures, model, speech: all local. The only internet-touching things are Google Fonts (cosmetic) and Rung 1's glasses livestream (has 3 fallback rungs).
