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
#   3. Generates secrets (service key directory, identity seed)
#   4. Wraps identity seed with passphrase (Argon2id + AES-256-GCM)
#   5. Asks which LLM provider to use (Gemini, OpenAI, Claude, OpenRouter, Ollama)
#   6. Creates .env configuration with your API key
#   7. Builds and starts Docker containers
#   8. Waits for health checks to pass
#   9. Displays your DID
#
# Security: The raw identity seed never touches disk. It is wrapped with a
# user-chosen passphrase and only the encrypted form is stored. Two modes:
#   - Maximum Security: passphrase required on every restart (never stored)
#   - Server Mode: passphrase stored in secrets/ for unattended boot
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

# Service key directories (Ed25519 keypairs for Core↔Brain mutual auth)
# Separate bind mounts ensure private keys never exist in the peer's container.
#   core/   → mounted only to Core container (private key)
#   brain/  → mounted only to Brain container (private key)
#   public/ → mounted to both containers (public keys)
SERVICE_KEY_DIR="${SECRETS_DIR}/service_keys"
mkdir -p "${SERVICE_KEY_DIR}/core" "${SERVICE_KEY_DIR}/brain" "${SERVICE_KEY_DIR}/public"
chmod 700 "${SERVICE_KEY_DIR}" "${SERVICE_KEY_DIR}/core" "${SERVICE_KEY_DIR}/brain"
chmod 755 "${SERVICE_KEY_DIR}/public"
ok "Service key directories ready (core/, brain/, public/)"

# Internal token for admin/agent proxy (Core→Brain bearer auth for browser paths)
INTERNAL_TOKEN_FILE="${SECRETS_DIR}/internal_token"
if [ ! -f "${INTERNAL_TOKEN_FILE}" ]; then
    openssl rand -hex 32 > "${INTERNAL_TOKEN_FILE}"
    chmod 600 "${INTERNAL_TOKEN_FILE}"
    ok "Generated DINA_INTERNAL_TOKEN"
else
    skip "DINA_INTERNAL_TOKEN already exists"
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

# Prepare crypto venv for seed wrapping + BIP-39 mnemonic
INSTALL_VENV="${DINA_DIR}/.install-venv"
if [ ! -f "${INSTALL_VENV}/bin/python3" ]; then
    info "Setting up crypto tools..."
    python3 -m venv "${INSTALL_VENV}" 2>/dev/null
    "${INSTALL_VENV}/bin/pip" install -q argon2-cffi cryptography mnemonic 2>/dev/null
    ok "Crypto tools ready"
else
    skip "Crypto tools already installed"
fi
VPYTHON="${INSTALL_VENV}/bin/python3"

echo ""

# ---------------------------------------------------------------------------
# Step 4: Identity setup — new or restore + wrap
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 4: Setting up identity${RESET}"

# Check if seed is already wrapped (wrapped_seed.bin exists)
SEED_ALREADY_WRAPPED=false
if [ -f "${SECRETS_DIR}/wrapped_seed.bin" ] && [ -f "${SECRETS_DIR}/master_seed.salt" ]; then
    SEED_ALREADY_WRAPPED=true
fi

