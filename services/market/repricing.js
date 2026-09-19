// Background repricing job for ReLoop Market.
//
// Automatically scans active listings and lowers asking prices on stale items
// down toward the seller's floor, emitting REPRICED events.

export class RepricingJob {
  constructor({ market, intervalMs = 60_000, enabled = false, dropPct = 0.05, dropAmount = 5 } = {}) {
    this.market = market;
    this.intervalMs = intervalMs;
    this.dropPct = dropPct;
    this.dropAmount = dropAmount;
    this.timer = null;
    if (enabled) this.start();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Don't keep the Node event loop alive if only this timer is running
    if (this.timer?.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    return this.market.reprice({
      dropPct: this.dropPct,
      dropAmount: this.dropAmount,
    });
  }
}
