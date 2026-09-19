# Demo footage (compressed)

Compressed broadcast clips used as the deterministic demo fallback (README §13):
point the pipeline at these when live glasses input isn't available. Each clip
has a visible scoreboard/leaderboard that the vision stack can read.

> Note: README §16 says raw footage stays out of git. These are **downscaled,
> compressed** demo clips (480p, ~85 MB max, under GitHub's 100 MB per-file
> limit), not the raw downloads. Raw full-resolution footage lives in the
> git-ignored `footage/` folder.

| File | Sport | Match | Demo pack |
|---|---|---|---|
| `sb51_ne_atl__football_2017_02_05.mp4` | Football | Super Bowl LI — Patriots vs Falcons | `super-bowl-li` |
| `ufc229_khabib_mcgregor__ufc_2018_10_06.mp4` | UFC | UFC 229 — Khabib vs McGregor (full fight) | `ufc-229` |
| `wc22_final_arg_fra__soccer_2022_12_18.mp4` | Soccer | 2022 World Cup Final — Argentina vs France | `world-cup-2022-final` |
| `nba_bos_nyk__celtics_at_knicks_2026.mp4` | NBA | Celtics @ Knicks — April 9, 2026, NBA game `0022501168` | `nba-celtics-knicks-2026` |

Golf (`golf_2019_04_14_tiger_molinari`) was intentionally skipped.

Clips are third-party broadcast footage retained for internal hackathon demo/eval
only. Do not redistribute.

## Extract frames

```bash
scripts/extract-clip-frames.sh demo-footage/sb51_ne_atl__football_2017_02_05.mp4 clip-frames 1
```
