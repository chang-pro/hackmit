#!/usr/bin/env bash
# Launches the CDP-controlled Chrome that the muse.ai bridge attaches to.
#
# This is a SEPARATE Chrome instance with its own profile, deliberately:
#   - your everyday Chrome keeps running, with your tabs
#   - the automation session is isolated from your normal browsing
#   - Chrome cannot have a debugging port attached to an already-running
#     instance, so it has to be launched with the flag
#
# The backgrounding flags matter: Chrome throttles timers in background
# renderers, which makes Runtime.evaluate time out whenever the window is not
# in front. Without them the bridge only works while you are looking at it.
#
# The profile persists at ~/.reloop/cdp-profile, so you log into muse.ai once.
# That directory holds live session cookies — it is chmod 700 and must never be
# committed.

set -euo pipefail

CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="${CDP_PROFILE:-$HOME/.reloop/cdp-profile}"
PORT="${CDP_PORT:-9222}"
START_URL="${CDP_START_URL:-https://muse.ai}"

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at: $CHROME" >&2
  echo "Set CHROME_BIN to your Chrome binary." >&2
  exit 1
fi

if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "CDP Chrome is already listening on port ${PORT}."
  exit 0
fi

mkdir -p "$PROFILE"
chmod 700 "$PROFILE"

"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  "$START_URL" >/dev/null 2>&1 &

for _ in $(seq 1 30); do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "CDP Chrome ready on http://127.0.0.1:${PORT}"
    echo "Profile: $PROFILE"
    exit 0
  fi
  sleep 0.5
done

echo "Chrome launched but port ${PORT} never opened." >&2
exit 1
