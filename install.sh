#!/usr/bin/env bash
# install.sh — One-command Dina Home Node setup
#
# Usage:
#   ./install.sh                       # first-time setup (interactive)
#   ./install.sh --port 9100           # use specific Core port (PDS = port+1)
#   ./install.sh --instance alice      # named instance (isolated data + containers)
#   ./install.sh --skip-build          # skip Docker build (use existing images)
#   ./install.sh --config FILE         # non-interactive (read config from JSON file)
#   ./install.sh --verbose             # show detailed internal output
#
# Multi-instance:
#   ./install.sh --instance alice --port 8100    # Alice's Dina on 8100
#   ./install.sh --instance bob   --port 9100    # Bob's Dina on 9100
#   Each instance gets isolated containers (dina-alice-*), data, and secrets.
#
# Architecture:
#   install.sh is a PRESENTER — it renders prompts, collects input, and
#   displays progress. All validation, provisioning, and state management
#   live in the installer core (scripts/installer/).
#
#   The installer core runs inside a Docker container. install.sh talks
#   to it via a JSON-lines protocol over stdin/stdout. The seed never
#   leaves the container process.
#
# Security: The raw identity seed never touches disk or shell variables.
# It is generated inside the installer container, wrapped with the user's
# passphrase (Argon2id + AES-256-GCM), and only the encrypted form exits.

set -euo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DINA_DIR="${DINA_DIR:-$(pwd)}"
SECRETS_DIR="${DINA_DIR}/secrets"
ENV_FILE="${DINA_DIR}/.env"
# DINA_DATA_DIR is set after instance parsing; defaults to DINA_DIR.
HEALTH_TIMEOUT=90
HEALTH_INTERVAL=3
SKIP_BUILD=false
CONFIG_ONLY=false
CONFIG_FILE=""
VERBOSE=false
QUICK=false
INSTANCE_NAME=""
EXPLICIT_PORT=""

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --config-only) CONFIG_ONLY=true; SKIP_BUILD=true ;;
        --verbose|-v) VERBOSE=true ;;
        --quick) QUICK=true ;;
        --config|--port|--instance)
            # Two-arg flags — handled below
            ;;
    esac
done

# Parse two-arg flags
_prev=""
for _a in "$@"; do
    case "${_prev}" in
        --config)   CONFIG_FILE="${_a}" ;;
        --port)     EXPLICIT_PORT="${_a}" ;;
        --instance) INSTANCE_NAME="${_a}" ;;
    esac
    _prev="${_a}"
done

# Instance isolation: separate project name, data dir, secrets, CLI config.
# DINA_DIR stays as the project root (scripts, Dockerfiles, compose).
# DINA_DATA_DIR is where instance-specific data lives.
DINA_DATA_DIR="${DINA_DIR}"
if [ -n "${INSTANCE_NAME}" ]; then
    export COMPOSE_PROJECT_NAME="dina-${INSTANCE_NAME}"
    DINA_DATA_DIR="${DINA_DIR}/instances/${INSTANCE_NAME}"
    mkdir -p "${DINA_DATA_DIR}"
    SECRETS_DIR="${DINA_DATA_DIR}/secrets"
    ENV_FILE="${DINA_DATA_DIR}/.env"
    # Tell docker-compose where secrets are (relative to project root)
    export DINA_SECRETS_DIR="./instances/${INSTANCE_NAME}/secrets"
    echo ""
    echo "  Instance: ${INSTANCE_NAME}"
    echo "  Data:     ${DINA_DATA_DIR}"
    echo ""
fi

# ---------------------------------------------------------------------------
# Shared modules (colors only — logic is in the installer core)
# ---------------------------------------------------------------------------

# shellcheck source=scripts/setup/colors.sh
source scripts/setup/colors.sh
# shellcheck source=scripts/setup/env_ensure.sh
source scripts/setup/env_ensure.sh

# Output helpers
verbose_ok()   { [ "${VERBOSE}" = true ] && ok "$1"   || true; }
verbose_skip() { [ "${VERBOSE}" = true ] && skip "$1"  || true; }
verbose_info() { [ "${VERBOSE}" = true ] && info "$1"  || true; }

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

# ---------------------------------------------------------------------------
# Docker Compose detection
# ---------------------------------------------------------------------------

