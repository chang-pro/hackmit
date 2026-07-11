// Mock prediction-market adapter (README §7.7).
// Implements the same three operations a real provider adapter will:
// list_live_events / find_market / get_market_snapshot. Everything it returns
// is stamped is_mock: true — fallbacks must remain honest (README §13).
// Swapping in a real provider means adding a sibling adapter, not editing
// callers.

const MOCK_MARKETS = [
  {
    market_id: "market_123",
    event_id: "nba_2026_07_11_bos_nyk",
    outcome: "nba_bos_wins",
    yes_bid: 0.58,
    yes_ask: 0.60,
    liquidity: 12500.0,
  },
  {
    market_id: "market_124",
    event_id: "nba_2026_07_11_bos_nyk",
    outcome: "nba_nyk_wins",
    yes_bid: 0.40,
    yes_ask: 0.42,
    liquidity: 11800.0,
  },
];

export const mockAdapter = {
  provider: "mock",

  list_live_events() {
    return [...new Set(MOCK_MARKETS.map((m) => m.event_id))];
  },

  // Requires a unique (event, outcome) match — contract resolution is part of
  // correctness. Never fuzzy-match.
  find_market(eventId, outcome) {
    const hits = MOCK_MARKETS.filter(
      (m) => m.event_id === eventId && m.outcome === outcome
    );
    if (hits.length !== 1)
      throw new Error(`Expected exactly 1 market for ${eventId}/${outcome}, found ${hits.length}`);
    return hits[0].market_id;
  },

  get_market_snapshot(marketId) {
    const m = MOCK_MARKETS.find((x) => x.market_id === marketId);
    if (!m) throw new Error(`Unknown market: ${marketId}`);
    const now = new Date().toISOString();
    return {
      provider: this.provider,
      market_id: m.market_id,
      event_id: m.event_id,
      outcome: m.outcome,
      yes_bid: m.yes_bid,
      yes_ask: m.yes_ask,
      // Displayed probability = midpoint of best yes bid/ask (README §7.7).
      display_probability: Number(((m.yes_bid + m.yes_ask) / 2).toFixed(4)),
      liquidity: m.liquidity,
      provider_timestamp: now,
      received_at: now,
      is_mock: true,
    };
  },
};