# Check if .env has a raw DINA_MASTER_SEED (legacy — needs migration)
EXISTING_SEED=""
if [ -f "${ENV_FILE}" ]; then
    EXISTING_SEED=$(sed -n 's/^DINA_MASTER_SEED=\([a-f0-9]*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
fi

IDENTITY_NEW=true   # tracks whether we generated a new identity
SEED_MODE=""        # "maximum" or "server"

if [ "${SEED_ALREADY_WRAPPED}" = true ] && [ -z "${EXISTING_SEED}" ]; then
    skip "Identity seed already wrapped"
    MASTER_SEED=""
    IDENTITY_NEW=false
elif [ -n "${EXISTING_SEED}" ]; then
    # Legacy migration: raw seed in .env — wrap it now
    warn "Raw identity seed found in .env — migrating to encrypted storage"
    MASTER_SEED="${EXISTING_SEED}"
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
                SEED_ERR=$("${VPYTHON}" scripts/mnemonic_to_seed.py "${MNEMONIC_INPUT}" 2>&1)
                if [ $? -eq 0 ]; then
                    MASTER_SEED="${SEED_ERR}"
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
                            MASTER_SEED=""
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
                MASTER_SEED=$(echo "${HEX_INPUT}" | tr '[:upper:]' '[:lower:]')
                IDENTITY_NEW=false
                ok "Identity restored from hex seed"
            else
                warn "Invalid hex seed (expected 64 hex characters) — generating new identity"
                MASTER_SEED=""
            fi
            ;;
        *)
            # Default: create new (option 1 or any other input)
            MASTER_SEED=""
            ;;
    esac

    # Generate new seed if not restored
    if [ -z "${MASTER_SEED}" ]; then
        MASTER_SEED=$(python3 -c "import secrets; print(secrets.token_hex(32), end='')" 2>/dev/null \
            || openssl rand -hex 32 | tr -d '\n')
        IDENTITY_NEW=true
        ok "Generated new identity (256-bit seed)"
    fi
else
    # Non-interactive — generate new
    MASTER_SEED=$(python3 -c "import secrets; print(secrets.token_hex(32), end='')" 2>/dev/null \
        || openssl rand -hex 32 | tr -d '\n')
    ok "Generated identity seed (256-bit)"
fi

