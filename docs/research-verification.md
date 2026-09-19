# Research Verification Report

Date: 2026-07-11. Method: live API probes (curl against gamma-api.polymarket.com and site.api.espn.com, run 2026-07-11) plus web research. Each finding is marked **CONFIRMED**, **CORRECTED**, or **UNVERIFIED**.

---

## 1. Meta Ray-Ban glasses -> laptop live video (MOST IMPORTANT)

### 1.1 Our capture-page flow: "start livestream from glasses -> open it on this computer -> screen-capture that window"

**CORRECTED (two corrections):**

1. **FB/IG livestreaming is Ray-Ban Meta Gen 1 ONLY.** Meta's own help page states: "This feature is only available on Ray-Ban Meta (Gen 1) glasses." Gen 2 (2025), Oakley Meta HSTN/Vanguard, and Ray-Ban Display do NOT support Facebook/Instagram livestreaming; community forums report the feature was removed for Gen 2 (users cite overheating). If a demo user has 2025+ hardware, the livestream path does not exist for them.
   - Source: https://www.meta.com/help/ai-glasses/1384089832459749/
   - Source (Gen 2 removed): https://communityforums.atmeta.com/discussions/ai-troubleshooting/live-streaming-removed/1350322 , Best Buy Q&A on Gen 2
2. **The livestream is not "started from the glasses."** The user starts a Live from the **Facebook or Instagram app on the phone** (Add -> Live), taps the **Glasses** icon to use the glasses as camera, then double-presses the glasses capture button to switch to the glasses POV, then taps Go Live. The glasses are a wireless camera; the phone app owns the stream.
   - Source: https://www.meta.com/help/ai-glasses/1384089832459749/

**Recommended flow ranking for the capture page (mid-2026):**

| Path | Hardware | Steps | Latency to laptop screen |
|---|---|---|---|
| **A. WhatsApp/Messenger video call (RECOMMENDED default)** | ALL current glasses: Ray-Ban Meta Gen 1 & Gen 2, Oakley Meta, Ray-Ban Display | Pair glasses with phone (Meta AI app). Start a WhatsApp/Messenger/Instagram video call from the phone to a second account logged in on the laptop (WhatsApp Desktop / messenger.com). During the call tap **Glasses** (or double-press the capture button / double-tap the frame) to share the glasses POV. Screen-capture the call window on the laptop. | Real-time call (WebRTC-class), well under 1 s. Best for live scoreboard reading. |
| **B. Instagram/Facebook Live** | **Gen 1 only** | Start Live from phone FB/IG app with glasses as camera (steps above); open the live on instagram.com / facebook.com in a browser on the laptop; screen-capture that window. | Typical HLS live latency ~5-30 s; Meta warns livestream resolution is LOWER than recorded video. Workable but stale prices vs. the market. |
| **C. Wearables Device Access Toolkit (developer SDK)** | Supported Meta AI glasses, iOS/Android app you build | SDK is in **developer preview** (announced Connect 2025). Provides **camera streaming** (session/stream setup, video frames, resolution/frame rate) and photo capture into YOUR mobile app; mic/speaker via standard Bluetooth. You would still need to forward frames from the phone app to the desktop yourself (e.g. WebRTC relay). Publishing to the public expected during 2026; test via orgs/release channels; a Mock Device Kit exists for development without hardware. | Depends on your relay; potentially lowest and most controllable. Not a "user steps" path — an engineering path. |
- Sources: https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/ , https://github.com/facebook/meta-wearables-dat-android , https://github.com/facebook/meta-wearables-dat-ios , https://wearables.developer.meta.com/docs/develop/dat/mock-device-kit/ , https://developers.meta.com/wearables/faq/

### 1.2 Video calling with glasses POV
**CONFIRMED.** Official Meta/WhatsApp docs: during a Messenger, WhatsApp, or Instagram video call, tap **Glasses** to share your view; double-press the capture button to switch between phone camera and glasses camera. Ray-Ban Display marketing explicitly: "Two-way video calling lets you see them on your display, while they see the world through your eyes... available on WhatsApp, Messenger and Instagram."
- Sources: https://faq.whatsapp.com/745123461071373 , https://www.meta.com/help/smart-glasses/articles/ray-ban-meta/share-your-view-ray-ban-meta-smart-glasses/ , https://www.meta.com/ai-glasses/meta-ray-ban-display/
- Caveat (UNVERIFIED edge): scattered forum reports of the WhatsApp view-share toggle being flaky/disabled for some users; have Messenger as fallback in the demo script.

