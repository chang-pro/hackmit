# Demo intelligence pack handoff

These four JSON files are the deterministic funding-demo layer used after Cerebras identifies a broadcast. They are not substitutes for visual detection: the camera still supplies sport, competition, participants, score, phase, clock, and confidence.

## Canonical clips

| Pack | Expected footage | Exact-match signals |
|---|---|---|
| `world-cup-2022-final.json` | Argentina vs France, 2022 FIFA World Cup Final | World Cup plus ARG/Argentina and FRA/France |
| `nba-finals-2016-game-7.json` | Cleveland vs Golden State, 2016 NBA Finals Game 7 | NBA Finals plus Cavaliers/Cleveland and Warriors/Golden State |
| `super-bowl-li.json` | New England vs Atlanta, Super Bowl LI | Super Bowl plus Patriots/New England and Falcons/Atlanta |
| `ufc-229.json` | Khabib vs McGregor, UFC 229 | UFC 229 plus both fighter names |

If the teammate clips differ, update the pack identity, aliases, moments, evidence, and disclosure before demo day. Do not preserve the old facts under a new clip.

## Routing rules

`services/demo/intelligence.js` performs:

1. A minimum vision-confidence gate of 0.55.
2. Canonical sport matching.
3. Participant and competition/event alias matching.
4. Moment selection by exact score, phase, clock proximity, and visible situation.
5. Monotonic progression so a replay graphic or OCR regression cannot rewind the event.

An exact event match receives `precollected_event_replay` and deterministic probabilities. A sport-only match receives `illustrative_sport_template`; it may enrich a real Cerebras analytics response, but it can never create a probability when analytics is unavailable.

## Required moment fields

Every moment must contain:

- Stable `id` and stage-readable `label`.
- Score pairs, phase tokens, and a clock anchor where applicable.
- Bounded model and explicitly mocked market probabilities.
- Market question and outcome.
- Summary, `what_changed`, `next_trigger`, and key factors.
- At least three evidence entries with provider, query, and cached-result detail.
- At least one honest disclosure at the pack level.

For UFC, store the broadcast countdown clock. UFC 229 ended at 3:03 elapsed in round four, which is 1:57 remaining.

## Mock research schema

Each pack carries a top-level `research` array representing the precollected web-research experience shown during the funding demo. These entries are deterministic historical fixtures, not results fetched from the web during the presentation. The UI and API must preserve their mock labeling and must never describe them as current or live research.

Every pack must include at least one entry in each category:

- `players`
- `teams` (teams, camps, or corners as appropriate to the sport)
- `strategy/tactics`
- `news/context`

Every research entry has exactly these public fields:

- `category`: one of the categories above.
- `query`: the historical lookup the demo is simulating.
- `source`: a clearly labeled mock historical research cache.
- `result`: a concise, historically plausible cached finding.
- `is_mock`: always `true`.

Research text must be event-specific, use past-tense historical framing, and avoid implying that the app performed current or live web access.

## Verification

Run:

```bash
npm test
curl -fsS http://localhost:3000/api/demo/intelligence
```

The tests assert all four event matches, exact checkpoint selection, low-confidence rejection, non-rewinding timelines, deterministic exact-event fallback, stable live API output, and viewer disclosure.
