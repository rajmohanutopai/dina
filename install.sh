#!/usr/bin/env bash
# install.sh — One-command Dina Home Node setup
#
# Usage:
#   ./install.sh                 # first-time setup
#   ./install.sh --skip-build    # skip Docker build (use existing images)
#   ./install.sh --verbose       # show detailed internal output
#
# What it does:
#   1. Checks prerequisites (docker, docker compose, curl)
#   2. Allocates ports
#   3. Generates secrets (service key directory, identity seed)
#   4. Wraps identity seed with passphrase (Argon2id + AES-256-GCM)
#   5. Asks which LLM provider to use (Gemini, OpenAI, Claude, OpenRouter, Ollama)
#   6. Creates .env configuration with your API key
#   7. Builds and starts Docker containers
#   8. Waits for health checks to pass
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
cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DINA_DIR="${DINA_DIR:-$(pwd)}"
SECRETS_DIR="${DINA_DIR}/secrets"
ENV_FILE="${DINA_DIR}/.env"
HEALTH_TIMEOUT=90     # seconds to wait for health check
HEALTH_INTERVAL=3     # seconds between health check attempts
SKIP_BUILD=false
VERBOSE=false

# Default port bases (auto-allocated if in use)
DEFAULT_CORE_PORT=8100
DEFAULT_PDS_PORT=2583

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --verbose|-v) VERBOSE=true ;;
    esac
done

# ---------------------------------------------------------------------------
# Shared modules
# ---------------------------------------------------------------------------

# shellcheck source=scripts/setup/colors.sh
source scripts/setup/colors.sh
# shellcheck source=scripts/setup/env_ensure.sh
source scripts/setup/env_ensure.sh
# shellcheck source=scripts/setup/llm_provider.sh
source scripts/setup/llm_provider.sh
# shellcheck source=scripts/setup/telegram.sh
source scripts/setup/telegram.sh

# ---------------------------------------------------------------------------
# Crypto runner — runs Python crypto scripts inside a Docker container
# so the host machine does not need Python installed.
# ---------------------------------------------------------------------------

CRYPTO_IMAGE="dina-crypto-tools"
CRYPTO_IMAGE_BUILT=false

build_crypto_image() {
    if [ "${CRYPTO_IMAGE_BUILT}" = true ]; then
        return 0
    fi
    if [ "${VERBOSE}" = true ]; then
        info "Building crypto tools image..."
        if docker build -q -t "${CRYPTO_IMAGE}" -f scripts/setup/Dockerfile.crypto scripts/setup/ >/dev/null 2>&1; then
            CRYPTO_IMAGE_BUILT=true
            ok "Crypto tools image ready"
        else
            fail "Failed to build crypto tools image. Check that Docker is running."
        fi
    else
        printf "  %-44s" "Preparing crypto tools..."
        # Run build in background with a spinner
        docker build -q -t "${CRYPTO_IMAGE}" -f scripts/setup/Dockerfile.crypto scripts/setup/ >/dev/null 2>&1 &
        local _build_pid=$!
        local _spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
        local _i=0
        local _spun=false
        while kill -0 "$_build_pid" 2>/dev/null; do
            printf "\b${CYAN}${_spin:_i++%${#_spin}:1}${RESET}"
            _spun=true
            sleep 0.1
        done
        wait "$_build_pid"
        local _rc=$?
        [ "$_spun" = true ] && printf "\b \b"
        if [ $_rc -eq 0 ]; then
            CRYPTO_IMAGE_BUILT=true
            echo -e "${GREEN}done${RESET}"
        else
            echo -e "${RED}failed${RESET}"
            fail "Failed to build crypto tools image. Check that Docker is running."
        fi
    fi
}

