# Architecture Decisions

Key decisions inferred from the code and README as of 2026-07-11, recorded in the style of `docs/decisions/0001-slice-boundaries.md` (which remains the authoritative ADR for slice ownership and the additive-change rule on shared files). Each entry: context, decision, consequences, and where to see it in code.

---

## D1. Zero-dependency Node runtime

**Context.** A hackathon build edited by multiple teammates and AI agents in parallel. Every dependency is an install step, a version conflict, and a supply-chain risk; the demo must run anywhere with `node` alone.

**Decision.** No runtime dependencies at all. `package.json` has no `dependencies` or `devDependencies`; the server uses `node:http`, tests use `node --test`, and ESM (`"type": "module"`) throughout. Even the Gemini and Polymarket integrations use the built-in `fetch`.

**Consequences.**
- `npm start` / `npm test` work on a fresh clone with zero install.
- No schema-validation library: the §7 contracts are enforced by hand-written normalizers and resolvers that throw on bad input, plus tests. The README's proposed `packages/contracts/` package doesn't exist.
- Hand-rolled pieces that a library would normally provide: JSON body reading with a size cap (`server.js readJsonBody`), the FNV-1a sampled hash (`selector.js`), and Gaussian CDF/inverse-CDF approximations (`services/probability/models/gaussian.js`).

**See:** `package.json`, `services/api/server.js`.

---

## D2. Fixture-first extraction seam (superseded for the live demo)

**Context.** Real scoreboard OCR (Slice 2) is the riskiest part of the build, but every other slice needs a working pipeline *now*, and the demo needs a deterministic bottom rung on the resilience ladder (README §13).

**Decision.** The deterministic `/api/comparison` path keeps the pluggable fixture extraction seam for model and contract tests. The live `/api/frames` path now uses `LiveEventAnalyzer` and the Cerebras Gemma backend to extract a universal multi-sport observation from real camera pixels; exact historical demo events then resolve through `services/demo/intelligence.js`. Payload provenance distinguishes live vision, historical packs, mock markets/research, and quota-free rehearsal.

**Consequences.**
- Every downstream component (normalize, resolver, reconciler, models, market, UI, iOS) was built and tested against realistic typed state before any OCR existed.
- Live frames are never silently replaced with NBA fixture state. If event or checkpoint evidence is insufficient, the live UI stays pending or uses a clearly labeled sport template.
- `scripts/evaluate-fixtures.js` still measures the legacy extraction seam; live four-clip acceptance additionally requires real teammate-footage rehearsal.

**See:** `services/api/live-event-analyzer.js`, `services/vision/backends/cerebras.js`, `services/demo/intelligence.js`, and `services/api/pipeline.js` for the legacy fixture path.

---

## D3. Mock-default market adapter

**Context.** The demo must work offline, in tests, and during the NBA off-season — when the recorded Gamma API queries for the demo matchup literally return `[]` (`packages/fixtures/market/`). Real market data must never be a prerequisite for running the pipeline, and mocked data must never masquerade as real.

**Decision.** A named-adapter registry (`services/market/index.js`) resolves the provider from `MARKET_PROVIDER`, **defaulting to `mock`**. Callers never import a provider file directly. The mock implements the same three operations as a real provider, stamps everything `is_mock: true`, and carries per-period `price_schedule` entries so historical replays show period-accurate prices instead of one static lie. Polymarket (public, no-auth Gamma API; chosen over Kalshi, whose useful reads need a key) is the first real sibling, with `NoMatchingMarketError` as a first-class, user-presentable outcome.

**Consequences.**
- Tests and offline demos never touch the network; the Polymarket adapter is tested by replaying real recorded responses via an injectable `fetchImpl`.
- The UI shows a persistent "Simulated market feed" banner whenever `is_mock` is true — the honest-fallback rule is enforced by the data shape, not discipline.
- The mock's optional `state` argument on `get_market_snapshot` slightly widens the adapter interface; real adapters ignore it.

**See:** `services/market/index.js`, `services/market/mock-adapter.js`, `services/market/polymarket-adapter.js`, `packages/fixtures/market/README.md`.

---

## D4. Brownian-motion (Stern 1994) probability baseline

**Context.** README §7.6: for a hackathon, "a small, explainable model with reliable inputs is better than a sophisticated model fed noisy state." No historical training data was in hand; the model must be deterministic, bounded, monotone in obvious scenarios, and defensible to judges.

