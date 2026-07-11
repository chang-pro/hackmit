# Vision-Model Training Plan

> Train our own scoreboard-reading model from the frames the system already collects,
> until it can replace the Gemini API as the default extraction backend.

Status: plan (no training has run yet — per README §17.6 no results in this document
are measurements until a run produces them).

Companion documents:
- `docs/vision-training/DATASET-SPEC.md` — exact on-disk dataset format and quality rules.
- `tools/dataset-viewer.html` — local human review tool for collected pairs.

---

## 1. Why and what

Today `services/vision/index.js` has two backends: `fixture` (saved JSON, deterministic)
and `gemini` (`gemini-2.0-flash`, schema-constrained JSON, needs `GEMINI_API_KEY`).
Gemini costs money per frame, needs a network round trip inside the 500–2,000 ms
parsing budget (README §9), and is a dependency we do not control.

Meanwhile every live session can already produce training data: the selector accepts a
frame, extraction parses it, the reconciler accepts a state, and `services/capture/dataset.js`
(DatasetWriter, opt-in via `DATASET_DIR`) saves the image next to the reconciled state
JSON. That is the data flywheel: **usage → labeled pairs → local model → cheaper, faster,
private usage.**

The trained model's job is exactly README §7.3 and nothing more: one broadcast frame in,
one ParsedScoreboard-shaped JSON out (team text, scores, period text, clock text,
per-field confidences). It slots in as a third backend object `{ name, extract }` beside
`fixture` and `gemini`; `normalize.js` and everything downstream stay untouched.

## 2. Dataset schema (summary — full spec in DATASET-SPEC.md)

One training example = one image + one label JSON, same basename, under
`DATASET_DIR/<sport>/` (`sport` ∈ `nba | soccer | football | ufc | golf`, the ids in
`services/sports/index.js`).

- **Image**: the selector-ACCEPTED frame as saved by DatasetWriter (`<frame_id>.jpg`).
- **Label JSON** (`<frame_id>.state.json`): today `{ sport, frame, state, labeled_at }`
  where `state` is the reconciled canonical state (README §7.5). The spec extends this
  with `parsed` (the normalized ParsedScoreboard that produced the state — display-level
  text plus `field_confidences`) and `provenance` (which backend/model/prompt labeled it).
  The `parsed` block is the actual training target; `state` is the consistency check.

