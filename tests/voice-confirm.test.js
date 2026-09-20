import test from "node:test";
import assert from "node:assert/strict";
import { createReLoopServer } from "../services/api/server.js";
import { DraftQueue } from "../services/market/draft-queue.js";
import { EventLog } from "../services/events/event-log.js";
import { buildSetup, isAffirmative, mintLiveToken } from "../services/voice/confirm-session.js";

const ITEMS = [
  { id: "it_ps4", label: "Sony PS4 Slim", condition: "good", price_usd: 185, price_basis: "used PS4 Slim consoles sell around $185" },
  { id: "it_lamp", label: "Desk Lamp", condition: "good", price_usd: 40, price_basis: "similar lamps sell around $40" },
];

function setup(t, { mintVoiceToken } = {}) {
  const eventLog = new EventLog();
  const published = [];
  const server = createReLoopServer({
    eventLog,
    draftQueue: new DraftQueue({ eventLog, draft: async () => ({ reply: "drafted" }) }),
    marketFile: null,
    marketplaceDrafts: false,
    // Stubbed so no test can reach the live store or Google.
    publish: async (item) => { published.push(item); return { success: true, dry_run: true, product: { id: "gid://shopify/Product/1", url: "https://example.test/p" } }; },
    mintVoiceToken: mintVoiceToken ?? (async () => ({ token: "auth_tokens/test", expiresAt: "2030-01-01T00:00:00.000Z" })),
  });
  server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body = {}) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { post, published };
}

async function newPlan(post) {
  const { status, body } = await post("/api/plans", { items: ITEMS, goal: {} });
  assert.equal(status, 201);
  return body;
}

test("a clear yes is affirmative; hedged, negated and mixed answers are not", () => {
  for (const yes of ["Yes", "yeah go ahead", "Looks good, publish it", "confirm", "Yep, that's right."]) {
    assert.equal(isAffirmative(yes), true, yes);
  }
  for (const no of ["", "no", "yes but change the lamp", "wait", "not yet", "actually make it 150", "don't publish", "hmm", "what about the lamp"]) {
    assert.equal(isAffirmative(no), false, no);
  }
});

test("revising a price bumps the revision and keeps the total in step", async (t) => {
  const { post } = setup(t);
  const plan = await newPlan(post);
  const ps4 = plan.decisions.find((d) => d.label === "Sony PS4 Slim");
  assert.equal(plan.revision ?? 0, 0);

  const { status, body } = await post(`/api/plans/${plan.id}/revise`, { item_id: ps4.itemId, list_usd: 150, condition: "Like New" });
  assert.equal(status, 200);
  const revised = body.decisions.find((d) => d.itemId === ps4.itemId);
  assert.equal(revised.listUsd, 150);
  assert.equal(revised.condition, "like_new");
  assert.equal(body.revision, 1);
  // Expected is what it should sell for, which sits under the list price and
  // comes down with it.
  assert.ok(body.expectedUsd < plan.expectedUsd, "a lower price lowers the expected total");
  assert.ok(body.expectedUsd <= body.decisions.filter((d) => d.action === "SELL").reduce((sum, d) => sum + d.listUsd, 0));
});

test("keeping an item takes it out of the total, and it can be sold after all", async (t) => {
  const { post } = setup(t);
  const plan = await newPlan(post);
  const lamp = plan.decisions.find((d) => d.label === "Desk Lamp");
  assert.equal(lamp.action, "SELL");

  const kept = (await post(`/api/plans/${plan.id}/revise`, { item_id: lamp.itemId, action: "KEEP" })).body;
  assert.equal(kept.decisions.find((d) => d.itemId === lamp.itemId).action, "KEEP");
  // Default goal plans on the normal tier, so that is what the lamp contributed.
  assert.equal(kept.expectedUsd, plan.expectedUsd - Math.max(2, lamp.band.normalUsd));

  const back = (await post(`/api/plans/${plan.id}/revise`, { item_id: lamp.itemId, action: "SELL" })).body;
  assert.equal(back.expectedUsd, plan.expectedUsd);
  assert.equal(back.revision, 2);
});

