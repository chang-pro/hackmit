#!/usr/bin/env bash
# Extract ~1 fps frames from a prerecorded broadcast clip — the deterministic
# demo fallback on the resilience ladder (README §13). Requires ffmpeg.
#
# Usage: scripts/extract-clip-frames.sh <clip.mp4> [output-dir] [fps]
#
# NOTE (README §16): extracted frames are raw footage. Keep the output
# directory out of git — do not commit clips or extracted frames.

set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is not installed, so no frames were extracted."
  echo "Install it first (macOS: 'brew install ffmpeg', Debian/Ubuntu: 'sudo apt install ffmpeg')"
  echo "and run this script again."
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 <clip.mp4> [output-dir] [fps]" >&2
  exit 2
fi

CLIP="$1"
OUT="${2:-./clip-frames}"
FPS="${3:-1}"

if [ ! -f "$CLIP" ]; then
  echo "Clip not found: $CLIP" >&2
  exit 2
fi

mkdir -p "$OUT"
ffmpeg -hide_banner -loglevel error -i "$CLIP" -vf "fps=$FPS" "$OUT/frame_%06d.jpg"

COUNT=$(find "$OUT" -name 'frame_*.jpg' | wc -l | tr -d ' ')
echo "Extracted $COUNT frame(s) at $FPS fps into $OUT"
echo "Reminder: these are raw footage — do not commit them (README §16)."
