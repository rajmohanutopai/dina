#!/usr/bin/env bash
# Telegram Sanity Suite Runner
#
# Usage:
#   ./tests/sanity/run_sanity.sh --new        # Fresh install: creates new DID, new instances
#   ./tests/sanity/run_sanity.sh --existing   # Reuse running instances (same DID, same bots)
#   ./tests/sanity/run_sanity.sh              # Auto-detect: existing if healthy, else fail
#
# Prerequisites:
#   - tests/sanity/.env.sanity with Telethon API credentials
#   - Telethon session created (one-time: python tests/sanity/create_session.py)
#   - For --new: install.sh must be available, config files in tests/sanity/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ALONSO_INSTANCE="regression-alonso"
SANCHO_INSTANCE="regression-sancho"
ALONSO_PORT=18100
SANCHO_PORT=18300
ALONSO_CONFIG="${SCRIPT_DIR}/config-alonso.json"
SANCHO_CONFIG="${SCRIPT_DIR}/config-sancho.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[sanity]${NC} $*"; }
warn()  { echo -e "${YELLOW}[sanity]${NC} $*"; }
fail()  { echo -e "${RED}[sanity]${NC} $*"; exit 1; }

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

health_check() {
    local port=$1
    local name=$2
    if curl -sf "http://localhost:${port}/healthz" > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

both_healthy() {
    health_check ${ALONSO_PORT} "Alonso" && health_check ${SANCHO_PORT} "Sancho"
}

# ---------------------------------------------------------------------------
# Instance management
# ---------------------------------------------------------------------------

stop_instance() {
    local name=$1
    info "Stopping ${name}..."
    cd "${PROJECT_ROOT}"
    docker compose -p "dina-${name}" down --remove-orphans 2>/dev/null || true
}

start_instance() {
    local name=$1
    info "Starting ${name}..."
    cd "${PROJECT_ROOT}"
    local env_file="instances/${name}/.env"
    if [ ! -f "${env_file}" ]; then
        fail "Instance ${name} not installed. Run with --new first."
    fi
    docker compose -p "dina-${name}" --env-file "${env_file}" up -d
}

install_instance() {
    local name=$1
    local port=$2
    local config=$3
    info "Installing ${name} on port ${port}..."
    cd "${PROJECT_ROOT}"
    ./install.sh --instance "${name}" --port "${port}" --config "${config}"
}

wait_healthy() {
    local port=$1
    local name=$2
    local timeout=60
    local elapsed=0
    info "Waiting for ${name} (port ${port}) to be healthy..."
    while [ $elapsed -lt $timeout ]; do
        if health_check "${port}" "${name}"; then
            info "${name} is healthy."
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    fail "${name} did not become healthy within ${timeout}s"
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

mode_new() {
    info "=== Fresh Install Mode ==="
    info "This will create new Dina instances with new DIDs."
    echo ""

    # Verify config files exist
    [ -f "${ALONSO_CONFIG}" ] || fail "Missing ${ALONSO_CONFIG}"
    [ -f "${SANCHO_CONFIG}" ] || fail "Missing ${SANCHO_CONFIG}"

    # Stop existing instances if running
    stop_instance "${ALONSO_INSTANCE}"
    stop_instance "${SANCHO_INSTANCE}"

    # Remove old instance data for clean install
    rm -rf "${PROJECT_ROOT}/instances/${ALONSO_INSTANCE}"
    rm -rf "${PROJECT_ROOT}/instances/${SANCHO_INSTANCE}"

    # Install fresh
    install_instance "${ALONSO_INSTANCE}" "${ALONSO_PORT}" "${ALONSO_CONFIG}"
    install_instance "${SANCHO_INSTANCE}" "${SANCHO_PORT}" "${SANCHO_CONFIG}"

    # Wait for health
    wait_healthy "${ALONSO_PORT}" "Alonso"
    wait_healthy "${SANCHO_PORT}" "Sancho"

    info "Both instances installed and healthy."
    echo ""
    run_tests
}

mode_existing() {
    info "=== Existing Instance Mode ==="

    if ! both_healthy; then
        warn "Instances not running. Attempting to start..."
        start_instance "${ALONSO_INSTANCE}"
        start_instance "${SANCHO_INSTANCE}"
        wait_healthy "${ALONSO_PORT}" "Alonso"
        wait_healthy "${SANCHO_PORT}" "Sancho"
    else
        info "Both instances already healthy."
    fi

    echo ""
    run_tests
}

mode_auto() {
    if both_healthy; then
        info "Auto-detected: instances are running."
        mode_existing
    else
        fail "Instances not running. Use --new for fresh install or --existing to auto-start."
    fi
}

# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

run_tests() {
    info "=== Running Telegram Sanity Tests ==="
    echo ""
    cd "${PROJECT_ROOT}"
    python -m pytest tests/sanity/test_telegram_sanity.py -v -s --tb=short "$@"
    local rc=$?
    echo ""
    if [ $rc -eq 0 ]; then
        info "All sanity tests passed!"
    else
        fail "Sanity tests failed (exit code: ${rc})"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

MODE=""
EXTRA_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --new)      MODE="new" ;;
        --existing) MODE="existing" ;;
        --help|-h)
            echo "Usage: $0 [--new | --existing] [pytest args...]"
            echo ""
            echo "  --new        Fresh install: create new instances with new DIDs"
            echo "  --existing   Reuse running instances (start if stopped)"
            echo "  (no flag)    Auto-detect: use existing if healthy, else fail"
            echo ""
            echo "Any extra arguments are passed to pytest."
            exit 0
            ;;
        *)          EXTRA_ARGS+=("$arg") ;;
    esac
done

# Verify .env.sanity exists
if [ ! -f "${SCRIPT_DIR}/.env.sanity" ]; then
    fail "Missing ${SCRIPT_DIR}/.env.sanity — create it with Telethon credentials."
fi

case "${MODE}" in
    new)      mode_new "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" ;;
    existing) mode_existing "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" ;;
    *)        mode_auto "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" ;;
esac
