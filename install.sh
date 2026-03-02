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
#   4. Asks which LLM provider to use (Gemini, OpenAI, Claude, OpenRouter, Ollama)
#   5. Creates .env configuration with your API key
#   6. Builds and starts Docker containers
#   7. Waits for health checks to pass
#   8. Displays your DID and recovery phrase
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

# PDS secrets (JWT secret, admin password, K256 rotation key)
PDS_JWT_SECRET=""
PDS_ADMIN_PASSWORD=""
PDS_ROTATION_KEY=""

if [ -f "${ENV_FILE}" ]; then
    PDS_JWT_SECRET=$(sed -n 's/^DINA_PDS_JWT_SECRET=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
    PDS_ADMIN_PASSWORD=$(sed -n 's/^DINA_PDS_ADMIN_PASSWORD=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
    PDS_ROTATION_KEY=$(sed -n 's/^DINA_PDS_ROTATION_KEY_HEX=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
fi

PDS_GENERATED=false
if [ -z "${PDS_JWT_SECRET}" ]; then
    PDS_JWT_SECRET=$(openssl rand -hex 32)
    PDS_GENERATED=true
fi

if [ -z "${PDS_ADMIN_PASSWORD}" ]; then
    PDS_ADMIN_PASSWORD=$(openssl rand -hex 16)
    PDS_GENERATED=true
fi

if [ -z "${PDS_ROTATION_KEY}" ]; then
    PDS_ROTATION_KEY=$(openssl rand -hex 32)
    PDS_GENERATED=true
fi

if [ "${PDS_GENERATED}" = true ]; then
    ok "Generated PDS secrets"
else
    skip "PDS secrets already set"
fi

echo ""

# ---------------------------------------------------------------------------
# Step 4: Identity setup — new or restore
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 4: Setting up identity${RESET}"

# Check if .env already has DINA_IDENTITY_SEED
EXISTING_SEED=""
if [ -f "${ENV_FILE}" ]; then
    EXISTING_SEED=$(sed -n 's/^DINA_IDENTITY_SEED=\([a-f0-9]*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
fi

IDENTITY_NEW=true   # tracks whether we generated a new identity

if [ -n "${EXISTING_SEED}" ]; then
    skip "Identity seed already set in .env"
    IDENTITY_SEED="${EXISTING_SEED}"
    IDENTITY_NEW=false
elif [ -t 0 ]; then
    # Interactive terminal — ask user
    echo ""
    echo -e "  ${BOLD}Your identity is your cryptographic passport.${RESET}"
    echo -e "  ${DIM}It determines your DID and all encryption keys.${RESET}"
    echo ""
    echo -e "    ${CYAN}1)${RESET} Create new identity          ${DIM}(first-time setup)${RESET}"
    echo -e "    ${CYAN}2)${RESET} Restore from recovery phrase  ${DIM}(24 words from a previous install)${RESET}"
    echo -e "    ${CYAN}3)${RESET} Restore from seed hex         ${DIM}(advanced — 64-char hex string)${RESET}"
    echo ""
    printf "  Enter choice [1-3]: "
    read -r IDENTITY_CHOICE

    case "${IDENTITY_CHOICE}" in
        2)
            # Restore from 24-word mnemonic
            echo ""
            echo -e "  Enter your 24-word recovery phrase (space-separated):"
            printf "  > "
            read -r MNEMONIC_INPUT

            while true; do
                SEED_ERR=$(python3 scripts/mnemonic_to_seed.py "${MNEMONIC_INPUT}" 2>&1)
                if [ $? -eq 0 ]; then
                    IDENTITY_SEED="${SEED_ERR}"
                    IDENTITY_NEW=false
                    ok "Identity restored from recovery phrase"
                    break
                else
                    echo -e "  ${YELLOW}✗${RESET} ${SEED_ERR}"
                    echo ""
                    echo -e "    ${CYAN}1)${RESET} Try again"
                    echo -e "    ${CYAN}2)${RESET} Create new identity instead"
                    echo ""
                    printf "  What would you like to do? [1-2]: "
                    read -r RETRY_MNEMONIC
                    case "${RETRY_MNEMONIC}" in
                        1)
                            echo ""
                            echo -e "  Enter your 24-word recovery phrase:"
                            printf "  > "
                            read -r MNEMONIC_INPUT
                            ;;
                        *)
                            # Fall through to generate new
                            IDENTITY_SEED=""
                            break
                            ;;
                    esac
                fi
            done
            ;;
        3)
            # Restore from raw hex seed
            echo ""
            printf "  Enter your 64-character hex seed: "
            read -r HEX_INPUT
            HEX_INPUT=$(echo "${HEX_INPUT}" | tr -d '[:space:]')

            if [ ${#HEX_INPUT} -eq 64 ] && echo "${HEX_INPUT}" | grep -qE '^[0-9a-fA-F]+$'; then
                IDENTITY_SEED=$(echo "${HEX_INPUT}" | tr '[:upper:]' '[:lower:]')
                IDENTITY_NEW=false
                ok "Identity restored from hex seed"
            else
                warn "Invalid hex seed (expected 64 hex characters) — generating new identity"
                IDENTITY_SEED=""
            fi
            ;;
        *)
            # Default: create new (option 1 or any other input)
            IDENTITY_SEED=""
            ;;
    esac

    # Generate new seed if not restored
    if [ -z "${IDENTITY_SEED}" ]; then
        IDENTITY_SEED=$(python3 -c "import secrets; print(secrets.token_hex(32), end='')" 2>/dev/null \
            || openssl rand -hex 32 | tr -d '\n')
        IDENTITY_NEW=true
        ok "Generated new identity (256-bit seed)"
    fi
else
    # Non-interactive — generate new
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
    # --- Interactive LLM provider selection ---
    echo ""
    echo -e "  ${BOLD}Which LLM provider would you like to use?${RESET}"
    echo ""
    echo -e "    ${CYAN}1)${RESET} Gemini      ${DIM}(Google — free tier available)${RESET}"
    echo -e "    ${CYAN}2)${RESET} OpenAI      ${DIM}(GPT-5.2)${RESET}"
    echo -e "    ${CYAN}3)${RESET} Claude      ${DIM}(Anthropic)${RESET}"
    echo -e "    ${CYAN}4)${RESET} OpenRouter  ${DIM}(access 200+ models via one key)${RESET}"
    echo -e "    ${CYAN}5)${RESET} Ollama      ${DIM}(local models, fully private — no API key needed)${RESET}"
    echo -e "    ${CYAN}6)${RESET} Skip        ${DIM}(configure later in .env)${RESET}"
    echo ""

    PROVIDER_CHOICE=""
    LLM_KEY_NAME=""
    LLM_KEY_VALUE=""
    LLM_EXTRA_LINES=""

    if [ -t 0 ]; then
        # Interactive terminal — prompt user
        printf "  Enter choice [1-6]: "
        read -r PROVIDER_CHOICE
    else
        # Non-interactive (piped input) — default to skip
        PROVIDER_CHOICE="6"
        info "Non-interactive mode — skipping provider selection"
    fi

    case "${PROVIDER_CHOICE}" in
        1)
            LLM_KEY_NAME="GEMINI_API_KEY"
            echo ""
            echo -e "  Get a free key at: ${CYAN}https://aistudio.google.com/apikey${RESET}"
            printf "  Enter your Gemini API key: "
            read -r LLM_KEY_VALUE
            ;;
        2)
            LLM_KEY_NAME="OPENAI_API_KEY"
            echo ""
            echo -e "  Get a key at: ${CYAN}https://platform.openai.com/api-keys${RESET}"
            printf "  Enter your OpenAI API key: "
            read -r LLM_KEY_VALUE
            ;;
        3)
            LLM_KEY_NAME="ANTHROPIC_API_KEY"
            echo ""
            echo -e "  Get a key at: ${CYAN}https://console.anthropic.com/${RESET}"
            printf "  Enter your Anthropic API key: "
            read -r LLM_KEY_VALUE
            ;;
        4)
            LLM_KEY_NAME="OPENROUTER_API_KEY"
            LLM_EXTRA_LINES="OPENROUTER_MODEL=google/gemini-2.5-flash"
            echo ""
            echo -e "  Get a key at: ${CYAN}https://openrouter.ai/keys${RESET}"
            printf "  Enter your OpenRouter API key: "
            read -r LLM_KEY_VALUE
            ;;
        5)
            LLM_KEY_NAME="OLLAMA_BASE_URL"
            LLM_KEY_VALUE="http://localhost:11434"
            echo ""
            echo -e "  ${DIM}Using local Ollama at http://localhost:11434${RESET}"
            echo -e "  ${DIM}Make sure Ollama is running: ollama serve${RESET}"
            ;;
        *)
            info "Skipping provider setup — edit .env later to add your API key"
            ;;
    esac

    # Validate API key by sending a tiny completion through the real provider.
    # Uses the same Brain adapter classes the application uses at runtime —
    # if this works here, it will work in production.
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ] && [ -t 0 ] && command -v python3 &>/dev/null; then
        while true; do
            printf "  Validating API key (sending a test completion)... "
            VALIDATE_ERR=$(python3 scripts/validate_key.py "${LLM_KEY_NAME}" "${LLM_KEY_VALUE}" 2>&1)
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓${RESET} Key works"
                break
            else
                echo -e "${YELLOW}✗${RESET} Key did not work"
                if [ -n "${VALIDATE_ERR}" ]; then
                    echo -e "  ${DIM}${VALIDATE_ERR}${RESET}"
                fi
                echo ""
                echo -e "    ${CYAN}1)${RESET} Re-enter key"
                echo -e "    ${CYAN}2)${RESET} Continue without a key  ${DIM}(you can add it to .env later)${RESET}"
                echo -e "    ${CYAN}3)${RESET} Exit"
                echo ""
                printf "  What would you like to do? [1-3]: "
                read -r RETRY_CHOICE
                case "${RETRY_CHOICE}" in
                    1)
                        printf "  Enter your API key: "
                        read -r LLM_KEY_VALUE
                        if [ -z "${LLM_KEY_VALUE}" ]; then
                            info "Empty key — continuing without provider"
                            LLM_KEY_NAME=""
                            LLM_KEY_VALUE=""
                            break
                        fi
                        ;;
                    3)
                        echo ""
                        info "Exiting. Re-run ./install.sh when ready."
                        exit 0
                        ;;
                    *)
                        info "Continuing without validated key — edit .env later"
                        LLM_KEY_NAME=""
                        LLM_KEY_VALUE=""
                        break
                        ;;
                esac
            fi
        done
    fi

    # Write .env file
    cat > "${ENV_FILE}" << ENVEOF
