# ADR 0001: Parallel slice builds and the seams each slice owns

Status: accepted · Date: 2026-07-11

## Context

Slice 1 (the deterministic end-to-end skeleton) is merged on `master`.
Slices 2–6 (README §11) are being built in parallel branches by different
teammates/agents. Several slices need to touch the same orchestration files,
so uncoordinated edits to `services/api/server.js` and
`services/api/pipeline.js` would produce constant merge conflicts.

## Decision

Each slice owns a seam and stays inside it. Shared files follow an
additive-change rule.

| Slice | Owns |
|---|---|
| 2 — scoreboard extraction | `services/vision/*` internals behind the `parseFrame` contract; new frame fixtures it needs |
| 3 — probability model | `services/probability/*` behind the `estimate`/`winProbability` contract; model metadata |
| 4 — camera flow | capture gateway and frame ingestion; additive routes in `server.js` |
| 5 — market integration | `services/market/*` (real adapter as a sibling of the mock, which is preserved); adapter selection |
| 6 — delivery and demo polish | `apps/demo-web/*`, `docs/*`, demo-moment fixtures, additive routes in `server.js` |

Shared-file rules:

- `server.js`: add routes or route parameters; do not restructure existing
  handlers.
- `pipeline.js`: avoid edits except where unavoidable; when unavoidable, keep
  them additive with unchanged defaults. (Slice 6's only pipeline edit adds an
  optional injected `reconciler` parameter whose default preserves the
  previous singleton behavior.)
- Components communicate only through the typed contracts in README §7–§8,
  so a slice can be reviewed and merged without reading its siblings' diffs
  (README §17 rules 4, 9, 11).

## Consequences

- Merges between slice branches should conflict only in `server.js` import
  and route blocks, which are additive and easy to resolve.
- The §8 payload is the integration test: every slice must keep
  `GET /api/comparison` returning the full contract.
- Cross-seam changes (e.g., a new field in the canonical state) require a
  README update and a new ADR, not a silent edit.
