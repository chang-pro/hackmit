#!/usr/bin/env bash
# Pulls the glasses recordings off the phone over USB.
#
# The recording is written on the phone as passthrough HEVC — the glasses'
# own encoded frames, straight to an mp4, no decode and no re-encode. It never
# touches the network, so its quality is completely independent of how bad the
# wifi is. This script is how it gets to the laptop: USB, not wifi.

set -euo pipefail

DEVICE="${RELOOP_DEVICE:-00008120-001815341A39A01E}"   # Dante's iPhone
BUNDLE="${RELOOP_BUNDLE:-com.bloomknights.app}"
DEST="${1:-$HOME/Desktop/reloop-recordings}"

mkdir -p "$DEST"

echo "Recordings in the app container:"
xcrun devicectl device info files \
  --device "$DEVICE" \
  --domain-type appDataContainer \
  --domain-identifier "$BUNDLE" \
  --username mobile \
  Documents 2>/dev/null | grep -iE "\.mp4|reloop_" || {
    echo "  none found — start and STOP a stream first; the file is finalised on stop."
    exit 1
  }

echo
echo "Pulling to $DEST ..."
xcrun devicectl device copy from \
  --device "$DEVICE" \
  --domain-type appDataContainer \
  --domain-identifier "$BUNDLE" \
  --username mobile \
  --source Documents \
  --destination "$DEST"

echo
find "$DEST" -name "*.mp4" -newermt "-1 day" -exec ls -lh {} \; 2>/dev/null | tail -10
echo "Done."
