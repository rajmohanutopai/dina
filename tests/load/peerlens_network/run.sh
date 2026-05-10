#!/usr/bin/env bash
# tests/load/trust_network/run.sh — TN-TEST-081 runner.
#
# Detects k6, health-checks the AppView, runs the three k6 scripts
# in sequence (search → getProfile → networkFeed), and exits with
# the worst non-zero exit code so a CI gate sees the failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPVIEW_URL="${APPVIEW_URL:-http://localhost:3000}"

# 1. k6 availability gate. Exit 0 with a friendly message if k6 isn't
# installed — the load suite is a separate cadence, not a hard CI gate.
if ! command -v k6 >/dev/null 2>&1; then
  cat >&2 <<EOF
[TN-TEST-081] k6 is not installed — skipping load tests.

Install: https://k6.io/docs/get-started/installation/
  macOS:    brew install k6
  Linux:    https://dl.k6.io/key.gpg | sudo apt-key add -
  Docker:   docker run -i --rm grafana/k6 run - < script.js

Once installed, re-run: ./tests/load/trust_network/run.sh
EOF
  exit 0
fi

# 2. Health check — bail loudly if the AppView is unreachable. Don't
# spend 3 minutes timing out one request at a time.
echo "[TN-TEST-081] Health check: ${APPVIEW_URL}/health"
if ! curl -fsS --max-time 5 "${APPVIEW_URL}/health" >/dev/null; then
  cat >&2 <<EOF
[TN-TEST-081] AppView is not responding at ${APPVIEW_URL}/health.

Bring it up first:
  docker compose up -d
  # or: cd appview && npm start
EOF
  exit 1
fi

# 3. Run scripts in sequence. k6 uses non-zero exit when a threshold
# breaches, so we capture each and surface the worst.
worst=0
for script in search.k6.js get-profile.k6.js network-feed.k6.js; do
  echo
  echo "============================================================"
  echo "[TN-TEST-081] Running ${script}"
  echo "============================================================"
  if ! APPVIEW_URL="${APPVIEW_URL}" k6 run "${SCRIPT_DIR}/${script}"; then
    rc=$?
    echo "[TN-TEST-081] ${script} failed with exit ${rc}"
    if [[ $rc -gt $worst ]]; then worst=$rc; fi
  fi
done

if [[ $worst -ne 0 ]]; then
  echo
  echo "[TN-TEST-081] FAILED — at least one threshold breached."
  exit "$worst"
fi

echo
echo "[TN-TEST-081] All capacity targets met."
