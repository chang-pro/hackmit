# Recorded Polymarket Gamma API responses

Real, unmodified responses from Polymarket's public Gamma API
(`https://gamma-api.polymarket.com`, no authentication), captured on
**2026-07-11 at 15:57-15:58 UTC** (exact capture time is in each filename).
This is public market data; nothing here is fabricated or sanitized.
`tests/market-adapter.test.js` replays these files through the Polymarket
adapter so normalization is tested against real provider payloads without
any network access.

| File | Request | What it exercises |
|---|---|---|
| `polymarket-events-slug-nba-nyk-okc-2026-03-29.captured-*.json` | `GET /events?slug=nba-nyk-okc-2026-03-29` | A real NBA game event (Knicks vs. Thunder, 2026-03-29, closed) with one `moneyline` market, `teams` metadata, spreads/totals/props. Drives `find_market` resolution. |
| `polymarket-market-1691455-nyk-okc-moneyline.captured-*.json` | `GET /markets/1691455` | The moneyline market for that game. Has `bestAsk`/`lastTradePrice` but no `bestBid`, so it exercises the labeled last-trade fallback for `display_probability`. |
| `polymarket-market-741099-lebron-retire.captured-*.json` | `GET /markets/741099` | An active NBA-tagged market with both `bestBid` and `bestAsk`, exercising the bid/ask midpoint path. |
| `polymarket-events-slug-nba-bos-nyk-2026-07-11-empty.captured-*.json` | `GET /events?slug=nba-bos-nyk-2026-07-11` | `[]` — the Slice 1 demo event has no real market (NBA off-season). Drives the first-class "no matching market" outcome. |
| `polymarket-events-nba-live-window-2026-07-11.captured-*.json` | `GET /events?tag_slug=nba&active=true&closed=false&start_date_min=2026-07-11T00:00:00Z&start_date_max=2026-07-13T00:00:00Z&limit=100` | `[]` — the exact `list_live_events` query for the capture day; no NBA game events exist in July. |
| `polymarket-events-slug-lebron-retire-nongame.captured-*.json` | `GET /events?slug=will-lebron-james-retire-before-next-nba-season` | A real NBA-tagged non-game event, proving `list_live_events` filters out award/prop/free-agency events. |

Prices in these files are frozen at capture time and will not match the live
API; they describe what the provider returned then, not current markets.