# Dina Home Node Configuration
# Generated by install.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Identity seed (DO NOT SHARE — your recovery phrase derives from this)
DINA_IDENTITY_SEED=${IDENTITY_SEED}

# AT Protocol PDS secrets (auto-generated, do not edit)
DINA_PDS_JWT_SECRET=${PDS_JWT_SECRET}
DINA_PDS_ADMIN_PASSWORD=${PDS_ADMIN_PASSWORD}
DINA_PDS_ROTATION_KEY_HEX=${PDS_ROTATION_KEY}
ENVEOF

    # Add the selected provider key
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ]; then
        echo "" >> "${ENV_FILE}"
        echo "# LLM Provider" >> "${ENV_FILE}"
        echo "${LLM_KEY_NAME}=${LLM_KEY_VALUE}" >> "${ENV_FILE}"
        if [ -n "${LLM_EXTRA_LINES}" ]; then
            echo "${LLM_EXTRA_LINES}" >> "${ENV_FILE}"
        fi
    fi

    echo "" >> "${ENV_FILE}"
    cat >> "${ENV_FILE}" << 'ENVEOF'
# Other providers (uncomment and set to enable)
# GEMINI_API_KEY=
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
# OPENROUTER_MODEL=google/gemini-2.5-flash
# OLLAMA_BASE_URL=http://localhost:11434
ENVEOF

    chmod 600 "${ENV_FILE}"
    ok "Created .env (mode 600)"
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ]; then
        ok "Configured ${LLM_KEY_NAME}"
    fi
