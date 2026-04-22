#!/usr/bin/env bash
# Task 11.12 — pen-test key read paths beyond the filesystem.
#
# `verify-key-isolation.sh` (task 11.11) covers the canonical bind-mount
# boundary. This script extends the probe set to the escape vectors an
# attacker inside a compromised Brain might try:
#
#   1. PID-namespace snooping — Brain's `ps`, `/proc/[0-9]+`
#   2. /proc/*/environ leak — reading another process's env strings
#   3. Symlink escape — symlink a path inside Brain to Core's vault
#   4. Direct kernel memory — /dev/mem, /dev/kmem
#   5. Raw network capture — /dev/net/tun, CAP_NET_RAW
#   6. Linux capability inventory — cap_drop: ALL must zero every set
#
# Pre-condition: stack is up (install-lite.sh run, or compose up -d).
#
# What we DON'T probe:
#   - Host-side `docker inspect` leaks. That's a host-operator capability
#     (whoever can run docker can see everything); not a Brain-container
#     boundary concern. Out of scope.
#   - Kernel exploits (CVE-2022-0185 style). The cap_drop + read_only +
#     no-new-privileges posture mitigates *classes* of bug; CVE-scanning
#     lives separately in the Trivy step (task 7.31).

set -euo pipefail

CORE="${DINA_CORE_CONTAINER:-dina-core-lite}"
BRAIN="${DINA_BRAIN_CONTAINER:-dina-brain-lite}"

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; BOLD=""; RESET=""
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; FAILED=1; }
FAILED=0

for c in "$CORE" "$BRAIN"; do
  if ! docker inspect -f '{{ .State.Running }}' "$c" 2>/dev/null | grep -q true; then
    printf "${RED}container $c is not running — start the stack first${RESET}\n" >&2
    exit 2
  fi
done

# ─── 1. PID-namespace ─────────────────────────────────────────────────
echo "${BOLD}1. PID-namespace isolation${RESET}"
core_proc_count=$(docker exec "$BRAIN" sh -c "ps aux | grep -E 'core-server/src/bin' | grep -v grep | wc -l | tr -d ' '" 2>&1)
if [ "$core_proc_count" -le 0 ]; then
  ok "Brain's ps output contains no Core process names (isolated)"
else
  fail "Brain sees ${core_proc_count} Core-matching process(es) in its PID namespace"
fi

# /proc enumeration — should only yield Brain's own PIDs.
proc_pids=$(docker exec "$BRAIN" ls /proc/ | grep -E '^[0-9]+$' | wc -l | tr -d ' ')
if [ "$proc_pids" -le 20 ]; then
  ok "Brain's /proc lists only ${proc_pids} PIDs (own namespace — Core PIDs absent)"
else
  fail "Brain's /proc exposes ${proc_pids} PIDs — PID namespace may be shared with host"
fi

# ─── 2. /proc/*/environ leak attempt ──────────────────────────────────
echo
echo "${BOLD}2. /proc/*/environ accessibility${RESET}"
# For each PID in Brain's /proc, try to read environ + check if any
# contain Core-specific keys like DINA_VAULT_DIR. If we see those
# strings in any environ, Core's env has leaked.
leaked_env=$(docker exec "$BRAIN" sh -c '
  for p in /proc/[0-9]*/environ; do
    if [ -r "$p" ] && tr -d "\0" < "$p" | grep -q DINA_VAULT_DIR; then
      echo leaked
    fi
  done
' 2>/dev/null)
if [ -z "$leaked_env" ]; then
  ok "No Brain-readable /proc/*/environ contains Core env (DINA_VAULT_DIR)"
else
  fail "Brain CAN read an environ containing Core's DINA_VAULT_DIR"
fi

# ─── 3. Symlink escape ────────────────────────────────────────────────
echo
echo "${BOLD}3. Symlink escape${RESET}"
# Brain can create a symlink — that's fine. What matters is: following
# it still can't reach Core's vault because Brain's mount namespace
# has no /var/lib/dina.
symlink_result=$(docker exec "$BRAIN" sh -c '
  ln -sf /var/lib/dina /tmp/escape-link 2>/dev/null
  if [ -e "/tmp/escape-link/keyfile" ]; then
    echo REACHED
  else
    echo sealed
  fi
  rm -f /tmp/escape-link
' 2>&1)
if [ "$symlink_result" = "sealed" ]; then
  ok "Symlink /tmp/escape-link → /var/lib/dina does NOT resolve to Core's keyfile"
else
  fail "Symlink escape reached Core's keyfile: $symlink_result"
fi

# ─── 4. Direct kernel memory ──────────────────────────────────────────
echo
echo "${BOLD}4. Kernel memory device nodes${RESET}"
for dev in /dev/mem /dev/kmem; do
  readable=$(docker exec "$BRAIN" sh -c "test -r '$dev' && echo yes || echo no" 2>&1)
  if [ "$readable" = "no" ]; then
    ok "$dev is NOT readable from Brain"
  else
    fail "$dev IS readable from Brain — a CAP_SYS_RAWIO leak"
  fi
done

# ─── 5. Raw network ───────────────────────────────────────────────────
echo
echo "${BOLD}5. Raw network capture${RESET}"
# /dev/net/tun requires CAP_NET_ADMIN to open for write. cap_drop: ALL
# should make it unwritable.
tun_writable=$(docker exec "$BRAIN" sh -c 'test -w /dev/net/tun && echo yes || echo no' 2>&1)
if [ "$tun_writable" = "no" ]; then
  ok "/dev/net/tun is NOT writable (CAP_NET_ADMIN correctly dropped)"
else
  fail "/dev/net/tun IS writable — CAP_NET_ADMIN leaked"
fi

# ─── 6. Linux capability inventory ────────────────────────────────────
echo
echo "${BOLD}6. Linux capability sets${RESET}"
# cap_drop: ALL should produce zero caps in Inh / Prm / Eff / Bnd / Amb.
cap_output=$(docker exec "$BRAIN" grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb)' /proc/self/status | tr -d ' \t' | awk -F: '{printf "%s=%s\n", $1, $2}')
nonzero_caps=$(echo "$cap_output" | awk -F= '$2 != "0000000000000000" { print }')
if [ -z "$nonzero_caps" ]; then
  ok "Every capability set is 0x0000000000000000 (cap_drop: ALL + no-new-privileges holds)"
else
  echo "$nonzero_caps" | while read -r c; do fail "capability set nonzero: $c"; done
fi

# ─── Summary ──────────────────────────────────────────────────────────
echo
if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — 6 escape-vector classes cleared (task 11.12)\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — escape vector found\n" >&2
  exit 1
fi
