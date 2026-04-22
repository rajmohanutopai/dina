#!/usr/bin/env bash
# Task 7.32 — clean-host `docker compose up` smoke test.
#
# Asserts the full install-cycle invariants against a host that has
# NO pre-existing Dina state:
#
#   Before: no dina-* containers, no dina-core-vault volume, no
#           dina-lite network.
#   After up (--wait):
#           - dina-core-lite + dina-brain-lite containers healthy
#           - /healthz returns 200 from both
#           - dina-core-vault volume exists (Core's state)
#           - dina-lite network exists
#   After down -v:
#           - containers gone, volume gone, network gone
#
# Failure modes surface the specific invariant that broke, so
# regressions during Phase 7 tuning get caught before the release.
#
# Pre-condition: Lite images already built (install-lite.sh or CI
# workflow produces them). This script does NOT rebuild — it's a
# smoke of the image-level artefacts.
#
# Usage:
#   ./apps/home-node-lite/docker/security-checks/smoke-clean-host.sh
#
# Env overrides:
#   - DINA_IMAGE_TAG (default: dev)
#   - DINA_SMOKE_BOOT_TIMEOUT_SEC (default: 90)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/apps/home-node-lite/docker-compose.lite.yml"

IMAGE_TAG="${DINA_IMAGE_TAG:-dev}"
BOOT_TIMEOUT="${DINA_SMOKE_BOOT_TIMEOUT_SEC:-90}"

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; FAILED=1; }
info() { printf "%s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }

FAILED=0

# Host-facing wrapper — strict clean-state assertion.
assert_clean_state() {
  local phase="$1"
  echo
  echo "${BOLD}State assertion: $phase${RESET}"
  local lingering=""
  for c in dina-core-lite dina-brain-lite; do
    if docker ps -a --filter "name=^${c}$" --format '{{.Names}}' | grep -q "^${c}$"; then
      lingering="${lingering}${c} "
    fi
  done
  if [ -n "$lingering" ]; then
    fail "lingering container(s): $lingering"
  else
    ok "no dina-core-lite / dina-brain-lite containers"
  fi

  if docker volume ls --filter 'name=^dina-core-vault$' --format '{{.Name}}' | grep -q '^dina-core-vault$'; then
    fail "dina-core-vault volume exists (state not clean)"
  else
    ok "no dina-core-vault volume"
  fi

  if docker network ls --filter 'name=^dina-lite$' --format '{{.Name}}' | grep -q '^dina-lite$'; then
    fail "dina-lite network exists (state not clean)"
  else
    ok "no dina-lite network"
  fi
}

# ─── Preflight ─────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { echo "docker not on PATH" >&2; exit 2; }
command -v curl   >/dev/null 2>&1 || { echo "curl not on PATH" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing" >&2; exit 2; }

# Verify images exist (we don't build from this script).
for img in ghcr.io/rajmohan/dina-home-node-lite-core ghcr.io/rajmohan/dina-home-node-lite-brain; do
  if ! docker image inspect "${img}:${IMAGE_TAG}" >/dev/null 2>&1; then
    echo "image not built: ${img}:${IMAGE_TAG}" >&2
    echo "  build via: install-lite.sh  or  docker build -f apps/home-node-lite/docker/Dockerfile.{core,brain}" >&2
    exit 2
  fi
done

info "${BOLD}Home Node Lite — clean-host smoke (task 7.32)${RESET}"
info "compose file: ${COMPOSE_FILE}"
info "image tag:    ${IMAGE_TAG}"
info "boot timeout: ${BOOT_TIMEOUT}s"

# ─── Phase 1: assert pre-conditions ───────────────────────────────────
# Before we can claim a clean-host test, the host MUST be clean. If it
# isn't, we fail loudly rather than starting in an unknown state.
assert_clean_state "pre-start (clean host)"
if [ "$FAILED" != 0 ]; then
  fail "aborting: host is not in a clean state. Run 'docker compose -f $COMPOSE_FILE down -v' first."
  exit 1
fi

# ─── Phase 2: up --wait ───────────────────────────────────────────────
echo
echo "${BOLD}Bringing stack up${RESET}"
# Use /dev/null for env-file so we get pure default behaviour — no
# operator overrides pollute the test.
if ! DINA_IMAGE_TAG="$IMAGE_TAG" docker compose -f "$COMPOSE_FILE" --env-file /dev/null up -d --wait --wait-timeout "$BOOT_TIMEOUT" 2>&1 | sed 's/^/  /'; then
  fail "docker compose up --wait failed or timed out (${BOOT_TIMEOUT}s)"
  docker compose -f "$COMPOSE_FILE" logs --tail 30 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
  exit 1
fi
ok "docker compose up --wait completed within ${BOOT_TIMEOUT}s"

# ─── Phase 3: runtime invariants ──────────────────────────────────────
echo
echo "${BOLD}Runtime invariants${RESET}"

for c in dina-core-lite dina-brain-lite; do
  state=$(docker inspect -f '{{ .State.Status }}' "$c" 2>/dev/null || echo "missing")
  health=$(docker inspect -f '{{ .State.Health.Status }}' "$c" 2>/dev/null || echo "none")
  if [ "$state" = "running" ] && [ "$health" = "healthy" ]; then
    ok "$c: running + healthy"
  else
    fail "$c: state=$state health=$health"
  fi
done

for pair in "core-lite:8100:core:version" "brain-lite:8200:brain:role"; do
  IFS=: read -r svc port tag field <<<"$pair"
  body=$(curl -sf "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)
  if [ -z "$body" ]; then
    fail "$svc /healthz returned no body"
  elif echo "$body" | grep -q '"status":"ok"'; then
    # Further sanity: each service's body carries a service-identifying field.
    if echo "$body" | grep -q "\"${field}\":"; then
      ok "$svc /healthz → $body"
    else
      fail "$svc /healthz missing expected field '${field}': $body"
    fi
  else
    fail "$svc /healthz did not return status=ok: $body"
  fi
done

# Volume + network must now exist.
if docker volume ls --filter 'name=^dina-core-vault$' --format '{{.Name}}' | grep -q dina-core-vault; then
  ok "dina-core-vault volume created"
else
  fail "dina-core-vault volume missing"
fi

if docker network ls --filter 'name=^dina-lite$' --format '{{.Name}}' | grep -q dina-lite; then
  ok "dina-lite network created"
else
  fail "dina-lite network missing"
fi

# ─── Phase 4: teardown ────────────────────────────────────────────────
echo
echo "${BOLD}Teardown${RESET}"
if ! docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>&1 | sed 's/^/  /'; then
  fail "docker compose down -v failed"
fi

# ─── Phase 5: post-conditions ─────────────────────────────────────────
assert_clean_state "post-teardown"

# ─── Summary ──────────────────────────────────────────────────────────
echo
if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — clean-host install cycle works end-to-end (task 7.32)\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — invariant broken\n" >&2
  exit 1
fi
