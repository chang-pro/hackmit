// Mock prediction-market adapter (README §7.7).
// Implements the same three operations a real provider adapter will:
// list_live_events / find_market / get_market_snapshot. Everything it returns
// is stamped is_mock: true — fallbacks must remain honest (README §13).
// Swapping in a real provider means adding a sibling adapter, not editing
// callers.

// A market may carry an optional `price_schedule`: period-accurate prices for
// historical replay demos (the multi-sport fixtures replay famous games, so a
// single static price would be dishonest about what the market looked like at
// that moment). get_market_snapshot picks the first schedule entry whose
// `when` conditions all match the passed game state; without a state match it
// falls back to the top-level yes_bid/yes_ask. All of it is is_mock: true.
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

  // ── Soccer: 2022 World Cup Final, Argentina vs France (replay) ───────────
  // "Argentina wins" here is the match market (a shootout win counts), so in
  // deep extra time at 3–3 it sits near a coin flip — while our model prices
  // only a win before penalties. That gap is the demo's talking point.
  {
    market_id: "market_wc22_arg",
    event_id: "soccer_2022_12_18_arg_fra",
    outcome: "wc_arg_wins",
    yes_bid: 0.55,
    yes_ask: 0.57,
    liquidity: 250000.0,
    price_schedule: [
      { when: { period: 2 }, yes_bid: 0.84, yes_ask: 0.86 }, // 60', ARG 2–0
      { when: { period: 4 }, yes_bid: 0.46, yes_ask: 0.48 }, // 118', 3–3, pens looming
    ],
  },
  {
    market_id: "market_wc22_fra",
    event_id: "soccer_2022_12_18_arg_fra",
    outcome: "wc_fra_wins",
    yes_bid: 0.41,
    yes_ask: 0.43,
    liquidity: 240000.0,
    price_schedule: [
      { when: { period: 2 }, yes_bid: 0.10, yes_ask: 0.12 },
      { when: { period: 4 }, yes_bid: 0.44, yes_ask: 0.46 },
    ],
  },

  // ── NFL: Super Bowl LI, Patriots vs Falcons 28–3 comeback (replay) ───────
  {
    market_id: "market_sb51_ne",
    event_id: "football_2017_02_05_ne_atl",
    outcome: "nfl_ne_wins",
    yes_bid: 0.50,
    yes_ask: 0.52,
    liquidity: 500000.0,
    price_schedule: [
      { when: { period: 3 }, yes_bid: 0.03, yes_ask: 0.05 }, // Q3 8:31, down 28–3
      { when: { period: 4 }, yes_bid: 0.53, yes_ask: 0.57 }, // Q4 0:57, 28–28, momentum
    ],
  },
  {
    market_id: "market_sb51_atl",
    event_id: "football_2017_02_05_ne_atl",
    outcome: "nfl_atl_wins",
    yes_bid: 0.48,
    yes_ask: 0.50,
    liquidity: 480000.0,
    price_schedule: [
      { when: { period: 3 }, yes_bid: 0.95, yes_ask: 0.97 },
      { when: { period: 4 }, yes_bid: 0.43, yes_ask: 0.47 },
    ],
  },

  // ── UFC 229: Khabib vs McGregor (replay) ─────────────────────────────────
  {
    market_id: "market_ufc229_khabib",
    event_id: "ufc_2018_10_06_khabib_mcgregor",
    outcome: "ufc_khabib_wins",
    yes_bid: 0.61,
    yes_ask: 0.63,
    liquidity: 90000.0,
    price_schedule: [
      { when: { period: 2 }, yes_bid: 0.72, yes_ask: 0.74 }, // R2, Khabib dominant
      { when: { period: 4 }, yes_bid: 0.85, yes_ask: 0.87 }, // R4, closing in
    ],
  },
  {
    market_id: "market_ufc229_mcgregor",
    event_id: "ufc_2018_10_06_khabib_mcgregor",
    outcome: "ufc_mcgregor_wins",
    yes_bid: 0.37,
    yes_ask: 0.39,
    liquidity: 85000.0,
    price_schedule: [
      { when: { period: 2 }, yes_bid: 0.26, yes_ask: 0.28 },
      { when: { period: 4 }, yes_bid: 0.13, yes_ask: 0.15 },
    ],
  },

  // ── Golf: 2019 Masters final round, Tiger Woods (replay) ─────────────────
  // Two demo moments track different chasers, hence two two-player events.
  {
    market_id: "market_masters19_tiger_h12",
    event_id: "golf_2019_04_14_tiger_molinari",
    outcome: "pga_tiger_wins",
    yes_bid: 0.48,
    yes_ask: 0.52, // tied for the lead with 6 to play
    liquidity: 60000.0,
  },
  {
    market_id: "market_masters19_molinari",
    event_id: "golf_2019_04_14_tiger_molinari",
    outcome: "pga_molinari_wins",
    yes_bid: 0.44,
    yes_ask: 0.48,
    liquidity: 55000.0,
  },
  {
    market_id: "market_masters19_tiger_h16",
    event_id: "golf_2019_04_14_tiger_koepka",
    outcome: "pga_tiger_wins",
    yes_bid: 0.88,
    yes_ask: 0.90, // two clear with two to play
    liquidity: 70000.0,
  },
  {
    market_id: "market_masters19_koepka",
    event_id: "golf_2019_04_14_tiger_koepka",
    outcome: "pga_koepka_wins",
    yes_bid: 0.09,
    yes_ask: 0.11,
    liquidity: 50000.0,
  },
];

// First schedule entry whose `when` keys all equal the state's values.
function scheduledPrice(market, state) {
  if (!market.price_schedule || !state) return market;
  const hit = market.price_schedule.find((entry) =>
    Object.entries(entry.when).every(([key, value]) => state[key] === value)
  );
  return hit ?? market;
}

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

  // Optional `state` (canonical game state) picks the period-accurate price
  // from a replay market's price_schedule; omitted -> the base price. Real
  // provider adapters ignore the extra argument.
  get_market_snapshot(marketId, state = null) {
    const m = MOCK_MARKETS.find((x) => x.market_id === marketId);
    if (!m) throw new Error(`Unknown market: ${marketId}`);
    const { yes_bid, yes_ask } = scheduledPrice(m, state);
    const now = new Date().toISOString();
    return {
      provider: this.provider,
      market_id: m.market_id,
      event_id: m.event_id,
      outcome: m.outcome,
      yes_bid,
      yes_ask,
      // Displayed probability = midpoint of best yes bid/ask (README §7.7).
      display_probability: Number(((yes_bid + yes_ask) / 2).toFixed(4)),
      liquidity: m.liquidity,
      provider_timestamp: now,
      received_at: now,
      is_mock: true,
    };
  },
};
