# Camera-guided local stream playback

This is the canonical implementation contract for the four-stream demo. The camera or Meta glasses no longer need to remain the video shown in the main theater after recognition. They are the visual selector.

## Product behavior

```text
phone / glasses camera
        |
        | WebRTC detector preview + gated JPEG analysis window
        v
Cerebras Gemma identifies exact event + visible checkpoint
        |
        v
demo intelligence resolves pack_id + moment_id
        |
        v
PlaybackDirector emits a new revision only when pack_id changes
        |
        v
desktop loads the predownloaded MP4, seeks once, and lets it play
```

The four indexed broadcasts are:

| `pack_id` / `stream_id` | Required file |
|---|---|
| `world-cup-2022-final` | `wc22_final_arg_fra__soccer_2022_12_18.mp4` |
| `nba-celtics-knicks-2026` | `nba_bos_nyk__celtics_at_knicks_2026.mp4` |
| `super-bowl-li` | `sb51_ne_atl__football_2017_02_05.mp4` |
| `ufc-229` | `ufc229_khabib_mcgregor__ufc_2018_10_06.mp4` |

The exact compressed demo edits are committed under `demo-footage/`, the default media directory. An operator may override that directory with `DEMO_STREAMS_DIR=/absolute/path`, but any replacement edit needs a new size, SHA-256, duration, and checkpoint calibration. Raw full-resolution footage remains outside Git.

## The switch invariant

The backend, not the UI, owns stream-switch decisions.

| New model result | Playback action |
|---|---|
| First exact, ready, calibrated event A | Load A and seek once to its detected checkpoint. |
| Event A identified at ≥70%, but visible state is between checkpoints | Load A immediately, interpolate a seek from phase/clock, and show a labeled point-in-time estimate from the archived probability timeline. |
| Event A again at any later or earlier checkpoint | No source change and no seek. A continues naturally. |
| Below 70%, ambiguous, or unsupported event | Keep the current video unchanged. |
| Analysis stopped or detector disconnected | Keep the current video unchanged. |
| Exact, ready, calibrated event B | Load B offscreen; when it can play, replace A and seek once. |
| B fails to load | Keep A visible and report the failure. |
| A is detected after B | This is a real new switch. Load A and seek once to the newly detected checkpoint. |

The UI keys on the ordered pair `(playback.epoch, playback.revision)`, not score, clock, `moment_id`, polling count, or `event_switch.detected`. A revision increments only when the active `stream_id` changes or an explicit reset is issued; the process epoch changes on a server restart. Older epochs and lower/equal revisions are ignored.

## Why checkpoint calibration is required

`clock_seconds` in the intelligence packs is game state, not file time:

- Soccer counts upward and has stoppage time, halftime, and extra time.
- NBA and NFL clocks count down and pause during breaks, reviews, timeouts, and commercials.
- UFC clocks count down separately in each round and omit round breaks and walkouts.
- Different downloads may include different intros, ads, replays, or edits.

Never derive an MP4 timestamp from the visible game clock. The timestamp map in `packages/fixtures/demo-streams/manifest.json` is bound to the exact chosen edit.

For every checkpoint, set:

```json
{
  "moment_id": "france-equalizer",
  "anchor_media_seconds": 6812.4,
  "playback_start_seconds": 6809.4
}
```

`anchor_media_seconds` is the exact frame corresponding to the checkpoint. `playback_start_seconds` is normally one to three seconds earlier so the transition has context. The UFC edit is the one explicit best-available exception: it starts after Round 1 movement begins, so the opening target starts at `0.0` and records that its first visible clock is `4:57`. Also fill `source.duration_seconds` and `source.expected_sha256`; if the file changes, recalibrate its offsets.

Once the exact indexed event is at least 70% confident, an in-between score issues an `approximate_event_sync` revision derived from the visible period and clock. The same point on the complete archived timeline provides an interpolated model and mock-market probability. This switches to the correct broadcast immediately and keeps the prediction continuous; it is labeled as a historical, point-in-time estimate and never substitutes the known final result for an earlier state.

## Backend contract

### `GET /api/demo/streams`