# Run a Python crypto script inside the container.
# Usage: run_crypto <script> [script-args...] [-e VAR=val ...] [-v host:cont ...]
run_crypto() {
    build_crypto_image
    local script="$1"; shift
    local docker_args=()
    local script_args=()
    while [ $# -gt 0 ]; do
        case "$1" in
            -e|-v) docker_args+=("$1" "$2"); shift 2 ;;
            *)     script_args+=("$1"); shift ;;
        esac
    done
    docker run --rm --user "$(id -u):$(id -g)" \
        -v "${DINA_DIR}/scripts:/scripts:ro" \
        "${docker_args[@]}" \
        "${CRYPTO_IMAGE}" \
        python3 "/scripts/${script#scripts/}" "${script_args[@]}"
}

# ---------------------------------------------------------------------------
# Output helpers (default = clean user-facing; --verbose = full detail)
# ---------------------------------------------------------------------------

# Verbose-only output — replaces ok/skip/info for internal details.
verbose_ok()   { [ "${VERBOSE}" = true ] && ok "$1"   || true; }
verbose_skip() { [ "${VERBOSE}" = true ] && skip "$1"  || true; }
verbose_info() { [ "${VERBOSE}" = true ] && info "$1"  || true; }

# Progress lines for non-interactive sections.
#   step_begin "Doing something..."   → prints line without newline
#   step_end                          → appends "done" (default) or nothing (verbose)
step_begin() {
    if [ "${VERBOSE}" = true ]; then
        echo ""
        echo -e "${BOLD}$1${RESET}"
    else
        printf "  %-44s" "$1"
    fi
}
step_end() {
    [ "${VERBOSE}" = true ] || echo -e "${GREEN}done${RESET}"
}
step_end_skip() {
    [ "${VERBOSE}" = true ] || echo -e "${DIM}already done${RESET}"
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo ""
echo -e "  ${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${BOLD}  Setting up Dina${RESET}"
echo -e "  ${DIM}  ${DINA_DIR}${RESET}"
echo -e "  ${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Prerequisites
# ---------------------------------------------------------------------------

step_begin "Checking your system..."

command -v docker >/dev/null 2>&1 || fail "Docker not found.\n\n  Dina needs Docker to run. Please install Docker and try again:\n  ${CYAN}https://docs.docker.com/get-docker/${RESET}"
verbose_ok "Docker found"

# Check for 'docker compose' (v2 plugin) or 'docker-compose' (legacy)
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    verbose_ok "Docker Compose found (plugin)"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    verbose_ok "Docker Compose found (standalone)"
else
    fail "Docker Compose not found.\n\n  Dina needs Docker Compose to run. Please install it and try again:\n  ${CYAN}https://docs.docker.com/compose/install/${RESET}"
fi

command -v curl >/dev/null 2>&1 || fail "curl not found. Please install curl and try again."
verbose_ok "curl found"

command -v openssl >/dev/null 2>&1 || fail "openssl not found. Please install openssl and try again."
verbose_ok "openssl found"

# Check Docker daemon is accessible
if ! docker info >/dev/null 2>&1; then
    [ "${VERBOSE}" = true ] || echo ""
    fail "Cannot connect to Docker.\n\n  Please make sure these commands work before running install.sh:\n\n    ${REVERSE} docker run hello-world ${RESET}\n    ${REVERSE} docker compose version ${RESET}\n\n  If they don't, please install or configure Docker and try again."
fi
verbose_ok "Docker daemon running"

step_end

# ---------------------------------------------------------------------------
# Step 2: Port allocation (verbose-only — shown in final banner)
# ---------------------------------------------------------------------------

if [ "${VERBOSE}" = true ]; then
    echo ""
    echo -e "${BOLD}Allocating ports${RESET}"
fi

# If ports were previously allocated and saved in .env, reuse them.
if [ -f "${ENV_FILE}" ]; then
    SAVED_CORE_PORT=$(sed -n 's/^DINA_CORE_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
    SAVED_PDS_PORT=$(sed -n 's/^DINA_PDS_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
fi

# Use saved ports, env overrides, or auto-detect free ports.
CORE_PORT="${SAVED_CORE_PORT:-${DINA_CORE_PORT:-}}"
PDS_PORT="${SAVED_PDS_PORT:-${DINA_PDS_PORT:-}}"

if [ -z "${CORE_PORT}" ]; then
    CORE_PORT=$(find_free_port "${DEFAULT_CORE_PORT}")
fi
if [ -z "${PDS_PORT}" ]; then
    PDS_PORT=$(find_free_port "${DEFAULT_PDS_PORT}")
fi

verbose_ok "Core port: ${CORE_PORT}"
verbose_ok "PDS port:  ${PDS_PORT}"

# ---------------------------------------------------------------------------
# Step 3: Prepare crypto tools + secure storage
# ---------------------------------------------------------------------------

# Build the crypto Docker image first (its own line with spinner)
build_crypto_image

step_begin "Preparing secure storage..."

# ---------------------------------------------------------------------------
# Ownership repair: Docker bind mounts may have created secrets/ as root
# during a prior run. We must own these paths before proceeding.
# ---------------------------------------------------------------------------
_repair_ownership() {
    [ -d "${SECRETS_DIR}" ] || return 0

    local need_fix=0
    # First check: can we even read/write the top-level directory?
    # A root-owned 700 directory is not traversable by the current user,
    # so find would silently produce no output — we must check this first.
    if [ ! -w "${SECRETS_DIR}" ] || [ ! -x "${SECRETS_DIR}" ]; then
        need_fix=1
    elif find "${SECRETS_DIR}" -maxdepth 3 \( ! -writable -o ! -readable \) -print -quit 2>/dev/null | grep -q .; then
        need_fix=1
    fi

    [ "$need_fix" -eq 1 ] || return 0

    # Not writable — need sudo to reclaim ownership
    echo ""
    echo -e "  ${YELLOW}Fixing file ownership${RESET} ${DIM}(a previous run created files as root)${RESET}"
    if sudo chown -R "$(id -u):$(id -g)" "${SECRETS_DIR}"; then
        verbose_ok "Ownership repaired"
    else
        fail "Cannot fix ownership of ${SECRETS_DIR}.\n\n  Run:  ${CYAN}sudo chown -R \$(id -u):\$(id -g) secrets/${RESET}\n  Then run ./install.sh again."
    fi
}

[ -d "${SECRETS_DIR}" ] && _repair_ownership
mkdir -p "${SECRETS_DIR}"

# Service key directories (Ed25519 keypairs for Core↔Brain mutual auth)
# Pre-create all bind-mounted paths BEFORE Docker Compose runs, so Docker
# doesn't create them as root.
#   core/   → mounted only to Core container (private key)
#   brain/  → mounted only to Brain container (private key)
#   public/ → mounted read-only to both containers (public keys)
SERVICE_KEY_DIR="${SECRETS_DIR}/service_keys"
mkdir -p "${SERVICE_KEY_DIR}/core" "${SERVICE_KEY_DIR}/brain" "${SERVICE_KEY_DIR}/public"
chmod 700 "${SERVICE_KEY_DIR}" "${SERVICE_KEY_DIR}/core" "${SERVICE_KEY_DIR}/brain"
chmod 755 "${SERVICE_KEY_DIR}/public"
verbose_ok "Service key directories ready"

# Session ID — 3-char alphanumeric identifier for this deployment.
# Scopes all container names (core-a7k, brain-a7k) and Docker resources.
# Lowercase only — Docker Compose project names require it.
# Generated once; preserved across re-runs.
SESSION_ID_FILE="${SECRETS_DIR}/session_id"
if [ -f "${SESSION_ID_FILE}" ]; then
    DINA_SESSION=$(cat "${SESSION_ID_FILE}")
    verbose_skip "Session ID: ${DINA_SESSION}"
else
    DINA_SESSION=$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 3 || true)
    printf '%s' "${DINA_SESSION}" > "${SESSION_ID_FILE}"
    chmod 600 "${SESSION_ID_FILE}"
    verbose_ok "Session ID: ${DINA_SESSION}"
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
    verbose_ok "Generated PDS secrets"
else
    verbose_skip "PDS secrets already set"
fi

# Service key provisioning is deferred until the master seed is available
# (after identity setup). See the provisioning block below wrap_seed.py.

step_end

# ---------------------------------------------------------------------------
# Step 4: Identity setup — new or restore + wrap
# ---------------------------------------------------------------------------

# Check if seed is already wrapped (wrapped_seed.bin exists)
SEED_ALREADY_WRAPPED=false
if [ -f "${SECRETS_DIR}/wrapped_seed.bin" ] && [ -f "${SECRETS_DIR}/master_seed.salt" ]; then
    SEED_ALREADY_WRAPPED=true
fi

# Strict no-legacy mode: raw DINA_MASTER_SEED in .env is not supported.
if [ -f "${ENV_FILE}" ] && grep -q '^DINA_MASTER_SEED=' "${ENV_FILE}" 2>/dev/null; then
    fail "Legacy DINA_MASTER_SEED detected in .env. Remove it and rerun install.sh."
fi

IDENTITY_NEW=true   # tracks whether we generated a new identity
SEED_MODE=""        # "maximum" or "server"

if [ "${SEED_ALREADY_WRAPPED}" = true ]; then
    step_begin "Creating your identity..."
    verbose_skip "Identity already created"
    MASTER_SEED=""
    IDENTITY_NEW=false
    step_end_skip
elif [ -t 0 ]; then
    # Interactive terminal — ask user
    echo ""
    echo -e "  ${BOLD}Creating your identity${RESET}"
    echo ""
    echo -e "  ${DIM}Your identity generates your username (DID) and encryption keys.${RESET}"
    echo -e "  ${DIM}Your recovery phrase is the master key — anyone with these words can access your identity and data.${RESET}"
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
            echo -e "  ${BOLD}Enter your 24-word recovery phrase${RESET} ${DIM}(space-separated):${RESET}"
            printf "  ${CYAN}>${RESET} "
            read -r MNEMONIC_INPUT

            while true; do
                SEED_ERR=$(run_crypto scripts/mnemonic_to_seed.py "${MNEMONIC_INPUT}" 2>&1)
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
                            echo -e "  ${BOLD}Enter your 24-word recovery phrase:${RESET}"
                            printf "  ${CYAN}>${RESET} "
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
            printf "  ${BOLD}Enter your 64-character hex seed:${RESET} "
            read -r HEX_INPUT
            HEX_INPUT=$(echo "${HEX_INPUT}" | tr -d '[:space:]')

            if [ ${#HEX_INPUT} -eq 64 ] && echo "${HEX_INPUT}" | grep -qE '^[0-9a-fA-F]+$'; then
                MASTER_SEED=$(echo "${HEX_INPUT}" | tr '[:upper:]' '[:lower:]')
                IDENTITY_NEW=false
                ok "Identity restored from hex seed"
            else
                warn "Invalid hex seed (expected 64 hex characters) — creating new identity"
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
        MASTER_SEED=$(openssl rand -hex 32 | tr -d '\n')
        IDENTITY_NEW=true
        verbose_ok "Generated new identity seed"
    fi
else
    # Non-interactive — generate new
    MASTER_SEED=$(openssl rand -hex 32 | tr -d '\n')
    verbose_ok "Generated identity seed"
fi

# --- Show recovery phrase (only for new identities, before wrapping) ---
if [ -n "${MASTER_SEED}" ] && [ "${IDENTITY_NEW}" = true ]; then
    MNEMONIC=$(run_crypto scripts/seed_to_mnemonic.py "${MASTER_SEED}" 2>/dev/null || true)
    if [ -n "${MNEMONIC}" ]; then
        echo ""
        echo -e "  ${BOLD}Your Recovery Phrase${RESET}"
        echo ""
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
        echo -e "  ${RED}${BOLD}SAVE THIS RECOVERY PHRASE! You need it to recover your Dina.${RESET}"
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
            _vp_nums=()
            while [ ${#_vp_nums[@]} -lt 3 ]; do
                _vp_n=$(( $(od -An -tu4 -N4 /dev/urandom | tr -d ' ') % 24 + 1 ))
                _vp_dup=false
                for _vp_e in "${_vp_nums[@]}"; do [ "$_vp_e" = "$_vp_n" ] && _vp_dup=true; done
                [ "$_vp_dup" = false ] && _vp_nums+=("$_vp_n")
            done
            VERIFY_POS=($(printf '%s\n' "${_vp_nums[@]}" | sort -n))

            VERIFY_PASS=true
            for pos in "${VERIFY_POS[@]}"; do
                EXPECTED="${WORDS[$((pos - 1))]}"
                printf "  ${BOLD}Word #%d:${RESET} " "${pos}"
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
            fi
        fi
    fi
fi

# --- Wrap the seed with a passphrase ---
if [ -n "${MASTER_SEED}" ]; then
    echo ""
    if [ -t 0 ]; then
        # Step 1: Always collect the passphrase first
        echo -e "  ${BOLD}Choose a passphrase to protect your identity:${RESET}"
        echo -e "  ${DIM}(minimum 8 characters)${RESET}"
        while true; do
            printf "  ${BOLD}Passphrase:${RESET} "
            read -rs SEED_PASSPHRASE
            echo ""
            if [ ${#SEED_PASSPHRASE} -lt 8 ]; then
                echo -e "  ${YELLOW}✗${RESET} Passphrase must be at least 8 characters"
                continue
            fi
            printf "  ${BOLD}Confirm:${RESET}    "
            read -rs SEED_PASSPHRASE_CONFIRM
            echo ""
            if [ "${SEED_PASSPHRASE}" != "${SEED_PASSPHRASE_CONFIRM}" ]; then
                echo -e "  ${YELLOW}✗${RESET} Passphrases do not match — try again"
                continue
            fi
            break
        done

        # Step 2: Ask about startup mode
        echo ""
        echo -e "  ${BOLD}How should Dina start?${RESET}"
        echo ""
        echo -e "    ${CYAN}1)${RESET} Enter passphrase each time  ${DIM}(most secure)${RESET}"
        echo -e "    ${CYAN}2)${RESET} Start automatically         ${DIM}(passphrase stored locally)${RESET}"
        echo ""
        echo -e "  ${DIM}You can switch later: ${CYAN}dina-admin security auto-start${RESET} ${DIM}or${RESET} ${CYAN}manual-start${RESET}"
        echo ""
        printf "  Enter choice [1-2]: "
        read -r SEED_MODE_CHOICE

        case "${SEED_MODE_CHOICE}" in
            2) SEED_MODE="server" ;;
            *) SEED_MODE="maximum" ;;
        esac
    else
        # Non-interactive: auto-generate passphrase, Server Mode
        SEED_MODE="server"
        SEED_PASSPHRASE=$(openssl rand -base64 32 | tr -d '\n')
        verbose_info "Non-interactive: auto-generated passphrase (Server Mode)"
    fi

    # Call wrap_seed.py — secrets passed via env to avoid process-list exposure.
    info "Securing your identity..."
    if run_crypto scripts/wrap_seed.py /secrets \
        -e DINA_SEED_HEX="${MASTER_SEED}" \
        -e DINA_SEED_PASSPHRASE="${SEED_PASSPHRASE}" \
        -v "${SECRETS_DIR}:/secrets" \
        >/dev/null 2>&1; then
        # Docker may have written files as root despite --user. Reclaim ownership.
        _repair_ownership
        verbose_ok "Identity seed encrypted"
    else
        fail "Failed to encrypt identity seed"
    fi

    # Always write the passphrase for initial startup — Core needs it to
    # decrypt the wrapped seed. For Maximum Security mode, we clear it from
    # disk after containers are healthy (see post-health-check section below).
    printf '%s' "${SEED_PASSPHRASE}" > "${SECRETS_DIR}/seed_password"
    chmod 600 "${SECRETS_DIR}/seed_password"
    if [ "${SEED_MODE}" = "server" ]; then
        verbose_ok "Passphrase stored (Server Mode)"
    else
        verbose_ok "Passphrase written for initial startup (will be cleared)"
    fi

    # Provision deterministic service keys from master seed (SLIP-0010 at m/9999'/3'/').
    # Must happen before the seed is zeroed. Writes PEM files to the same layout
    # that Docker mounts expect (core/, brain/, public/).
    run_crypto scripts/provision_derived_service_keys.py /service_keys \
        -e DINA_SEED_HEX="${MASTER_SEED}" \
        -v "${SERVICE_KEY_DIR}:/service_keys" \
        || fail "Failed to provision service keys"

    # Docker may have written files as root despite --user. Reclaim ownership.
    _repair_ownership

    # Verify all key files were actually written
    for _kf in core/core_ed25519_private.pem brain/brain_ed25519_private.pem \
               public/core_ed25519_public.pem public/brain_ed25519_public.pem; do
        [ -f "${SERVICE_KEY_DIR}/${_kf}" ] || fail "Service key missing: ${_kf}"
    done
    verbose_ok "Service keys provisioned (seed-derived)"

    # Zero the seed variable — raw seed must not persist
    MASTER_SEED="0000000000000000000000000000000000000000000000000000000000000000"
    unset MASTER_SEED
    SEED_PASSPHRASE=""; unset SEED_PASSPHRASE
    SEED_PASSPHRASE_CONFIRM=""; unset SEED_PASSPHRASE_CONFIRM
    verbose_ok "Raw seed zeroed from memory"

    ok "Identity secured"

    # Show mode-specific guidance
    echo ""
    if [ "${SEED_MODE}" = "maximum" ]; then
        echo -e "  ${DIM}You'll need your passphrase each time Dina starts.${RESET}"
        echo -e "  ${DIM}Run ${CYAN}./run.sh${RESET}${DIM} — it will prompt you.${RESET}"
        echo -e "  ${DIM}Note: Dina will not restart unattended. Use ${CYAN}./run.sh${RESET}${DIM} to start it again.${RESET}"
    else
        echo -e "  ${DIM}Dina will start automatically — no passphrase needed on restart.${RESET}"
    fi
fi

echo ""

# ---------------------------------------------------------------------------
# Step 5: Configure
# ---------------------------------------------------------------------------

echo -e "  ${BOLD}Configuring Dina${RESET}"

# --- Optional: Telegram bot setup ---
# Runs for both new and existing .env (skips if already configured).
if has_telegram "${ENV_FILE}" 2>/dev/null; then
    verbose_skip "Telegram already configured"
else
    setup_telegram "${ENV_FILE}"
fi

if [ ! -f "${ENV_FILE}" ]; then
    # --- Interactive LLM provider selection ---
    setup_llm_provider

    # Write .env file (seed is NOT stored here — it's in secrets/wrapped_seed.bin)
    cat > "${ENV_FILE}" << ENVEOF
# Dina Home Node Configuration
# Generated by install.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# Identity seed is encrypted in secrets/wrapped_seed.bin (not stored here).

# Session ID — scopes container names and Docker resources for this deployment.
DINA_SESSION=${DINA_SESSION}
COMPOSE_PROJECT_NAME=dina-${DINA_SESSION}

# Host ports (auto-allocated to avoid conflicts with other sessions)
DINA_CORE_PORT=${CORE_PORT}
DINA_PDS_PORT=${PDS_PORT}

# AT Protocol PDS secrets (auto-generated, do not edit)
DINA_PDS_JWT_SECRET=${PDS_JWT_SECRET}
DINA_PDS_ADMIN_PASSWORD=${PDS_ADMIN_PASSWORD}
DINA_PDS_ROTATION_KEY_HEX=${PDS_ROTATION_KEY}
ENVEOF

    write_llm_to_env "${ENV_FILE}"
    write_telegram_to_env "${ENV_FILE}"

    # Add provider hint
    echo "" >> "${ENV_FILE}"
    echo "# Add more providers: see models.json or run ./dina-admin model list" >> "${ENV_FILE}"

    chmod 600 "${ENV_FILE}"
    verbose_ok "Created .env"
else
    # Backfill required keys in existing .env (migration from older installs)
    if [ "${VERBOSE}" = true ]; then
        ensure_required_env "${ENV_FILE}"
    else
        ensure_required_env "${ENV_FILE}" > /dev/null
    fi
    write_telegram_to_env "${ENV_FILE}"
fi

# Re-read ports from .env (ensure_required_env may have written new values)
CORE_PORT=$(sed -n 's/^DINA_CORE_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || echo "${CORE_PORT}")
PDS_PORT=$(sed -n 's/^DINA_PDS_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || echo "${PDS_PORT}")

echo ""

# ---------------------------------------------------------------------------
# Step 6: Lock permissions (verbose-only)
# ---------------------------------------------------------------------------

if [ "${VERBOSE}" = true ]; then
    echo -e "${BOLD}Locking permissions${RESET}"
fi

# Repair ownership if Docker created/modified files as root during build/start
_repair_ownership
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

verbose_ok "Permissions locked"

# ---------------------------------------------------------------------------
# Step 7: Build Docker images
# ---------------------------------------------------------------------------

step_begin "Building Dina..."

if [ "${SKIP_BUILD}" = true ]; then
    [ "${VERBOSE}" = true ] || echo -e "${DIM}skipped${RESET}"
else
    if $COMPOSE build 2>&1 | while IFS= read -r line; do
        if [ "${VERBOSE}" = true ]; then
            echo -e "  ${DIM}${line}${RESET}"
        else
            printf "${GREEN}.${RESET}"
        fi
    done; then
        step_end
    else
        [ "${VERBOSE}" = true ] || echo ""
        fail "Build failed. Run with --verbose to see details."
    fi
fi

# ---------------------------------------------------------------------------
# Step 8: Start containers
# ---------------------------------------------------------------------------

step_begin "Starting Dina..."

_start_output=$($COMPOSE up -d 2>&1) || {
    [ "${VERBOSE}" = true ] || echo ""
    echo -e "  ${RED}${BOLD}Failed to start containers.${RESET}"
    echo ""
    echo -e "  ${DIM}${_start_output}${RESET}" | head -20
    echo ""
    echo -e "  Try: ${CYAN}docker compose logs${RESET}"
    exit 1
}

if [ "${VERBOSE}" = true ]; then
    echo "${_start_output}" | while IFS= read -r line; do
        echo -e "  ${DIM}${line}${RESET}"
    done
fi

step_end

# ---------------------------------------------------------------------------
# Step 9: Wait for health
# ---------------------------------------------------------------------------

step_begin "Waiting for Dina to be ready..."

ELAPSED=0

while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
    STATUS=$(curl -s --connect-timeout 3 \
        "http://localhost:${CORE_PORT}/healthz" 2>/dev/null || true)

    if echo "${STATUS}" | grep -q '"status"'; then
        step_end
        break
    fi

    if [ "${VERBOSE}" = true ]; then
        printf "  ${DIM}[....]${RESET} Waiting... (%ds/%ds)\r" "$ELAPSED" "$HEALTH_TIMEOUT"
    else
        printf "${GREEN}.${RESET}"
    fi
    sleep $HEALTH_INTERVAL
    ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

if [ $ELAPSED -ge $HEALTH_TIMEOUT ]; then
    [ "${VERBOSE}" = true ] || echo ""
    warn "Health check timed out after ${HEALTH_TIMEOUT}s"
    echo ""
    echo -e "  ${BOLD}Container status:${RESET}"
    $COMPOSE ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null | while IFS= read -r line; do
        echo "    $line"
    done
    echo ""
    # Show logs for containers that are restarting, exited, or unhealthy
    for svc in pds core brain; do
        SVC_STATUS=$($COMPOSE ps "$svc" --format "{{.Status}}" 2>/dev/null || true)
        HEALTH=$($COMPOSE ps "$svc" --format "{{.Health}}" 2>/dev/null || true)
        # Show logs if: unhealthy, restarting, exited, or no health status
        if echo "${SVC_STATUS}" | grep -qiE "restarting|exit" 2>/dev/null; then
            echo -e "  ${RED}${svc}${RESET} is ${SVC_STATUS} — last 20 log lines:"
            $COMPOSE logs --tail=20 "$svc" 2>/dev/null | while IFS= read -r line; do
                echo "    ${line}"
            done
            echo ""
        elif [ "$HEALTH" != "healthy" ] && [ -n "$HEALTH" ]; then
            echo -e "  ${YELLOW}${svc}${RESET} is ${HEALTH} — last 15 log lines:"
            $COMPOSE logs --tail=15 "$svc" 2>/dev/null | while IFS= read -r line; do
                echo "    ${line}"
            done
            echo ""
        fi
    done
    echo -e "  Full logs: ${CYAN}${COMPOSE} logs${RESET}"
    echo ""
    echo -e "  Containers may still be starting."
    echo -e "  Re-run ${CYAN}./install.sh --skip-build${RESET} once services are ready."
    exit 1
fi

# Maximum Security: clear passphrase from disk now that Core has started
# and read the secret into memory. Future starts will require the user
# to enter the passphrase (via run.sh or dina-admin security auto-start).
if [ "${SEED_MODE}" = "maximum" ]; then
    : > "${SECRETS_DIR}/seed_password"
    chmod 600 "${SECRETS_DIR}/seed_password"
    verbose_ok "Passphrase cleared from disk (Maximum Security)"
fi

echo ""

# ---------------------------------------------------------------------------
# Final banner
# ---------------------------------------------------------------------------

echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}${BOLD}  Dina is ready!${RESET}"
echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${CYAN}http://localhost:${CORE_PORT}${RESET}"
echo ""
if [ -n "${SEED_MODE}" ]; then
    if [ "${SEED_MODE}" = "maximum" ]; then
        echo -e "  Security:  ${CYAN}passphrase required on restart${RESET}"
    else
        echo -e "  Security:  ${CYAN}starts automatically${RESET}"
    fi
fi
if has_telegram "${ENV_FILE}"; then
    echo -e "  Telegram:  ${GREEN}connected${RESET}"
fi
# Check LLM status from Brain's healthz (inside the container network)
_brain_health=$($COMPOSE exec -T brain python -c \
    "import httpx,json; print(json.dumps(httpx.get('http://localhost:8200/healthz',timeout=3).json()))" \
    2>/dev/null || true)
if [ -n "${_brain_health}" ]; then
    _llm_router=$(echo "${_brain_health}" | grep -oE '"llm_router"\s*:\s*"[^"]*"' | cut -d'"' -f4 || true)
    _llm_models=$(echo "${_brain_health}" | grep -oE '"llm_models"\s*:\s*"[^"]*"' | cut -d'"' -f4 || true)
    if [ "${_llm_router}" = "available" ]; then
        echo -e "  LLM:       ${GREEN}available${RESET} ${DIM}${_llm_models}${RESET}"
    else
        echo -e "  LLM:       ${YELLOW}not configured${RESET} ${DIM}edit .env to add your API key${RESET}"
    fi
fi
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "    Stop:      ${CYAN}./run.sh --stop${RESET}"
echo -e "    Logs:      ${CYAN}./run.sh --logs${RESET}"
echo -e "    Status:    ${CYAN}./run.sh --status${RESET}"

if [ "${VERBOSE}" = true ]; then
    echo ""
    echo -e "  ${DIM}Session: ${DINA_SESSION} (core-${DINA_SESSION}, brain-${DINA_SESSION})${RESET}"
    echo -e "  ${DIM}PDS: http://localhost:${PDS_PORT}${RESET}"
    echo -e "  ${DIM}Health: http://localhost:${CORE_PORT}/healthz${RESET}"
fi

echo ""
