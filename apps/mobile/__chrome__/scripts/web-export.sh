#!/usr/bin/env bash
#
# web-export.sh — build the RNW SPA + start a static server so the web
# driver can run scenarios against it. Stand-alone alternative to the
# full brain-server (which Phase 1 adds). Logs to /tmp; kill via the
# PID file when done.
#
# Usage:
#   ./web-export.sh           # build + serve on :18290
#   ./web-export.sh --stop    # kill the running static server
#

set -euo pipefail

PORT="${DINA_WEB_PORT:-18290}"
PID_FILE="/tmp/dina-web-spike.pid"
LOG_FILE="/tmp/dina-web-spike.log"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile_dir="$(cd "$script_dir/../.." && pwd)"
out_dir="$mobile_dir/../home-node-lite/web/dist"

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      printf "Stopped static server (pid %s)\n" "$pid"
    fi
    rm -f "$PID_FILE"
  else
    printf "No PID file at %s — nothing to stop.\n" "$PID_FILE"
  fi
  exit 0
fi

# 1. Build the SPA.
printf "Building RNW SPA into %s...\n" "$out_dir"
cd "$mobile_dir"
rm -rf "$out_dir"
npx expo export --platform web --output-dir "$out_dir"

# 2. Stop any prior static server on this port.
if [ -f "$PID_FILE" ]; then
  prev_pid=$(cat "$PID_FILE")
  if kill -0 "$prev_pid" 2>/dev/null; then
    kill "$prev_pid"
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# 3. Serve the bundle. Python's static server is enough for Phase 0
#    smoke runs; Phase 1 promotes this to a Fastify route in the
#    brain-server with SPA fallback (any unknown path → index.html).
#
#    The bundle is built with `experiments.baseUrl: "/web"` in
#    app.json, so all asset URLs in the served HTML are prefixed
#    with `/web/`. We serve from `$out_dir/..` (the parent of `dist`)
#    and treat `dist/` as the `/web/` mount point — the simplest
#    way to satisfy the bundle's URL expectations with Python's
#    flat directory server.
serve_root="$(dirname "$out_dir")"
mkdir -p "$serve_root/web"
# Rebuild the symlink each run so a re-export refreshes the bundle.
ln -sfn "$out_dir" "$serve_root/web"
cd "$serve_root"
nohup python3 -m http.server "$PORT" >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  printf "Static server failed to start. Log:\n"
  cat "$LOG_FILE"
  exit 1
fi

printf "\nSPA served at http://127.0.0.1:%s/web/\n" "$PORT"
printf "Log:    %s\n" "$LOG_FILE"
printf "Stop:   %s --stop\n\n" "$0"
