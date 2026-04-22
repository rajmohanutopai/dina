#!/usr/bin/env bash
# Task 11.15 — read-only root filesystem verification.
#
# `docker-compose.lite.yml` sets `read_only: true` on both core-lite
# and brain-lite. The kernel mounts the container's root fs read-only
# (MS_RDONLY); any write attempt returns EROFS. This script verifies
# the mount flag is actually in effect at runtime — not just that the
# compose file declares it.
#
# Writable escape hatches are intentional and also verified:
#
#   - Core's vault volume (`dina-core-vault:/var/lib/dina`) must be
#     writable — Core needs to persist identity + vault.
#   - `/tmp` tmpfs (64 MiB) must be writable — pino-pretty stream
#     buffering, among other transient uses.
#
# Any OTHER path that accepts a write is a hardening regression.
#
# Pre-condition: the Lite stack is running
# (`./apps/home-node-lite/install-lite.sh`).
#
# Re-running:
#   ./apps/home-node-lite/docker/security-checks/verify-read-only-rootfs.sh
#
# Exit 0 on PASS, 1 on FAIL (unexpectedly-writable path), 2 if the
# stack isn't up.

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

# ─── 1. HostConfig.ReadonlyRootfs confirms the declaration ─────────────
echo "${BOLD}1. Docker runtime config${RESET}"
for c in "$CORE" "$BRAIN"; do
  ro=$(docker inspect -f '{{ .HostConfig.ReadonlyRootfs }}' "$c")
  if [ "$ro" = "true" ]; then
    ok "$c: HostConfig.ReadonlyRootfs=true (declaration in effect)"
  else
    fail "$c: HostConfig.ReadonlyRootfs=$ro — read_only: true is NOT applied"
  fi
done

# ─── 2. Empirical write-denial on the root FS ─────────────────────────
# The kernel returns EROFS ("Read-only file system") for any write
# attempt against a MS_RDONLY mount. We probe four representative
# locations that a compromised process would aim at:
#
#   /root         — no dir permissions issue; write failure MUST be EROFS
#   /etc          — config tampering vector
#   /usr/local/bin — binary planting vector
#   /bin          — same
#
# Using `touch` rather than a full write — the creat(2) syscall is
# enough to probe the mount flag. A successful touch is a FAIL.

echo
echo "${BOLD}2. Root-FS write denials (probed inside each container)${RESET}"

probe_root_denied() {
  local container="$1" label="$2" path="$3"
  # Run touch inside the container. If it succeeds, the mount isn't
  # read-only (BAD). If it fails, the mount is honouring read-only
  # (GOOD). We don't inspect the error string — any non-zero exit is
  # interpreted as denial, which is correct regardless of whether
  # the kernel returned EROFS or Docker's overlay layer intercepted.
  if docker exec "$container" sh -c "touch '$path'" >/dev/null 2>&1; then
    fail "$container: $label — wrote to $path (root FS is NOT read-only)"
    # Best-effort cleanup so re-running the probe stays idempotent even
    # if the container happens to be writable for a different reason.
    docker exec "$container" sh -c "rm -f '$path'" >/dev/null 2>&1 || true
  else
    ok "$container: $label — write to $path denied"
  fi
}

for c in "$CORE" "$BRAIN"; do
  probe_root_denied "$c" "home dir"        "/root/.dina-probe"
  probe_root_denied "$c" "system config"   "/etc/.dina-probe"
  probe_root_denied "$c" "user-local bin"  "/usr/local/bin/.dina-probe"
  probe_root_denied "$c" "system bin"      "/bin/.dina-probe"
done

# ─── 3. Writable escape hatches — MUST still work ─────────────────────
# The configured writable paths must remain usable. If /tmp or Core's
# vault volume got cut off, Core's logging + persistence would fail
# fail-closed in prod; surfacing it here catches the misconfiguration
# before a customer sees a crash loop.

echo
echo "${BOLD}3. Writable escape hatches still work${RESET}"

probe_writable() {
  local container="$1" label="$2" path="$3"
  if docker exec "$container" sh -c "touch '$path' && rm -f '$path'" >/dev/null 2>&1; then
    ok "$container: $label — $path is writable as expected"
  else
    fail "$container: $label — $path is NOT writable (escape hatch broken)"
  fi
}

for c in "$CORE" "$BRAIN"; do
  probe_writable "$c" "tmpfs" "/tmp/.dina-probe"
done
# Core's vault volume is the per-persona write surface (brain has
# none — it's stateless).
probe_writable "$CORE" "vault volume" "/var/lib/dina/.dina-probe"

# ─── 4. /tmp IS a tmpfs (not a bind mount smuggled in) ────────────────
# `read_only: true` + tmpfs is how you preserve logging ergonomics
# under a sealed root. If `/tmp` ever gets replaced by a bind mount to
# the host, the RO guarantee shrinks to "root fs + nothing bind-
# mounted". Assert the mount type is tmpfs so a future compose edit
# that loses the tmpfs directive trips this check.

echo
echo "${BOLD}4. /tmp mount type${RESET}"
for c in "$CORE" "$BRAIN"; do
  # /proc/mounts inside the container is the authoritative source;
  # docker inspect would miss an in-container remount. Field 3 is the fs type.
  fstype=$(docker exec "$c" sh -c "grep ' /tmp ' /proc/mounts | awk '{print \$3}'" 2>/dev/null || echo "")
  if [ "$fstype" = "tmpfs" ]; then
    ok "$c: /tmp is tmpfs (compose tmpfs directive honoured)"
  else
    fail "$c: /tmp is '$fstype' — expected tmpfs"
  fi
done

# ─── Summary ──────────────────────────────────────────────────────────
echo
if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — root FS is read-only, writable escape hatches work (task 11.15)\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — read-only / tmpfs invariant broken\n" >&2
  exit 1
fi
