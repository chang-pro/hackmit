# Failure modes — top 8 breaks and the 10-second recovery

Golden rule on stage: **never debug in front of judges.** Every recovery here is one sentence + one click. If a recovery takes longer than 10 seconds, drop a rung and keep talking.

Universal safety net: the dashboard's NBA demo moments run on committed fixtures with the mock market adapter — no camera, no internet, no external service. As long as `node` runs on the laptop, the demo has a floor.

---

## 1. Port 3000 is taken when you start the server

**Symptom:** `npm start` errors with `EADDRINUSE`.
**Recovery (10s):** `PORT=3001 npm start`, then use `:3001` in the tabs. Do NOT kill whatever owns 3000 — you don't know what it is, and you don't have time to find out.
**Prevent:** T-60 port check in the setup checklist.

## 2. Server crashes or wasn't started — dashboard shows "API OFFLINE"

**Symptom:** red dot in the top bar, lens says "Pipeline unreachable."
**Recovery (10s):** Alt-Tab to the terminal, `npm start`, say "one second — cold start." The dashboard polls every 5 seconds and recovers by itself; no refresh needed.
**Prevent:** keep the server terminal visible; it prints one startup line and then stays quiet.

## 3. Glasses livestream dies mid-demo (Rung 1 fails)

**Symptom:** shared window freezes or the browser fires "stop sharing"; capture counters stop.
**Recovery (10s):** on `/capture`, click **Webcam** mode → Connect. The webcam is already taped in position pointing at the clip laptop (you did this at T-20). Line: "Glasses, webcam, recording — the pipeline doesn't care where frames come from. That's the point."
**Prevent:** fully charged glasses, phone hotspot pre-joined, stream started fresh within 10 minutes of the slot.

## 4. Webcam denied or missing (Rung 2 fails)

**Symptom:** permission popup denied, or `getUserMedia` errors on the venue machine.
**Recovery (10s):** click **Clip replay** mode → choose the local game clip file (you know the folder) → play. Same counters, same pipeline. If even that fumbles, skip Beat 3 entirely and return to the dashboard — the demo moments never needed a camera.
**Prevent:** grant camera permission for localhost during T-20 testing; keep the clip file on the desktop.

## 5. Vision recognizes the sport but not the exact event pack

**Symptom:** the evidence badge says `Sport template` instead of `Historical replay`.
**Recovery (10s):** switch the source screen to the matching canonical clip. Line: "The sport is recognized, but we refuse to attach another game's facts. Let me use the event this evidence pack belongs to." Continue when the exact pack appears.
**Prevent:** use the four clip identities in `runbook.md`, verify them with the pack catalog, and rehearse each event switch before the slot.

## 6. Speak button makes no sound

**Symptom:** click Speak, silence.
**Recovery (10s):** read the lens line out loud yourself, verbatim, in a robot-ish deadpan: "Boston's estimated win probability is 88 percent. The market is at 59 percent." It gets a laugh and loses nothing. Then check tab-mute (right-click the tab) during the next beat, not now.
**Prevent:** T-10 audio check on the actual venue output; auto-speak left OFF so nothing competes with you.

## 7. Projector/layout looks wrong — numbers cut off, fonts ugly, page cramped

**Symptom:** projector is 720p and the three metrics don't fit; or no wifi so Google Fonts fell back to system fonts.
**Recovery (10s):** Ctrl+Minus once or twice until the compare panel and lens fit; keep talking — never mention fonts, nobody but you can tell.
**Prevent:** T-30 zoom check on the real projector, F11 full-screen rehearsed.

## 8. A judge challenges the amber "Simulated market feed" banner or a stale/low-confidence status pill

**Symptom:** "Wait, is any of this real?" — or the status pill shows `stale_market` / `low_confidence` instead of `ready`.
**Recovery (10s):** this is not a failure, it's the designed behavior — say: "Exactly — when data is mocked or unreliable, the system labels it or refuses to show a number. A product that whispers probabilities in your ear has to earn trust, so it never bluffs. Neither do we." Then continue.
**Prevent:** nothing to prevent. Rehearse the line until it sounds like you planned the question. (You did — it's judge-qa.md Q2 and Q14.)
