// HTTP contract tests for the multi-sport API surface: /api/sports,
// sport-aware /api/comparison, POST /api/frames with a sport tag, and the
// saved-stats endpoints. The server factory runs on an ephemeral port —
// no fixed-port collisions, no network beyond localhost.
import test from "node:test";
import assert from "node:assert/strict";
import { createBloomServer } from "../services/api/server.js";

async function withServer(fn) {
  const server = createBloomServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/sports lists all five sports with fixtures and demo moments", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/sports`);
    assert.equal(res.status, 200);
    const sports = await res.json();
    assert.ok(Array.isArray(sports));
    assert.deepEqual(
      sports.map((s) => s.id).sort(),
      ["football", "golf", "nba", "soccer", "ufc"]
    );
    for (const s of sports) {
      assert.equal(typeof s.label, "string");
      assert.equal(typeof s.league, "string");
      assert.equal(typeof s.default_fixture, "string");
      assert.ok(Array.isArray(s.fixtures) && s.fixtures.length >= 2);
      assert.ok(Array.isArray(s.demo_moments) && s.demo_moments.length >= 2);
      for (const m of s.demo_moments) {
        assert.ok(s.fixtures.includes(m.fixture));
        assert.equal(typeof m.label, "string");
      }
    }
    const nba = sports.find((s) => s.id === "nba");
    assert.equal(nba.default, true, "nba is flagged as the default sport");
  });
});

test("GET /api/comparison stays backward compatible (no sport param = NBA)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/comparison`);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.sport, "nba");
    assert.equal(out.event.event_id, "nba_2026_07_11_bos_nyk");
    assert.equal(out.estimate.outcome, "nba_bos_wins");
    assert.equal(out.presentation.status, "ready");
  });
});

test("GET /api/comparison?sport=<id> runs each sport's default fixture", async () => {
  await withServer(async (base) => {
    const expectations = {
      soccer: { event: "soccer_2022_12_18_arg_fra", outcome: "wc_arg_wins" },
      football: { event: "football_2017_02_05_ne_atl", outcome: "nfl_ne_wins" },
      ufc: { event: "ufc_2018_10_06_khabib_mcgregor", outcome: "ufc_khabib_wins" },
      golf: { event: "golf_2019_04_14_tiger_molinari", outcome: "pga_tiger_wins" },
    };
    for (const [sportId, expected] of Object.entries(expectations)) {
      const res = await fetch(`${base}/api/comparison?sport=${sportId}`);
      assert.equal(res.status, 200, sportId);
      const out = await res.json();
      assert.equal(out.sport, sportId);
      assert.equal(out.event.event_id, expected.event);
      assert.equal(out.estimate.outcome, expected.outcome);
      assert.equal(out.market.is_mock, true, "replay markets are labeled");
      assert.equal(out.presentation.status, "ready");
    }
  });
});

test("GET /api/comparison validates sport and per-sport fixture allowlists", async () => {
  await withServer(async (base) => {
    const badSport = await fetch(`${base}/api/comparison?sport=cricket`);
    assert.equal(badSport.status, 400);
    assert.match((await badSport.json()).error, /Unknown sport/);

    // A real fixture, but for another sport — rejected, never path-resolved.
    const crossSport = await fetch(`${base}/api/comparison?sport=nba&fixture=ufc229_r2`);
    assert.equal(crossSport.status, 400);
    assert.match((await crossSport.json()).error, /unknown fixture for sport "nba"/);

    const explicit = await fetch(`${base}/api/comparison?sport=football&fixture=sb51_q4_057`);
    assert.equal(explicit.status, 200);
    const out = await explicit.json();
    assert.equal(out.state.away_score, 28);
    assert.equal(out.state.period, 4);
  });
});

test("POST /api/frames auto-detects by default and treats sport only as an optional hint", async () => {
  await withServer(async (base) => {
    const submit = (body) =>
      fetch(`${base}/api/frames`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const frame = {
      source: "webcam",
      image_base64: "dGVzdC1mcmFtZS1ieXRlcw==",
      width: 1280,
      height: 720,
    };

    const noSport = await submit(frame);
    // Accepted frames enter the quota-aware analyzer batch: 202 while queued,
    // 201 once a batch is analyzed. Both mean "ingested".
    assert.ok([201, 202].includes(noSport.status), `got ${noSport.status}`);
    const noSportBody = await noSport.json();
    assert.equal(noSportBody.sport, "auto", "omitted sport leaves detection to vision");
    assert.equal(noSportBody.selection.accepted, true);

    const tagged = await submit({ ...frame, image_base64: "b3RoZXItYnl0ZXM=", sport: "ufc" });
    // Rate-limited (same selector) is fine — the sport must still be echoed.
    const taggedBody = await tagged.json();
    assert.equal(taggedBody.sport, "ufc");

    const openEndedSport = await submit({ ...frame, image_base64: "Y3JpY2tldA==", sport: "cricket" });
    assert.ok([200, 201, 202].includes(openEndedSport.status));
    assert.equal((await openEndedSport.json()).sport, "cricket");
  });
});

test("GET /api/stats serves saved snapshots only (data or an honest reason)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/stats`);
    assert.equal(res.status, 200);
    const { sports } = await res.json();
    assert.deepEqual(Object.keys(sports).sort(), ["football", "golf", "soccer", "ufc"]);
    for (const [id, entry] of Object.entries(sports)) {
      if (entry.data === null) {
        assert.equal(typeof entry.reason, "string", `${id} needs a reason when empty`);
      } else {
        assert.equal(entry.data.sport, id);
        assert.equal(typeof entry.data.event_count, "number");
        assert.ok(Array.isArray(entry.data.events));
        assert.equal(typeof entry.pulled_at, "string");
      }
    }
  });
});

test("GET /api/stats/raw validates the sport and returns the full snapshot when present", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/stats/raw?sport=nba`);
    assert.equal(bad.status, 400, "nba has no ESPN pull — not a stats sport");

    const res = await fetch(`${base}/api/stats/raw?sport=golf`);
    assert.ok([200, 404].includes(res.status), "full snapshot or an honest 404");
    if (res.status === 200) {
      const snapshot = await res.json();
      assert.equal(snapshot.sport, "golf");
      assert.equal(typeof snapshot.pulled_at, "string");
      assert.ok(snapshot.ok === true ? "raw" in snapshot : "error" in snapshot);
    } else {
      assert.match((await res.json()).error, /no snapshot saved/);
    }
  });
});
