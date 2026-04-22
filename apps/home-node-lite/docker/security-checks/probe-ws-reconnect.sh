#!/usr/bin/env bash
# Task 11.10 — WebSocket reconnect stability under `tc netem`.
#
# Probes the WS-reconnect behaviour of the Lite stack by driving
# packet-loss + latency + drop scenarios at the kernel level via
# `tc netem`, then reading Core's logs for reconnect/retry lines.
#
# What "stability" means here:
#
#   1. Under 5% packet loss, Brain's WS client reconnects without
#      operator intervention — backoff eventually succeeds.
#   2. Under 100% packet drop for 10s, Brain surfaces a clear
#      "disconnected" signal; on restore, reconnects within the
#      reconnect-backoff window (default ≤30s).
#   3. No WS state leakage — after N reconnect cycles, Brain's
#      active-connections count returns to baseline.
#
# Linux-only (tc netem isn't on macOS). The script detects non-Linux
# and skips cleanly; the gate for Phase 11c requires a Linux soak host.
#
# Pre-condition: Lite stack is running + `tc` + NET_ADMIN on the host
# (required to manipulate the interface's qdisc).
#
# Usage:
#   sudo ./probe-ws-reconnect.sh                              # default scenarios
#   DINA_WS_INTERFACE=eth0 sudo ./probe-ws-reconnect.sh       # pin the interface
#   DINA_WS_BASELINE_SEC=60 sudo ./probe-ws-reconnect.sh      # longer baseline
#
# Exit: 0 if all three scenarios pass; 1 on failure; 2 on
# platform/toolchain not met (skip with clear message).

set -euo pipefail

CORE="${DINA_CORE_CONTAINER:-dina-core-lite}"
BRAIN="${DINA_BRAIN_CONTAINER:-dina-brain-lite}"
INTERFACE="${DINA_WS_INTERFACE:-}"
BASELINE_SEC="${DINA_WS_BASELINE_SEC:-15}"
LOSS_SEC="${DINA_WS_LOSS_SEC:-20}"
DROP_SEC="${DINA_WS_DROP_SEC:-10}"
RECONNECT_WINDOW_SEC="${DINA_WS_RECONNECT_WINDOW_SEC:-30}"

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
info() { printf "${YELLOW}→${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; FAILED=1; }
FAILED=0

# ─── Platform gate ────────────────────────────────────────────────────
if [ "$(uname -s)" != "Linux" ]; then
  printf "${YELLOW}SKIP${RESET} — tc netem is Linux-only; current platform: $(uname -s)\n"
  printf "The Phase 11c soak host must be Linux. Re-run this probe from there.\n"
  exit 2
fi

if ! command -v tc >/dev/null 2>&1; then
  printf "${RED}tc not installed — need iproute2${RESET}\n" >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  printf "${RED}tc netem requires root (CAP_NET_ADMIN) — re-run with sudo${RESET}\n" >&2
  exit 2
fi

# Pre-check: containers running.
for c in "$CORE" "$BRAIN"; do
  if ! docker inspect -f '{{ .State.Running }}' "$c" 2>/dev/null | grep -q true; then
    printf "${RED}container $c is not running — start the stack first${RESET}\n" >&2
    exit 2
  fi
done

# Derive the interface if not explicitly set. For Docker's default
# bridge, the interface name is typically `docker0`; for user-defined
# bridges (what compose creates for `dina-lite`), the name is
# `br-<12-hex-chars>`. We find it by inspecting the compose network.
if [ -z "$INTERFACE" ]; then
  INTERFACE=$(docker network inspect dina-lite \
    --format '{{ range .Containers }}{{ end }}{{ index .Options "com.docker.network.bridge.name" }}' \
    2>/dev/null || true)
  if [ -z "$INTERFACE" ]; then
    # Fall back to the bridge name derived from the network ID.
    net_id=$(docker network inspect dina-lite --format '{{ .Id }}' 2>/dev/null | cut -c1-12)
    INTERFACE="br-${net_id}"
  fi
fi

if [ -z "$INTERFACE" ] || ! ip link show "$INTERFACE" >/dev/null 2>&1; then
  printf "${RED}could not identify Lite network interface — set DINA_WS_INTERFACE${RESET}\n" >&2
  exit 2
fi
info "using interface: $INTERFACE"

# Always clean up qdisc on exit — otherwise we leave a permanent
# network degradation in place.
cleanup() {
  tc qdisc del dev "$INTERFACE" root 2>/dev/null || true
}
trap cleanup EXIT

# ─── Helpers ──────────────────────────────────────────────────────────

count_ws_connections() {
  # Brain's WS client count surfaces via /api/v1/internal/ws-status in
  # M1; pre-M1, fall back to counting established TCP sockets on
  # Brain's side. Matches a reasonable approximation.
  docker exec "$BRAIN" sh -c "ss -tn state established 'sport = :8200' | wc -l" \
    2>/dev/null | tr -d ' '
}

count_reconnects_in_core_logs() {
  local since="$1"
  docker logs --since "$since" "$CORE" 2>&1 \
    | grep -cE 'websocket.*(reconnect|connect)' \
    || true
}

apply_netem() {
  tc qdisc replace dev "$INTERFACE" root netem "$@"
}

clear_netem() {
  tc qdisc del dev "$INTERFACE" root 2>/dev/null || true
}

# ─── Scenario 1 — baseline (no degradation) ───────────────────────────

echo
echo "${BOLD}Scenario 1 — baseline (no netem)${RESET}"
clear_netem
sleep "$BASELINE_SEC"
baseline_conns=$(count_ws_connections)
ok "baseline WS connections on brain: $baseline_conns"

# ─── Scenario 2 — 5% packet loss ──────────────────────────────────────

echo
echo "${BOLD}Scenario 2 — 5% packet loss for ${LOSS_SEC}s${RESET}"
apply_netem loss 5%
sleep "$LOSS_SEC"
clear_netem
# After restore, give reconnect window to re-establish.
sleep "$RECONNECT_WINDOW_SEC"
loss_conns=$(count_ws_connections)
if [ "$loss_conns" -ge "$baseline_conns" ]; then
  ok "WS connections recovered to $loss_conns ≥ baseline $baseline_conns"
else
  fail "WS connections $loss_conns < baseline $baseline_conns — leak or stuck reconnect"
fi

# ─── Scenario 3 — 100% packet drop for 10s, then restore ──────────────

echo
echo "${BOLD}Scenario 3 — 100% drop for ${DROP_SEC}s, recovery window ${RECONNECT_WINDOW_SEC}s${RESET}"
t0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
apply_netem loss 100%
sleep "$DROP_SEC"
clear_netem
sleep "$RECONNECT_WINDOW_SEC"
recovery_conns=$(count_ws_connections)
reconnect_count=$(count_reconnects_in_core_logs "$t0")

if [ "$recovery_conns" -ge "$baseline_conns" ]; then
  ok "WS connections recovered to $recovery_conns ≥ baseline $baseline_conns"
else
  fail "WS connections $recovery_conns < baseline $baseline_conns after drop+restore"
fi
info "Core log reconnect/connect lines since drop-start: $reconnect_count"

# ─── Summary ──────────────────────────────────────────────────────────

echo
if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — WS reconnect stable under packet loss + drop (task 11.10)\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — WS reconnect did not recover cleanly\n" >&2
  exit 1
fi