else
    # Ensure DINA_IDENTITY_SEED is in existing .env
    if [ -z "${EXISTING_SEED}" ]; then
        echo "" >> "${ENV_FILE}"
        echo "# Identity seed (added by install.sh)" >> "${ENV_FILE}"
        echo "DINA_IDENTITY_SEED=${IDENTITY_SEED}" >> "${ENV_FILE}"
        ok "Added identity seed to existing .env"
    else
        skip "Identity seed already set"
    fi

    # Ensure PDS secrets are in existing .env
    if ! grep -q "^DINA_PDS_JWT_SECRET=" "${ENV_FILE}" 2>/dev/null; then
        echo "" >> "${ENV_FILE}"
        echo "# AT Protocol PDS secrets (added by install.sh)" >> "${ENV_FILE}"
        echo "DINA_PDS_JWT_SECRET=${PDS_JWT_SECRET}" >> "${ENV_FILE}"
        echo "DINA_PDS_ADMIN_PASSWORD=${PDS_ADMIN_PASSWORD}" >> "${ENV_FILE}"
        echo "DINA_PDS_ROTATION_KEY_HEX=${PDS_ROTATION_KEY}" >> "${ENV_FILE}"
        ok "Added PDS secrets to existing .env"
    else
        skip "PDS secrets already set"
    fi

    chmod 600 "${ENV_FILE}"
