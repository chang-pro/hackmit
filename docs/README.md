# BloomKnights documentation index

## What was built (2026-07-11)

- Multi-sport backend: 5 sports (NBA, football, soccer, UFC, golf in `services/sports/`), famous-match replay fixtures, 130 passing tests (`npm test`).
- Redesigned demo web app: dashboard (`/`), Ray-Ban phone capture page (`/capture`), data dashboard (`/data`).
- Landing page (`/landing`) and pitch deck (`/pitch`), both served by the same zero-dependency Node server.
- iOS app at `apps/ios/` (SwiftUI, iOS 17+), including Meta glasses SDK streaming — see its README.
- 60-second demo video at `apps/demo-video/out/`.
- Demo-day docs (runbook, judge Q&A, failure modes, setup checklist), vision-model training plan, and a research verification report.

## Start here, by audience

- **Judge**: [demo-script.md](demo-script.md), then [launch/devpost.md](launch/devpost.md).
- **Developer**: top-level [README.md](../README.md) (product source of truth), then [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) and [architecture/API.md](architecture/API.md).
- **Demo operator**: [demo-day/runbook.md](demo-day/runbook.md), then [demo-day/setup-checklist.md](demo-day/setup-checklist.md).

## All documents

| Doc | What it is | For |
|---|---|---|
| [../README.md](../README.md) | Product and architecture source of truth for the whole project | developer |
| [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) | How the implemented system is actually structured | developer |
| [architecture/API.md](architecture/API.md) | HTTP API reference for `services/api/server.js` (routes, shapes, gaps) | developer |
| [architecture/DECISIONS.md](architecture/DECISIONS.md) | Running log of implementation decisions | developer |
| [decisions/0001-slice-boundaries.md](decisions/0001-slice-boundaries.md) | ADR: slice boundaries for the first build | developer |
| [demo-script.md](demo-script.md) | Judge-facing demo script (what to say and show, language rules) | judge, demo operator |
| [demo-day/runbook.md](demo-day/runbook.md) | Step-by-step demo-day operating procedure | demo operator |
| [demo-day/setup-checklist.md](demo-day/setup-checklist.md) | Pre-demo hardware/software checklist | demo operator |
| [demo-day/failure-modes.md](demo-day/failure-modes.md) | What can break during the demo and the fallback for each | demo operator |
| [demo-day/judge-qa.md](demo-day/judge-qa.md) | Anticipated judge questions with honest answers | judge, demo operator |
| [launch/devpost.md](launch/devpost.md) | Devpost submission text | judge |
| [launch/submission-checklist.md](launch/submission-checklist.md) | Everything required before submitting | demo operator |
| [launch/one-liner-bank.md](launch/one-liner-bank.md) | Ready-to-use short pitches and taglines | judge, demo operator |
| [launch/x-thread.md](launch/x-thread.md) | Launch thread copy for X | demo operator |
| [vision-training/TRAINING-PLAN.md](vision-training/TRAINING-PLAN.md) | Plan to train our own scoreboard-reading model to replace the Gemini backend | developer |
| [vision-training/DATASET-SPEC.md](vision-training/DATASET-SPEC.md) | Spec for the training dataset collected from live frames | developer |
| [research-verification.md](research-verification.md) | Fact-check of external claims via live API probes (Polymarket, ESPN), each marked confirmed/corrected/unverified | judge, developer |
| [../apps/ios/README.md](../apps/ios/README.md) | iOS companion app: build, run, and glasses streaming | developer |