**Decision.** Model the remaining scoring margin as Brownian motion: `P(win) = Phi((margin + drift) / (sd_per_sqrt_sec × sqrt(seconds_left)))`, with NBA constants (full-game margin sd 11.5 pts, home edge 2.5 pts) and an optional pregame prior that converts to an equivalent point spread via probit and *replaces* the home edge, decaying with time remaining. Output clamped to (0.001, 0.999) — the model never claims certainty. All constants, assumptions, and known limitations are recorded in `models/metadata/nba-win-probability-v1.json`, including an explicit `calibration.status: "not_calibrated"` and the CSV harness to fix that (`scripts/evaluate-model.js`).

**Consequences.**
- Closed-form, no training step, instantly explainable ("a lead is worth more as sqrt(time) shrinks").
- The same skeleton generalizes: NFL reuses it with different constants; soccer (Poisson goals), UFC (prior decay), and golf (stroke-lead diffusion) plug their own honest models into the same `winProbability(state, subjectId, options)` shape, sharing `phi/probit/clamp` from `models/gaussian.js`.
- Mid-range probabilities are the least trustworthy until calibration runs — documented, not hidden.

**See:** `services/probability/index.js`, `models/metadata/nba-win-probability-v1.json`, `services/probability/models/`.

---

## D5. Allowlisted fixtures — request params never touch the filesystem

**Context.** `GET /api/comparison?fixture=...` takes a client-controlled string that ultimately names a file. Interpolating it into a path invites traversal (`fixture=../../...`) and turns every committed file into an accidental API surface.

**Decision.** The server keeps an explicit allowlist (`KNOWN_FIXTURES` in `services/api/server.js`, currently `frame_000184` and `frame_000260`) and rejects anything else with a 400 listing the known values. Only allowlisted names are joined into a path. The same fail-loud posture runs through the stack: exact-match team aliases (no fuzzy matching), exact sport ids, unique-market-or-throw resolution, and a sport-tag assertion so a fixture can't be served under the wrong sport.

**Consequences.**
- No path traversal; adding a demo moment is a deliberate one-line server change (or, once the sports registry is wired into the server, driven by each sport's `fixtures` list).
- Multi-sport fixtures already committed to `packages/fixtures/frames/` are not reachable over HTTP yet — the visible cost of allowlisting during parallel slice development.

**See:** `services/api/server.js` (`KNOWN_FIXTURES`), `services/vision/resolver.js`, `services/api/pipeline.js` (sport-tag check).

---

## D6. Base64-JSON frame transport, in-memory only

**Context.** Frames arrive from wildly different sources (iPhone camera, browser webcam, future glasses bridge, replayed clips) and the backend is a zero-dep `node:http` server with no multipart parser. Privacy baseline (README §16): don't persist raw camera footage by default.

**Decision.** One transport for all sources: `POST /api/frames` with a JSON body carrying the image as a base64 string plus minimal metadata (`source`, `captured_at`, `width`, `height`). The gateway holds frames in a 30-slot in-memory ring buffer; `image_uri` is a `memory://` reference, never a disk path. The body cap is 8 MiB — sized for base64 1080p JPEGs. Disk persistence exists only as the opt-in `DatasetWriter` gated on `DATASET_DIR`.

**Consequences.**
- Trivial clients: browser `canvas.toDataURL` and iOS JPEG-encode both produce the payload in a few lines; JSON works through any proxy and needs no multipart handling.
- ~33% base64 size overhead and full-body buffering per frame — acceptable at ~1–2 fps, wrong for high-rate streaming (which is out of scope, README §5).
- The selector's duplicate check can cheaply hash the base64 string directly; privacy claims are structural (a process restart forgets everything).

**See:** `services/capture/gateway.js`, `services/api/server.js` (`handleFrameSubmission`, `MAX_BODY_BYTES`), `services/capture/dataset.js`.

---

## D7. Sports as data-only registry configs

**Context.** README §17.3 forbids widening sport scope until the primary NBA slice works — but the demo wants five sports, and naive multi-sport support would smear `if (sport === ...)` branches across the pipeline.

**Decision.** All sport-specific behavior lives in one config object per sport (`services/sports/<sport>.js`): gemini prompt + response schema, normalizer, alias table, probability model + demo options, reconciler invariants, and demo fixtures. `getSport(null)` returns NBA so every pre-registry call site behaves byte-for-byte as before; unknown ids throw. The pipeline stays sport-generic and reads only the config.

**Consequences.**
- Adding a sport = adding one config module + a normalizer + a model + fixtures; no orchestration edits.
- Sport differences that would otherwise be special cases become declarative rules: golf allows score decreases, soccer caps score jumps at 1, UFC has no score at all (null scores skip score invariants honestly).
- The registry is currently ahead of the HTTP layer: `server.js` doesn't take a `sport` param or serve `/api/sports` yet (in flight — see `docs/architecture/API.md`).

**See:** `services/sports/index.js`, `services/sports/nba.js` (the zero-behavior-change default), `services/vision/reconciler.js` (rule-configurable invariants).
