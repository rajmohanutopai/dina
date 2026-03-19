#!/usr/bin/env bash
# run.sh — Manage the Dina Home Node
#
# Usage:
#   ./run.sh              # show usage
#   ./run.sh --start      # start containers (prompts for passphrase if manual-start)
#   ./run.sh --stop       # stop containers
#   ./run.sh --status     # show container status
#   ./run.sh --logs       # tail container logs

set -euo pipefail
cd "$(dirname "$0")"

DINA_DIR="${DINA_DIR:-$(pwd)}"
SECRETS_DIR="${DINA_DIR}/secrets"
ENV_FILE="${DINA_DIR}/.env"
HEALTH_TIMEOUT=90
HEALTH_INTERVAL=3

# shellcheck source=scripts/setup/colors.sh
source scripts/setup/colors.sh
# shellcheck source=scripts/setup/env_ensure.sh
source scripts/setup/env_ensure.sh
# shellcheck source=scripts/setup/llm_provider.sh
source scripts/setup/llm_provider.sh
# shellcheck source=scripts/setup/telegram.sh
source scripts/setup/telegram.sh

# ---------------------------------------------------------------------------
# Docker Compose detection (needed for --stop/--status/--logs)
# ---------------------------------------------------------------------------

detect_compose() {
    if docker compose version >/dev/null 2>&1; then
        COMPOSE="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE="docker-compose"
    else
        fail "Docker Compose not found. Install from https://docs.docker.com/compose/install/"
    fi
}

# ---------------------------------------------------------------------------
# Flags: --stop, --status, --logs (need Docker immediately)
# ---------------------------------------------------------------------------

case "${1:-}" in
    "")
        echo ""
        echo -e "  ${BOLD}Dina Home Node${RESET}"
        echo ""
        echo -e "  Usage:  ${CYAN}./run.sh${RESET} <command>"
        echo ""
        echo -e "    ${CYAN}--start${RESET}    Start the Home Node"
        echo -e "    ${CYAN}--stop${RESET}     Stop all containers"
        echo -e "    ${CYAN}--status${RESET}   Show container status"
        echo -e "    ${CYAN}--logs${RESET}     Tail container logs"
        echo ""
        exit 0
        ;;
    --stop)
        detect_compose
        info "Stopping containers..."
        $COMPOSE down
        ok "Containers stopped"
        exit 0
        ;;
    --status)
        detect_compose
        echo ""
        echo -e "  ${BOLD}Dina Status${RESET}"
        echo ""

        # Read config
        DINA_SESSION=$(sed -n 's/^DINA_SESSION=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
        CORE_PORT=$(sed -n 's/^DINA_CORE_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || echo "8100")

        # Container health
        for svc in core brain pds; do
            _status=$($COMPOSE ps "$svc" --format "{{.Status}}" 2>/dev/null || true)
            if echo "$_status" | grep -qi "healthy" 2>/dev/null; then
                printf "  ${GREEN}●${RESET} %-6s ${DIM}%s${RESET}\n" "$svc" "$_status"
            elif echo "$_status" | grep -qiE "up|running" 2>/dev/null; then
                printf "  ${YELLOW}●${RESET} %-6s ${DIM}%s${RESET}\n" "$svc" "$_status"
            elif [ -n "$_status" ]; then
                printf "  ${RED}●${RESET} %-6s ${DIM}%s${RESET}\n" "$svc" "$_status"
            else
                printf "  ${RED}●${RESET} %-6s ${DIM}not running${RESET}\n" "$svc"
            fi
        done

        echo ""

        # Core health details
        if _health=$(curl -s --connect-timeout 3 "http://localhost:${CORE_PORT}/healthz" 2>/dev/null); then
            echo -e "  Core:      ${CYAN}http://localhost:${CORE_PORT}${RESET}"
        else
            echo -e "  Core:      ${RED}unreachable${RESET}"
        fi

        # DID
        if _did=$(curl -s --connect-timeout 3 "http://localhost:${CORE_PORT}/.well-known/atproto-did" 2>/dev/null) && [ -n "$_did" ]; then
            echo -e "  DID:       ${DIM}${_did}${RESET}"
        else
            echo -e "  DID:       ${YELLOW}not available${RESET} ${DIM}(Core may still be initializing)${RESET}"
        fi

        # LLM status from Brain
        _brain_health=$($COMPOSE exec -T brain python -c \
            "import httpx,json; print(json.dumps(httpx.get('http://localhost:8200/healthz',timeout=3).json()))" \
            2>/dev/null || true)
        if [ -n "$_brain_health" ]; then
            _llm_router=$(echo "$_brain_health" | jq -r '.llm_router // empty' 2>/dev/null || true)
            if [ "$_llm_router" = "available" ]; then
                _lite=$(echo "$_brain_health" | jq -r '.llm_models.lite // "?"' 2>/dev/null || echo "?")
                _primary=$(echo "$_brain_health" | jq -r '.llm_models.primary // "?"' 2>/dev/null || echo "?")
                _heavy=$(echo "$_brain_health" | jq -r '.llm_models.heavy // "?"' 2>/dev/null || echo "?")
                echo -e "  LLM:       ${GREEN}available${RESET}"
                echo -e "             ${DIM}Lite:    ${_lite}${RESET}"
                echo -e "             ${DIM}Primary: ${_primary}${RESET}"
                echo -e "             ${DIM}Heavy:   ${_heavy}${RESET}"
            else
                echo -e "  LLM:       ${YELLOW}not configured${RESET}"
            fi
        fi

        # Session
        if [ -n "$DINA_SESSION" ]; then
            echo -e "  Session:   ${DIM}${DINA_SESSION}${RESET}"
        fi

        # Startup mode
        SEED_PASSWORD_FILE="${SECRETS_DIR}/seed_password"
        if [ -f "$SEED_PASSWORD_FILE" ]; then
            if [ -s "$SEED_PASSWORD_FILE" ]; then
                echo -e "  Security:  ${DIM}auto-start${RESET}"
            else
                echo -e "  Security:  ${DIM}manual-start${RESET}"
            fi
        fi

        echo ""
        exit 0
        ;;
    --logs)
        detect_compose
        shift
        exec $COMPOSE logs -f "$@"
        ;;
    --start)
        # Fall through to the startup flow below
        ;;
    --*)
        echo -e "  ${RED}Unknown option: $1${RESET}" >&2
        echo ""
        echo -e "  Usage: ${CYAN}./run.sh${RESET} [--start|--stop|--status|--logs]"
        exit 1
        ;;
