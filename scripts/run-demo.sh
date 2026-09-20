#!/usr/bin/env bash
# Keeps the demo alive. Run once and leave it:   scripts/run-demo.sh &
#
# Every 10 seconds it makes sure two things are up, and starts whichever is not:
#   - the server, with pricing armed and the Facebook tracker answering buyers
#     by itself (auto-reply on, checking every 45s) from the moment it boots
#   - the CDP Chrome that muse.ai lives in; without it no buyer is ever seen or
#     answered, and it has died mid-demo before
#
# Stop it with:   scripts/run-demo.sh stop
set -uo pipefail
cd "$(dirname "$0")/.."
RUN_DIR="$HOME/.reloop"; mkdir -p "$RUN_DIR"
PIDFILE="$RUN_DIR/run-demo.pid"; LOG="$RUN_DIR/demo.log"; SRVLOG="$RUN_DIR/server.log"
PORT="${PORT:-3000}"

if [ "${1:-}" = "stop" ]; then
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"
  echo "supervisor stopped (the server and Chrome are left running)"; exit 0
fi
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
echo $$ > "$PIDFILE"
say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$1" >> "$LOG"; }
say "supervisor started"

while true; do
  if ! lsof -ti "tcp:9222" -sTCP:LISTEN >/dev/null 2>&1; then
    say "muse Chrome is down: relaunching"
    (bash scripts/start-cdp-chrome.sh >/dev/null 2>&1 &)
    sleep 8
  fi
  if ! lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    say "server is down: starting"
    (RELOOP_PRICING_ON=1 MARKETPLACE_AUTO_REPLY="${MARKETPLACE_AUTO_REPLY:-1}" MARKETPLACE_WATCH_MS="${MARKETPLACE_WATCH_MS:-45000}" \
      RELOOP_LOG_REQUESTS=1 npm start >> "$SRVLOG" 2>&1 &)
    sleep 5
  fi
  sleep 10
done
