# Dataset Specification

> Exact on-disk format for the scoreboard-training dataset — matching what
> `services/capture/dataset.js` (DatasetWriter) writes today, plus the v2 extensions
> the training loop needs. Companion to `docs/vision-training/TRAINING-PLAN.md`.

## 1. Directory layout

Root is `DATASET_DIR` (opt-in environment variable; when unset, nothing is ever
written — README §16). Sport ids are the registry ids from `services/sports/index.js`.

```text
$DATASET_DIR/
├── nba/
│   ├── raw/                          # DatasetWriter output lands here (see §2 note)
│   │   ├── <session>_frame_000184.jpg
│   │   └── <session>_frame_000184.state.json
│   ├── train/                        # populated by the split step, by GAME (§5)
│   ├── val/
│   ├── test/                         # frozen; only grows, never reshuffled
│   ├── rejected/                     # bad pairs moved here by cleaning, never deleted silently
│   │   └── <basename>.{jpg,state.json,reason.txt}
│   └── splits.json                   # game -> split assignment, append-only
├── soccer/ …                         # same shape per sport
├── football/ …
├── ufc/ …
└── golf/ …
```

**Compatibility note.** DatasetWriter v1 writes pairs directly under
`DATASET_DIR/<sport>/` (no `raw/`). The split tool must accept both locations;
new writer versions should target `<sport>/raw/`. Train/val/test/rejected content is
produced by tooling, never by the live writer — the live path stays as dumb and fast
as it is today.

## 2. Filenames

- Image: `<basename>.jpg` — the selector-ACCEPTED frame, exactly the bytes the
  pipeline saw (base64-decoded by DatasetWriter; no re-encode, no resize).
- Label: `<basename>.state.json` — same basename, same directory. An image with no
  label file is an **unlabeled** frame (DatasetWriter saves image-only when no
  reconciled state exists yet — a label is never invented).

**Basename rule.** v1 uses the gateway `frame_id` (`frame_000184`). The gateway
counter resets per process, so `frame_000001` WILL collide across sessions. v2
basenames must be `<session_id>_<frame_id>` (e.g. `s20260711a_frame_000184`), where
`session_id` is any stable per-process token (timestamp-based is fine). Collision
handling for v1 data: never overwrite — if the target basename exists, suffix `_1`,
`_2`, …

## 3. Label JSON fields

v1 (what `DatasetWriter.record()` writes today):

```json
{
  "sport": "nba",
  "frame": {
    "frame_id": "frame_000184",
    "captured_at": "2026-07-11T20:14:32.491Z",
    "source": "glasses",
    "image_uri": "memory://capture/frame_000184",
    "width": 1920,
    "height": 1080
  },
  "state": {
    "event_id": "nba_2026_07_11_bos_nyk",
    "observed_at": "2026-07-11T20:14:32.491Z",
    "accepted_at": "2026-07-11T20:14:32.780Z",
    "away_team_id": "nba_bos",
    "home_team_id": "nba_nyk",
    "away_score": 104,
    "home_score": 101,
    "period": 4,
    "clock_seconds": 134,
    "possession_team_id": null,
    "extras": null,
    "confidence": 0.94,
    "source_frame_ids": ["frame_000184"]
  },
  "labeled_at": "2026-07-11T20:14:32.802Z"
}
```

`state` is the reconciled canonical state (README §7.5); `state.confidence` is the
minimum over the sport's required per-field confidences (see `services/vision/reconciler.js`).

v2 extensions (additive — every v1 file remains valid; readers treat missing fields
as absent, never guess):

```json
{
  "schema_version": 2,
  "session_id": "s20260711a",

  "parsed": {
    "sport": "basketball",
    "league": "NBA",
    "away_team_text": "BOS",
    "home_team_text": "NYK",
    "away_score": 104,
    "home_score": 101,
    "period": 4,
    "clock_seconds": 134,
    "shot_clock_seconds": 14,
    "possession_team_text": "BOS",
    "scoreboard_bbox": null,
    "field_confidences": {
      "teams": 0.98, "scores": 0.96, "period": 0.99, "clock": 0.94, "possession": 0.61
    }
  },

  "provenance": {
    "backend": "gemini",
    "model": "gemini-2.0-flash",
    "prompt_id": "nba/v1",
    "labeled_by": "auto",
    "review": null
  }
}
```

Field meanings:
- `parsed` — the normalized ParsedScoreboard (README §7.3) that produced `state`.
  **This is the training target** (display-level text semantics + per-field
  confidences); `state` alone is not sufficient because it drops the raw team text
  and merges confidences to one number.
