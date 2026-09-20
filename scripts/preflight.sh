#!/usr/bin/env bash
# Is everything up for the demo? Run it from the repo root: scripts/preflight.sh
# Reads only; it changes nothing and publishes nothing. Exit code 0 = ready.
#
# Every line is something that has actually broken a run: pricing switched off
# and mistaken for a dead key, the muse Chrome not running, the phone on the
# slow path, stale listings from the night before on the status page.

set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
BASE="http://localhost:$PORT"
fails=0; warns=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✖ %s\033[0m\n      → %s\n' "$1" "$2"; fails=$((fails+1)); }
warn() { printf '  \033[33m! %s\033[0m\n      → %s\n' "$1" "$2"; warns=$((warns+1)); }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "Server"
if curl -sf -o /dev/null --max-time 3 "$BASE/"; then ok "live page answers on :$PORT"; else bad "server is not running on :$PORT" "RELOOP_PRICING_ON=1 npm start"; fi
status=$(curl -s --max-time 3 "$BASE/api/analysis/status")
if [ "$(echo "$status" | json "d['analysis_enabled']")" = "True" ]; then ok "pricing is ON"; else bad "pricing is OFF" "press Start pricing, or: curl -X POST $BASE/api/analysis/start"; fi
err=$(echo "$status" | json "d['queue']['last_error'] or ''")
[ -z "$err" ] && ok "no pricing error" || bad "last pricing call failed: $err" "check RIGHTCODES_KEY_GEMINI in .env"
curl -sf -o /dev/null --max-time 3 "$BASE/status" && ok "status page answers" || bad "status page does not answer" "pull main and restart"

echo "Keys (.env)"
for k in RIGHTCODES_KEY_GEMINI SHOPIFY_CLIENT_ID SHOPIFY_CLIENT_SECRET SHOPIFY_STORE_DOMAIN GEMINI_API_KEY; do
  if grep -qE "^$k=.+" .env 2>/dev/null; then ok "$k is set"; else
    [ "$k" = GEMINI_API_KEY ] && warn "$k is missing" "voice confirmation will not work" || bad "$k is missing" "add it to .env"; fi
done

echo "Pricing model"
if [ -f .env ]; then
  key=$(grep -E '^RIGHTCODES_KEY_GEMINI=' .env | cut -d= -f2-)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://right.codes/v1/chat/completions -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"ok"}],"max_tokens":1}')
  [ "$code" = 200 ] && ok "right.codes answers (HTTP 200)" || bad "right.codes answered HTTP $code" "key, balance or outage; the Google key is the automatic fallback"
fi

echo "Facebook (muse)"
if curl -sf -o /dev/null --max-time 3 http://127.0.0.1:9222/json/version; then
  ok "muse Chrome is running"
  tabs=$(curl -s --max-time 3 http://127.0.0.1:9222/json | json "sum(1 for t in d if 'muse.ai' in t.get('url',''))")
  [ "${tabs:-0}" -ge 1 ] && ok "a muse.ai tab is open" || bad "no muse.ai tab" "open https://muse.ai in that Chrome and log in"
else bad "muse Chrome is not running" "scripts/start-cdp-chrome.sh"; fi

echo "Phone and glasses"
if ping -c 1 -t 2 192.168.234.2 >/dev/null 2>&1; then ok "phone is on the USB cable (fast path)"
else warn "phone is not on the cable" "plug it in; without it the stream falls back to wifi or Tailscale and lags"; fi
age=$(curl -s --max-time 3 "$BASE/api/live-frame" | json "d.get('age_ms', -1)")
if [ -n "${age:-}" ] && [ "$age" != "-1" ] && [ "$age" -lt 4000 ] 2>/dev/null; then ok "glasses frames are arriving (${age}ms old)"
else warn "no live frames right now" "unlock the phone, open ReLoop, press START with the glasses on"; fi

echo "Clean slate"
listed=$(curl -s --max-time 3 "$BASE/api/status" | json "d['totals']['listed']")
[ "${listed:-0}" = 0 ] && ok "no old listings on the status page" || warn "$listed listings already on the status page" "fine mid-demo; before it, clear them so the recovered total starts at \$0"

echo
if [ "$fails" -gt 0 ]; then printf '\033[31mNOT READY: %d to fix, %d to look at.\033[0m\n' "$fails" "$warns"; exit 1; fi
if [ "$warns" -gt 0 ]; then printf '\033[33mServer side is ready. %d thing(s) to look at above.\033[0m\n' "$warns"; exit 0; fi
printf '\033[32mREADY.\033[0m\n'
