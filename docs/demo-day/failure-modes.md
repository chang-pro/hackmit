# Failure modes — stage recovery in one sentence

Rule: do not debug in front of judges. Name the designed boundary, take one recovery action, and continue.

## 1. Stable URL is unavailable

**Symptom:** `/capture`, `/phone`, or `/api/health` does not load.

**Recovery:** keep the local server running, restart `npm run phone:tunnel`, and use the local-network URLs printed by the server only if both devices can reach them.

**Line:** “The wearable and inference pipeline are independent of the public signaling endpoint; I am reconnecting that endpoint now.”

## 2. Camera feed does not appear on the other device

**Symptom:** the phone shows a local preview, but the viewer remains idle.

**Recovery:** stop and start the phone/glasses feed once. The most recently started provider becomes active automatically.

**Line:** “The video is a direct WebRTC session, so I am replacing the peer session without restarting the analysis service.”

If campus NAT still blocks it, verify the configured TURN credentials before the slot. Do not copy IP addresses or use a new temporary tunnel on stage.

## 3. Vision is slow or the request quota is cooling down

**Symptom:** acquisition remains at a partial frame window or the prior result has cleared while the next event is being identified.

**Recovery:** hold the canonical scorebug steady and narrate the visible acquisition state. Do not repeatedly toggle Analyze; that resets the window.

**Line:** “We deliberately batch temporal evidence and cap calls at five per minute so one replay graphic cannot become a confident prediction.”

## 4. Sport is recognized, but the exact event is not

**Symptom:** the badge says `Sport template`, `checkpoint pending`, or no market comparison appears.

**Recovery:** return to a clean frame containing both primary participants, the competition, score, phase, and clock.

**Line:** “The system recognizes the sport but refuses to attach another event's historical facts until the identity and checkpoint are anchored.”

Never describe a sport-template result as an exact match.

## 5. The source switches events while an old prediction is visible

**Symptom:** the video changes before the next five-frame window completes.

**Recovery:** stop analysis, frame the new event, then start analysis. Video remains live while the result surface clears.

**Line:** “I am clearing the trusted state before the next event lock so context cannot leak between games.”

## 6. YOLO boxes are slow or absent

**Symptom:** the feed works, but the player overlay says WASM, unavailable, or shows few distant athletes.

**Recovery:** continue. YOLO is a local visual layer; event identification and prediction remain available through Cerebras.

**Line:** “Player tracking runs locally and independently from the scoreboard-to-market analysis.”

## 7. Projector clips the right rail

**Symptom:** the prediction context or research cards extend below a 720p projector viewport.

**Recovery:** use the tested browser zoom once; the prediction card has its own internal scroll. Do not resize individual panels on stage.

**Line:** keep presenting; do not discuss the projector.

## 8. A judge asks whether the market or web research is real

**Symptom:** “Is this live data?”

**Recovery:** point directly at `MOCK`, `Historical replay`, and `MOCK WEB`.

**Line:** “The camera recognition is live. For these historical clips, market prices and web research are precollected simulations and explicitly labeled; funding replaces those adapters with licensed live sources.”

## 9. Everything external fails

Open:

```text
https://capture.saicharanramineni.com/capture?demo=1&cycle=1
```

If the public endpoint is also down, use the equivalent localhost URL while `npm start` is running.

**Line:** “This is the quota-free rehearsal layer—same prediction workspace, with an explicit disclosure that camera detection and model calls are not being claimed.”
