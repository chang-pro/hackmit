# Judge Q&A — 15 hard questions, rehearsed answers

Rules: 2–3 sentences, then stop talking. Never bluff a number. The honest-fallback design is a strength — lead with it, don't apologize for it. Banned words: "guaranteed edge", "risk-free", "the market is wrong."

---

**1. What's your end-to-end latency?**
The phone captures a fast five-frame opening window in roughly four seconds, followed by the live Cerebras vision request; later windows are capped at one every 12 seconds to respect the five-request-per-minute limit. We expose acquisition, model, and cooldown state rather than claiming a latency number we have not measured end to end on this venue network.

**2. Is that real computer vision, or staged?**
In the primary demo, continuous video really comes from the phone or glasses over WebRTC, YOLO11s tracks players locally with WebGPU, and Cerebras Gemma reads five ordered camera frames into a strict event schema. The historical intelligence, market, and web-research layers are precollected for these four old games and are visibly labeled; the separate rehearsal URL also says when no camera or model call occurred.

**3. How accurate is the win-probability model?**
The live repository contains small, explainable sport-specific baselines with sanity and boundary tests, but these four historical demo probabilities are explicitly illustrative checkpoints rather than a claimed calibrated production model. The funded milestone is calibration against licensed play-by-play and market histories; today we prove the screen-to-state-to-market product loop without inventing a validation score.

**4. Isn't this just an API wrapper around Polymarket?**
Polymarket is one adapter behind an interface; the product is everything before the price arrives: reading the physical world into structured game state, reconciling noisy frames, estimating a probability, and refusing to speak when confidence is low. The market API is the easiest 5% of this system. Swap in Kalshi tomorrow and the product doesn't change.

**5. This helps people gamble. How do you think about that?**
We're an information layer, not an execution layer — trade execution is explicitly out of scope, and the UI language is policed: "model estimate," "gap," never "place this trade." The system also declines to show a number at all when its inputs are unreliable, which is the opposite of how gambling products behave. A production version would need age gates, jurisdiction checks, and responsible-use limits, and we've written that down before writing the trading code we don't have.

**6. How do you make money?**
Subscription for the intelligence layer — think "Bloomberg terminal for live events" at consumer price — plus affiliate/API partnerships with market venues who want engaged, informed order flow. We never need to touch custody or execution to get paid. Long-term, the structured live-state feed itself (screen → schema in seconds) is licensable data infrastructure.

**7. Why glasses? A phone app is easier.**
Because the input is your gaze: the glasses see exactly the screen you're watching, so there's zero search step — no "which game, which market, which contract." On a phone you look away from the game to get the answer, which destroys the moment; on glasses the answer arrives inside the moment. And the capture layer is hardware-agnostic, so a phone client is a fallback we already support, not a pivot.

**8. What's defensible here? Meta could do this next quarter.**
The defensible asset is the boring middle: per-sport scoreboard parsers, temporal reconciliation that survives replays and cuts, event-to-contract matching, and calibrated models per sport — a grind of edge cases, not one clever trick. Platforms build platforms; they historically let vertical apps own use cases like this. If Meta wants live-event probability in the lens, being the team that already solved broadcast-state extraction is exactly where you want to stand.

**9. What's the plan for training the vision model?**
Near term we don't train — we run OCR/multimodal extraction on a detected scoreboard crop, constrained to a JSON schema, evaluated against fixture frames with expected outputs already committed in the repo. Every user session generates labeled pairs (frame → reconciled state) that become fine-tuning data for a small specialized scoreboard model per broadcast layout. Narrow model, narrow job, measurable accuracy — not an end-to-end video foundation model.

**10. Does this violate Polymarket's terms of service?**
For the hackathon we read public market data and mostly demo on a labeled mock — no automated trading, no order flow, which is where ToS risk actually lives. The adapter pattern means compliance is a per-provider decision, and a real launch would be a partnership conversation, not a scrape: venues want distribution surfaces like this. We treat "can we legally show this price here" as a launch checklist item, and we haven't hand-waved it.

**11. What happens off-season, or when there's no market for the game I'm watching?**
The system requires a unique event-to-contract match before it compares anything; no market means it says so plainly instead of inventing a number — you still get the model's win probability, just no gap. That's a deliberate design: the confidence gate would rather show less than mislead. And five sports plus elections, awards shows, and esports on the same architecture means the calendar is never actually empty.

**12. What about replays, commercials, and cut-aways fooling the vision system?**
Gemma is prompted to prefer the persistent primary scorebug over tickers, replays, and studio graphics, while the router requires an exact event identity and an anchored score/phase/clock checkpoint before deterministic data appears. Ambiguous frames hold the last trusted checkpoint or show a pending state; they do not borrow a probability from the first famous game in that sport.

**13. You're pointing a camera at everything. Privacy?**
Frames are processed for the requested analysis and we avoid storing raw footage by default — we log structured state and latency, not images. Capture status is always visible to the wearer, and the committed fixtures are sanitized team-owned data. The glasses hardware itself carries Meta's recording indicator; we don't defeat any of that.

**14. The market number in your demo was mocked. Why should I believe the real integration works?**
The repository includes a Polymarket adapter, recorded provider payloads, unique event/contract matching, and tests for ambiguous and missing markets. We use labeled replay prices on stage because these games are historical and a funding demo should not depend on a currently listed contract; swapping the adapter does not change the camera, event, or comparison pipeline.

**15. What did you actually build this weekend versus take off the shelf?**
Off the shelf: Cerebras inference, ONNX Runtime WebGPU, YOLO weights, Meta's device SDK, Cloudflare signaling, and TURN. Built here: the capture and latest-provider flow, temporal model gating, universal event schema, exact-event/checkpoint router, four historical intelligence timelines, probability and market comparison contracts, mock-research experience, viewer, iOS companion, failure-safe rehearsal layer, and the repository's full passing test suite.
