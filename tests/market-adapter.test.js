// Slice 5: Polymarket adapter + registry tests.
//
// Network-free by construction: a stub fetch replays the REAL Gamma API
// responses recorded in packages/fixtures/market/ (see its README for capture
// times). Every expected price below is computed from the recorded payloads,
// never hard-coded from imagination.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPolymarketAdapter,
  NoMatchingMarketError,
  AmbiguousMarketError,
} from "../services/market/polymarket-adapter.js";
import { getAdapter, marketAdapter } from "../services/market/index.js";
import { mockAdapter } from "../services/market/mock-adapter.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "packages", "fixtures", "market"
);

function loadFixture(prefix) {
  const file = readdirSync(FIXTURE_DIR).find(
    (f) => f.startsWith(prefix) && f.endsWith(".json")
  );
  assert.ok(file, `missing recorded fixture ${prefix}*.json`);
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
}

const gameEvent = loadFixture("polymarket-events-slug-nba-nyk-okc-2026-03-29");
const moneylineMarket = loadFixture("polymarket-market-1691455");
const midpointMarket = loadFixture("polymarket-market-741099");
const emptySlugResponse = loadFixture("polymarket-events-slug-nba-bos-nyk-2026-07-11-empty");
const liveWindowResponse = loadFixture("polymarket-events-nba-live-window-2026-07-11");
const nonGameEvent = loadFixture("polymarket-events-slug-lebron-retire-nongame");