if docker compose version >/dev/null 2>&1; then
    _COMPOSE_BIN="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    _COMPOSE_BIN="docker-compose"
else
    fail "Docker Compose not found. Install: ${CYAN}https://docs.docker.com/compose/install/${RESET}"
fi

# For instances, pass --env-file so compose reads the instance .env.
if [ -n "${INSTANCE_NAME}" ]; then
    COMPOSE="${_COMPOSE_BIN} --env-file ${ENV_FILE}"
else
    COMPOSE="${_COMPOSE_BIN}"
fi

# ---------------------------------------------------------------------------
# Crypto image (used to run the installer core)
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
        docker build -q -t "${CRYPTO_IMAGE}" -f scripts/setup/Dockerfile.crypto scripts/setup/ >/dev/null 2>&1 &
        local _build_pid=$!
        local _spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
        local _i=0
        while kill -0 "$_build_pid" 2>/dev/null; do
            _i=$(( (_i + 1) % ${#_spin} ))
            printf "\r  ${CYAN}${_spin:_i:1}${RESET} %-42s" "Preparing crypto tools..."
            sleep 0.1
        done
        wait "$_build_pid"
        local _rc=$?
        if [ $_rc -eq 0 ]; then
            CRYPTO_IMAGE_BUILT=true
            printf "\r  %-44s${GREEN}done${RESET}\n" "Preparing crypto tools..."
        else
            printf "\r  %-44s${RED}failed${RESET}\n" "Preparing crypto tools..."
            fail "Failed to build crypto tools image. Check that Docker is running."
        fi
    fi
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo ""
echo -e "  ${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${BOLD}  Setting up Dina${RESET}"
echo -e "  ${DIM}  ${DINA_DATA_DIR}${RESET}"
echo -e "  ${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Prerequisites
# ---------------------------------------------------------------------------

step_begin "Checking your system..."

command -v docker >/dev/null 2>&1 || fail "Docker not found.\n\n  Dina needs Docker to run. Please install Docker and try again:\n  ${CYAN}https://docs.docker.com/get-docker/${RESET}"
verbose_ok "Docker found"

command -v curl >/dev/null 2>&1 || fail "curl not found. Please install curl and try again."
verbose_ok "curl found"

command -v jq >/dev/null 2>&1 || fail "jq not found. Please install jq and try again:\n  ${CYAN}https://jqlang.github.io/jq/download/${RESET}"
verbose_ok "jq found"

if ! docker info >/dev/null 2>&1; then
    [ "${VERBOSE}" = true ] || echo ""
    fail "Cannot connect to Docker.\n\n  Please make sure Docker is running."
fi
verbose_ok "Docker daemon running"

step_end

# ---------------------------------------------------------------------------
# Step 2: Build crypto image
# ---------------------------------------------------------------------------

build_crypto_image

# ---------------------------------------------------------------------------
# Step 3: Run installer core wizard (or non-interactive apply)
# ---------------------------------------------------------------------------
#
# The wizard runs inside a Docker container. install.sh reads structured
# JSON messages from stdout, renders prompts, collects input, and sends
# answers back via stdin. The seed stays inside the container.

# Allocate ports on the HOST (not inside the container, which has its own
# network namespace). Reuse saved ports from .env if present.
if [ -f "${ENV_FILE}" ]; then
    _saved_core=$(sed -n 's/^DINA_CORE_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
    _saved_pds=$(sed -n 's/^DINA_PDS_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
fi
# --port overrides saved/auto-detected ports. PDS = core_port + 1 when explicit.
if [ -n "${EXPLICIT_PORT}" ]; then
    CORE_PORT="${EXPLICIT_PORT}"
    PDS_PORT=$(( EXPLICIT_PORT + 1 ))
else
    CORE_PORT="${_saved_core:-$(find_free_port 8100)}"
    PDS_PORT="${_saved_pds:-$(find_free_port 2583)}"
fi
verbose_ok "Ports: core=${CORE_PORT}, pds=${PDS_PORT}"

# Variables populated by the wizard result
SEED_MODE=""
DINA_SESSION=""

if [ -n "${CONFIG_FILE}" ]; then
    # --- Non-interactive mode: apply config from JSON file ---
    # Resolve to absolute path so we can bind-mount it into the container.
    _ABS_CONFIG="$(cd "$(dirname "${CONFIG_FILE}")" && pwd)/$(basename "${CONFIG_FILE}")"
    [ -f "${_ABS_CONFIG}" ] || fail "Config file not found: ${CONFIG_FILE}"
    info "Applying config from ${CONFIG_FILE}..."
    _RESULT=$(docker run --rm --user "$(id -u):$(id -g)" \
        -v "${DINA_DATA_DIR}:/work" \
        -v "${DINA_DIR}/scripts:/work/scripts:ro" \
        -v "${DINA_DIR}/cli:/work/cli:ro" \
        -v "${_ABS_CONFIG}:/tmp/install-config.json:ro" \
        -e PYTHONPATH=/work \
        -e DINA_DIR=/work \
        -e DINA_CORE_PORT="${CORE_PORT}" \
        -e DINA_PDS_PORT="${PDS_PORT}" \
        "${CRYPTO_IMAGE}" \
        python3 -m scripts.installer apply --config /tmp/install-config.json 2>&1) || {
        echo "${_RESULT}" >&2
        fail "Install failed. Run with --verbose for details."
    }
    SEED_MODE=$(echo "${_RESULT}" | jq -r '.startup_mode // "server"' 2>/dev/null || echo "server")
    CORE_PORT=$(echo "${_RESULT}" | jq -r '.core_port // "8100"' 2>/dev/null || echo "8100")
    PDS_PORT=$(echo "${_RESULT}" | jq -r '.pds_port // "2583"' 2>/dev/null || echo "2583")
    DINA_SESSION=$(echo "${_RESULT}" | jq -r '.session_id // ""' 2>/dev/null || echo "")
    ok "Configuration applied"

elif [ -t 0 ]; then
    # --- Interactive mode: run wizard via JSON-lines protocol ---

    # Start the wizard container with named pipes for bidirectional I/O.
    _WIZARD_IN=$(mktemp -u)
    _WIZARD_OUT=$(mktemp -u)
    mkfifo "${_WIZARD_IN}" "${_WIZARD_OUT}"

    # Cleanup on Ctrl+C or unexpected exit
    _wizard_cleanup() {
        exec 4>&- 2>/dev/null
        exec 5<&- 2>/dev/null
        [ -n "${_WIZARD_PID:-}" ] && kill "${_WIZARD_PID}" 2>/dev/null
        [ -n "${_WIZARD_PID:-}" ] && wait "${_WIZARD_PID}" 2>/dev/null
        rm -f "${_WIZARD_IN}" "${_WIZARD_OUT}"
        tput rmcup 2>/dev/null  # restore main screen if on alt screen
        echo ""
    }
    trap _wizard_cleanup INT TERM EXIT

    docker run --rm -i --user "$(id -u):$(id -g)" \
        -v "${DINA_DATA_DIR}:/work" \
        -v "${DINA_DIR}/scripts:/work/scripts:ro" \
        -v "${DINA_DIR}/cli:/work/cli:ro" \
        -e PYTHONPATH=/work \
        -e DINA_DIR=/work \
        -e DINA_CORE_PORT="${CORE_PORT}" \
        -e DINA_PDS_PORT="${PDS_PORT}" \
        -e DINA_VERBOSE="${VERBOSE}" \
        -e DINA_SKIP_MNEMONIC_VERIFY="$([ "${QUICK}" = true ] && echo 1 || echo 0)" \
        "${CRYPTO_IMAGE}" \
        python3 -m scripts.installer wizard \
        < "${_WIZARD_IN}" > "${_WIZARD_OUT}" 2>"${DINA_DATA_DIR}/.wizard-stderr.log" &
    _WIZARD_PID=$!

    # Open write FD to wizard stdin (must happen after docker starts reading)
    exec 4>"${_WIZARD_IN}"
    # Open read FD to wizard stdout ONCE. Re-opening the FIFO per iteration
    # closes the reader between events and can SIGPIPE the wizard.
    exec 5<"${_WIZARD_OUT}"

    # Read JSON lines from wizard, render prompts, send answers.
    while IFS= read -r line <&5; do
        # Parse the JSON message
        _type=$(echo "$line" | jq -r '.type // ""' 2>/dev/null || true)
        if [ "${VERBOSE}" = true ]; then echo -e "  ${DIM}[wizard] ${_type}: $(echo "$line" | jq -c '.' 2>/dev/null | head -c 120)${RESET}" >&2; fi

        case "${_type}" in
            prompt)
                _field=$(echo "$line" | jq -r '.field // ""' 2>/dev/null || true)
                _kind=$(echo "$line" | jq -r '.kind // ""' 2>/dev/null || true)
                _msg=$(echo "$line" | jq -r '.message // ""' 2>/dev/null || true)
                _help=$(echo "$line" | jq -r '.help_text // ""' 2>/dev/null || true)
                _secret=$(echo "$line" | jq -r '.secret // false' 2>/dev/null || true)
                _allow_blank=$(echo "$line" | jq -r '.allow_blank // false' 2>/dev/null || true)
                _default=$(echo "$line" | jq -r '.default // ""' 2>/dev/null || true)
                _multi=$(echo "$line" | jq -r '.multi_select // false' 2>/dev/null || true)

                # Render based on kind (no blank line before verify_word prompts)
                case "${_field}" in
                    verify_word_*) ;;
                    *) echo "" ;;
                esac
                if [ -n "${_help}" ] && [ "${_help}" != "null" ]; then
                    # Indent continuation lines to match the 2-space prefix
                    _help_indented=$(echo -e "${_help}" | sed '2,$s/^/  /')
                    echo -e "  ${DIM}${_help_indented}${RESET}"
                    echo ""
                fi

                if [ "${_kind}" = "choice" ]; then
                    echo -e "  ${BOLD}${_msg}${RESET}"
                    echo ""
                    # Render choices
                    echo "$line" | jq -r '.choices[]? | "    \u001b[36m\(.key))\u001b[0m \(.label)  \u001b[2m\(.help // "")\u001b[0m"' 2>/dev/null || true
                    echo ""
                    if [ "${_multi}" = "true" ]; then
                        printf "  Enter one or more numbers separated by spaces: "
                    elif [ -n "${_default}" ] && [ "${_default}" != "" ]; then
                        printf "  Enter choice [default: %s]: " "${_default}"
                    else
                        printf "  Enter choice: "
                    fi
                else
                    printf "  ${BOLD}%s:${RESET} " "${_msg}"
                fi

                # Read input
                if [ "${_secret}" = "true" ]; then
                    read -rs _answer
                    # Show masked preview so user knows something was entered
                    if [ -n "${_answer}" ]; then
                        _len=${#_answer}
                        if [ ${_len} -gt 8 ]; then
                            echo "${_answer:0:4}$( printf '*%.0s' $(seq 1 $((_len - 6))) )${_answer: -2}"
                        else
                            echo "********"
                        fi
                    else
                        echo ""
                    fi
                else
                    read -r _answer
                fi

                # Use default if blank
                if [ -z "${_answer}" ] && [ -n "${_default}" ]; then
                    _answer="${_default}"
                fi

                # Send answer back to wizard (jq handles JSON escaping)
                if [ "${VERBOSE}" = true ]; then echo -e "  ${DIM}[answer] ${_field}=${_answer:0:20}${RESET}" >&2; fi
                jq -nc --arg f "${_field}" --arg v "${_answer}" '{"field":$f,"value":$v}' >&4
                ;;

            event)
                _name=$(echo "$line" | jq -r '.name // ""' 2>/dev/null || true)
                case "${_name}" in
                    show_recovery_phrase)
                        # Display on alternate screen
                        _words=$(echo "$line" | jq -r '.words[]' 2>/dev/null || true)
                        tput smcup 2>/dev/null
                        echo ""
                        echo -e "  ${BOLD}Your Recovery Phrase${RESET}"
                        echo ""

                        _wnum=1
                        _line=""
                        echo -e "  ${YELLOW}╔══════════════════════════════════════════════════════════════════╗${RESET}"
                        while IFS= read -r word; do
                            _line="${_line}$(printf '%2d. %-12s' ${_wnum} "${word}")"
                            if [ $((_wnum % 4)) -eq 0 ]; then
                                echo -e "  ${YELLOW}║${RESET} ${_line} ${YELLOW}║${RESET}"
                                _line=""
                            fi
                            _wnum=$((_wnum + 1))
                        done <<< "${_words}"
                        [ -n "${_line}" ] && echo -e "  ${YELLOW}║${RESET} ${_line} ${YELLOW}║${RESET}"
                        echo -e "  ${YELLOW}╚══════════════════════════════════════════════════════════════════╝${RESET}"

                        echo ""
                        echo -e "  ${RED}${BOLD}SAVE THIS RECOVERY PHRASE! You need it to recover your Dina.${RESET}"
                        echo -e "  ${RED}Write it down on paper. Do not store it digitally.${RESET}"
                        echo ""
                        printf "  Press Enter when you've written it down..."
                        read -r _
                        tput rmcup 2>/dev/null

                        # Send ack
                        if [ "${VERBOSE}" = true ]; then echo -e "  ${DIM}[answer] recovery_ack=ok${RESET}" >&2; fi
                        jq -nc '{"field":"recovery_ack","value":"ok"}' >&4

                        # Verify user saved it (unless skipped for tests)
                        if [ "${DINA_SKIP_MNEMONIC_VERIFY:-}" != "1" ] && [ "${QUICK}" != true ]; then
                            # Build word array
                            _WORDS=()
                            while IFS= read -r _w; do
                                _WORDS+=("$_w")
                            done <<< "${_words}"

                            _verified=false
                            while [ "${_verified}" = false ]; do
                                echo ""
                                echo -e "  ${BOLD}Let's verify you saved it.${RESET}"
                                echo -e "  ${DIM}Enter the words for the positions below:${RESET}"

                                # Pick 3 random positions (1-indexed, sorted)
                                _vp=()
                                while [ ${#_vp[@]} -lt 3 ]; do
                                    _n=$(( $(od -An -tu4 -N4 /dev/urandom | tr -d ' ') % ${#_WORDS[@]} + 1 ))
                                    _dup=false
                                    for _e in "${_vp[@]+"${_vp[@]}"}"; do [ "$_e" = "$_n" ] && _dup=true; done
                                    [ "$_dup" = false ] && _vp+=("$_n")
                                done
                                _vp_sorted=($(printf '%s\n' "${_vp[@]}" | sort -n))

                                _all_ok=true
                                for _p in "${_vp_sorted[@]}"; do
                                    printf "  ${BOLD}Word #%d:${RESET} " "$_p"
                                    read -r _uword
                                    _uword=$(echo "$_uword" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
                                    _expected=$(echo "${_WORDS[$((_p - 1))]}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
                                    if [ "$_uword" != "$_expected" ]; then
                                        _all_ok=false
                                        break
                                    fi
                                done

                                if [ "$_all_ok" = true ]; then
                                    _verified=true
                                    echo -e "  ${GREEN}[ok]${RESET}   Recovery phrase verified"
                                else
                                    echo ""
                                    echo -e "  ${YELLOW}✗${RESET} That doesn't match. Let's try again."
                                    # Re-show phrase on alt screen
                                    tput smcup 2>/dev/null
                                    echo ""
                                    echo -e "  ${BOLD}Your Recovery Phrase${RESET}"
                                    echo ""
                                    _wnum=1
                                    _line=""
                                    echo -e "  ${YELLOW}╔══════════════════════════════════════════════════════════════════╗${RESET}"
                                    while IFS= read -r word; do
                                        _line="${_line}$(printf '%2d. %-12s' ${_wnum} "${word}")"
                                        if [ $((_wnum % 4)) -eq 0 ]; then
                                            echo -e "  ${YELLOW}║${RESET} ${_line} ${YELLOW}║${RESET}"
                                            _line=""
                                        fi
                                        _wnum=$((_wnum + 1))
                                    done <<< "${_words}"
                                    [ -n "${_line}" ] && echo -e "  ${YELLOW}║${RESET} ${_line} ${YELLOW}║${RESET}"
                                    echo -e "  ${YELLOW}╚══════════════════════════════════════════════════════════════════╝${RESET}"
                                    echo ""
                                    echo -e "  ${RED}Write it down on paper. Do not store it digitally.${RESET}"
                                    echo ""
                                    printf "  Press Enter when you've written it down..."
                                    read -r _
                                    tput rmcup 2>/dev/null
                                fi
                            done
                            # Tell wizard verification is done
                            if [ "${VERBOSE}" = true ]; then echo -e "  ${DIM}[answer] verification_done=ok${RESET}" >&2; fi
                            jq -nc '{"field":"verification_done","value":"ok"}' >&4
                        fi
                        ;;
                    info)
                        _imsg=$(echo "$line" | jq -r '.message // ""' 2>/dev/null || true)
                        echo -e "  ${DIM}${_imsg}${RESET}"
                        ;;
                    ok)
                        _imsg=$(echo "$line" | jq -r '.message // ""' 2>/dev/null || true)
                        ok "${_imsg}"
                        ;;
                    heading)
                        _imsg=$(echo "$line" | jq -r '.message // ""' 2>/dev/null || true)
                        echo -e "  ${BOLD}${_imsg}${RESET}"
                        ;;
                    warning)
                        _wmsg=$(echo "$line" | jq -r '.message // ""' 2>/dev/null || true)
                        warn "${_wmsg}"
                        ;;
                esac
                ;;

            error)
                _emsg=$(echo "$line" | jq -r '.message // ""' 2>/dev/null || true)
                echo -e "  ${YELLOW}✗${RESET} ${_emsg}"
                ;;

            done)
                # Extract result values
                SEED_MODE=$(echo "$line" | jq -r '.result.startup_mode // "server"' 2>/dev/null || echo "server")
                CORE_PORT=$(echo "$line" | jq -r '.result.core_port // "8100"' 2>/dev/null || echo "8100")
                PDS_PORT=$(echo "$line" | jq -r '.result.pds_port // "2583"' 2>/dev/null || echo "2583")
                DINA_SESSION=$(echo "$line" | jq -r '.result.session_id // ""' 2>/dev/null || echo "")
                break
                ;;
        esac
    done

    # Cleanup: close write FD, wait for container, remove pipes
    trap - INT TERM EXIT  # clear trap before normal cleanup
    exec 4>&- 2>/dev/null
    exec 5<&- 2>/dev/null
    wait "${_WIZARD_PID}" 2>/dev/null
    _WIZARD_EXIT=$?
    rm -f "${_WIZARD_IN}" "${_WIZARD_OUT}"

    # Fail-closed: if wizard exited without sending "done", abort
    if [ -z "${DINA_SESSION}" ]; then
        if [ -f "${DINA_DIR}/.wizard-stderr.log" ] && [ -s "${DINA_DIR}/.wizard-stderr.log" ]; then
            echo "" >&2
            echo -e "  ${RED}Wizard error:${RESET}" >&2
            tail -20 "${DINA_DIR}/.wizard-stderr.log" >&2
        fi
        fail "Installer wizard exited without completing."
    fi
    if [ "${_WIZARD_EXIT}" -ne 0 ]; then
        if [ -f "${DINA_DIR}/.wizard-stderr.log" ] && [ -s "${DINA_DIR}/.wizard-stderr.log" ]; then
            echo "" >&2
            echo -e "  ${RED}Wizard error:${RESET}" >&2
            tail -20 "${DINA_DIR}/.wizard-stderr.log" >&2
        fi
        fail "Installer wizard failed (exit ${_WIZARD_EXIT})."
    fi
    rm -f "${DINA_DIR}/.wizard-stderr.log"

else
    # --- Non-interactive, no config file: auto-generate everything ---
    info "Non-interactive mode — auto-configuring..."
    _AUTO_CONFIG=$(cat <<AUTOJSON
{
    "dina_dir": "/work",
    "identity_choice": "new",
    "passphrase": "$(openssl rand -base64 32 | tr -d '\n')",
    "startup_mode": "server"
}
AUTOJSON
    )
    _RESULT=$(echo "${_AUTO_CONFIG}" | docker run --rm -i --user "$(id -u):$(id -g)" \
        -v "${DINA_DATA_DIR}:/work" \
        -v "${DINA_DIR}/scripts:/work/scripts:ro" \
        -v "${DINA_DIR}/cli:/work/cli:ro" \
        -e PYTHONPATH=/work \
        -e DINA_DIR=/work \
        -e DINA_CORE_PORT="${CORE_PORT}" \
        -e DINA_PDS_PORT="${PDS_PORT}" \
        "${CRYPTO_IMAGE}" \
        python3 -m scripts.installer apply 2>&1) || {
        if [ "${VERBOSE}" = true ]; then echo "${_RESULT}" >&2; fi
        fail "Auto-configure failed."
    }
    SEED_MODE=$(echo "${_RESULT}" | jq -r '.startup_mode // "server"' 2>/dev/null || echo "server")
    CORE_PORT=$(echo "${_RESULT}" | jq -r '.core_port // "8100"' 2>/dev/null || echo "8100")
    PDS_PORT=$(echo "${_RESULT}" | jq -r '.pds_port // "2583"' 2>/dev/null || echo "2583")
    DINA_SESSION=$(echo "${_RESULT}" | jq -r '.session_id // ""' 2>/dev/null || echo "")
    ok "Auto-configured"
fi

echo ""

# ---------------------------------------------------------------------------
# Step 4: Config-only exit
# ---------------------------------------------------------------------------

if [ "${CONFIG_ONLY}" = true ]; then
    ok "Configuration complete (--config-only)"
    echo ""
    echo -e "  ${DIM}To build and start: ${CYAN}./install.sh${RESET}"
    exit 0
fi

# Re-read ports from .env if the wizard wrote them
if [ -f "${ENV_FILE}" ]; then
    _ep=$(sed -n 's/^DINA_CORE_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
    [ -n "${_ep}" ] && CORE_PORT="${_ep}"
    _pp=$(sed -n 's/^DINA_PDS_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
    [ -n "${_pp}" ] && PDS_PORT="${_pp}"
    _ss=$(sed -n 's/^DINA_SESSION=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
    [ -n "${_ss}" ] && DINA_SESSION="${_ss}"
fi

# For instances: fix paths in .env that the installer writes relative to /work
# but compose needs relative to the project root.
if [ -n "${INSTANCE_NAME}" ] && [ -f "${ENV_FILE}" ]; then
    _sed_inplace() {
        if sed --version 2>/dev/null | grep -q GNU; then
            sed -i "$@"
        else
            sed -i '' "$@"
        fi
    }
    _sed_inplace "s|^DINA_SECRETS_DIR=.*|DINA_SECRETS_DIR=./instances/${INSTANCE_NAME}/secrets|" "${ENV_FILE}"
    _sed_inplace "s|^COMPOSE_PROJECT_NAME=.*|COMPOSE_PROJECT_NAME=dina-${INSTANCE_NAME}|" "${ENV_FILE}"
fi

# ---------------------------------------------------------------------------
# Step 5: Build Docker images
# ---------------------------------------------------------------------------

echo -e "  ${BOLD}Building Dina...${RESET}"

if [ "${SKIP_BUILD}" = true ]; then
    echo -e "  ${DIM}skipped${RESET}"
else
    _build_spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    _build_si=0
    _build_last_svc=""
    if $COMPOSE build 2>&1 | while IFS= read -r line; do
        if [ "${VERBOSE}" = true ]; then
            echo -e "  ${DIM}${line}${RESET}"
        else
            _svc=$(echo "$line" | grep -oE '\[(core|brain|admin) [a-z]+ [0-9]+/[0-9]+\]' | tr -d '[]' || true)
            if [ -n "$_svc" ]; then
                _build_last_svc="$_svc"
            fi
            _build_si=$(( (_build_si + 1) % ${#_build_spin} ))
            _build_ch="${_build_spin:_build_si:1}"
            if [ -n "$_build_last_svc" ]; then
                printf "\r  ${CYAN}${_build_ch}${RESET} ${DIM}%-48s${RESET}" "$_build_last_svc"
            else
                printf "\r  ${CYAN}${_build_ch}${RESET} ${DIM}%-48s${RESET}" "preparing..."
            fi
        fi
    done; then
        printf "\r  %-50s\n" ""
        echo -e "  ${GREEN}Build complete${RESET}"
    else
        printf "\r  %-50s\n" ""
        fail "Build failed. Run with --verbose to see details."
    fi
fi

# ---------------------------------------------------------------------------
# Step 6: Start containers
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
# Step 7: Wait for health
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
    for svc in pds core brain; do
        SVC_STATUS=$($COMPOSE ps "$svc" --format "{{.Status}}" 2>/dev/null || true)
        HEALTH=$($COMPOSE ps "$svc" --format "{{.Health}}" 2>/dev/null || true)
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
if [ "${SEED_MODE}" = "maximum" ]; then
    : > "${SECRETS_DIR}/seed_password"
    chmod 600 "${SECRETS_DIR}/seed_password"
    verbose_ok "Passphrase cleared from disk (Maximum Security)"
fi

# ---------------------------------------------------------------------------
# Step 8: Smoke test
# ---------------------------------------------------------------------------

TOKEN_FILE="${SECRETS_DIR}/client_token"
if [ -f "${TOKEN_FILE}" ]; then
    _smoke_token=$(cat "${TOKEN_FILE}" 2>/dev/null || true)
    if [ -n "${_smoke_token}" ]; then
        printf "  Verifying LLM... "
        _smoke_resp=$(curl -sf -X POST \
            -H "Authorization: Bearer ${_smoke_token}" \
            -H "Content-Type: application/json" \
            -d '{"prompt":"Reply with just the word OK."}' \
            "http://localhost:${CORE_PORT}/api/v1/reason" 2>/dev/null || true)

        _smoke_error=$(echo "${_smoke_resp}" | jq -r '.error_code // empty' 2>/dev/null || true)
        _smoke_content=$(echo "${_smoke_resp}" | jq -r '.content // empty' 2>/dev/null || true)

        if [ -n "${_smoke_error}" ]; then
            _smoke_msg=$(echo "${_smoke_resp}" | jq -r '.message // empty' 2>/dev/null || true)
            echo -e "${YELLOW}✗${RESET}"
            echo ""
            echo -e "  ${YELLOW}LLM is not working:${RESET} ${_smoke_msg}"
            echo -e "  ${DIM}Fix: check your API key in .env, then ${CYAN}./run.sh --stop && ./run.sh --start${RESET}"
        elif [ -n "${_smoke_content}" ]; then
            echo -e "${GREEN}✓${RESET}"
        else
            echo -e "${YELLOW}?${RESET} ${DIM}(no response — LLM may still be starting)${RESET}"
        fi
    fi
fi

echo ""

# ---------------------------------------------------------------------------
# Step 9: Final banner
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
# Check LLM status from Brain's healthz
_brain_health=$($COMPOSE exec -T brain python -c \
    "import httpx,json; print(json.dumps(httpx.get('http://localhost:8200/healthz',timeout=3).json()))" \
    2>/dev/null || true)
if [ -n "${_brain_health}" ]; then
    _llm_router=$(echo "${_brain_health}" | jq -r '.llm_router // empty' 2>/dev/null || true)
    if [ "${_llm_router}" = "available" ]; then
        _lite=$(echo "${_brain_health}" | jq -r '.llm_models.lite // "?"' 2>/dev/null || echo "?")
        _primary=$(echo "${_brain_health}" | jq -r '.llm_models.primary // "?"' 2>/dev/null || echo "?")
        _heavy=$(echo "${_brain_health}" | jq -r '.llm_models.heavy // "?"' 2>/dev/null || echo "?")
        echo -e "  LLM:       ${GREEN}available${RESET}"
        echo -e "             ${DIM}Lite:    ${_lite}${RESET}"
        echo -e "             ${DIM}Primary: ${_primary}${RESET}"
        echo -e "             ${DIM}Heavy:   ${_heavy}${RESET}"
    else
        echo -e "  LLM:       ${YELLOW}not configured${RESET} ${DIM}run ./dina-admin model set${RESET}"
    fi
fi
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "    ${CYAN}./run.sh --start${RESET}    Start"
echo -e "    ${CYAN}./run.sh --stop${RESET}     Stop"
echo -e "    ${CYAN}./run.sh --status${RESET}   Status"
echo -e "    ${CYAN}./run.sh --logs${RESET}     Logs"

if [ "${VERBOSE}" = true ]; then
    echo ""
    echo -e "  ${DIM}Session: ${DINA_SESSION}${RESET}"
    echo -e "  ${DIM}PDS: http://localhost:${PDS_PORT}${RESET}"
    echo -e "  ${DIM}Health: http://localhost:${CORE_PORT}/healthz${RESET}"
fi

echo ""
