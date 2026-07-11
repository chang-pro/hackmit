# Demo-day setup checklist

Run this top to bottom on the actual demo network and projector. Do not introduce a new pull, dependency, clip, or browser after this pass.

## T-60 · Machine and stable service

- [ ] Laptop is on power; sleep, notifications, and automatic updates are off.
- [ ] `git status -sb` shows the rehearsed commit and no unexplained changes.
- [ ] `npm test` finishes with zero failures. Trust the current total; do not hardcode an old test count.
- [ ] Start the server and named Cloudflare connector with `npm run phone:tunnel`.
- [ ] Leave that terminal running. It must show registered tunnel connections without a repeating error loop.
- [ ] Run:

  ```bash
  curl -fsS https://capture.saicharanramineni.com/api/health | jq .
  curl -fsS https://capture.saicharanramineni.com/api/demo/intelligence | jq .
  ```

- [ ] Health reports `status: "ok"`, `vision.selected: "cerebras"`, `vision.error: null`, and `demo_intelligence_packs: 4`.
- [ ] The catalog lists the World Cup Final, 2016 NBA Finals Game 7, Super Bowl LI, and UFC 229.

## T-45 · Check every stage checkpoint

- [ ] Open `https://capture.saicharanramineni.com/capture?demo=1&cycle=1`.
- [ ] Confirm each event renders a prediction, mock market comparison, four `MOCK WEB` research cards, and an explicit `REHEARSAL · NO MODEL CALL` label.
- [ ] Pin one checkpoint directly if needed:

  ```text
  /capture?demo=1&pack=<pack-id>&moment=<checkpoint-id>
  ```

- [ ] Never use rehearsal mode as proof of camera recognition. It is the honest UI/recovery floor.

## T-30 · Real two-device path

- [ ] Viewer laptop: `https://capture.saicharanramineni.com/capture` in current Chrome or Edge.
- [ ] Camera device: native glasses companion or `https://capture.saicharanramineni.com/phone`.
- [ ] Start the camera feed. The latest provider appears automatically; there is no pairing code or refresh button.
- [ ] Confirm continuous video on the viewer before pressing **Analyze**.
- [ ] Confirm the viewer eventually reports `YOLO11s WebGPU`. WASM is a functional but slower fallback.
- [ ] Press **Analyze** once. Confirm the acquisition counter advances and a live insight appears.
- [ ] Stop analysis and confirm video continues while the old prediction disappears.

## T-20 · Four canonical clips

Use only these identities unless their JSON packs have been deliberately recalibrated:

1. 2022 FIFA World Cup Final — Argentina vs France.
2. 2016 NBA Finals Game 7 — Cavaliers vs Warriors.
3. Super Bowl LI — Patriots vs Falcons.
4. UFC 229 — Khabib Nurmagomedov vs Conor McGregor.

- [ ] Each clip keeps the primary scorebug visible and large enough to read.
- [ ] Each clip reaches at least one committed checkpoint and shows `Historical replay`, not `Sport template`.
- [ ] Switch through all four without touching a sport selector.
- [ ] Terminal footage resolves to 100% for the known winner instead of retaining a pre-finish estimate.
- [ ] If any teammate clip is a different event, stop and update the pack. Never attach a famous game's facts to unrelated footage.

## T-10 · Projector and audio

- [ ] Test at the projector's native resolution, especially 1280×720.
- [ ] The theater remains the largest surface; prediction and at least one research result are visible without page scrolling.
- [ ] Browser zoom is fixed for the entire pitch.
- [ ] Click **Speak** once and verify venue audio. If it fails on stage, read the visible sentence yourself and keep moving.
- [ ] Close unrelated tabs, hide bookmarks, and enable Do Not Disturb.

## T-2 · Final state

- [ ] Viewer is open on `/capture`, camera feed is live, and analysis is **off**.
- [ ] World Cup clip is framed at the first rehearsed checkpoint.
- [ ] Tunnel terminal is healthy; `/api/health` still returns 200.
- [ ] Rehearsal URL is bookmarked as the final fallback.
- [ ] Opening line is memorized: “Prediction markets know their contracts. BloomKnights knows what I am looking at.”

## Recovery ladder

1. Meta glasses companion → viewer.
2. Phone browser → viewer.
3. Prerecorded canonical clip displayed to either camera source.
4. Quota-free `/capture?demo=1&cycle=1` rehearsal.

The first three prove visual recognition. The fourth proves the interaction and intelligence presentation while explicitly disclosing that no camera or model call occurred.

## Network reality

The live path needs internet for HTTPS signaling, TURN when required by campus NAT, and Cerebras inference. Continuous video uses WebRTC between the peers or the TURN relay; Cloudflare carries page delivery, signaling, and gated analysis snapshots, not the live media stream. If the venue loses internet completely, use the local rehearsal floor and say so plainly.