fi

echo ""

# ---------------------------------------------------------------------------
# Step 6: Lock permissions
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 6: Locking permissions${RESET}"

chmod 700 "${SECRETS_DIR}"
chmod 600 "${SECRETS_DIR}"/*

# Ensure .env and secrets/ are in .gitignore (safety net)
GITIGNORE="${DINA_DIR}/.gitignore"
if [ -f "${GITIGNORE}" ]; then
    grep -qxF '.env' "${GITIGNORE}" 2>/dev/null || echo '.env' >> "${GITIGNORE}"
    grep -qxF 'secrets/' "${GITIGNORE}" 2>/dev/null || echo 'secrets/' >> "${GITIGNORE}"
else
    printf '.env\nsecrets/\n' > "${GITIGNORE}"
fi

ok "Permissions locked (.env: 600, secrets/: 700)"
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
    echo ""
    echo -e "  ${BOLD}Container status:${RESET}"
    $COMPOSE ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null | while IFS= read -r line; do
        echo "    $line"
    done
    echo ""
    # Show logs for any unhealthy container
    for svc in pds core brain; do
        HEALTH=$($COMPOSE ps "$svc" --format "{{.Health}}" 2>/dev/null || true)
        if [ "$HEALTH" != "healthy" ] && [ -n "$HEALTH" ]; then
            echo -e "  ${YELLOW}${svc}${RESET} is ${HEALTH} — last 15 log lines:"
            $COMPOSE logs --tail=15 "$svc" 2>/dev/null | while IFS= read -r line; do
                echo "    ${line}"
            done
            echo ""
        fi
    done
    echo -e "  Full logs: ${CYAN}${COMPOSE} logs${RESET}"
    echo ""
    echo -e "${BOLD}Partial setup complete.${RESET} Containers may still be starting."
    echo -e "Re-run ${CYAN}./install.sh --skip-build${RESET} once services are ready."
    exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# Step 11: Retrieve identity
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 10: Retrieving your identity${RESET}"

# Only derive and show the mnemonic for new identities.
# Restored users already have their recovery phrase.
MNEMONIC=""
DID=""

if [ "${IDENTITY_NEW}" = true ]; then
    MNEMONIC=$(python3 scripts/seed_to_mnemonic.py "${IDENTITY_SEED}" 2>/dev/null || true)
    if [ -n "${MNEMONIC}" ]; then
        ok "Recovery phrase derived — SAVE IT (shown below)"
    else
        warn "Could not derive recovery phrase"
    fi
else
    ok "Identity restored — recovery phrase not shown (you already have it)"
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
elif [ "${IDENTITY_NEW}" = false ]; then
    echo -e "  ${GREEN}Identity restored successfully.${RESET}"
    echo ""
fi

echo -e "  ${BOLD}Services:${RESET}"
echo -e "    Core:   ${CYAN}http://localhost:${CORE_PORT}${RESET}"
echo -e "    PDS:    ${CYAN}http://localhost:${DINA_PDS_PORT:-2583}${RESET}"
echo -e "    Health: ${CYAN}http://localhost:${CORE_PORT}/healthz${RESET}"
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "    Logs:      ${CYAN}${COMPOSE} logs -f${RESET}"
echo -e "    Stop:      ${CYAN}${COMPOSE} down${RESET}"
echo -e "    Uninstall: ${CYAN}./uninstall.sh${RESET}"
echo ""
