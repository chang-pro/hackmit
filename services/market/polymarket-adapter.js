// Real prediction-market adapter: Polymarket Gamma API (README §7.7, Slice 5).
//
// Provider choice: Polymarket's Gamma API (https://gamma-api.polymarket.com)
// serves market data publicly with no authentication, and lists NBA game
// events with a moneyline market whose outcomes are the two team names.
// Kalshi's market-data endpoints require an API key for most useful reads,
// so Polymarket is the first real provider.
//
// Provider-specific naming stays inside this file:
//   - Game events are slugged `nba-{away}-{home}-{YYYY-MM-DD}`
//     (e.g. "nba-nyk-okc-2026-03-29", title "Knicks vs. Thunder").
//     Our internal event IDs are `nba_{YYYY}_{MM}_{DD}_{away}_{home}`,
//     so the mapping is deterministic in both directions.
//   - The moneyline market has `sportsMarketType: "moneyline"` and
//     `outcomes` = [awayTeamName, homeTeamName]. `bestBid` / `bestAsk` /
//     `lastTradePrice` are quoted for outcomes[0]; the other side is the
//     complement (1 - price).
//   - The event's `teams` array carries `abbreviation` and `ordering`
//     ("away"/"home"), which is how internal outcomes like "nba_bos_wins"
//     resolve to one outcome index.
//
// "No matching events" is a first-class outcome, not a crash: during the NBA
// off-season (like now) there are simply no live game markets. list_live_events
// returns an empty list, and find_market throws NoMatchingMarketError with a
// clear, user-presentable message and a stable `code` — never a TypeError from
// assuming data exists.
//
// Product language (README §6): everything here is a market-implied
// probability with timestamps. Nothing in this adapter claims an edge.

const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 10_000;

// Internal ID grammar (README §7.4): nba_2026_03_29_nyk_okc / nba_nyk_wins.
const EVENT_ID_RE = /^([a-z0-9]+)_(\d{4})_(\d{2})_(\d{2})_([a-z0-9]{2,5})_([a-z0-9]{2,5})$/;
const GAME_SLUG_RE = /^([a-z0-9]+)-([a-z0-9]{2,5})-([a-z0-9]{2,5})-(\d{4})-(\d{2})-(\d{2})$/;
const OUTCOME_RE = /^[a-z0-9]+_([a-z0-9]{2,5})_wins$/;

// The event (or its unique market/outcome) is not listed on the provider.
// Expected during off-season or before markets open — callers should present
// safeMessage instead of a comparison (README §7.9).
export class NoMatchingMarketError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoMatchingMarketError";
    this.code = "no_matching_market";
    this.safeMessage =
      "Game identified, but no matching prediction market is listed right now, so no comparison is available.";
  }
}

// More than one candidate market or outcome matched. Never guess between
// candidates — contract resolution is part of correctness (README §7.7).
export class AmbiguousMarketError extends Error {
  constructor(message) {
    super(message);
    this.name = "AmbiguousMarketError";
    this.code = "ambiguous_market";
  }
}

function eventIdToSlug(eventId) {
  const m = EVENT_ID_RE.exec(eventId);
  if (!m) {
    throw new NoMatchingMarketError(
      `Event ID "${eventId}" does not match the expected form ` +
        `"league_yyyy_mm_dd_away_home", so it cannot be resolved to a Polymarket event.`
    );
  }
  const [, league, yyyy, mm, dd, away, home] = m;
  return `${league}-${away}-${home}-${yyyy}-${mm}-${dd}`;
}

function slugToEventId(slug) {
  const m = GAME_SLUG_RE.exec(slug ?? "");
  if (!m) return null; // Not a game event (award, prop, free-agency, ...).
  const [, league, away, home, yyyy, mm, dd] = m;
  return `${league}_${yyyy}_${mm}_${dd}_${away}_${home}`;
}

// Opaque market ID handed back to callers. Encodes everything
// get_market_snapshot needs to stay stateless. Callers must not parse it.
function makeMarketToken(gammaMarketId, outcomeIndex, eventId, outcome) {
  return `polymarket:${gammaMarketId}:${outcomeIndex}:${eventId}:${outcome}`;
}

function parseMarketToken(marketId) {
  const parts = String(marketId).split(":");
  if (parts.length !== 5 || parts[0] !== "polymarket") {
    throw new Error(`Not a Polymarket market ID: "${marketId}"`);
  }
  const [, gammaMarketId, indexText, eventId, outcome] = parts;
  const outcomeIndex = Number(indexText);
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 1) {
    throw new Error(`Invalid outcome index in market ID: "${marketId}"`);
  }
  return { gammaMarketId, outcomeIndex, eventId, outcome };
}

