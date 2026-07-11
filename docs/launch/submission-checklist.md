# BloomKnights — Hackathon Submission Checklist

Fill every `[ ]` and `TODO:` before the deadline. Honesty rail (README §6) applies to everything judge-facing: "model estimate" vs. "market-implied probability," historical demos labeled as replays, never "guaranteed profit."

## Core links

- [ ] **Demo video link:** `TODO: <YouTube/Vimeo URL>` (60s hype film source: `apps/demo-video/out/bloomknights-demo.mp4` — upload, set public/unlisted, verify it plays logged out)
- [ ] **Repo link:** `TODO: <GitHub URL>` — confirm repo is public and README renders
- [ ] **Live/demo URL (if hosted):** `TODO: <URL>` or note "run locally: `npm start` → http://localhost:3000"
- [ ] **Devpost project page:** paste `docs/launch/devpost.md` sections into the matching Devpost fields

## Video requirements (check the event's exact rules)

- [ ] Under the max length (typically 2–3 min; our hype film is 60s — record a screen walkthrough if a longer demo video is required)
- [ ] Shows the actual product working (debug view at `apps/demo-web/index.html`, iOS app, or capture page)
- [ ] Includes the Super Bowl LI 28–3 → 28–28 demo moment beat
- [ ] On-screen or spoken label that famous-match demos are **replays with mock market snapshots**
- [ ] No "guaranteed profit" / "beat the market" language anywhere in the video
- [ ] Audio is clear; captions if required

## Category / prize track picks

- [ ] Primary track: `TODO: (e.g. Best Use of Meta Ray-Ban / Wearables)`
- [ ] Sponsor prizes to opt into: `TODO:` (candidates based on real stack: Gemini/Google AI prize — schema-constrained vision backend; Polymarket/prediction-market prize — Gamma adapter; Best Mobile — SwiftUI companion)
- [ ] Confirm eligibility rules for each track (some require using the sponsor's API in a core path — ours are core paths, cite the files: `services/vision/backends/gemini.js`, `services/market/polymarket-adapter.js`)

## Team info

- [ ] Team name: **BloomKnights** (confirm not taken on the platform)
- [ ] Members + emails: `TODO:`
- [ ] Devpost profiles linked for every member: `TODO:`
- [ ] Roles blurb (suggested split per README §12): vision/state, probability, markets/backend, glasses/client/demo — `TODO: who did what`

## Written submission fields

- [ ] Tagline field: "Look at the game. See the probability."
- [ ] Inspiration / What it does / How we built it / Challenges / Accomplishments / What we learned / What's next: from `docs/launch/devpost.md`
- [ ] "Built with" tags: `node.js`, `gemini`, `polymarket`, `swift`, `swiftui`, `hyperframes`, `javascript`
- [ ] Screenshots/gallery: debug view, `/data` dashboard (`apps/demo-web/data.html`), iOS app, a famous-moment comparison card — `TODO: capture images`

## Repo hygiene (before making public)

- [ ] No secrets committed — `GEMINI_API_KEY` is env-only; grep for keys/tokens one last time
- [ ] `npm test` passes clean on a fresh clone (zero deps, so no install step to document)
- [ ] `npm run evaluate` (fixture evaluation) passes
- [ ] README demo instructions verified on a machine that isn't a dev machine
- [ ] Fixtures are sanitized/team-owned (README §16)
- [ ] License file if the event requires one: `TODO:`

## Demo-day resilience ladder (README §13 — prepare every rung)

- [ ] Rung 1: live glasses capture + live market data
- [ ] Rung 2: webcam/phone capture + live market data
- [ ] Rung 3: prerecorded clip + live market data
- [ ] Rung 4: prerecorded clip + timestamped mock market data
- [ ] Rung 5: saved frames + deterministic expected outputs (fixture backend)
- [ ] Rehearsed dropping a rung mid-demo without apologizing

## Deadline

- [ ] Submission deadline (with timezone): `TODO:`
- [ ] Submitted at least 1 hour early
- [ ] Confirmation email/screenshot saved
