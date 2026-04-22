#!/usr/bin/env bash
# install-lite.sh — one-shot Home Node Lite bootstrap.
#
# Phase 7d of docs/HOME_NODE_LITE_TASKS.md (tasks 7.21 – 7.27):
#   - 7.21 Secret gen (BIP-39) — done by Core on first boot; this script
#          surfaces the mnemonic the operator must write down.
#   - 7.22 PDS credential prompt.
#   - 7.23 `.env` creation from .env.example + interactive prompts.
#   - 7.24 `docker compose up -d` + wait-healthy.
#   - 7.25 Print DID + recovery phrase.
#   - 7.26 Idempotent re-run (leaves existing .env + volumes alone).
#   - 7.27 `--uninstall` flag.
#
# Works against apps/home-node-lite/docker-compose.lite.yml.
# Requires: bash, docker, docker compose, curl. The containers' own
# healthchecks probe via wget (Alpine-base default); this script only
# needs curl on the host to fetch the DID after boot.
#
# Usage:
#   ./apps/home-node-lite/install-lite.sh              # install (or re-run; idempotent)
#   ./apps/home-node-lite/install-lite.sh --test-infra # install pointed at test-*.dinakernel.com (task 13.1)
#   ./apps/home-node-lite/install-lite.sh --uninstall  # stop + remove containers + network + vault
#   ./apps/home-node-lite/install-lite.sh --help       # usage summary

set -euo pipefail

# ─── Where we live ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.lite.yml"
ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE="${SCRIPT_DIR}/.env.example"

# ─── Test-infra defaults (task 13.1) ──────────────────────────────────
# When --test-infra is supplied, the PDS / MsgBox / AppView defaults
# point at the test-*.dinakernel.com infrastructure instead of the
# production community PDS (bsky.social). Used during the Phase 13
# adoption soak (task 13.2) so an operator can exercise Lite against
# the test-infra without being asked to pick infrastructure
# URLs interactively.
#
# The production path stays the default (empty / bsky.social / bsky
# relay) — matches what a first-time operator running install-lite.sh
# expects.
TEST_INFRA=false
PDS_URL_DEFAULT="https://bsky.social"

# ─── ANSI colour helpers ───────────────────────────────────────────────
if [ -t 1 ]; then
  C_RED="\033[31m"
  C_GREEN="\033[32m"
  C_YELLOW="\033[33m"
  C_BLUE="\033[34m"
  C_BOLD="\033[1m"
  C_RESET="\033[0m"
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_RESET=""
fi

info()  { printf "${C_BLUE}▸${C_RESET} %s\n" "$*"; }
ok()    { printf "${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}!${C_RESET} %s\n" "$*" >&2; }
error() { printf "${C_RED}✗${C_RESET} %s\n" "$*" >&2; }
ask()   { printf "${C_BOLD}?${C_RESET} %s " "$*"; }

# ─── Commands ──────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
install-lite.sh — bootstrap Dina Home Node Lite.

Commands:
  (no flag)        Install or re-run (idempotent). Creates .env if
                   absent, starts the stack, waits for healthz, prints
                   the first-boot mnemonic + the live DID.

  --test-infra     Modifier on (no flag) — shifts PDS / MsgBox / AppView
                   defaults to test-*.dinakernel.com instead of
                   bsky.social. Used for the Phase 13 adoption soak
                   (task 13.1). Compose with an empty handle to skip
                   PDS publish entirely during local dev.

  --uninstall      Stop + remove containers, network, and the named
                   dina-core-vault volume. Destructive — your mnemonic
                   is the only recovery path after this.

  --help, -h       Show this message.

Environment prerequisites:
  - docker (≥ 24.0)
  - docker compose plugin
  - bash, curl

The script is idempotent: re-running with an existing .env preserves
your config + vault; only containers/images are restarted. First boot
generates a 24-word BIP-39 mnemonic inside the Core container — this
script echoes it from Core's logs so you can write it down.
USAGE
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "required tool not found on PATH: $1"
    exit 1
  fi
}