### 1.3 "Meta AI app livestreaming"
**CORRECTED.** The Meta AI app has **no general-purpose local live viewfinder / POV stream** for Gen 1/Gen 2 — it is setup, import, and settings. (A community feature request explicitly asks for "Local Live View for Ray-Ban Meta Gen 2 without calls or public streaming," confirming it does not exist.) Ray-Ban Display's viewfinder is on the in-lens display, not on the phone/desktop. Do not describe the Meta AI app as a streaming path.
- Source: https://communityforums.atmeta.com/discussions/ai-tips-tricks/feature-request-local-live-view-for-ray-ban-meta-gen-2-without-calls-or-public-s/1350254

---

## 2. Polymarket Gamma API (adapter assumptions, verified live 2026-07-11)

File checked: `services/market/polymarket-adapter.js`.

### 2.1 Core mechanics
- **CONFIRMED:** `GET https://gamma-api.polymarket.com/events?slug=...` returns an array; no auth needed. Live probe of `mlb-laa-min-2026-07-11` returned 1 event.
- **CONFIRMED:** Game events carry `teams[]` with `abbreviation` and `ordering` ("home"/"away"), and `markets[]` with `sportsMarketType`. Moneyline market has `outcomes` as a **JSON-encoded string array** and quotes `bestBid` / `bestAsk` / `lastTradePrice` **for outcomes[0]**, complement for outcomes[1]. Live probe: MLB moneyline `["Los Angeles Angels","Minnesota Twins"]`, bestBid 0.38 / bestAsk 0.39 / last 0.39 — consistent with the away team (~38c) and complement pricing.
- **CONFIRMED:** `nba-{away}-{home}-{yyyy-mm-dd}` slug format for NBA (repo fixture `nba-nyk-okc-2026-03-29` plus MLB analog `mlb-laa-min-2026-07-11` where laa=away, min=home). NBA is off-season in July; `tag_slug=nba` currently returns only futures/props (e.g. LeBron retirement), so empty `list_live_events` is the correct expectation right now.
- **CONFIRMED:** `tag_slug` filtering works (`nba`, `mlb`, `epl`, `nfl`, `ufc`, `mma`, `golf`, `pga` all return results).
- **CONFIRMED (design validated):** derivative events share the game-slug prefix with suffixes (`mlb-laa-min-2026-07-11-first-five-winner`, `-player-props`, `epl-...-total-corners`). The strict `GAME_SLUG_RE` correctly excludes them.
- **CORRECTED (latent bug even for NBA-adjacent reuse):** `sportsMarketType` values observed include `moneyline`, `spreads`, `totals`, plus sport-specific types (`nrfi`, `baseball_team_first_five_spread`, `ufc_go_the_distance`, `ufc_method_of_victory`). Fine for NBA; but see per-sport corrections below — the "exactly 1 moneyline market" invariant is FALSE for soccer.

### 2.2 Live in-play trading
**CONFIRMED.** Polymarket runs a dedicated live section (polymarket.com/sports/live) with real-time in-game trading across NBA, NFL, MLB, NHL, UFC, soccer, 20+ sports; prices move in-play. NFL is ~40% of sports volume; marquee NBA games do $0.5-2M.
- Sources: https://polymarket.com/sports/live , https://laikalabs.ai/prediction-markets/polymarket-sports-markets

### 2.3 Per-sport slug/market formats for our 4 new sports (all probed live)

