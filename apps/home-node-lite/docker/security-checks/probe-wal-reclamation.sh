#!/usr/bin/env bash
# Task 11.9 — DB WAL reclamation tracked.
#
# Samples the size of SQLite's write-ahead log on Core's persona +
# identity databases at a configurable interval, reporting growth +
# checkpoint recovery over time. Intended for the Phase 11c soak
# (task 11.7) where the question is "does WAL accumulate unbounded
# or does SQLite reclaim pages cleanly under sustained write load?"
#
# WAL behaviour recap:
#   - SQLite writes changes to the WAL file first, then periodically
#     `checkpoint`s them into the main DB file. WAL reclamation means
#     either (a) the WAL file truncates after a full checkpoint, or
#     (b) SQLite reuses the WAL's allocated pages in a round-robin
#     so the file stays bounded.
#   - If the WAL keeps growing (no reclamation) the disk fills up.
#     That's the soak failure mode we want to catch.
#
# Output is a TSV stream on stdout — timestamp / file / bytes — so an
# operator can pipe it to a file + `gnuplot` or load into a notebook.
# A summary at the end reports peak WAL size + net-growth-over-window.
#
# Pre-condition: Lite stack is running with write activity. Run this
# during the soak, not against an idle stack (the WAL stays near zero
# on an idle stack regardless of reclamation behaviour).
#
# Usage:
#   ./probe-wal-reclamation.sh                  # 60s window, 5s sample
#   DINA_WAL_WINDOW_SEC=3600 ./probe-wal-reclamation.sh    # 1h window
#   DINA_WAL_SAMPLE_SEC=30 ./probe-wal-reclamation.sh      # 30s interval
#   DINA_WAL_OUTPUT=/tmp/wal.tsv ./probe-wal-reclamation.sh  # split file
#
# Exit: 0 on successful sampling; 1 if WAL exceeds `DINA_WAL_MAX_MB`
# (default: 256 MB) — the soak acceptance ceiling.

set -euo pipefail

CORE="${DINA_CORE_CONTAINER:-dina-core-lite}"
VAULT_DIR="${DINA_VAULT_DIR_IN_CONTAINER:-/var/lib/dina}"
WINDOW_SEC="${DINA_WAL_WINDOW_SEC:-60}"
SAMPLE_SEC="${DINA_WAL_SAMPLE_SEC:-5}"
MAX_MB="${DINA_WAL_MAX_MB:-256}"
OUTPUT="${DINA_WAL_OUTPUT:-}"

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; BOLD=""; RESET=""
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; FAILED=1; }
FAILED=0

# Pre-check: container running.
if ! docker inspect -f '{{ .State.Running }}' "$CORE" 2>/dev/null | grep -q true; then
  printf "${RED}container $CORE is not running — start the stack first${RESET}\n" >&2
  exit 2
fi

# Find every *.sqlite-wal file under Core's vault directory.
list_wals() {
  docker exec "$CORE" sh -c "find '$VAULT_DIR' -name '*.sqlite-wal' -type f 2>/dev/null" \
    || true
}

sample_sizes() {
  # Emit one TSV line per WAL file found: <ts>\t<path>\t<bytes>
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local paths
  paths=$(list_wals)
  if [ -z "$paths" ]; then
    printf "%s\t(no-wal-files-found)\t0\n" "$ts"
    return
  fi
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    local bytes
    bytes=$(docker exec "$CORE" stat -c %s "$p" 2>/dev/null || echo 0)
    printf "%s\t%s\t%s\n" "$ts" "$p" "$bytes"
  done <<< "$paths"
}

# ─── Header + loop ────────────────────────────────────────────────────

echo "${BOLD}WAL reclamation probe${RESET} — container=$CORE vault=$VAULT_DIR"
echo "window=${WINDOW_SEC}s sample=${SAMPLE_SEC}s max=${MAX_MB}MB"
echo

# Header line for the TSV stream.
printf "# ts\tpath\tbytes\n"

# Capture all samples; peak + final computed at end.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

deadline=$(( $(date +%s) + WINDOW_SEC ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sample_sizes | tee -a "$tmp"
  sleep "$SAMPLE_SEC"
done

# Optional JSON/TSV persist.
if [ -n "$OUTPUT" ]; then
  cp "$tmp" "$OUTPUT"
  ok "raw samples written to $OUTPUT"
fi

# ─── Summary ──────────────────────────────────────────────────────────
echo
echo "${BOLD}Summary${RESET}"

# Per-file: first / last / peak / delta.
awk -F'\t' '
  NR > 0 && $0 !~ /^#/ && $2 != "" {
    first[$2] = ($2 in first) ? first[$2] : $3
    last[$2] = $3
    if ($3 > peak[$2]) peak[$2] = $3
  }
  END {
    for (p in first) {
      delta = last[p] - first[p]
      printf "  %-50s  first=%8s  last=%8s  peak=%8s  delta=%+d bytes\n",
        p, first[p], last[p], peak[p], delta
    }
  }
' "$tmp"

# Fail threshold: any single file exceeds the max ceiling.
max_bytes=$((MAX_MB * 1024 * 1024))
peak=$(awk -F'\t' 'NR > 0 && $0 !~ /^#/ && $3 > peak { peak = $3 } END { print peak+0 }' "$tmp")

echo
if [ "$peak" -gt "$max_bytes" ]; then
  fail "peak WAL size ${peak} bytes > ceiling ${max_bytes} bytes (${MAX_MB} MB)"
else
  ok "peak WAL size $(( peak / 1024 / 1024 )) MB ≤ ${MAX_MB} MB ceiling"
fi

if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — WAL stayed bounded (task 11.9)\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — WAL unbounded growth detected\n" >&2
  exit 1
fi
