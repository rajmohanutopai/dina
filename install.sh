#!/usr/bin/env bash
# install.sh — One-command Dina Home Node setup
#
# Usage:
#   ./install.sh                 # first-time setup
#   ./install.sh --skip-build    # skip Docker build (use existing images)
#
# What it does:
#   1. Checks prerequisites (docker, docker compose, curl)
#   2. Checks port availability
#   3. Generates secrets (brain_token, identity seed)
#   4. Creates .env configuration
#   5. Builds and starts Docker containers
#   6. Waits for health checks to pass
#   7. Displays your DID and recovery phrase
#
# Host filesystem: only secrets/ and .env are created.
# All runtime data lives in Docker named volumes (dina-data, dina-models).
#
# Idempotent: safe to re-run. Existing secrets and seeds are preserved.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DINA_DIR="${DINA_DIR:-$(pwd)}"
SECRETS_DIR="${DINA_DIR}/secrets"
ENV_FILE="${DINA_DIR}/.env"
CORE_PORT="${DINA_CORE_PORT:-8100}"
HEALTH_TIMEOUT=90     # seconds to wait for health check
HEALTH_INTERVAL=3     # seconds between health check attempts
SKIP_BUILD=false

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
    esac
done

# ---------------------------------------------------------------------------
# Colors (disabled if not a terminal)
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    RESET='\033[0m'
else
    GREEN='' YELLOW='' RED='' CYAN='' BOLD='' DIM='' RESET=''
fi

ok()   { echo -e "  ${GREEN}[ok]${RESET}   $1"; }
skip() { echo -e "  ${DIM}[skip]${RESET} $1"; }
fail() { echo -e "  ${RED}[fail]${RESET} $1" >&2; exit 1; }
warn() { echo -e "  ${YELLOW}[warn]${RESET} $1"; }
info() { echo -e "  ${DIM}[....]${RESET} $1"; }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       Dina Home Node Setup           ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Directory: ${CYAN}${DINA_DIR}${RESET}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Prerequisites
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 1: Checking prerequisites${RESET}"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install from https://docs.docker.com/get-docker/"
ok "Docker found"

# Check for 'docker compose' (v2 plugin) or 'docker-compose' (legacy)
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    ok "Docker Compose found (plugin)"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    ok "Docker Compose found (standalone)"
else
    fail "Docker Compose not found. Install from https://docs.docker.com/compose/install/"
fi

command -v curl >/dev/null 2>&1 || fail "curl is not installed."
ok "curl found"

# Check Docker daemon is running
docker info >/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker and try again."
ok "Docker daemon running"

echo ""

# ---------------------------------------------------------------------------
# Step 2: Port check
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 2: Checking port availability${RESET}"

if curl -s --connect-timeout 2 "http://localhost:${CORE_PORT}/healthz" >/dev/null 2>&1; then
    warn "Port ${CORE_PORT} is already in use (Dina may already be running)"
    echo -e "       Run ${CYAN}./uninstall.sh${RESET} first, or set DINA_CORE_PORT to a different port."
    echo ""
fi

ok "Port ${CORE_PORT} ready"
echo ""

# ---------------------------------------------------------------------------
# Step 3: Generate secrets
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 3: Generating secrets${RESET}"

mkdir -p "${SECRETS_DIR}"

# Brain token (shared secret between Core and Brain)
if [ ! -f "${SECRETS_DIR}/brain_token" ]; then
    python3 -c "import secrets; print(secrets.token_urlsafe(32), end='')" \
        > "${SECRETS_DIR}/brain_token" 2>/dev/null \
        || openssl rand -base64 32 | tr -d '\n' > "${SECRETS_DIR}/brain_token"
    ok "Generated brain_token"
else
    skip "brain_token already exists"
fi

echo ""

# ---------------------------------------------------------------------------
# Step 4: Generate identity seed
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 4: Setting up identity${RESET}"

