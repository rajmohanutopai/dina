#!/usr/bin/env bash
# Task 11.11 — verify Brain cannot read Core's key file.
#
# Asserts the filesystem-level boundary between Core and Brain:
#   - Core's /var/lib/dina is a bind-mounted volume visible ONLY in
#     the core-lite container's mount namespace.
#   - Brain's container has no path that resolves to it.
#
# The distinction between "no such file" (ENOENT) and "permission
# denied" (EACCES) matters. Permission denied implies the file is
# still reachable through the kernel's path resolver — a privilege-
# escalation bug inside Brain could then target it. ENOENT means the
# file doesn't exist in Brain's view of the filesystem at all,
# because the bind mount was never attached.
#
# Expected output on success:
#
#   ✓ Core keyfile exists at /var/lib/dina/keyfile (64 bytes, chmod 600)
#   ✓ Brain ls /var/lib/dina → ENOENT (not EACCES)
#   ✓ Brain cat /var/lib/dina/keyfile → ENOENT (not EACCES)
#   ✓ Brain /proc/mounts → /var/lib/dina not mounted in Brain's namespace
#
# Expected exit 0 on success; exit 1 with a loud error if any probe
# reveals a boundary violation.
#
# Pre-condition: `docker compose -f apps/home-node-lite/docker-compose.lite.yml up -d`
# has been run and both containers are healthy.

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

# Pre-check: both containers alive.
for c in "$CORE" "$BRAIN"; do
  if ! docker inspect -f '{{ .State.Running }}' "$c" 2>/dev/null | grep -q true; then
    printf "${RED}container $c is not running — start the stack first${RESET}\n" >&2
    exit 2
  fi
done

# ─── 1. Core CAN see its own keyfile ───────────────────────────────────
echo "${BOLD}1. Core container can access its own vault${RESET}"
core_keyfile_size=$(docker exec "$CORE" sh -c 'stat -c %s /var/lib/dina/keyfile 2>/dev/null' || true)
if [ "$core_keyfile_size" = "64" ]; then
  ok "Core keyfile exists at /var/lib/dina/keyfile (64 bytes)"
else
  fail "Core keyfile missing or wrong size (got: '${core_keyfile_size}', want: 64)"
fi

core_keyfile_perm=$(docker exec "$CORE" sh -c 'stat -c %a /var/lib/dina/keyfile 2>/dev/null' || true)
if [ "$core_keyfile_perm" = "600" ]; then
  ok "Core keyfile is chmod 600 (read/write owner only)"
else
  fail "Core keyfile permissions are '${core_keyfile_perm}', want '600'"
fi

# ─── 2. Brain CANNOT see Core's vault dir ──────────────────────────────
echo
echo "${BOLD}2. Brain container cannot see Core's vault${RESET}"

brain_ls_stderr=$(docker exec "$BRAIN" ls /var/lib/dina/ 2>&1 >/dev/null || true)
if echo "$brain_ls_stderr" | grep -qi 'No such file or directory'; then
  ok "Brain ls /var/lib/dina → ENOENT"
elif echo "$brain_ls_stderr" | grep -qiE 'Permission denied|EACCES'; then
  fail "Brain ls /var/lib/dina → EACCES (BOUNDARY LEAK: path still reachable via kernel)"
else
  fail "Brain ls /var/lib/dina → unexpected output: $brain_ls_stderr"
fi

brain_cat_stderr=$(docker exec "$BRAIN" cat /var/lib/dina/keyfile 2>&1 >/dev/null || true)
if echo "$brain_cat_stderr" | grep -qi 'No such file or directory'; then
  ok "Brain cat /var/lib/dina/keyfile → ENOENT"
elif echo "$brain_cat_stderr" | grep -qiE 'Permission denied|EACCES'; then
  fail "Brain cat /var/lib/dina/keyfile → EACCES (BOUNDARY LEAK)"
else
  fail "Brain cat /var/lib/dina/keyfile → unexpected output: $brain_cat_stderr"
fi

# ─── 3. Brain's mount namespace has no Dina-vault mount ────────────────
echo
echo "${BOLD}3. Brain's mount namespace verification${RESET}"

brain_mounts=$(docker exec "$BRAIN" cat /proc/mounts 2>&1)
if echo "$brain_mounts" | grep -q '/var/lib/dina'; then
  fail "Brain has a /var/lib/dina mount in /proc/mounts (BOUNDARY LEAK)"
  echo "$brain_mounts" | grep '/var/lib/dina' | sed 's/^/    /'
else
  ok "Brain's mount namespace has no /var/lib/dina entry"
fi

# ─── 4. Pathological probe — explicit escape attempts ─────────────────
echo
echo "${BOLD}4. Pathological path probes${RESET}"

for probe in \
  '/var/lib/dina' \
  '/var/lib/dina/keyfile' \
  '/var/lib/dina/identity.sqlite' \
  '/var/lib/dina/vault/personal.sqlite' \
  ; do
  result=$(docker exec "$BRAIN" sh -c "test -e '$probe' && echo visible || echo absent" 2>&1 || true)
  if [ "$result" = "absent" ]; then
    ok "Brain test -e '$probe' → absent"
  else
    fail "Brain test -e '$probe' → $result (BOUNDARY LEAK)"
  fi
done

# ─── Summary ──────────────────────────────────────────────────────────
echo
if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — filesystem boundary verified (task 11.11)\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — boundary violation detected\n" >&2
  exit 1
fi
