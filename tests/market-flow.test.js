import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReLoopServer } from "../services/api/server.js";
import { DraftQueue } from "../services/market/draft-queue.js";
import { EventLog } from "../services/events/event-log.js";

function setupTestServer(t, { marketFile = null, mockDraft = null } = {}) {
  const eventLog = new EventLog();
  const draftQueue = new DraftQueue({
    eventLog,
    draft: mockDraft || (async (item) => ({
      reply: `Created draft for ${item.label} at https://www.facebook.com/marketplace/item/99887766`,
    })),
  });

  const server = createReLoopServer({
    eventLog,
    draftQueue,
    marketFile,
  });

  server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, eventLog, server };
}

test("full market flow: plan -> approve -> drafts -> buyer negotiation -> checkout -> SOLD", async (t) => {
  const { base, eventLog } = setupTestServer(t);

  // 1. Create a plan with items
  const planItems = [
    {
      id: "it_ps4",
      label: "Sony PS4 Slim",
      condition: "good",
      price_usd: 185,
      price_basis: "used PS4 Slim consoles sell around $185",
    },
    {
      id: "it_cables",
      label: "Cables",
      condition: "good",
      price_usd: 5,
      price_basis: "cables under $15 listing threshold",
    },
  ];

  const planRes = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: planItems,
      goal: { mode: "CASH", targetUsd: 200 },
      photo_url: `${base}/api/photos/demo_room`,
    }),
  });
  assert.equal(planRes.status, 201);
  const plan = await planRes.json();
  assert.equal(plan.decisions.length, 2);
  const sellDecision = plan.decisions.find((d) => d.action === "SELL");
  assert.ok(sellDecision);
  assert.ok(sellDecision.itemId.startsWith(plan.id));

  // 2. Approve the plan
  const approveRes = await fetch(`${base}/api/plans/${plan.id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "Cambridge, MA",
    }),
  });
  assert.equal(approveRes.status, 200);
  const approved = await approveRes.json();
  assert.equal(approved.listings.length, 1);
  const listing = approved.listings[0];
  assert.equal(listing.title, "Sony PS4 Slim");
  assert.equal(listing.status, "ACTIVE");

  // Verify Marketplace draft was queued and processed
  const draftsRes = await fetch(`${base}/api/drafts`);
  const drafts = await draftsRes.json();
  assert.equal(drafts.jobs.length, 1);
  assert.equal(drafts.jobs[0].status, "done");
  assert.ok(drafts.jobs[0].url.includes("facebook.com"));

  // Verify catalog has the listing
  const catalogRes = await fetch(`${base}/catalog.json`);
  const catalog = await catalogRes.json();
  assert.equal(catalog.listings.length, 1);
  assert.equal(catalog.listings[0].id, listing.id);

  // 3. Buyer haggles
  const msg1 = await fetch(`${base}/api/listings/${listing.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyer: "agent_alice", text: "Is this available?" }),
  });
  assert.equal(msg1.status, 200);
  const reply1 = await msg1.json();
  assert.ok(reply1.threadId);
  assert.equal(reply1.move, "INFO");

  // Buyer makes an offer within floor
  const msg2 = await fetch(`${base}/api/listings/${listing.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thread_id: reply1.threadId,
      price_usd: listing.listUsd,
      text: `I'll take it for $${listing.listUsd}!`,
    }),
  });
  assert.equal(msg2.status, 200);
  const reply2 = await msg2.json();
  assert.equal(reply2.move, "ACCEPT");

  // 4. Checkout
  const checkoutRes = await fetch(`${base}/api/listings/${listing.id}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: reply1.threadId }),
  });
  assert.equal(checkoutRes.status, 200);
  const sale = await checkoutRes.json();
  assert.equal(sale.listing.status, "SOLD");
  assert.equal(sale.listing.soldUsd, listing.listUsd);

  // 5. Verify SOLD event in dashboard fold
  const dashRes = await fetch(`${base}/api/dashboard`);
  const dash = await dashRes.json();
  assert.equal(dash.counts.sold, 1);
  assert.equal(dash.recoveredUsd, listing.listUsd);
});

test("repricing endpoint lowers prices on active listings down to floor", async (t) => {
  const { base } = setupTestServer(t);

  // Seed demo listings (PS4 list $190, floor $160)
  await fetch(`${base}/api/events/seed`, { method: "POST" });

  const catalogBefore = await (await fetch(`${base}/catalog.json`)).json();
  const ps4Before = catalogBefore.listings.find((l) => l.title.includes("PS4"));
  assert.equal(ps4Before.listUsd, 190);

  // Trigger repricing
  const repriceRes = await fetch(`${base}/api/market/reprice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drop_pct: 0.10 }),
  });
  assert.equal(repriceRes.status, 200);
  const repriceResult = await repriceRes.json();
  assert.ok(repriceResult.repriced.length > 0);

  const catalogAfter = await (await fetch(`${base}/catalog.json`)).json();
  const ps4After = catalogAfter.listings.find((l) => l.title.includes("PS4"));
  assert.ok(ps4After.listUsd < 190);
  assert.ok(ps4After.listUsd >= 160);
});

test("market state survives server restart via disk persistence", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "reloop-market-test-"));
  const marketFile = join(tmpDir, "market_state.json");
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  // Run server 1 and seed demo data
  {
    const { base, server } = setupTestServer(t, { marketFile });
    const seedRes = await fetch(`${base}/api/events/seed`, { method: "POST" });
    assert.equal(seedRes.status, 200);

    const catalog = await (await fetch(`${base}/catalog.json`)).json();
    assert.equal(catalog.listings.length, 4);
    server.close();
  }

  // Run server 2 with same marketFile
  {
    const { base } = setupTestServer(t, { marketFile });
    const catalog = await (await fetch(`${base}/catalog.json`)).json();
    assert.equal(catalog.listings.length, 4);
    assert.ok(catalog.listings.some((l) => l.title === "Sony PS4 Slim"));
  }
});

test("photo endpoint serves demo fallbacks without 404", async (t) => {
  const { base } = setupTestServer(t);

  const res1 = await fetch(`${base}/api/photos/demo_ps4`);
  assert.equal(res1.status, 200);
  assert.equal(res1.headers.get("content-type"), "image/jpeg");
  const bytes = Buffer.from(await res1.arrayBuffer());
  assert.ok(bytes.length > 0);
});