# Check if .env already has DINA_IDENTITY_SEED
EXISTING_SEED=""
if [ -f "${ENV_FILE}" ]; then
    EXISTING_SEED=$(grep -oP 'DINA_IDENTITY_SEED=\K[a-f0-9]+' "${ENV_FILE}" 2>/dev/null || true)
fi

if [ -n "${EXISTING_SEED}" ]; then
    skip "Identity seed already set in .env"
    IDENTITY_SEED="${EXISTING_SEED}"
else
    # Generate 32 random bytes (256 bits) → hex
    IDENTITY_SEED=$(python3 -c "import secrets; print(secrets.token_hex(32), end='')" 2>/dev/null \
        || openssl rand -hex 32 | tr -d '\n')
    ok "Generated identity seed (256-bit)"
fi

echo ""

# ---------------------------------------------------------------------------
# Step 5: Create .env
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 5: Writing configuration${RESET}"

if [ ! -f "${ENV_FILE}" ]; then
    cat > "${ENV_FILE}" << ENVEOF
# Dina Home Node Configuration
# Generated by install.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Identity seed (DO NOT SHARE — your recovery phrase derives from this)
DINA_IDENTITY_SEED=${IDENTITY_SEED}

# Ports (defaults)
# DINA_CORE_PORT=8100
# DINA_BRAIN_PORT=8200
# DINA_LLM_PORT=8080

# Rate limiting
# DINA_RATE_LIMIT=100

# Dead drop spool limit (bytes, default 10MB)
# DINA_SPOOL_MAX=10485760

# LLM configuration
# DINA_LLM_URL=http://llm:8080
# DINA_LLM_MODEL=gemma-2b-it-q4_k_m.gguf

# Cloud LLM (optional — leave empty for local-only)
# DINA_CLOUD_LLM=gemini
# GOOGLE_API_KEY=your-key-here
# ANTHROPIC_API_KEY=your-key-here

# Logging
# DINA_LOG_LEVEL=INFO
ENVEOF
    ok "Created .env"
else
    # Ensure DINA_IDENTITY_SEED is in existing .env
    if [ -z "${EXISTING_SEED}" ]; then
        echo "" >> "${ENV_FILE}"
        echo "# Identity seed (added by install.sh)" >> "${ENV_FILE}"
        echo "DINA_IDENTITY_SEED=${IDENTITY_SEED}" >> "${ENV_FILE}"
        ok "Added identity seed to existing .env"
    else
        skip ".env already configured"
    fi
fi

echo ""

# ---------------------------------------------------------------------------
# Step 6: Lock permissions
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 6: Locking permissions${RESET}"