// Serves recorded responses by URL; anything unrouted fails the test loudly.
function stubFetch(routes) {
  return async (url) => {
    for (const [match, body] of routes) {
      if (url.includes(match)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    throw new Error(`test stub has no route for ${url} — tests must not hit the network`);
  };
}

function adapterWith(routes) {
  return createPolymarketAdapter({ fetchImpl: stubFetch(routes) });
}

// --- find_market -----------------------------------------------------------

test("find_market resolves a real game event to its unique moneyline contract", async () => {
  const adapter = adapterWith([["slug=nba-nyk-okc-2026-03-29", gameEvent]]);
  const gammaId = gameEvent[0].markets.find((m) => m.sportsMarketType === "moneyline").id;

  const away = await adapter.find_market("nba_2026_03_29_nyk_okc", "nba_nyk_wins");
  assert.equal(away, `polymarket:${gammaId}:0:nba_2026_03_29_nyk_okc:nba_nyk_wins`);

  const home = await adapter.find_market("nba_2026_03_29_nyk_okc", "nba_okc_wins");
  assert.equal(home, `polymarket:${gammaId}:1:nba_2026_03_29_nyk_okc:nba_okc_wins`);
});

test("no listed event is a first-class, clearly-messaged outcome (off-season)", async () => {
  const adapter = adapterWith([["slug=nba-bos-nyk-2026-07-11", emptySlugResponse]]);
  await assert.rejects(
    adapter.find_market("nba_2026_07_11_bos_nyk", "nba_bos_wins"),
    (err) => {
      assert.ok(err instanceof NoMatchingMarketError);
      assert.equal(err.code, "no_matching_market");
      assert.match(err.message, /No Polymarket event is listed for nba_2026_07_11_bos_nyk/);
      assert.match(err.safeMessage, /no comparison is available/);
      return true;
    }
  );
});

test("find_market rejects an outcome for a team not in the game", async () => {
  const adapter = adapterWith([["slug=nba-nyk-okc-2026-03-29", gameEvent]]);
  await assert.rejects(
    adapter.find_market("nba_2026_03_29_nyk_okc", "nba_lal_wins"),
    NoMatchingMarketError
  );
});

test("find_market never guesses between duplicate moneyline candidates", async () => {
  // Control-flow guard test: the real event with its real moneyline market
  // listed twice must trip the uniqueness rule, same as the mock's.
  const event = gameEvent[0];
  const ml = event.markets.find((m) => m.sportsMarketType === "moneyline");
  const doubled = [{ ...event, markets: [...event.markets, { ...ml }] }];
  const adapter = adapterWith([["slug=nba-nyk-okc-2026-03-29", doubled]]);
  await assert.rejects(
    adapter.find_market("nba_2026_03_29_nyk_okc", "nba_nyk_wins"),
    AmbiguousMarketError
  );
});

// --- get_market_snapshot normalization --------------------------------------

test("snapshot normalizes a recorded market with only ask+last to a labeled last-trade probability", async () => {
  const adapter = adapterWith([["/markets/1691455", moneylineMarket]]);
  const snap = await adapter.get_market_snapshot(
    "polymarket:1691455:0:nba_2026_03_29_nyk_okc:nba_nyk_wins"
  );

  // Recorded payload has bestAsk and lastTradePrice but no bestBid, so the
  // midpoint is undefined and the last trade must be used — and labeled.
  assert.equal(moneylineMarket.bestBid, undefined);
  assert.equal(snap.yes_bid, null);
  assert.equal(snap.yes_ask, moneylineMarket.bestAsk);
  assert.equal(snap.display_probability, Number(moneylineMarket.lastTradePrice.toFixed(4)));
  assert.equal(snap.display_probability_source, "last_trade");

  assert.equal(snap.provider, "polymarket");
  assert.equal(snap.event_id, "nba_2026_03_29_nyk_okc");
  assert.equal(snap.outcome, "nba_nyk_wins");
  assert.equal(snap.outcome_name, JSON.parse(moneylineMarket.outcomes)[0]);
  assert.equal(snap.is_mock, false);
  assert.equal(snap.provider_timestamp, moneylineMarket.updatedAt);
  assert.ok(!Number.isNaN(Date.parse(snap.received_at)), "received_at is a timestamp");
});

test("snapshot prices the opposite outcome as the complement of the quoted side", async () => {
  const adapter = adapterWith([["/markets/1691455", moneylineMarket]]);
  const snap = await adapter.get_market_snapshot(
    "polymarket:1691455:1:nba_2026_03_29_nyk_okc:nba_okc_wins"
  );

  // Gamma quotes outcomes[0]; outcomes[1] is 1 - price, with bid/ask swapped.
  assert.equal(snap.yes_bid, Number((1 - moneylineMarket.bestAsk).toFixed(4)));
  assert.equal(snap.yes_ask, null); // no bestBid recorded -> no ask for side 1
  assert.equal(
    snap.display_probability,
    Number((1 - moneylineMarket.lastTradePrice).toFixed(4))
  );
  assert.equal(snap.display_probability_source, "last_trade");
  assert.equal(snap.outcome_name, JSON.parse(moneylineMarket.outcomes)[1]);
});

test("snapshot uses the bid/ask midpoint when both recorded quotes exist", async () => {
  const adapter = adapterWith([["/markets/741099", midpointMarket]]);
  const snap = await adapter.get_market_snapshot(
    "polymarket:741099:0:nba_2026_07_11_test_test:nba_test_wins"
  );

  assert.ok(midpointMarket.bestBid != null && midpointMarket.bestAsk != null);
  assert.equal(snap.yes_bid, midpointMarket.bestBid);
  assert.equal(snap.yes_ask, midpointMarket.bestAsk);
  assert.equal(
    snap.display_probability,
    Number(((midpointMarket.bestBid + midpointMarket.bestAsk) / 2).toFixed(4))
  );
  assert.equal(snap.display_probability_source, "bid_ask_midpoint");
  assert.ok(snap.display_probability >= 0 && snap.display_probability <= 1);
  assert.equal(snap.is_mock, false);
});

// --- list_live_events --------------------------------------------------------

test("list_live_events returns an empty list during the off-season (recorded window)", async () => {
  const adapter = adapterWith([["tag_slug=nba", liveWindowResponse]]);
  const events = await adapter.list_live_events("nba", {
    from: "2026-07-11T00:00:00Z",
    to: "2026-07-13T00:00:00Z",
  });
  assert.deepEqual(events, []); // first-class outcome, no throw
});

test("list_live_events maps game slugs to internal event IDs and skips non-game events", async () => {
  const adapter = adapterWith([
    ["tag_slug=nba", [...gameEvent, ...nonGameEvent]],
  ]);
  const events = await adapter.list_live_events("nba", {
    from: "2026-03-29T00:00:00Z",
    to: "2026-03-30T00:00:00Z",
  });
  assert.deepEqual(events, ["nba_2026_03_29_nyk_okc"]);
});

// --- registry ----------------------------------------------------------------

test("registry defaults to the mock provider", () => {
  assert.equal(getAdapter().provider, "mock");
  assert.equal(getAdapter(), mockAdapter);
  assert.equal(marketAdapter.provider, "mock"); // MARKET_PROVIDER unset in tests
});

test("registry selects polymarket by name and rejects unknown providers", () => {
  assert.equal(getAdapter("polymarket").provider, "polymarket");
  assert.throws(() => getAdapter("nope"), /Unknown market provider "nope"/);
});