- `provenance.backend` / `model` — which extractor labeled this pair (`gemini`,
  `local`, `fixture`, `human`). Required for teacher/student disagreement analysis
  and for excluding a bad teacher batch later.
- `provenance.prompt_id` — sport id + prompt version, so a prompt change is visible
  in the data (train-time prompt must equal label-time prompt).
- `provenance.labeled_by` — `auto` | `auto+interpolated` | `human`.
- `provenance.review` — `null` (unreviewed) | `"accepted"` | `"corrected"` (a human
  fixed fields in `parsed`; original kept in `provenance.original_parsed`).

Per-field confidences: `parsed.field_confidences` (0–1 per required field, plus
optional fields). Backends that don't report them get `UNREPORTED_CONFIDENCE = 0.5`
from `normalize.js`, which correctly lands them below the label floor in §4.

## 4. Quality rules

Applied by the cleaning step (tooling, offline), in order. A pair that fails any rule
moves to `rejected/` with a one-line `<basename>.reason.txt` — never silently deleted.

1. **Pairs only.** Image without label = unlabeled pool (kept for later labeling, not
   trained on). Label without image = rejected.
2. **Dedup.** Exact: SHA-256 of image bytes. Near-duplicate: perceptual dHash
   (64-bit, Hamming distance ≤ 4) **within the same game** — keep the pair whose label
   confidence is highest. Cross-game near-dupes are kept (same layout, different game
   is exactly the variance we want).
3. **Blur filter.** Variance of Laplacian on the grayscale image below threshold
   (calibrate on the first 200 accepted frames; start around 60) = rejected as blurry —
   unless the label is human-reviewed (a human could read it, so the model may learn to).
4. **Label-confidence floor.** Every required field's confidence
   (`parsed.field_confidences`, sport's `confidenceFields` from its reconciler rules)
   must be ≥ **0.85**, and `state.confidence` ≥ 0.85. Below the floor →
   `needs_review` queue (dataset-viewer), not train.
5. **Reconciler consistency.** The pair's `state` must have been ACCEPTED by the
   reconciler in-session (DatasetWriter only saves labels from reconciled state, so
   this holds by construction for auto labels; imported/backfilled labels must be
   replayed through `Reconciler.observe()` in captured order).
6. **Plausibility bounds.** Sport-specific static checks: NBA scores 0–200,
   period 1–8, clock 0–720 s; soccer goals 0–15; etc. Out of bounds = rejected.
7. **Human review outcomes.** Pairs marked bad in the dataset viewer
   (`bad-list.json` export) are moved to `rejected/` with reason `human_bad`.
   Corrected pairs get `provenance.review = "corrected"` and stay in.

## 5. Train/val/test split policy — split by GAME, never by frame

Frames within one game share layout, teams, jersey colors, arena lighting, and mostly
differ by a few digits. Random frame-level splits leak that context and inflate every
metric. Therefore:

- The split key is `state.event_id` (one game/event). ALL frames of a game go to
  exactly one of train/val/test.
- Assignment recorded in `splits.json` (`{ "nba_2026_07_11_bos_nyk": "test", … }`),
  **append-only**: a game once assigned never moves. New games are assigned
  train/val/test ≈ 80/10/10 while keeping each broadcast layout represented in all
  three splits as soon as it has ≥3 games.
- The test split is the promotion-gate set (TRAINING-PLAN §8): frozen, only grows,
  and its games must never have been used for training ANY promoted model version.
- If two `event_id`s are the same real-world game captured twice (e.g. live + replay
  run), they count as one game for splitting.

## 6. Privacy rules (README §16 — binding)

- **Opt-in only.** Dataset writing happens only when `DATASET_DIR` is explicitly set.
  Default is OFF; no raw camera footage is persisted otherwise. Recording status must
  be visible to the operator whenever the writer is enabled.
- **No bystander footage.** Frames are supposed to show a broadcast on a screen. Any
  frame containing an identifiable person physically present in the room (not on the
  broadcast), personal environment details, or anything other than the screen being
  analyzed is rejected at review (`human_bad: bystander`) and its image deleted from
  `rejected/` as well — reason file stays, pixels do not.
- **Team-owned or sanitized footage only** for anything that leaves the local machine
  or enters the repo. The dataset itself (broadcast imagery) is NOT committed to git
  and is not redistributed; only `packages/fixtures/` (sanitized, team-owned) live in
  the repo.
- No secrets, tokens, or account identifiers anywhere in label JSON. `frame.source`
  stays a device-class string (`glasses`, `webcam`, `upload`), never a user id.
- Training runs stay on the local 4070 by default. Any cloud training/labeling beyond
  the already-in-use Gemini labeling call needs an explicit decision recorded in
  `docs/decisions/`.