chmod 700 "${SECRETS_DIR}"
chmod 600 "${SECRETS_DIR}"/*
chmod 600 "${ENV_FILE}"

ok "Permissions locked (secrets: 600, .env: 600)"
echo ""

# ---------------------------------------------------------------------------
# Step 8: Build Docker images
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 7: Building Docker images${RESET}"

if [ "${SKIP_BUILD}" = true ]; then
    skip "Build skipped (--skip-build)"
else
    info "This may take a few minutes on first run..."
    if $COMPOSE build 2>&1 | while IFS= read -r line; do
        # Show progress dots
        printf "."
    done; then
        echo ""
        ok "Docker images built"
    else
        echo ""
        fail "Docker build failed. Check the output above."
    fi
fi

echo ""

# ---------------------------------------------------------------------------
# Step 9: Start containers
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 8: Starting containers${RESET}"

$COMPOSE up -d 2>&1 | while IFS= read -r line; do
    echo -e "  ${DIM}${line}${RESET}"
done

ok "Containers started"
echo ""

# ---------------------------------------------------------------------------
# Step 10: Wait for health
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 9: Waiting for health check${RESET}"

BRAIN_TOKEN=$(cat "${SECRETS_DIR}/brain_token")
ELAPSED=0

while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
    STATUS=$(curl -s --connect-timeout 3 \
        -H "Authorization: Bearer ${BRAIN_TOKEN}" \
        "http://localhost:${CORE_PORT}/healthz" 2>/dev/null || true)

    if echo "${STATUS}" | grep -q '"status"'; then
        ok "Core is healthy"
        break
    fi

    printf "  ${DIM}[....]${RESET} Waiting... (%ds/%ds)\r" "$ELAPSED" "$HEALTH_TIMEOUT"
    sleep $HEALTH_INTERVAL
    ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

if [ $ELAPSED -ge $HEALTH_TIMEOUT ]; then
    warn "Health check timed out after ${HEALTH_TIMEOUT}s"
    echo -e "       Check logs: ${CYAN}${COMPOSE} logs${RESET}"
    echo ""
    echo -e "${BOLD}Partial setup complete.${RESET} Containers are running but may still be starting."
    echo -e "Re-run ${CYAN}./install.sh --skip-build${RESET} once services are ready."
    exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# Step 11: Retrieve identity
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 10: Retrieving your identity${RESET}"

# Get DID
DID_RESPONSE=$(curl -s --connect-timeout 5 \
    -H "Authorization: Bearer ${BRAIN_TOKEN}" \
    "http://localhost:${CORE_PORT}/v1/did" 2>/dev/null || true)

DID=$(echo "${DID_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)

if [ -z "${DID}" ]; then
    warn "Could not retrieve DID"
else
    ok "DID retrieved"
fi

# Get mnemonic (recovery phrase)
MNEMONIC_RESPONSE=$(curl -s --connect-timeout 5 \
    -H "Authorization: Bearer ${BRAIN_TOKEN}" \
    "http://localhost:${CORE_PORT}/v1/identity/mnemonic" 2>/dev/null || true)

MNEMONIC=$(echo "${MNEMONIC_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mnemonic',''))" 2>/dev/null || true)

if [ -z "${MNEMONIC}" ]; then
    warn "Could not retrieve recovery phrase"
fi

echo ""

# ---------------------------------------------------------------------------
# Final banner
# ---------------------------------------------------------------------------

echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║                  Your Dina Home Node is Live!               ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}"
echo ""

if [ -n "${DID}" ]; then
    echo -e "  ${BOLD}Your DID (Decentralized Identifier):${RESET}"
    echo -e "  ${CYAN}${DID}${RESET}"
    echo ""
fi

if [ -n "${MNEMONIC}" ]; then
    echo -e "  ${BOLD}Your Recovery Phrase:${RESET}"
    echo -e "  ${YELLOW}╔══════════════════════════════════════════════════════════╗${RESET}"
    # Print 4 words per line for readability
    WORD_NUM=1
    LINE=""
    for word in ${MNEMONIC}; do
        LINE="${LINE}$(printf '%2d. %-12s' ${WORD_NUM} "${word}")"
        if [ $((WORD_NUM % 4)) -eq 0 ]; then
            echo -e "  ${YELLOW}║${RESET}  ${LINE}${YELLOW}║${RESET}"
            LINE=""
        fi
        WORD_NUM=$((WORD_NUM + 1))
    done
    echo -e "  ${YELLOW}╚══════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo -e "  ${RED}${BOLD}SAVE THIS! You need it to recover your Dina.${RESET}"
    echo -e "  ${RED}Write it down on paper. Do not store it digitally.${RESET}"
    echo ""
fi

echo -e "  ${BOLD}Services:${RESET}"
echo -e "    Core:   ${CYAN}http://localhost:${CORE_PORT}${RESET}"
echo -e "    Health: ${CYAN}http://localhost:${CORE_PORT}/healthz${RESET}"
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "    Logs:      ${CYAN}${COMPOSE} logs -f${RESET}"
echo -e "    Stop:      ${CYAN}${COMPOSE} down${RESET}"
echo -e "    Uninstall: ${CYAN}./uninstall.sh${RESET}"
echo ""