test("bad revisions are refused without changing the plan", async (t) => {
  const { post } = setup(t);
  const plan = await newPlan(post);
  const ps4 = plan.decisions[0];
  assert.equal((await post(`/api/plans/${plan.id}/revise`, { item_id: "nope", list_usd: 10 })).status, 404);
  assert.equal((await post(`/api/plans/${plan.id}/revise`, { item_id: ps4.itemId, list_usd: -5 })).status, 400);
  assert.equal((await post(`/api/plans/${plan.id}/revise`, { item_id: ps4.itemId, action: "BURN" })).status, 400);
  const approved = await post(`/api/plans/${plan.id}/approve`, { expected_revision: 0 });
  assert.equal(approved.status, 200, "revision is still 0, so nothing was changed by the refused calls");
});

test("a voice approval needs a clear yes and the revision that was read back", async (t) => {
  const { post, published } = setup(t);
  const plan = await newPlan(post);

  // The model asking is not enough: no words, no publish.
  assert.equal((await post(`/api/plans/${plan.id}/approve`, { via: "voice", expected_revision: 0 })).status, 409);
  assert.equal((await post(`/api/plans/${plan.id}/approve`, { via: "voice", expected_revision: 0, heard: "yes but change the lamp" })).status, 409);
  assert.equal((await post(`/api/plans/${plan.id}/approve`, { via: "voice", heard: "yes" })).status, 400);

  // They said yes to revision 0, then the price changed: that yes is stale.
  await post(`/api/plans/${plan.id}/revise`, { item_id: plan.decisions[0].itemId, list_usd: 170 });
  const stale = await post(`/api/plans/${plan.id}/approve`, { via: "voice", expected_revision: 0, heard: "yes" });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since it was confirmed/);
  assert.equal(published.length, 0, "nothing reached the store through any refused approval");

  const ok = await post(`/api/plans/${plan.id}/approve`, { via: "voice", expected_revision: 1, heard: "Yes, go ahead." });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.listings.find((l) => l.title === plan.decisions[0].label).listUsd, 170);
});

test("the voice session hands the page a token and a setup locked to this plan, never the key", async (t) => {
  const { post } = setup(t);
  const plan = await newPlan(post);
  const { status, body } = await post(`/api/plans/${plan.id}/voice`);
  assert.equal(status, 201);
  assert.equal(body.token, "auth_tokens/test");
  assert.match(body.ws_url, /BidiGenerateContentConstrained$/);
  assert.deepEqual(body.setup.tools[0].functionDeclarations.map((f) => f.name), ["revise_item", "request_approval", "cancel"]);
  const instruction = body.setup.systemInstruction.parts[0].text;
  for (const d of plan.decisions.filter((x) => x.action === "SELL")) {
    assert.ok(instruction.includes(d.itemId) && instruction.includes(`$${d.listUsd}`), `readback covers ${d.label}`);
  }
  assert.ok(!JSON.stringify(body).includes("AIza"), "no API key in the payload");

  await post(`/api/plans/${plan.id}/approve`, {});
  assert.equal((await post(`/api/plans/${plan.id}/voice`)).status, 409, "an approved plan has nothing left to confirm");
});

test("voice is reported unavailable, not broken, when there is no key or Google refuses", async (t) => {
  await assert.rejects(mintLiveToken({ apiKey: "" }), (err) => err.statusCode === 503);
  const refused = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "API key not valid" } }) });
  await assert.rejects(mintLiveToken({ apiKey: "k", fetchImpl: refused }), (err) => err.statusCode === 502 && /API key not valid/.test(err.message));

  const { post } = setup(t, { mintVoiceToken: () => mintLiveToken({ apiKey: "" }) });
  const plan = await newPlan(post);
  const res = await post(`/api/plans/${plan.id}/voice`);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /GEMINI_API_KEY/);
});

test("the setup asks for both transcripts, since the person's words are what authorise a publish", () => {
  const setupMsg = buildSetup({ decisions: [{ itemId: "p_01", label: "Lamp", condition: "good", action: "SELL", listUsd: 40 }], expectedUsd: 40 });
  assert.deepEqual(setupMsg.inputAudioTranscription, {});
  assert.deepEqual(setupMsg.outputAudioTranscription, {});
  assert.deepEqual(setupMsg.generationConfig.responseModalities, ["AUDIO"]);
});