# --- Show recovery phrase (only for new identities, before wrapping) ---
if [ -n "${MASTER_SEED}" ] && [ "${IDENTITY_NEW}" = true ]; then
    MNEMONIC=$("${VPYTHON}" scripts/seed_to_mnemonic.py "${MASTER_SEED}" 2>/dev/null || true)
    if [ -n "${MNEMONIC}" ]; then
        echo ""
        echo -e "  ${BOLD}Your Recovery Phrase:${RESET}"
        # Build lines first, then compute box width from the widest line.
        MNEMONIC_LINES=()
        WORD_NUM=1
        LINE=""
        for word in ${MNEMONIC}; do
            LINE="${LINE}$(printf '%2d. %-12s' ${WORD_NUM} "${word}")"
            if [ $((WORD_NUM % 4)) -eq 0 ]; then
                MNEMONIC_LINES+=("${LINE}")
                LINE=""
            fi
            WORD_NUM=$((WORD_NUM + 1))
        done
        [ -n "${LINE}" ] && MNEMONIC_LINES+=("${LINE}")

        BOX_W=0
        for ml in "${MNEMONIC_LINES[@]}"; do
            [ ${#ml} -gt ${BOX_W} ] && BOX_W=${#ml}
        done
        BOX_W=$((BOX_W + 2))

        BORDER=$(printf '═%.0s' $(seq 1 ${BOX_W}))
        echo -e "  ${YELLOW}╔${BORDER}╗${RESET}"
        for ml in "${MNEMONIC_LINES[@]}"; do
            printf "  ${YELLOW}║${RESET} %-$((BOX_W - 2))s ${YELLOW}║${RESET}\n" "${ml}"
        done
        echo -e "  ${YELLOW}╚${BORDER}╝${RESET}"
        echo ""
        echo -e "  ${RED}${BOLD}SAVE THIS! You need it to recover your Dina.${RESET}"
        echo -e "  ${RED}Write it down on paper. Do not store it digitally.${RESET}"

        # --- Verify user saved it: ask for 3 random words ---
        if [ -t 0 ]; then
            echo ""
            echo -e "  ${BOLD}Let's verify you saved it.${RESET}"
            echo -e "  ${DIM}Enter the words for the positions below:${RESET}"
            echo ""

            # Split mnemonic into array
            WORDS=()
            for w in ${MNEMONIC}; do
                WORDS+=("$w")
            done

            # Pick 3 random positions (1-indexed, unique, sorted)
            VERIFY_POS=($(python3 -c "import random; nums = random.sample(range(1, 25), 3); nums.sort(); print(' '.join(str(n) for n in nums))" 2>/dev/null))

            VERIFY_PASS=true
            for pos in "${VERIFY_POS[@]}"; do
                EXPECTED="${WORDS[$((pos - 1))]}"
                printf "  Word #%d: " "${pos}"
                read -r USER_WORD
                USER_WORD=$(echo "${USER_WORD}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
                if [ "${USER_WORD}" != "${EXPECTED}" ]; then
                    VERIFY_PASS=false
                    break
                fi
            done

            if [ "${VERIFY_PASS}" = true ]; then
                ok "Recovery phrase verified"
            else
                echo ""
                echo -e "  ${YELLOW}✗${RESET} That doesn't match. Showing the phrase one more time:"
                echo ""
                echo -e "  ${YELLOW}╔${BORDER}╗${RESET}"
                for ml in "${MNEMONIC_LINES[@]}"; do
                    printf "  ${YELLOW}║${RESET} %-$((BOX_W - 2))s ${YELLOW}║${RESET}\n" "${ml}"
                done
                echo -e "  ${YELLOW}╚${BORDER}╝${RESET}"
                echo ""
                echo -e "  ${RED}${BOLD}Write it down now. This is your last chance to see it.${RESET}"
                echo ""
                printf "  Press Enter when you've saved it..."
                read -r _
                ok "Continuing (save your recovery phrase!)"
            fi
        fi
    fi
fi

# --- Wrap the seed with a passphrase ---
if [ -n "${MASTER_SEED}" ]; then
    echo ""
    if [ -t 0 ]; then
        echo -e "  ${BOLD}Choose how to protect your identity seed:${RESET}"
        echo ""
        echo -e "    ${CYAN}1)${RESET} Maximum Security  ${DIM}— enter passphrase on every restart (recommended)${RESET}"
        echo -e "    ${CYAN}2)${RESET} Server Mode       ${DIM}— store passphrase for unattended boot${RESET}"
        echo -e "                          ${DIM}(passphrase stored in secrets/ — convenience trade-off)${RESET}"
        echo ""
        printf "  Enter choice [1-2]: "
        read -r SEED_MODE_CHOICE

        case "${SEED_MODE_CHOICE}" in
            2) SEED_MODE="server" ;;
            *) SEED_MODE="maximum" ;;
        esac

        # Prompt for passphrase (min 8 chars, confirmed)
        echo ""
        echo -e "  ${BOLD}Choose a passphrase to encrypt your identity seed:${RESET}"
        echo -e "  ${DIM}(minimum 8 characters)${RESET}"
        while true; do
            printf "  Passphrase: "
            read -rs SEED_PASSPHRASE
            echo ""
            if [ ${#SEED_PASSPHRASE} -lt 8 ]; then
                echo -e "  ${YELLOW}✗${RESET} Passphrase must be at least 8 characters"
                continue
            fi
            printf "  Confirm:    "
            read -rs SEED_PASSPHRASE_CONFIRM
            echo ""
            if [ "${SEED_PASSPHRASE}" != "${SEED_PASSPHRASE_CONFIRM}" ]; then
                echo -e "  ${YELLOW}✗${RESET} Passphrases do not match — try again"
                continue
            fi
            break
        done
    else
        # Non-interactive: auto-generate passphrase, Server Mode
        SEED_MODE="server"
        SEED_PASSPHRASE=$(python3 -c "import secrets; print(secrets.token_urlsafe(32), end='')" 2>/dev/null \
            || openssl rand -base64 32 | tr -d '\n')
        warn "Non-interactive: auto-generated passphrase (Server Mode)"
    fi

    # Call wrap_seed.py
    info "Encrypting identity seed (Argon2id + AES-256-GCM)..."
    if "${VPYTHON}" scripts/wrap_seed.py \
        "${MASTER_SEED}" "${SEED_PASSPHRASE}" "${SECRETS_DIR}" >/dev/null 2>&1; then
        ok "Identity seed encrypted"
    else
        fail "Failed to encrypt identity seed"
    fi

    # Server Mode: store passphrase in secrets/
    if [ "${SEED_MODE}" = "server" ]; then
        printf '%s' "${SEED_PASSPHRASE}" > "${SECRETS_DIR}/seed_password"
        chmod 600 "${SECRETS_DIR}/seed_password"
        ok "Passphrase stored in secrets/seed_password (Server Mode)"
    else
        # Maximum Security: create empty file (Docker Secrets needs it to exist)
        : > "${SECRETS_DIR}/seed_password"
        chmod 600 "${SECRETS_DIR}/seed_password"
    fi

    # If migrating from raw seed in .env, remove it
    if [ -n "${EXISTING_SEED}" ] && [ -f "${ENV_FILE}" ]; then
        sed -i.bak '/^DINA_MASTER_SEED=/d' "${ENV_FILE}" 2>/dev/null \
            || sed -i '' '/^DINA_MASTER_SEED=/d' "${ENV_FILE}"
        rm -f "${ENV_FILE}.bak"
        ok "Removed raw seed from .env (migrated to encrypted storage)"
    fi

    # Zero the seed variable — raw seed must not persist
    MASTER_SEED="0000000000000000000000000000000000000000000000000000000000000000"
    unset MASTER_SEED
    SEED_PASSPHRASE=""; unset SEED_PASSPHRASE
    SEED_PASSPHRASE_CONFIRM=""; unset SEED_PASSPHRASE_CONFIRM
    ok "Raw seed zeroed from memory"

    # Show mode-specific guidance
    echo ""
    if [ "${SEED_MODE}" = "maximum" ]; then
        echo -e "  ┌─────────────────────────────────────────────────────┐"
        echo -e "  │ ${BOLD}Maximum Security mode${RESET}: you will need to provide     │"
        echo -e "  │ your passphrase on every container restart.         │"
        echo -e "  │                                                     │"
        echo -e "  │ Start with:                                         │"
        echo -e "  │   ${CYAN}DINA_SEED_PASSWORD=<passphrase> \\\\${RESET}                  │"
        echo -e "  │     ${CYAN}docker compose up -d${RESET}                            │"
        echo -e "  └─────────────────────────────────────────────────────┘"
    else
        echo -e "  ┌─────────────────────────────────────────────────────┐"
        echo -e "  │ ${BOLD}Server Mode${RESET}: passphrase stored for unattended boot. │"
        echo -e "  │ Containers restart automatically.                   │"
        echo -e "  └─────────────────────────────────────────────────────┘"
    fi
fi

echo ""

# ---------------------------------------------------------------------------
# Step 5: Create .env
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 5: Writing configuration${RESET}"

# --- Optional: Telegram bot setup ---
# Runs for both new and existing .env (skips if already configured).
TELEGRAM_TOKEN=""
TELEGRAM_USER_ID=""
EXISTING_TG_TOKEN=""
if [ -f "${ENV_FILE}" ]; then
    EXISTING_TG_TOKEN=$(sed -n 's/^DINA_TELEGRAM_TOKEN=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
fi

if [ -n "${EXISTING_TG_TOKEN}" ]; then
    skip "Telegram bot already configured in .env"
elif [ -t 0 ]; then
    echo ""
    echo -e "  ${BOLD}Would you like to connect a Telegram bot?${RESET}"
    echo -e "  ${DIM}Dina can chat with you via Telegram — fully optional.${RESET}"
    echo ""
    echo -e "    ${CYAN}1)${RESET} Yes — I have a bot token (or will create one now)"
    echo -e "    ${CYAN}2)${RESET} Skip ${DIM}(you can set this up later in .env)${RESET}"
    echo ""
    printf "  Enter choice [1-2]: "
    read -r TG_CHOICE

    if [ "${TG_CHOICE}" = "1" ]; then
        echo ""
        echo -e "  ${BOLD}Step A: Create a Telegram bot${RESET}"
        echo -e "    1. Open Telegram and message ${CYAN}@BotFather${RESET}"
        echo -e "    2. Send ${CYAN}/newbot${RESET} and follow the prompts"
        echo -e "    3. Copy the token (looks like ${DIM}123456:ABC-DEF...${RESET})"
        echo ""
        printf "  Enter your bot token: "
        read -r TELEGRAM_TOKEN
        TELEGRAM_TOKEN=$(echo "${TELEGRAM_TOKEN}" | tr -d '[:space:]')

        if [ -n "${TELEGRAM_TOKEN}" ]; then
            echo ""
            echo -e "  ${BOLD}Step B: Get your Telegram user ID${RESET}"
            echo -e "    1. Message ${CYAN}@userinfobot${RESET} on Telegram"
            echo -e "    2. It will reply with your numeric ID (e.g. ${DIM}987654321${RESET})"
            echo ""
            printf "  Enter your Telegram user ID: "
            read -r TELEGRAM_USER_ID
            TELEGRAM_USER_ID=$(echo "${TELEGRAM_USER_ID}" | tr -d '[:space:]')

            if [ -n "${TELEGRAM_USER_ID}" ]; then
                ok "Telegram bot configured (token + user ID)"
            else
                warn "No user ID entered — bot will reject all messages until DINA_TELEGRAM_ALLOWED_USERS is set in .env"
            fi
        else
            info "No token entered — skipping Telegram setup"
            TELEGRAM_TOKEN=""
        fi
    fi
fi

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

    # Read internal token for .env
    INTERNAL_TOKEN_VALUE=""
    if [ -f "${SECRETS_DIR}/internal_token" ]; then
        INTERNAL_TOKEN_VALUE=$(cat "${SECRETS_DIR}/internal_token" | tr -d '\n')
    fi

    # Write .env file (seed is NOT stored here — it's in secrets/wrapped_seed.bin)
    cat > "${ENV_FILE}" << ENVEOF
# Dina Home Node Configuration
# Generated by install.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# Identity seed is encrypted in secrets/wrapped_seed.bin (not stored here).

# Internal token for admin/agent proxy (auto-generated, do not edit)
DINA_INTERNAL_TOKEN=${INTERNAL_TOKEN_VALUE}

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

    # Add Telegram config if provided
    if [ -n "${TELEGRAM_TOKEN}" ]; then
        echo "" >> "${ENV_FILE}"
        echo "# Telegram Bot" >> "${ENV_FILE}"
        echo "DINA_TELEGRAM_TOKEN=${TELEGRAM_TOKEN}" >> "${ENV_FILE}"
        if [ -n "${TELEGRAM_USER_ID}" ]; then
            echo "DINA_TELEGRAM_ALLOWED_USERS=${TELEGRAM_USER_ID}" >> "${ENV_FILE}"
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

# Telegram Bot (uncomment and set to enable)
# DINA_TELEGRAM_TOKEN=
# DINA_TELEGRAM_ALLOWED_USERS=
# DINA_TELEGRAM_ALLOWED_GROUPS=
ENVEOF

    chmod 600 "${ENV_FILE}"
    ok "Created .env (mode 600)"
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ]; then
        ok "Configured ${LLM_KEY_NAME}"
    fi
else
    # Ensure DINA_INTERNAL_TOKEN is in existing .env
    if ! grep -q "^DINA_INTERNAL_TOKEN=" "${ENV_FILE}" 2>/dev/null; then
        INTERNAL_TOKEN_VALUE=""
        if [ -f "${SECRETS_DIR}/internal_token" ]; then
            INTERNAL_TOKEN_VALUE=$(cat "${SECRETS_DIR}/internal_token" | tr -d '\n')
        fi
        echo "" >> "${ENV_FILE}"
        echo "# Internal token for admin/agent proxy (added by install.sh)" >> "${ENV_FILE}"
        echo "DINA_INTERNAL_TOKEN=${INTERNAL_TOKEN_VALUE}" >> "${ENV_FILE}"
        ok "Added DINA_INTERNAL_TOKEN to existing .env"
    else
        skip "DINA_INTERNAL_TOKEN already in .env"
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

    # Ensure Telegram config is in existing .env (if user provided it)
    if [ -n "${TELEGRAM_TOKEN}" ] && ! grep -q "^DINA_TELEGRAM_TOKEN=" "${ENV_FILE}" 2>/dev/null; then
        echo "" >> "${ENV_FILE}"
        echo "# Telegram Bot (added by install.sh)" >> "${ENV_FILE}"
        echo "DINA_TELEGRAM_TOKEN=${TELEGRAM_TOKEN}" >> "${ENV_FILE}"
        if [ -n "${TELEGRAM_USER_ID}" ]; then
            echo "DINA_TELEGRAM_ALLOWED_USERS=${TELEGRAM_USER_ID}" >> "${ENV_FILE}"
        fi
        ok "Added Telegram config to existing .env"
    fi

    chmod 600 "${ENV_FILE}"
fi

echo ""

# ---------------------------------------------------------------------------
# Step 6: Lock permissions
# ---------------------------------------------------------------------------

echo -e "${BOLD}Step 6: Locking permissions${RESET}"

chmod 700 "${SECRETS_DIR}"
# Lock files but preserve directory permissions (service_keys/ has subdirs)
find "${SECRETS_DIR}" -maxdepth 1 -type f -exec chmod 600 {} +

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

ELAPSED=0

while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
    STATUS=$(curl -s --connect-timeout 3 \
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
# Final banner
# ---------------------------------------------------------------------------

BANNER_MSG="Your Dina Home Node is Live!"
BANNER_W=$(( ${#BANNER_MSG} + 4 ))  # 2 space padding each side
[ ${BANNER_W} -lt 40 ] && BANNER_W=40
BANNER_BORDER=$(printf '═%.0s' $(seq 1 ${BANNER_W}))
BANNER_PAD=$(( (BANNER_W - ${#BANNER_MSG}) / 2 ))
BANNER_LEFT=$(printf '%*s' ${BANNER_PAD} '')
BANNER_RIGHT=$(printf '%*s' $(( BANNER_W - BANNER_PAD - ${#BANNER_MSG} )) '')
echo -e "${BOLD}╔${BANNER_BORDER}╗${RESET}"
echo -e "${BOLD}║${BANNER_LEFT}${BANNER_MSG}${BANNER_RIGHT}║${RESET}"
echo -e "${BOLD}╚${BANNER_BORDER}╝${RESET}"
echo ""

echo -e "  ${BOLD}Identity:${RESET}"
echo -e "    Seed:      ${GREEN}encrypted${RESET} (AES-256-GCM + Argon2id)"
if [ -n "${SEED_MODE}" ]; then
    if [ "${SEED_MODE}" = "maximum" ]; then
        echo -e "    Mode:      ${CYAN}Maximum Security${RESET} (passphrase on restart)"
    else
        echo -e "    Mode:      ${CYAN}Server Mode${RESET} (unattended boot)"
    fi
fi
echo ""

echo -e "  ${BOLD}Services:${RESET}"
echo -e "    Core:      ${CYAN}http://localhost:${CORE_PORT}${RESET}"
echo -e "    PDS:       ${CYAN}http://localhost:${DINA_PDS_PORT:-2583}${RESET}"
echo -e "    Health:    ${CYAN}http://localhost:${CORE_PORT}/healthz${RESET}"
if [ -n "${TELEGRAM_TOKEN}" ] || [ -n "${EXISTING_TG_TOKEN}" ]; then
    echo -e "    Telegram:  ${GREEN}connected${RESET}"
fi
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "    Admin:     ${CYAN}${COMPOSE} exec core dina-admin status${RESET}"
echo -e "    Logs:      ${CYAN}${COMPOSE} logs -f${RESET}"
echo -e "    Stop:      ${CYAN}${COMPOSE} down${RESET}"
echo -e "    Uninstall: ${CYAN}./uninstall.sh${RESET}"
echo ""
