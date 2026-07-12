# Local demo broadcasts

The server uses the four exact, predownloaded broadcast edits committed under `demo-footage/`:

```text
wc22_final_arg_fra__soccer_2022_12_18.mp4
nba_bos_nyk__celtics_at_knicks_2026.mp4
sb51_ne_atl__football_2017_02_05.mp4
ufc229_khabib_mcgregor__ufc_2018_10_06.mp4
```

This folder is documentation-only by default. Optional local replacement copies can live here when selected explicitly through `DEMO_STREAMS_DIR=/absolute/path/to/apps/demo-web/streams`; those copies are ignored by Git.

After choosing the final edits, calibrate every checkpoint in `packages/fixtures/demo-streams/manifest.json`:

- `anchor_media_seconds` is the exact file timestamp matching the detected scoreboard state.
- `playback_start_seconds` is where the theater should begin, normally one to three seconds before the anchor.
- `duration_seconds` and `expected_sha256` bind those offsets to the exact edit so a replacement file cannot silently use incorrect timestamps.

Game clocks are not media timestamps. Broadcast breaks, replays, commercials, halftime, round breaks, and countdown clocks make automatic conversion unsafe.

For the live demo, open the viewer at `http://localhost:3000/capture` and the phone/glasses page at `https://capture.saicharanramineni.com/phone`. This keeps the large local MP4 bytes on the laptop while the phone continues to use the stable public endpoint.
