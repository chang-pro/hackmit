// Market adapter registry (README §7.7): every provider implements the same
// three operations, and callers pick one by name — never by importing a
// provider file directly. The mock stays the default so offline demos and
// tests never need the network (README §11 Slice 5, §13).

import { mockAdapter } from "./mock-adapter.js";
import { polymarketAdapter } from "./polymarket-adapter.js";

const ADAPTERS = {
  mock: mockAdapter,
  polymarket: polymarketAdapter,
};

export function getAdapter(name = process.env.MARKET_PROVIDER || "mock") {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(
      `Unknown market provider "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}. ` +
        `Set MARKET_PROVIDER or leave it unset for the mock.`
    );
  }
  return adapter;
}

// Resolved once at startup from MARKET_PROVIDER (default "mock").
export const marketAdapter = getAdapter();