- **UFC/MMA — CORRECTED (two ways):**
  - Game events exist as `ufc-{fighter1}-{fighter2}-{yyyy-mm-dd}` (e.g. `ufc-ode-cod2-2026-07-11`, `ufc-alv2-all6-2026-07-18`). Moneyline outcomes are the two fighter names — structurally like NBA. `teams[]` still uses `ordering: home/away` (first-listed fighter = "home").
  - **BUT fighter "abbreviations" break our regexes:** they contain digits and run up to 6+ chars (`tabdul`, `jnasci`, `lchokh`, `scolli`, `jac21`). `GAME_SLUG_RE`/`EVENT_ID_RE` cap segments at `{2,5}` chars — `ufc-tabdul-jnasci-2026-06-27` would NOT parse. Widen to `{2,8}` (or `[a-z0-9]+`) for UFC.
  - Tag notes: `tag_slug=ufc` and `tag_slug=mma` both work; fight-card events are tagged ufc. Fights get extra markets: `ufc_go_the_distance`, `ufc_method_of_victory` (several Yes/No markets), round `totals` — the single-moneyline filter still holds for UFC (1 moneyline per fight event).
- **Soccer (EPL) — CORRECTED (two ways):**
  - Slug is `epl-{HOME}-{AWAY}-{yyyy-mm-dd}` — **home team FIRST**, opposite of the NBA/MLB away-home convention. Verified: `epl-cry-ars-2026-05-24` has teams cry=home, ars=away.
  - **Moneyline is NOT one 2-outcome market.** Live probe shows THREE separate binary `moneyline` markets per match: "Will Crystal Palace FC win...?" [Yes,No], "...end in a draw?" [Yes,No], "Will Arsenal FC win...?" [Yes,No]. The adapter's `moneylines.length > 1 -> AmbiguousMarketError` fires on every soccer match, and outcome matching by team name inside `outcomes` fails (outcomes are Yes/No; team is in `question`). Soccer needs 3-way handling: pick the market whose `question` names the team, price its Yes side, and remember P(win)+P(draw)+P(loss) must be handled (win prob is NOT 1 - other team's price).
  - World Cup: no WC match markets listable now (next WC is 2026 in progress? — see UNVERIFIED note below); EPL season over (last matchday 2026-05-24, all closed). Off-season empty-list behavior applies to soccer too. Tag for World Cup markets UNVERIFIED (likely `world-cup` / `fifa-world-cup`); check when markets list.
- **NFL — CONFIRMED pattern / UNVERIFIED ordering:** `tag_slug=nfl` works (currently futures/props only; season starts Sept). Game slugs expected `nfl-{away}-{home}-{yyyy-mm-dd}` by analogy with MLB/NBA, but no live NFL game events existed to probe on 2026-07-11 — re-verify home/away ordering in September before trusting it (EPL proves ordering is per-sport, not global).
- **Golf — CORRECTED (no game events at all):** Golf has NO team/date game slugs. Structure is tournament-level **negRisk multi-outcome winner events**: `2026-us-open-winner` (negRisk: true, 121 markets — one Yes/No market per golfer), plus `{year}-{tournament}-top5/top10/top20` events (~100 markets each). For a Masters demo the market is "will Tiger Woods win the {year} Masters" — a per-golfer binary market inside the winner event, NOT a moneyline, and `teams[]`/away-home mapping does not apply. Exact Masters slug UNVERIFIED (2026 Masters events already closed and paginated out; pattern implies `2026-masters-winner` or similar — resolve by `tag_slug=golf` + title search rather than slug construction).

---

## 3. ESPN public JSON endpoints (all probed live 2026-07-11)

All under `https://site.api.espn.com/apis/site/v2/sports/...`, no auth:

- **CONFIRMED** `mma/ufc/scoreboard` — returned "UFC 329: McGregor vs. Holloway 2".
- **CONFIRMED** `soccer/eng.1/scoreboard` (EPL) and `soccer/fifa.world/scoreboard` (World Cup) — both live.
- **CONFIRMED** `football/nfl/scoreboard` — 16 events (preseason schedule).
- **CONFIRMED** `golf/pga/scoreboard` — Genesis Scottish Open, ISCO Championship.
- **CONFIRMED historical `?dates=YYYYMMDD` works on all four:**
  - `football/nfl/scoreboard?dates=20170205` -> Super Bowl LI with per-quarter linescores (see §4).
  - `mma/ufc/scoreboard?dates=20181006` -> "UFC 229: Khabib vs. McGregor".
  - `soccer/fifa.world/scoreboard?dates=20221218` -> "France at Argentina", status "FT-Pens", ARG 3 FRA 3.
  - `golf/pga/scoreboard?dates=20190414` -> "2019 Masters Tournament", leaderboard: Tiger Woods -13, Dustin Johnson -12, Xander Schauffele -12.