esac

# ---------------------------------------------------------------------------
# Check installation state (all mandatory artifacts — no Docker needed)
# ---------------------------------------------------------------------------

echo ""
echo -e "  ${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${BOLD}  Dina Home Node${RESET}"
echo -e "  ${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

if ! check_install_complete "${DINA_DIR}"; then
    echo -e "  ${YELLOW}Dina is not fully installed.${RESET}"
    if [ -n "${INSTALL_MISSING}" ]; then
        echo -e "  ${DIM}Missing:${INSTALL_MISSING}${RESET}"
    fi
    echo ""
    echo -e "  Run:  ${CYAN}./install.sh${RESET}"
    echo ""
    exit 1
fi

ok "Installation verified"

# ---------------------------------------------------------------------------
# Backfill required .env keys (migration from older installs)
# ---------------------------------------------------------------------------

ensure_required_env "${ENV_FILE}"

# ---------------------------------------------------------------------------
# Fill optional configuration gaps
# ---------------------------------------------------------------------------

# Check LLM provider
if ! has_llm_provider "${ENV_FILE}"; then
    warn "No LLM provider configured"
    if [ -t 0 ]; then
        setup_llm_provider
        write_llm_to_env "${ENV_FILE}"
        if [ ${#LLM_PROVIDERS[@]} -gt 0 ]; then
            ok "LLM provider(s) configured"
        fi
    else
        info "Run interactively to configure LLM provider, or edit .env directly"
    fi
else
    ok "LLM provider configured"
fi

# Check Telegram (optional — just show status, don't prompt)
if has_telegram "${ENV_FILE}"; then
    ok "Telegram bot configured"
fi

echo ""

# ---------------------------------------------------------------------------
# Docker prerequisites
# ---------------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || fail "Docker not found. Please install Docker first."
if ! docker info >/dev/null 2>&1; then
    fail "Cannot connect to Docker.\n\n  Make sure these commands work:\n\n    ${REVERSE} docker run hello-world ${RESET}\n    ${REVERSE} docker compose version ${RESET}\n\n  Then run ./run.sh again."
fi
detect_compose

# ---------------------------------------------------------------------------
# Passphrase check (manual-start mode)
# ---------------------------------------------------------------------------

SEED_PASSWORD_FILE="${SECRETS_DIR}/seed_password"
if [ -f "${SEED_PASSWORD_FILE}" ] && [ ! -s "${SEED_PASSWORD_FILE}" ]; then
    # Empty seed_password = manual-start mode. Core needs it to start.
    if [ ! -t 0 ]; then
        fail "Passphrase required but running non-interactively.\n  Switch to auto-start: ${CYAN}./dina-admin security auto-start${RESET}"
    fi
    while true; do
        printf "  ${BOLD}Enter passphrase${RESET} ${DIM}(${CYAN}dina-admin security auto-start${RESET}${DIM} to skip this):${RESET} "
        read -rs _run_passphrase
        echo ""
        if [ -z "${_run_passphrase}" ]; then
            fail "Passphrase cannot be empty."
        fi
        # Validate passphrase by attempting to unwrap the seed
        if docker run --rm \
            --user "$(id -u):$(id -g)" \
            -v "${DINA_DIR}/scripts:/scripts:ro" \
            -v "${SECRETS_DIR}:/secrets:ro" \
            -e DINA_SEED_PASSPHRASE="${_run_passphrase}" \
            dina-crypto-tools \
            python3 /scripts/unwrap_seed.py /secrets >/dev/null 2>&1; then
            break
        else
            echo -e "  ${YELLOW}✗${RESET} Wrong passphrase. Try again."
        fi
    done
    # Write passphrase temporarily for this startup.
    # Core reads it from the Docker secret mount on container start.
    printf '%s' "${_run_passphrase}" > "${SEED_PASSWORD_FILE}"
    chmod 600 "${SEED_PASSWORD_FILE}"
    # Schedule cleanup: clear passphrase from disk after containers start.
    _CLEAR_PASSPHRASE_AFTER_START=true
else
    _CLEAR_PASSPHRASE_AFTER_START=false
fi

# ---------------------------------------------------------------------------
# Start containers
# ---------------------------------------------------------------------------

echo -e "${BOLD}Starting containers${RESET}"

# Load session and ports from .env
DINA_SESSION=$(sed -n 's/^DINA_SESSION=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || true)
CORE_PORT=$(sed -n 's/^DINA_CORE_PORT=\(.*\)$/\1/p' "${ENV_FILE}" 2>/dev/null || echo "8100")

# Check if containers are already running
RUNNING=$($COMPOSE ps --format "{{.Name}}" 2>/dev/null | head -1 || true)
if [ -n "${RUNNING}" ]; then
    ok "Containers already running"
    echo -e "  ${DIM}Use ${CYAN}./run.sh --stop${RESET}${DIM} then ${CYAN}./run.sh --start${RESET}${DIM} to restart.${RESET}"
else
    $COMPOSE up -d 2>&1 | while IFS= read -r line; do
        echo -e "  ${DIM}${line}${RESET}"
    done
    ok "Containers started"
fi

echo ""

# ---------------------------------------------------------------------------
# Wait for health
# ---------------------------------------------------------------------------

echo -e "${BOLD}Waiting for health check${RESET}"

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
    # Clear temporary passphrase even on failure — do not leave it on disk
    if [ "${_CLEAR_PASSPHRASE_AFTER_START}" = true ]; then
        : > "${SEED_PASSWORD_FILE}"
        chmod 600 "${SEED_PASSWORD_FILE}"
    fi
    exit 1
fi

# Clear passphrase from disk now that Core has read it and is healthy.
# Must happen AFTER health check, not after compose up -d (race condition:
# compose up -d returns immediately, entrypoint hasn't read the file yet).
if [ "${_CLEAR_PASSPHRASE_AFTER_START}" = true ]; then
    : > "${SEED_PASSWORD_FILE}"
    chmod 600 "${SEED_PASSWORD_FILE}"
fi

echo ""

# ---------------------------------------------------------------------------
# Status banner
# ---------------------------------------------------------------------------

echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}${BOLD}  Dina is running${RESET}"
echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
if [ -n "${DINA_SESSION}" ]; then
    echo -e "  Session:   ${CYAN}${DINA_SESSION}${RESET}  ${DIM}(core-${DINA_SESSION}, brain-${DINA_SESSION}, ...)${RESET}"
fi
echo -e "  Core:      ${CYAN}http://localhost:${CORE_PORT}${RESET}"
echo -e "  Health:    ${CYAN}http://localhost:${CORE_PORT}/healthz${RESET}"
if has_telegram "${ENV_FILE}"; then
    echo -e "  Telegram:  ${GREEN}connected${RESET}"
fi
# Check LLM status from Brain's healthz (inside the container network)
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
        echo -e "  LLM:       ${YELLOW}not configured${RESET} ${DIM}edit .env to add your API key${RESET}"
    fi
fi
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "    ${CYAN}./run.sh --status${RESET}   Show status"
echo -e "    ${CYAN}./run.sh --logs${RESET}     Tail logs"
echo -e "    ${CYAN}./run.sh --stop${RESET}     Stop"
echo ""
