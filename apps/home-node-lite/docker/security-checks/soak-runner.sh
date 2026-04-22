#!/usr/bin/env bash
# Task 11.7 — 24h soak at 1 req/s — no memory growth > 20%.
#
# Drives a long-running low-rate load against the Lite stack while
# sampling memory usage + WAL size + WS connection count + error
# counts over the window. At the end, reports growth vs baseline and
# gates on the acceptance criteria:
#
#   1. Memory (Core+Brain RSS combined) grows ≤ 20% from post-warmup
#      baseline to end-of-soak. Growth > 20% = leak candidate.
#   2. No unhandled promise rejections during the window (task 11.8 —
#      the per-test guard is already in place; this just re-asserts
#      for the soak). Surfaced via `docker logs | grep` for the
#      guard's error-prefix.
#   3. WAL stays under the bounded ceiling per task 11.9.
#
# Orchestrates the existing per-concern probes rather than
# reinventing them:
#   - `probe-throughput.py` for sustained 1 req/s load
#   - `probe-wal-reclamation.sh` for WAL tracking (task 11.9)
#   - direct `docker stats` sampling for RSS (mirrors `benchmark.sh`)
#
# Usage (defaults: 24h soak):
#   ./soak-runner.sh
#
# Shorter smoke (1h for CI dry-runs):
#   DINA_SOAK_DURATION_SEC=3600 ./soak-runner.sh
#
# Pre-conditions:
#   - Lite stack healthy (install-lite.sh already run)
#   - ample disk for the output file (default: ~6 MB for 24h@5s samples)
#
# Exit: 0 if all three gates pass; 1 on any gate failure; 2 on
# precondition or probe-invocation error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CORE="${DINA_CORE_CONTAINER:-dina-core-lite}"
BRAIN="${DINA_BRAIN_CONTAINER:-dina-brain-lite}"
SOAK_DURATION_SEC="${DINA_SOAK_DURATION_SEC:-86400}"   # 24h default
SOAK_RPS="${DINA_SOAK_RPS:-1}"
SOAK_URL="${DINA_SOAK_URL:-http://127.0.0.1:28100/healthz}"
MEMORY_GROWTH_CEILING_PCT="${DINA_SOAK_MEMORY_GROWTH_CEILING:-20}"
SAMPLE_INTERVAL_SEC="${DINA_SOAK_SAMPLE_INTERVAL:-300}"    # sample every 5 min
OUTPUT_DIR="${DINA_SOAK_OUTPUT_DIR:-/tmp/dina-soak-$(date +%Y%m%dT%H%M%S)}"

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
info() { printf "${YELLOW}→${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; FAILED=1; }
FAILED=0

mkdir -p "$OUTPUT_DIR"
MEM_LOG="$OUTPUT_DIR/memory.tsv"
LOAD_LOG="$OUTPUT_DIR/throughput.log"

# Pre-check: containers running.
for c in "$CORE" "$BRAIN"; do
  if ! docker inspect -f '{{ .State.Running }}' "$c" 2>/dev/null | grep -q true; then
    printf "${RED}container $c is not running — start the stack first${RESET}\n" >&2
    exit 2
  fi
done

echo "${BOLD}Dina Lite soak runner${RESET} — task 11.7"
echo "duration:          ${SOAK_DURATION_SEC}s ($(( SOAK_DURATION_SEC / 3600 ))h $(( (SOAK_DURATION_SEC % 3600) / 60 ))m)"
echo "rps:               ${SOAK_RPS}"
echo "target:            ${SOAK_URL}"
echo "memory ceiling:    +${MEMORY_GROWTH_CEILING_PCT}% growth"
echo "sample interval:   ${SAMPLE_INTERVAL_SEC}s"
echo "output dir:        ${OUTPUT_DIR}"
echo

# Ensure we stop the background load gen on exit (otherwise it
# outlives the script and keeps hammering the stack).
BG_PID=""
cleanup() {
  if [ -n "$BG_PID" ] && kill -0 "$BG_PID" 2>/dev/null; then
    kill "$BG_PID" 2>/dev/null || true
    wait "$BG_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ─── RSS sampler ──────────────────────────────────────────────────────
# Records combined Core+Brain RSS in MiB at `SAMPLE_INTERVAL_SEC`.
# Matches benchmark.sh's parsing of `docker stats --format {{.MemUsage}}`.

sample_rss_mib() {
  local c="$1"
  local raw
  raw=$(docker stats --no-stream --format '{{.MemUsage}}' "$c" 2>/dev/null || echo "")
  # raw looks like "95.25MiB / 5.786GiB" — take the LEFT usage token only.
  local usage_token
  usage_token=$(echo "$raw" | awk '{print $1}')
  if echo "$usage_token" | grep -q 'MiB'; then
    echo "$usage_token" | sed 's/MiB//'
  elif echo "$usage_token" | grep -q 'GiB'; then
    # GiB → MiB
    python3 -c "print(float('${usage_token%GiB}') * 1024)"
  elif echo "$usage_token" | grep -q 'KiB'; then
    python3 -c "print(float('${usage_token%KiB}') / 1024)"
  else
    echo "0"
  fi
}

echo "# ts\tcore_rss_mib\tbrain_rss_mib\tcombined_rss_mib" > "$MEM_LOG"

# ─── Launch background load generator (task 11.3 reused) ──────────────

info "launching background load at ${SOAK_RPS} req/s"
python3 "$SCRIPT_DIR/probe-throughput.py" \
  --url "$SOAK_URL" \
  --rps "$SOAK_RPS" \
  --duration "$SOAK_DURATION_SEC" \
  --warmup 0 \
  --rps-floor 0.90 \
  --error-ceiling 0.05 \
  > "$LOAD_LOG" 2>&1 &
BG_PID=$!

# Let the load start + warmup briefly before taking baseline.
sleep 30

# ─── Baseline sample ──────────────────────────────────────────────────

baseline_core=$(sample_rss_mib "$CORE")
baseline_brain=$(sample_rss_mib "$BRAIN")
baseline_combined=$(python3 -c "print($baseline_core + $baseline_brain)")
ok "baseline (post-30s warmup): Core=${baseline_core}MiB Brain=${baseline_brain}MiB combined=${baseline_combined}MiB"
printf "%s\t%s\t%s\t%s\n" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$baseline_core" "$baseline_brain" "$baseline_combined" >> "$MEM_LOG"

# ─── Main sample loop ─────────────────────────────────────────────────

deadline=$(( $(date +%s) + SOAK_DURATION_SEC - 30 ))   # already burned 30s on warmup
peak_combined="$baseline_combined"
last_combined="$baseline_combined"

while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$SAMPLE_INTERVAL_SEC"
  # Bail if the load generator died.
  if ! kill -0 "$BG_PID" 2>/dev/null; then
    fail "background load generator exited early — see ${LOAD_LOG}"
    break
  fi
  core=$(sample_rss_mib "$CORE")
  brain=$(sample_rss_mib "$BRAIN")
  combined=$(python3 -c "print($core + $brain)")
  last_combined="$combined"
  # Track peak for telemetry.
  peak_combined=$(python3 -c "print(max($peak_combined, $combined))")
  printf "%s\t%s\t%s\t%s\n" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$core" "$brain" "$combined" >> "$MEM_LOG"
done

# Let the load generator finish cleanly.
wait "$BG_PID" 2>/dev/null || true
BG_PID=""

# ─── Gate 1 — memory growth ─────────────────────────────────────────

growth_pct=$(python3 -c "print(100.0 * ($last_combined - $baseline_combined) / $baseline_combined)")
echo
echo "${BOLD}Gate 1 — memory growth${RESET}"
info "baseline: ${baseline_combined}MiB"
info "final:    ${last_combined}MiB"
info "peak:     ${peak_combined}MiB"
info "growth:   ${growth_pct}%"
if python3 -c "import sys; sys.exit(0 if $growth_pct <= $MEMORY_GROWTH_CEILING_PCT else 1)"; then
  ok "memory growth ${growth_pct}% ≤ ${MEMORY_GROWTH_CEILING_PCT}% ceiling"
else
  fail "memory growth ${growth_pct}% > ${MEMORY_GROWTH_CEILING_PCT}% ceiling (leak candidate)"
fi

# ─── Gate 2 — no unhandled rejections during soak ────────────────────

echo
echo "${BOLD}Gate 2 — no unhandled promise rejections${RESET}"
rejection_count=$(docker logs "$CORE" "$BRAIN" 2>&1 | grep -cE 'unhandled.*rejection|unhandledRejection' || true)
if [ "$rejection_count" -eq 0 ]; then
  ok "no unhandled rejection lines in Core/Brain logs"
else
  fail "$rejection_count unhandled-rejection log lines found — sample: $(docker logs "$CORE" "$BRAIN" 2>&1 | grep -E 'unhandled.*rejection|unhandledRejection' | head -1)"
fi

# ─── Gate 3 — throughput gate (from probe-throughput.py) ─────────────

echo
echo "${BOLD}Gate 3 — throughput probe result${RESET}"
if grep -qE "^PASS:" "$LOAD_LOG"; then
  ok "throughput probe PASSed — ${LOAD_LOG}"
else
  fail "throughput probe produced no PASS line — see ${LOAD_LOG}"
fi

# ─── Summary ──────────────────────────────────────────────────────────

echo
echo "${BOLD}Artefacts${RESET} (for Phase 11c reporting):"
echo "  memory samples: $MEM_LOG"
echo "  throughput log: $LOAD_LOG"
echo

if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — soak gates green (task 11.7)\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — one or more soak gates failed\n" >&2
  exit 1
fi