---

## 4. Famous-match ground truth

### 4.1 2022 World Cup Final (Argentina 3-3 France, ARG wins 4-2 on pens) — **CONFIRMED**
- 23' Messi (penalty) 1-0; 36' Di Maria 2-0; 80' Mbappe (penalty) 2-1; 81' Mbappe (volley) 2-2; 90' end regulation 2-2; 108' Messi 3-2; 118' Mbappe (penalty, his hat-trick) 3-3; shootout Argentina 4-2. Mbappe = 2nd WC-final hat-trick ever (Hurst 1966).
- Sources: https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final , https://www.skysports.com/football/news/12098/12768573/

### 4.2 UFC 229 (Oct 6, 2018, T-Mobile Arena) — **CONFIRMED**
- Khabib Nurmagomedov def. Conor McGregor by **submission (neck crank), Round 4, 3:03**. (Some outlets loosely say rear-naked choke; official result is neck crank at 3:03 R4.) Khabib dominated (takedowns, R2 knockdown); McGregor's best round was R3.
- Sources: https://en.wikipedia.org/wiki/UFC_229 , https://www.espn.com/mma/story/_/id/24916111/

### 4.3 Super Bowl LI (Feb 5, 2017) — **CONFIRMED**
- Final: **New England 34, Atlanta 28 (OT)** — first SB overtime. Quarters (from ESPN's own API, dates=20170205): ATL 0/21/7/0/0; NE 0/3/6/19/6. So 28-3 ATL midway through Q3, 28-9, 28-12, 28-20, 28-28, James White walk-off TD in OT.
- **Peak ATL live win probability — CONFIRMED with nuance (pick one number and cite it):** ESPN's model peaked at **99.8% with 6:04 left in Q3**; some ESPN write-ups cite 99.9% after the FG-range play with 2:05 left in Q3; FiveThirtyEight-style trackers cite 99.6-99.7%. NE bottomed at ~0.2-0.3%. Safest demo line: "ESPN's win probability hit 99.8% for Atlanta in the 3rd quarter." Note Brian Burke (model author) later called the model overconfident there.
- Sources: https://www.espn.com/blog/statsinfo/post/_/id/128369/ , https://www.foxsports.com/stories/nfl/no-the-patriots-never-had-a-0-1-chance-of-winning-super-bowl-li , http://www.slate.com/articles/sports/sports_nut/2017/02/did_the_falcons_really_have_a_99_percent_chance_to_win_the_super_bowl.html

### 4.4 2019 Masters, final round (Apr 14, 2019) — **CONFIRMED**
- Molinari led through 11 (Tiger -11, 2 back at the turn area). **Hole 12:** Molinari found Rae's Creek, double bogey; Tiger two-putt par -> **TIED for the lead at -11 after 12** (with Molinari; several others one back).
- Tiger birdied 15 for solo lead (Molinari's 2nd double, at 15); **hole 16: tee shot to ~4 feet, birdie -> two-shot lead at -14 through 16.**
- Bogey at 18 to win by **one stroke at -13 (275)** over Dustin Johnson, Brooks Koepka, Xander Schauffele (-12). 5th green jacket, 15th major, first major won trailing entering the final round. ESPN API confirms final leaderboard (Tiger -13, DJ -12, Schauffele -12).
- Sources: https://en.wikipedia.org/wiki/2019_Masters_Tournament , https://golf.com/news/tournaments/masters-2019-12th-hole-tiger-victory/ , https://www.pgatour.com/article/news/latest/2020/11/09/remembering-the-final-round-of-the-2019-masters-augusta-national-golf-club-tiger-woods

### 4.5 NBA BOS-NYK
No specific fixture date given in the plan; ESPN `basketball/nba/scoreboard?dates=YYYYMMDD` follows the same confirmed historical pattern as the four above (same API family). **CONFIRMED by pattern**, exact game left to the fixture builder.

---

## 5. Win-probability model reference constants

- **NFL — CONFIRMED:** Final margin ~ Normal(spread, SD): classic Stern/Winston SD = **13.86** (early-80s data); **13.45** from 1978-2012 NFL averages; modern fits 13-14. Home-field advantage: historical ~2.5 pts, but **declining — recent seasons ~1.5-2 pts** (avg home margin ~2 pts; 50% -> ~57.5% for even teams). Our constants should sit in HFA 2.0-2.5 and SD 13.0-13.9 to be defensible.
  - Sources: https://www.pro-football-reference.com/about/win_prob.htm , https://www.nfeloapp.com/analysis/margin-probabilities-from-nfl-spreads/ , https://g-tierney.github.io/post/home_field/
- **NBA — CONFIRMED:** Score-margin SD ~ **11-12.5** (Winston's mathletics derivation gives ~12; empirical fits ~11.5-12.5). Home edge ~2-3 pts (has drifted down toward ~2).
  - Source: https://waynewinston.com/wordpress/p_2333/
- **Soccer — CONFIRMED:** Total goals ~**2.5-3.0 per match** (~2.7-2.8 typical in top leagues); home ~1.4-1.6, away ~1.1-1.3; independent-Poisson per team is the standard baseline (with known caveats: slight underdispersion of draws, time-varying rates late).
  - Sources: https://help.smarkets.com/hc/en-gb/articles/115001457989 , https://arxiv.org/pdf/1906.05029
- **UFC/golf:** no equivalent "margin SD" convention. UFC in-fight WP is round-score/finish-hazard based; golf WP is strokes-vs-field with per-hole variance ~0.4-0.5 strokes (scattered sources; **UNVERIFIED** as a standard constant — treat golf model constants as heuristic and label them so).

---

## Summary of corrections (ranked)

1. **(Critical) Capture-page glasses flow is wrong for 2025+ hardware.** FB/IG livestreaming = Gen 1 only, and it is started from the phone's FB/IG app, not "from the glasses." Default flow should become: **WhatsApp/Messenger video call with glasses view-share -> answer on desktop -> screen-capture the call window** (works on all current glasses, sub-second latency). Keep IG-Live-in-browser as the Gen 1 alternate (5-30 s latency, lower resolution). Meta AI app is NOT a streaming path.
2. **(Critical for soccer) Soccer moneyline is three Yes/No markets (home win / draw / away win), not one 2-outcome market.** Current adapter throws AmbiguousMarketError on every soccer match; team matching via `outcomes` can't work (outcomes are Yes/No; team name is in `question`). Needs 3-way logic.
3. **(High) EPL slugs are `epl-{home}-{away}-{date}` — home first, opposite of NBA/MLB.** Slug ordering is per-sport; do not reuse the away-home builder blindly. NFL ordering unverifiable until September — re-probe then.
4. **(High) UFC fighter abbreviations break the `{2,5}` char regexes** (6+ chars, digits: `tabdul`, `jnasci`, `jac21`). Widen segment patterns for UFC. UFC events otherwise match the adapter shape (single moneyline, fighter-name outcomes, teams[] with home/away).
5. **(High) Golf has no game events at all** — tournament-level negRisk winner events (`2026-us-open-winner`, one Yes/No market per golfer) plus top5/10/20. The Masters demo must target the per-golfer "wins the Masters" market; away/home/moneyline machinery doesn't apply. Exact 2026 Masters slug unverified — find via tag+title search, not slug construction.
6. **(Medium) Pin the Super Bowl LI stat to "ESPN peak 99.8% ATL, Q3 6:04"** — sources range 99.6-99.9; pick one and cite ESPN.
7. **(Low) NFL home edge constant:** prefer 2.0-2.5 pts (modern era lower than the old 2.5-3.0); margin SD 13.45 or 13.86 both citable.

Everything else checked out: Gamma event/market field semantics (bestBid/bestAsk on outcomes[0], complement pricing, outcomes as JSON string, tag_slug, teams ordering), ESPN endpoints incl. historical `?dates=` for all four sports, all four famous-match fact sets, and Polymarket live in-play sports trading (live section exists, prices move in-game, UFC/soccer/NFL covered; golf = tournament markets).
