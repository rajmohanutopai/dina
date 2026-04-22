#!/usr/bin/env bash
# Tasks 11.17 + 11.18 — Raspberry Pi 5 8GB first-boot + idle memory.
#
# Pi-specific wrapper around `benchmark.sh` (tasks 11.1 + 11.2). The
# underlying probe is identical; what differs is:
#
#   1. **Budgets** — ARM is slower than x86_64 for both cold-start
#      (more CPU work per boot) and RSS (Node's base runtime is
#      slightly larger on ARM glibc/musl images). Pi 5 acceptance
#      budgets are per-task from the release sign-off doc:
#        - Cold-start < 10 s (vs 3 s on x86_64)
#        - Idle memory < 400 MB (vs 250 MB on x86_64)
#      Task 11.17 + 11.18 acceptance is these Pi budgets, NOT the
#      x86_64 baseline.
#   2. **Platform guard** — this script runs only on ARM64 Linux; it
#      skips loudly on anything else. The intent is that the Phase 11d
#      gate runs this on an actual Pi 5 (not a QEMU cross-build) so
#      the cold-start number reflects real Pi I/O + thermals.
#   3. **System info capture** — kernel, cpuinfo, distro → stdout so
#      the post-soak report (task 11.4) has the hardware context
#      pinned alongside the numbers.
#
# Task 11.19 (FTS/HNSW latency on Pi) is a separate probe — the Jest
# perf smokes (storage-node/perf_smoke + core/embedding/hnsw_perf_smoke)
# run on any arch with the `PERF_P95_MS` / `HNSW_P95_MS` overrides
# relaxed for ARM; documented in `PERF.md` rather than scripted here.
#
# Task 11.20 (24h stability on Pi) is `soak-runner.sh` driven from
# the Pi — no separate script needed; just run it on the Pi with Pi
# budgets set via env.
#
# Usage on a Pi:
#   ./pi5-smoke.sh
#
# Override budgets for a tighter / looser gate:
#   DINA_PI_COLDSTART_BUDGET_MS=8000 ./pi5-smoke.sh
#
# Exit: 0 pass / 1 fail / 2 platform skip (non-ARM64-Linux).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; BOLD=""; YELLOW=""; RESET=""
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
info() { printf "${YELLOW}→${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }

# Pi-tuned budgets (override via env).
COLDSTART_BUDGET_MS="${DINA_PI_COLDSTART_BUDGET_MS:-10000}"
MEMORY_BUDGET_MB="${DINA_PI_MEMORY_BUDGET_MB:-400}"

# ─── Platform guard ────────────────────────────────────────────────────

os=$(uname -s)
arch=$(uname -m)
if [ "$os" != "Linux" ]; then
  printf "${YELLOW}SKIP${RESET} — Pi 5 benchmark needs Linux; current OS: $os\n"
  exit 2
fi
if [ "$arch" != "aarch64" ] && [ "$arch" != "arm64" ]; then
  printf "${YELLOW}SKIP${RESET} — Pi 5 benchmark needs ARM64; current arch: $arch\n"
  printf "(Run on a real Pi 5 for tasks 11.17 / 11.18 acceptance.)\n"
  exit 2
fi

# ─── System info capture (pinned in report alongside numbers) ─────────

echo "${BOLD}Pi 5 smoke — Dina Lite (tasks 11.17 + 11.18)${RESET}"
echo "budgets:   cold-start < ${COLDSTART_BUDGET_MS} ms, combined idle RSS < ${MEMORY_BUDGET_MB} MB"
echo
echo "${BOLD}Host context${RESET}"
info "kernel:   $(uname -r)"
info "arch:     $arch"
if [ -r /proc/cpuinfo ]; then
  model=$(grep -m1 '^Model' /proc/cpuinfo 2>/dev/null | sed 's/^Model\s*:\s*//' || true)
  [ -n "$model" ] && info "cpu:      $model"
fi
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "distro:   ${PRETTY_NAME:-unknown}"
fi
if [ -r /proc/meminfo ]; then
  total_kb=$(grep '^MemTotal:' /proc/meminfo | awk '{print $2}')
  total_mb=$(( total_kb / 1024 ))
  info "ram:      ${total_mb} MB total"
fi
echo

# Sanity gate: Pi 5 8GB has ≥ 7800 MB usable RAM. Lower than that
# suggests the operator is running this on a Pi 4 or a smaller model,
# which changes the acceptance criteria materially.
if [ -n "${total_mb:-}" ] && [ "$total_mb" -lt 7500 ]; then
  printf "${YELLOW}note${RESET} — total RAM ${total_mb} MB is below the Pi 5 8GB bar; ensure you're running this on the right hardware class before recording numbers\n\n"
fi

# ─── Delegate to benchmark.sh with Pi budgets ─────────────────────────

info "invoking benchmark.sh with Pi-tuned budgets..."
echo

DINA_BENCH_COLDSTART_BUDGET_MS="$COLDSTART_BUDGET_MS" \
DINA_BENCH_MEMORY_BUDGET_MB="$MEMORY_BUDGET_MB" \
  "$SCRIPT_DIR/benchmark.sh" "$@"

rc=$?
if [ "$rc" -eq 0 ]; then
  ok "Pi 5 gates green (tasks 11.17 first-boot + 11.18 idle memory)"
  exit 0
else
  fail "Pi 5 gate failed — see benchmark.sh output above"
fi