Returns all four allowlisted streams, file availability, calibration coverage, and a readiness reason. It never exposes a filesystem path or secret.

```json
{
  "streams": [{
    "stream_id": "world-cup-2022-final",
    "media_url": "/demo-streams/world-cup-2022-final",
    "file_available": true,
    "calibrated_checkpoints": 5,
    "checkpoint_count": 7,
    "unavailable_checkpoint_count": 2,
    "coverage_status": "partial",
    "calibration_complete": true,
    "ready": true,
    "readiness_reason": "ready"
  }]
}
```

### `GET /api/playback`

Returns the authoritative theater state even after analysis stops:

```json
{
  "status": "locked",
  "epoch": 1783814400000,
  "revision": 2,
  "stream_id": "nba-celtics-knicks-2026",
  "media_url": "/demo-streams/nba-celtics-knicks-2026",
  "initial_moment_id": "late-tie",
  "initial_seek_seconds": 817.5,
  "event_confidence": 0.94,
  "reason": "new_stream_detected",
  "candidate": null
}
```

The same object is embedded in a completed live `/api/latest` result. `POST /api/analysis/stop` clears model acquisition state but does not clear playback. Only explicit `POST /api/reset` clears the PlaybackDirector.

### `GET|HEAD /demo-streams/:stream_id`

Serves one allowlisted, SHA-256-verified local file with browser-seekable HTTP byte ranges. Valid `Range` requests return `206` plus `Accept-Ranges`, `Content-Range`, and the exact `Content-Length`; invalid ranges return `416`. A wrong edit returns `409`. A raw filename or path is never accepted.

## Viewer implementation

`apps/demo-web/capture.html` has three separate video roles:

1. `remotePreview` remains the camera/WebRTC detector source.
2. `video` is one local program buffer.
3. `videoStandby` is the second local program buffer.

The next broadcast loads in the inactive program element. The viewer waits for metadata, seeks once, waits for `canplay`, and only then crossfades it in. The old local broadcast or camera remains visible throughout the load. A generation token prevents an older asynchronous load from overwriting a newer directive.

YOLO reads whichever video is currently in the theater. Server-side event recognition still comes from the phone/glasses JPEG window, so hiding the WebRTC preview does not stop detection.

The Next.js frontend should use the same policy:

```js
const playback = await fetch(`${apiBase}/api/playback`).then((response) => response.json());

const newer = playback.epoch > activeEpoch ||
  (playback.epoch === activeEpoch && playback.revision > activeRevision);
if (playback.status === "locked" && newer) {
  // Load in an offscreen video, seek to initial_seek_seconds once,
  // wait for canplay, swap it in, then remember activeRevision.
}
```

It must not seek in response to later `/api/latest` updates from the same epoch and revision.

## Demo network topology

Use:

- Desktop theater: `http://localhost:3000/capture`
- Phone/glasses: `https://capture.saicharanramineni.com/phone`

The public phone page and sparse analysis requests still reach the named Cloudflare endpoint. The large predownloaded MP4 is requested from localhost and remains on the demo laptop. Opening the desktop theater through the public hostname also works, but it sends the local VOD bytes through the tunnel and is unnecessary.

## Acceptance gate

Before calling the four-stream path ready:

- All four exact MP4 files exist.
- `GET /api/demo/streams` reports four files available and four streams ready.
- Every checkpoint present in the downloaded edits is calibrated; any checkpoint omitted by a condensed edit is explicitly marked `available_in_media: false`.
- Each file is tested with at least two camera checkpoints.
- A later detection in the same game does not change `revision` or current playback time.
- World Cup → NBA → Super Bowl → UFC each creates exactly one new revision.
- UFC → World Cup creates one more revision and seeks World Cup to the newly detected checkpoint.
- Missing media, a 404, a malformed file, analysis stop, and camera disconnect all preserve the currently visible program.
- `npm test` passes.

The four compressed edits, their exact hashes and durations, and every usable checkpoint calibration are committed. The two World Cup checkpoints omitted by its five-minute edit are explicitly unavailable instead of being mapped to the wrong footage.
