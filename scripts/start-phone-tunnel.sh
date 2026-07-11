#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3000}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared || true)}"
SERVER_PID=""

if [[ -z "$CLOUDFLARED_BIN" ]]; then
  echo "cloudflared is not installed. Install it with: brew install cloudflared" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  node --env-file-if-exists=.env services/api/server.js &
  SERVER_PID=$!
  for _ in {1..40}; do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "BloomKnights server exited before becoming ready." >&2
      exit 1
    fi
    sleep 0.25
  done
fi

if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "BloomKnights server did not become ready on port ${PORT}." >&2
  exit 1
fi

echo
echo "Creating public HTTPS phone/glasses endpoint..."
echo "Open the printed URL with /capture on the desktop, then copy its generated phone pairing link."
echo "Continuous camera video is direct WebRTC between the paired browsers."
echo "This tunnel carries SDP/ICE signaling and user-gated analysis snapshots only."
echo

"$CLOUDFLARED_BIN" tunnel \
  --no-autoupdate \
  --protocol http2 \
  --url "http://127.0.0.1:${PORT}"