**Training target format**: the model is trained to emit the same JSON the Gemini
backend emits per sport (`NBA_RESPONSE_SCHEMA` in `services/vision/backends/gemini.js`,
or the sport config's `vision.responseSchema`): `away_team_text`, `home_team_text`,
`away_score`, `home_score`, `period_text`, `clock_text`, `field_confidences`, plus
sport-specific optionals. Display text, not parsed numbers — `normalize.js` already owns
the "2:14" → 134 conversion and we keep that logic in one place.

## 3. Target volumes

Volumes are per sport per broadcast layout (a "layout" = one network's score bug, e.g.
ESPN bottom bar vs TNT corner box — README §15 calls layout variance the main OCR risk).

| Sport | Priority | Layouts | Frames/layout | Games (min) | Total target |
|---|---|---:|---:|---:|---:|
| NBA | P0 (primary slice) | 3 | 1,500 | 12 | ~4,500 |
| soccer | P1 | 2 | 1,000 | 8 | ~2,000 |
| football | P1 | 2 | 1,000 | 8 | ~2,000 |
| ufc | P2 | 1 | 800 | 6 events | ~800 |
| golf | P2 | 1 | 800 | 4 rounds | ~800 |

Rules of thumb:
- **Minimum viable NBA fine-tune**: ~1,000 clean pairs from ≥4 games on 1 layout.
  Below that, stay on Gemini.
- **Games matter more than frames.** 12 games × 375 frames beats 3 games × 1,500 —
  frames within a game are near-duplicates of each other (same layout, teams, lighting).
  The split policy (DATASET-SPEC §5) is by game for the same reason.
- Deliberately capture the hard tail: clock under 1:00 (tenths display, "14.5"),
  overtime periods, score in the 100s vs single digits, camera angle/glare variants.
  Aim for ≥10% of each sport's set from these.

Collection sources, in order of preference:
1. Live sessions with `DATASET_DIR` set (the flywheel proper — opt-in, README §16).
2. Team-owned recordings run through the same gateway → selector → pipeline path
   (`scripts/extract-clip-frames.sh` exists for clip extraction).
3. Never scraped third-party footage dumps; never frames containing bystanders (§16,
   and DATASET-SPEC §6).

## 4. Labeling strategy: Gemini as teacher, humans as auditors

**Auto-labels (teacher model).** Run the existing `gemini` backend over every collected
image. Because output is schema-constrained and then passes through `normalize.js` and
the `Reconciler`, we get three free quality filters:

1. `normalize.js` throws on unparseable required fields → frame is set aside, not labeled.
2. Reconciler invariants (scores never decrease, period never decreases, max score jump
   per sport) reject temporally implausible labels → pair marked `suspect`.
3. Per-field `field_confidences` from the teacher ride into the label. Any required field
   below the **label-confidence floor 0.85** (see DATASET-SPEC §4) flags the pair
   `needs_review` instead of entering the train set silently.

**Temporal cross-check (free extra labels).** Within one session, if frames at t and
t+2s reconcile to the same state, mid frames at t+1s can inherit that state as a label
with high trust — interpolation is only valid when the bracketing states are identical
(no score/period/clock-bucket change).

**Human spot-check pass.** Using `tools/dataset-viewer.html`:
- Review **100% of `needs_review` and `suspect` pairs**.
- Review a **random 10% sample of auto-accepted pairs** per sport per layout. If the
  sample's error rate exceeds 2% on any required field, review that whole
  layout batch — a systematic teacher error (e.g. Gemini swapping home/away on one
  layout) poisons everything and must be caught before training.
- Marked-bad pairs export to `bad-list.json`; the cleaning step moves them to
  `rejected/` (DATASET-SPEC §4). Bad pairs are never deleted silently — they are the
  best source of hard-negative examples for the next round.

**Uncertainty flagging in round 2+.** Once a local model exists, run BOTH the local
model and Gemini over new frames. Disagreement on any required field = automatic
`needs_review`. Agreement = high-trust label at near-zero human cost. This
teacher–student disagreement loop is what makes the flywheel compound.

## 5. Model choice for an RTX 4070 (12 GB)

Two credible paths were considered:

### Path A — fine-tune a small VLM (PaliGemma 2 3B / Florence-2 / Qwen2.5-VL-3B)

- Single stage: image in → JSON out. Mirrors the Gemini backend exactly, so the new
  backend is a drop-in replacement behind the same `extract(frame, options)` interface.
- Needs no bounding-box labels — critical, because DatasetWriter pairs carry **no
  reliable bbox** (the reconciled state has none; `scoreboard_bbox` is optional in
  ParsedScoreboard and Gemini isn't asked for it).
- QLoRA (4-bit base + LoRA adapters) on a 3B model fits comfortably in 12 GB.
- Within the family:
  - **Qwen2.5-VL-3B-Instruct** — strongest document/scene OCR of the three, native
    structured-JSON output, first-class HF `transformers` + PEFT support, dynamic-
    resolution ViT handles a 1080p frame without destroying small clock digits.
  - PaliGemma 2 (3B, 448px) — good, but 448px input squeezes a full broadcast frame
    hard; small shot-clock/tenths digits suffer unless we pre-crop, which reintroduces
    Path B's detection stage.
  - Florence-2-base (0.23B) — very fast, but built around task-token prompts; multi-field
    free-schema JSON is off its beaten path and it underperforms on dense small text.

### Path B — YOLO scoreboard detect → crop → TrOCR/PaddleOCR per field

- Fastest possible inference (~tens of ms) and tiny models.
- But: needs bbox annotation we do not collect (a whole new labeling workflow),
  needs per-layout field-region templates (the exact brittleness README §15 warns
  about), and is 3 models + glue instead of 1. Every new broadcast layout costs
  re-annotation; for the VLM it just costs more of the same pairs we already collect.

### Recommendation: **Path A with Qwen2.5-VL-3B-Instruct + QLoRA** (primary)

The flywheel already produces exactly Path A's training data and nothing of Path B's.
One model, one backend file, one eval script. Expected inference on a 4070 of roughly
0.5–1.5 s/frame (int4/int8, short JSON generation with a token budget) fits the 500–2,000 ms
parsing budget — **must be measured, not assumed**, in week 1 (README §17.6). Escape
hatch: if measured latency blows the budget, keep the fine-tuned VLM as the labeler
(offline teacher) and revisit Path B with VLM-bootstrapped bbox pseudo-labels — that
decision gets an ADR under `docs/decisions/`.

## 6. Training recipe (starting point, tune from here)

Environment: Windows or WSL2, CUDA 12.x, PyTorch + `transformers` + `peft` +
`bitsandbytes` (the same stack as the user's existing Whisper/CUDA tooling). Training
scripts live in `tools/` when implemented; this plan does not fabricate their results.

| Knob | Value | Why |
|---|---|---|
| Base | Qwen2.5-VL-3B-Instruct | see §5 |
| Method | QLoRA: 4-bit NF4 base, LoRA r=16, α=32, dropout 0.05, on attention + MLP projections | fits 12 GB with headroom |
| Trainable side | LoRA on language tower + vision-merger; ViT frozen first run | scoreboard reading is mostly "read text in context", vision tower is already good |
| Epochs | 3 (early-stop on val per-field accuracy, patience 1) | small datasets overfit fast |
| LR | 1e-4, cosine decay, warmup 3% | standard QLoRA range; halve it if loss spikes |
| Batch | 1 × grad-accum 8 (effective 8) | 1080p images are memory-heavy |
| Precision | bf16 compute | 4070 (Ada) supports bf16 |
| Prompt | the sport's exact `vision.prompt` from `services/sports/*.js` | train-time prompt == serve-time prompt, no drift |
| Target | the sport's exact response-schema JSON, canonical key order, minified | deterministic string target; parse failures measurable |
| Loss masking | loss on the JSON completion only, prompt tokens masked | standard SFT hygiene |

### Augmentations that matter for broadcast scoreboards

These simulate the glasses-camera-pointed-at-a-TV path (the real deployment condition),
applied on-the-fly at train time:

1. **JPEG re-compression**, quality 30–90 — camera + upload path recompresses hard.
2. **Moiré / screen-capture artifacts** — overlay a faint high-frequency grid pattern at
   random scale/rotation, then slight blur; this is THE artifact of filming a screen and
   most OCR augmentation stacks skip it.
3. **Perspective warp** ±10° with border reflection — the user never holds the glasses
   perfectly square to the TV.
4. **Glare / specular highlight** — random soft white ellipse at low-mid opacity; TVs
   reflect room lights directly over the score bug.
5. **Motion blur** (kernel 3–7 px, random angle) + mild Gaussian blur — head movement.
6. **Brightness/contrast/white-balance jitter** — TV picture modes vary wildly.
7. **Downscale-then-upscale** (0.4×–1.0×) — distance from the screen.

Forbidden augmentations: horizontal flip (mirrors text and swaps home/away semantics),
crops that can cut the score bug, hue rotation strong enough to change team colors
(possession/team cues), any elastic warp strong enough to deform digits.

Label-preserving check: augmentations change pixels only; JSON labels are untouched by
construction, so no label re-derivation is needed.

## 7. Eval protocol

Reuse the exact measurement style of `scripts/evaluate-fixtures.js`: per-field accuracy
on the required fields `teams, scores, period, clock`, where `teams` is correct only if
`resolveTeam()` maps both labels to the expected internal ids, and scores/period/clock
must match the expected values after `normalize.js`.

Concretely:
1. Add the local model as a backend object (`services/vision/backends/local.js`,
   `{ name: "local", extract }` calling a localhost inference server), same shape as
   `geminiBackend`.
2. Extend `scripts/evaluate-fixtures.js` to also run the `local` backend when its
   endpoint is reachable — same skip-honestly pattern used for the missing
   `GEMINI_API_KEY` today.
3. Add a dataset-scale evaluator (`tools/` — same diff logic, pointed at
   `DATASET_DIR/<sport>/test/` instead of `packages/fixtures/`) reporting per-field
   accuracy, JSON-parse failure rate, and p50/p95 latency per frame, for BOTH `local`
   and `gemini`, on the identical held-out set. The Gemini run is the baseline the gate
   compares against — measured on the same day, never quoted from memory.

Additional metrics beyond the fixture script: per-layout accuracy breakdown (a model can
ace ESPN and fail TNT while averaging fine), confidence calibration (when the model says
0.9+, is it right ≥90%?), and reconciler rejection rate in shadow mode.

## 8. Promotion gate — when does `local` replace `gemini` as default?

The local model becomes the default extraction backend for a sport when ALL of the
following hold, measured on that sport's frozen held-out test split (unseen GAMES,
DATASET-SPEC §5, ≥300 frames for NBA):

1. **Per-field accuracy ≥ Gemini's on every required field** (teams, scores, period,
   clock), each measured on the identical test set, AND absolute floors:
   teams ≥ 98%, scores ≥ 97%, period ≥ 99%, clock ≥ 90% (exact-second clock is the
   hardest field; the reconciler and multi-frame smoothing absorb small clock noise).
2. **JSON validity**: ≥ 99.5% of outputs parse and pass `normalize.js` without throwing.
3. **Latency**: p95 extraction ≤ 2,000 ms on the 4070 (README §9 budget), measured.
4. **Shadow run**: ≥ 3 full live/replayed sessions with the local backend running in
   parallel behind Gemini; reconciler rejection rate not worse than Gemini's on the same
   frames, and zero home/away swaps observed.
5. **Calibration**: no required field with reported confidence ≥ 0.9 and accuracy < 90%
   in the shadow run (the reconciler's 0.8 min-confidence gate depends on honest
   confidences — an overconfident model silently poisons canonical state).

Rollout: flip the default per sport (NBA first), keep `VISION_BACKEND=gemini` as an env
override and automatic fallback when the local server is down. Record the switch as an
ADR in `docs/decisions/`. Gemini remains the teacher for new-data labeling even after
promotion.

## 9. Week-by-week schedule

Assumes part-time effort alongside other workstreams; slips are expected — cut scope by
dropping P1/P2 sports, never by skipping the gate.

- **Week 1 — plumbing + feasibility.** Wire DatasetWriter provenance/`parsed` extension
  (DATASET-SPEC §3). Stand up Qwen2.5-VL-3B *un-tuned* on the 4070; measure zero-shot
  per-field accuracy and latency on the existing fixtures. This is the go/no-go on
  Path A latency (§5 escape hatch).
- **Week 2 — collection round 1.** NBA only, 1 layout. Run recorded games through the
  pipeline with `DATASET_DIR` set; Gemini auto-labels. Target ≥1,000 pairs from ≥4
  games. Human spot-check per §4 using the dataset viewer; freeze the first
  train/val/test split by game.
- **Week 3 — first fine-tune.** QLoRA run per §6 recipe, augmentations on. Evaluate per
  §7 against the same-day Gemini baseline. Expect to iterate 2–3 runs (LR, epochs,
  augmentation strength).
- **Week 4 — hard-tail collection + round 2.** Add 2 more NBA layouts and the hard-tail
  buckets (sub-minute clock, OT, glare/angle captures). Re-label round-1 rejects, add
  disagreement-flagging (local vs Gemini) to the labeling loop. Retrain.
- **Week 5 — gate attempt + shadow.** Freeze the candidate, run the full promotion gate
  including ≥3 shadow sessions. If it fails, the per-field/per-layout breakdown says
  what to collect next; loop week 4.
- **Week 6 — promote + expand.** Flip NBA default to `local` behind the env override,
  write the ADR. Start soccer/football collection with the trained NBA model + Gemini
  double-labeling from day one (they share the augmentation stack and recipe; only
  prompt/schema and aliases change — all already per-sport in `services/sports/`).

Ongoing after week 6: the flywheel proper — every opted-in session adds pairs, weekly
label-and-review batch, retrain when a sport gains ≥25% new data or a new layout appears.