uninstall() {
  info "tearing down dina-home-node-lite stack..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
  ok "stack removed (containers + network + dina-core-vault volume)"
  warn "your mnemonic was your only backup — keep it safe"
  info ".env left in place; delete it manually if you want a clean slate"
}

ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    info ".env present — re-using existing config (task 7.26 idempotent re-run)"
    return 0
  fi

  info "no .env found — generating from .env.example"

  cp "$ENV_EXAMPLE" "$ENV_FILE"

  printf "\n${C_BOLD}%s${C_RESET}\n\n" "Dina Home Node Lite — first-run setup"

  # PDS credentials (task 7.22) — optional; blank skips PDS publish.
  echo "Step 1/2 — AT Protocol PDS (optional)"
  echo "  Leave blank if you just want Dina to run locally; Trust Network"
  echo "  participation needs a PDS account on a community PDS."
  echo
  ask "PDS URL [${PDS_URL_DEFAULT}]:"; read -r pds_url
  # If the operator just hit enter, use the default (which respects
  # --test-infra if supplied). Otherwise use what they typed.
  if [ -z "$pds_url" ]; then pds_url="$PDS_URL_DEFAULT"; fi
  ask "PDS handle (e.g. alice.bsky.social) or blank to skip:"; read -r pds_handle
  pds_password=""
  if [ -n "$pds_handle" ]; then
    ask "PDS password (stored in .env — filesystem-local only):"
    read -rs pds_password
    echo
  fi

  # LLM provider (task 7.23) — must pick one to get meaningful answers.
  echo
  echo "Step 2/2 — LLM provider"
  echo "  Pick one provider. Leave all blank to install without Brain"
  echo "  reasoning (you'll still have a working vault + persona store)."
  echo
  ask "Anthropic API key (or blank):"; read -rs anthropic_key; echo
  ask "OpenAI API key (or blank):"; read -rs openai_key; echo
  ask "Gemini API key (or blank):"; read -rs gemini_key; echo

  # Write back into .env — only overriding the values the operator set.
  if [ -n "$pds_url" ];        then sed -i.bak "s|^DINA_PDS_URL=.*|DINA_PDS_URL=${pds_url}|"                   "$ENV_FILE"; fi
  if [ -n "$pds_handle" ];     then sed -i.bak "s|^DINA_PDS_HANDLE=.*|DINA_PDS_HANDLE=${pds_handle}|"          "$ENV_FILE"; fi
  if [ -n "$pds_password" ];   then sed -i.bak "s|^DINA_PDS_PASSWORD=.*|DINA_PDS_PASSWORD=${pds_password}|"    "$ENV_FILE"; fi
  if [ -n "$anthropic_key" ];  then sed -i.bak "s|^DINA_ANTHROPIC_API_KEY=.*|DINA_ANTHROPIC_API_KEY=${anthropic_key}|" "$ENV_FILE"; fi
  if [ -n "$openai_key" ];     then sed -i.bak "s|^DINA_OPENAI_API_KEY=.*|DINA_OPENAI_API_KEY=${openai_key}|"  "$ENV_FILE"; fi
  if [ -n "$gemini_key" ];     then sed -i.bak "s|^DINA_GEMINI_API_KEY=.*|DINA_GEMINI_API_KEY=${gemini_key}|"  "$ENV_FILE"; fi
  rm -f "${ENV_FILE}.bak"

  chmod 600 "$ENV_FILE"
  ok ".env created at ${ENV_FILE} (chmod 600 — readable only by $(whoami))"
}

wait_healthy() {
  local service="$1"
  local deadline=$(( $(date +%s) + 120 ))
  info "waiting for ${service} to report healthy..."
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local state
    state=$(docker inspect -f '{{ .State.Health.Status }}' "$service" 2>/dev/null || echo "starting")
    if [ "$state" = "healthy" ]; then
      ok "${service} healthy"
      return 0
    fi
    sleep 2
  done
  error "${service} did not become healthy within 120s"
  docker logs --tail 40 "$service" || true
  return 1
}

print_credentials() {
  # Task 7.25 — surface the first-boot mnemonic Core emitted as a warn
  # log line. Only shows a line the first time; re-runs won't re-emit.
  info "checking Core logs for first-boot mnemonic..."
  local mnemonic
  mnemonic=$(docker logs dina-core-lite 2>&1 | grep -oE '"mnemonic":"[^"]+"' | head -1 | sed 's/^"mnemonic":"//; s/"$//')
  if [ -n "$mnemonic" ]; then
    printf "\n${C_YELLOW}${C_BOLD}%s${C_RESET}\n\n" "⚠  YOUR 24-WORD MNEMONIC — WRITE THIS DOWN NOW"
    printf "${C_BOLD}%s${C_RESET}\n\n" "$mnemonic"
    printf "This is the only recovery path if you lose your vault.\n"
    printf "It was emitted to Core's logs; it won't be shown again.\n\n"
  else
    info "no first-boot mnemonic found in logs — vault already initialised"
  fi

  # Live-query the DID from Core. The endpoint lands in Phase 4g; if
  # absent we skip silently (not a blocker for install success).
  local did
  did=$(curl -sf "http://127.0.0.1:${DINA_CORE_PORT_EXTERNAL:-8100}/v1/identity/did" 2>/dev/null \
        | grep -oE '"did":"did:plc:[^"]+"' | head -1 | sed 's/^"did":"//; s/"$//') || true
  if [ -n "${did:-}" ]; then
    printf "${C_BOLD}DID:${C_RESET} %s\n\n" "$did"
  fi
}

install() {
  require_tool docker
  require_tool curl
  if ! docker compose version >/dev/null 2>&1; then
    error "docker compose plugin not installed"
    exit 1
  fi

  ensure_env

  info "pulling + starting containers..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

  wait_healthy dina-core-lite
  wait_healthy dina-brain-lite

  print_credentials

  ok "Dina Home Node Lite is running"
  info "core-lite:  http://127.0.0.1:${DINA_CORE_PORT_EXTERNAL:-8100}"
  info "brain-lite: http://127.0.0.1:${DINA_BRAIN_PORT_EXTERNAL:-8200}"
  info "To tear down later: $0 --uninstall"
}

# ─── Argument dispatch ─────────────────────────────────────────────────
# Support `--test-infra` as an optional modifier that composes with the
# default install path. Scans all args; unknown flags fail loudly.

for arg in "$@"; do
  case "$arg" in
    --test-infra)
      TEST_INFRA=true
      PDS_URL_DEFAULT="https://test-pds.dinakernel.com"
      info "test-infra mode — defaults point at test-*.dinakernel.com"
      ;;
    --uninstall|--help|-h)
      # Handled in the primary dispatcher below.
      ;;
    *)
      error "unknown flag: $arg"
      usage
      exit 1
      ;;
  esac
done

case "${1:-}" in
  --uninstall)   uninstall ;;
  --help|-h)     usage ;;
  --test-infra)  install ;;  # test-infra modifier already applied above
  "")            install ;;
  *)             error "unknown flag: $1"; usage; exit 1 ;;
esac
