#!/usr/bin/env bash
# run.sh — Start Dina Home Node
#
# Checks installation state, fills gaps, starts containers.
#
# Usage:
#   ./run.sh             # start (or install if needed)
#   ./run.sh --status    # show container status only
#   ./run.sh --stop      # stop containers
#   ./run.sh --logs      # tail container logs

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
    --stop)
        detect_compose
        info "Stopping containers..."
        $COMPOSE down
        ok "Containers stopped"
        exit 0
        ;;
    --status)
        detect_compose
        $COMPOSE ps
        exit 0
        ;;
    --logs)
        detect_compose
        shift
        exec $COMPOSE logs -f "$@"
        ;;
esac

# ---------------------------------------------------------------------------
# Check installation state (all mandatory artifacts — no Docker needed)
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}Dina Home Node${RESET}"
echo ""

if ! check_install_complete "${DINA_DIR}"; then
    if [ ! -t 0 ]; then
        # Non-interactive: refuse to bootstrap — identity creation requires
        # human interaction (passphrase, recovery phrase verification).
        fail "Dina is not installed in this directory. Run ./install.sh in a terminal first."
    fi
    echo -e "  ${YELLOW}Dina is not installed in this directory.${RESET}"
    echo ""
    while true; do
        printf "  ${BOLD}Install Dina? (Y/N):${RESET} "
        read -r INSTALL_CHOICE
        case "${INSTALL_CHOICE}" in
            [yY]) exec ./install.sh "$@" ;;
            [nN]) exit 0 ;;
            *)    echo -e "  ${DIM}Please enter Y or N.${RESET}" ;;
        esac
    done
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
        if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ]; then
            ok "Configured ${LLM_KEY_NAME}"
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

command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
docker info >/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker and try again."
detect_compose

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
    info "Containers already running — restarting..."
    $COMPOSE restart 2>&1 | while IFS= read -r line; do
        echo -e "  ${DIM}${line}${RESET}"
    done
else
    $COMPOSE up -d 2>&1 | while IFS= read -r line; do
        echo -e "  ${DIM}${line}${RESET}"
    done
fi

ok "Containers started"
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
    exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# Status banner
# ---------------------------------------------------------------------------

echo -e "${BOLD}Dina is running${RESET}"
echo ""
if [ -n "${DINA_SESSION}" ]; then
    echo -e "  Session:   ${CYAN}${DINA_SESSION}${RESET}  ${DIM}(core-${DINA_SESSION}, brain-${DINA_SESSION}, ...)${RESET}"
fi
echo -e "  Core:      ${CYAN}http://localhost:${CORE_PORT}${RESET}"
echo -e "  Health:    ${CYAN}http://localhost:${CORE_PORT}/healthz${RESET}"
if has_telegram "${ENV_FILE}"; then
    echo -e "  Telegram:  ${GREEN}connected${RESET}"
fi
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "    Status:  ${CYAN}./run.sh --status${RESET}"
echo -e "    Logs:    ${CYAN}./run.sh --logs${RESET}"
echo -e "    Stop:    ${CYAN}./run.sh --stop${RESET}"
echo ""