async function fetchJson(fetchImpl, url) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Polymarket request failed (${url}): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Polymarket request failed (${url}): HTTP ${res.status}`);
  }
  return res.json();
}

function round4(x) {
  return Number(x.toFixed(4));
}

// Gamma quotes bestBid/bestAsk/lastTradePrice for outcomes[0]. The price of
// outcomes[1] in a binary market is the complement, and bid/ask swap sides.
function sidePrices(market, outcomeIndex) {
  const bid0 = market.bestBid ?? null;
  const ask0 = market.bestAsk ?? null;
  const last0 = market.lastTradePrice ?? null;
  if (outcomeIndex === 0) return { yes_bid: bid0, yes_ask: ask0, last: last0 };
  return {
    yes_bid: ask0 == null ? null : round4(1 - ask0),
    yes_ask: bid0 == null ? null : round4(1 - bid0),
    last: last0 == null ? null : round4(1 - last0),
  };
}

// `fetchImpl` is injectable so tests replay recorded fixture responses
// (packages/fixtures/market/) without any network access.
export function createPolymarketAdapter({
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  return {
    provider: "polymarket",

    // Returns internal event IDs for game events starting inside the window.
    // An empty array is the normal answer when nothing is listed (for example
    // the NBA off-season) — callers must treat it as "no live events", not
    // as an error.
    async list_live_events(league = "nba", timeWindow = {}) {
      const from =
        timeWindow.from ?? new Date(Date.now() - 6 * 3_600_000).toISOString();
      const to =
        timeWindow.to ?? new Date(Date.now() + 24 * 3_600_000).toISOString();
      const url =
        `${baseUrl}/events?tag_slug=${encodeURIComponent(league)}` +
        `&active=true&closed=false` +
        `&start_date_min=${encodeURIComponent(from)}` +
        `&start_date_max=${encodeURIComponent(to)}&limit=100`;
      const events = await fetchJson(fetchImpl, url);
      // Only game events match the away-home-date slug grammar; award, prop,
      // and free-agency events fall out here by design.
      return events.map((e) => slugToEventId(e.slug)).filter(Boolean);
    },

    // Resolves (event, outcome) to exactly one moneyline contract side.
    // Requires a unique match at every step — same rule as the mock.
    async find_market(eventId, outcome) {
      const slug = eventIdToSlug(eventId);
      const events = await fetchJson(
        fetchImpl,
        `${baseUrl}/events?slug=${encodeURIComponent(slug)}`
      );
      if (events.length === 0) {
        throw new NoMatchingMarketError(
          `No Polymarket event is listed for ${eventId} (slug "${slug}"). ` +
            `The game may not have a market yet, or the league may be out of season.`
        );
      }
      if (events.length > 1) {
        throw new AmbiguousMarketError(
          `Expected exactly 1 Polymarket event for slug "${slug}", found ${events.length}.`
        );
      }
      const event = events[0];

      const moneylines = (event.markets ?? []).filter(
        (m) => m.sportsMarketType === "moneyline"
      );
      if (moneylines.length === 0) {
        throw new NoMatchingMarketError(
          `Polymarket event "${slug}" has no moneyline market, so ${outcome} cannot be priced.`
        );
      }
      if (moneylines.length > 1) {
        throw new AmbiguousMarketError(
          `Expected exactly 1 moneyline market for ${eventId}, found ${moneylines.length}.`
        );
      }
      const market = moneylines[0];

      const om = OUTCOME_RE.exec(outcome);
      if (!om) {
        throw new NoMatchingMarketError(
          `Outcome "${outcome}" does not match the expected form "league_team_wins".`
        );
      }
      const abbrev = om[1];
      const teams = (event.teams ?? []).filter(
        (t) => (t.abbreviation ?? "").toLowerCase() === abbrev
      );
      if (teams.length !== 1) {
        throw new NoMatchingMarketError(
          `Expected exactly 1 team with abbreviation "${abbrev}" on Polymarket event "${slug}", ` +
            `found ${teams.length}.`
        );
      }
      const team = teams[0];

      const outcomeNames = JSON.parse(market.outcomes ?? "[]");
      const indices = outcomeNames
        .map((name, i) => ({ name, i }))
        .filter(({ name }) => name === team.name || name === team.alias)
        .map(({ i }) => i);
      if (indices.length !== 1) {
        throw new AmbiguousMarketError(
          `Expected exactly 1 moneyline outcome matching team "${team.name}" ` +
            `on Polymarket event "${slug}", found ${indices.length} in ${market.outcomes}.`
        );
      }

      return makeMarketToken(market.id, indices[0], eventId, outcome);
    },

    // Normalizes one Gamma market read into the §7.7 MarketSnapshot contract.
    // display_probability is the bid/ask midpoint when both quotes exist;
    // otherwise it falls back to the last trade and is labeled as such via
    // display_probability_source (README §7.7: label last-trade prices).
    async get_market_snapshot(marketId) {
      const { gammaMarketId, outcomeIndex, eventId, outcome } =
        parseMarketToken(marketId);
      const market = await fetchJson(
        fetchImpl,
        `${baseUrl}/markets/${encodeURIComponent(gammaMarketId)}`
      );
      if (!market || !market.id) {
        throw new NoMatchingMarketError(
          `Polymarket market ${gammaMarketId} was not found.`
        );
      }
      const outcomeNames = JSON.parse(market.outcomes ?? "[]");
      if (outcomeNames.length !== 2) {
        throw new Error(
          `Polymarket market ${gammaMarketId} is not binary (outcomes: ${market.outcomes}); ` +
            `complement pricing does not apply.`
        );
      }

      const { yes_bid, yes_ask, last } = sidePrices(market, outcomeIndex);

      let display_probability = null;
      let display_probability_source = "unavailable";
      if (yes_bid != null && yes_ask != null) {
        display_probability = round4((yes_bid + yes_ask) / 2);
        display_probability_source = "bid_ask_midpoint";
      } else if (last != null) {
        display_probability = round4(last);
        display_probability_source = "last_trade";
      }

      return {
        provider: "polymarket",
        market_id: marketId,
        event_id: eventId,
        outcome,
        outcome_name: outcomeNames[outcomeIndex] ?? null,
        yes_bid,
        yes_ask,
        display_probability,
        display_probability_source,
        liquidity: market.liquidityNum ?? market.liquidityClob ?? null,
        accepting_orders: market.acceptingOrders ?? null,
        market_closed: market.closed ?? null,
        provider_timestamp: market.updatedAt ?? null,
        received_at: new Date().toISOString(),
        is_mock: false,
      };
    },
  };
}

export const polymarketAdapter = createPolymarketAdapter();
