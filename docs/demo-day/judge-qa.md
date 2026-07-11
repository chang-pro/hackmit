# Judge Q&A — 15 hard questions, rehearsed answers

Rules: 2–3 sentences, then stop talking. Never bluff a number. The honest-fallback design is a strength — lead with it, don't apologize for it. Banned words: "guaranteed edge", "risk-free", "the market is wrong."

---

**1. What's your end-to-end latency?**
Our design budget is 2–5 seconds from a stable scoreboard change to a spoken answer, and every pipeline stage is instrumented so we know where the time goes — vision parsing is the fat part at 0.5–2s. Today's demo runs the vision stage on committed fixtures, so what you saw is the real pipeline minus real OCR time. We publish the budget in the README rather than claiming a measured number we don't have yet.

**2. Is that real computer vision, or staged?**
The capture path is real — glasses frames really stream to the server, get rate-limited and dedup'd — but scoreboard extraction currently reads a committed fixture, and the API literally labels it `extraction: "fixture_parse"` so nobody can mistake it. We built the whole system around one honest seam: when OCR lands, one function body changes and nothing else does. We'd rather show you a truthful pipeline than a faked demo.

**3. How accurate is the win-probability model?**
It's a small, explainable baseline — score margin, time left, period, home court — that passes hard sanity tests: up 20 with 30 seconds left prints near-certainty, a tie at tip-off prints near the prior. We deliberately shipped explainable-and-right-shaped before sophisticated, because a fancy model fed noisy vision state is worse than a simple one fed clean state. Calibration against historical play-by-play is the very next model milestone.

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
The reconciler enforces game invariants — scores don't decrease, the clock runs down, points arrive in 1s, 2s, and 3s — so an implausible frame is rejected and the last trusted state is kept. Our test suite covers exactly these cases: score jumps, low-confidence frames, decreasing scores. When it's genuinely unsure it says "scoreboard not clear enough yet" instead of guessing.

**13. You're pointing a camera at everything. Privacy?**
Frames are processed for the requested analysis and we avoid storing raw footage by default — we log structured state and latency, not images. Capture status is always visible to the wearer, and the committed fixtures are sanitized team-owned data. The glasses hardware itself carries Meta's recording indicator; we don't defeat any of that.

**14. The market number in your demo was mocked. Why should I believe the real integration works?**
Because the real one is in the repo: a Polymarket adapter with captured API responses committed as test fixtures — real event lookups, real contract resolution, real edge cases like a non-game market. We demoed on mock because a stage demo shouldn't depend on venue wifi, and our rule is that mock data is always labeled — you saw the amber banner. Honest fallback is a feature we designed, not a corner we cut.

**15. What did you actually build this weekend versus take off the shelf?**
Off the shelf: Node's standard library — the server has zero dependencies. Built: the capture gateway and frame selector, the state reconciler with its invariants, five sport-specific probability models, the market adapter layer with mock and Polymarket implementations, the confidence/freshness gate, both web UIs, an iOS companion, and 68 passing tests. The off-the-shelf part of this product is genuinely small.
