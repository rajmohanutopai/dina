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
    ./install.sh --test --instance "${name}" --port "${port}" --config "${config}"
}

# ---------------------------------------------------------------------------
# OpenClaw container management
# ---------------------------------------------------------------------------

OPENCLAW_CONTAINER="sanity-openclaw"
OPENCLAW_IMAGE="dina-sanity-openclaw"
OPENCLAW_PORT=13000

build_openclaw() {
    info "Building OpenClaw container..."
    cd "${PROJECT_ROOT}"
    docker build -f tests/sanity/Dockerfile.openclaw -t "${OPENCLAW_IMAGE}" . 2>&1 | tail -5
}

start_openclaw() {
    local alonso_port=$1
    info "Starting OpenClaw container..."
    cd "${PROJECT_ROOT}"

    # Load sanity env for API keys
    local env_file="${SCRIPT_DIR}/.env.sanity"
    local google_key=$(grep '^SANITY_GOOGLE_API_KEY=' "$env_file" | cut -d= -f2)
    local gog_pw=$(grep '^GOG_KEYRING_PASSWORD=' "$env_file" | cut -d= -f2)
    local hook_token="dina-callback-sanity-token"

    # Get pairing code from Alonso's Core
    local pair_output=$(docker compose -p "dina-${ALONSO_INSTANCE}" \
        exec -T core dina-admin device pair 2>&1 || true)
    local pair_code=$(echo "$pair_output" | grep -oE '[0-9]{6}' | head -1)

    if [ -z "$pair_code" ]; then
        warn "Could not get pairing code — OpenClaw tests will be skipped"
        return
    fi

    docker rm -f "${OPENCLAW_CONTAINER}" 2>/dev/null || true
    docker run -d \
        --name "${OPENCLAW_CONTAINER}" \
        --network "dina-${ALONSO_INSTANCE}_dina-brain-net" \
        -p "${OPENCLAW_PORT}:3000" \
        -e "GOOGLE_API_KEY=${google_key}" \
        -e "DINA_CORE_URL=http://core-$(grep '^DINA_SESSION=' "${PROJECT_ROOT}/instances/${ALONSO_INSTANCE}/.env" | cut -d= -f2):8100" \
        -e "DINA_PAIRING_CODE=${pair_code}" \
        -e "DINA_HOOK_CALLBACK_TOKEN=${hook_token}" \
        -e "GOG_KEYRING_PASSWORD=${gog_pw}" \
        -v "${SCRIPT_DIR}/gog-auth:/root/.config/gogcli:ro" \
        "${OPENCLAW_IMAGE}"

    # Wait for gateway
    for i in $(seq 1 30); do
        if curl -sf "http://localhost:${OPENCLAW_PORT}/health" >/dev/null 2>&1; then
            info "OpenClaw container ready."
            return
        fi
        sleep 3
    done
    warn "OpenClaw container did not become healthy — agent tests may be skipped"
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
    info "This will stop ALL Docker containers, prune, and create new instances."
    echo ""

    # Verify config files exist
    [ -f "${ALONSO_CONFIG}" ] || fail "Missing ${ALONSO_CONFIG}"
    [ -f "${SANCHO_CONFIG}" ] || fail "Missing ${SANCHO_CONFIG}"

    # Stop ALL Docker containers and prune
    info "Stopping all Docker containers..."
    docker stop $(docker ps -q) 2>/dev/null || true
    info "Pruning Docker (containers, images, volumes, networks)..."
    docker system prune -af --volumes 2>/dev/null || true
    info "Docker pruned."

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

    # Verify infrastructure before running functional tests
    verify_infra

    # Build and start OpenClaw container (for agent integration tests)
    build_openclaw
    start_openclaw "${ALONSO_PORT}"

    run_tests
}

# ---------------------------------------------------------------------------
# Infrastructure verification (runs after install, before Telethon tests)
# ---------------------------------------------------------------------------

verify_infra() {
    info "=== Infrastructure Verification ==="
    local errors=0
    local total=0

    _check() {
        total=$((total + 1))
        if eval "$2" >/dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} $1"
        else
            echo -e "  ${RED}✗${NC} $1"
            errors=$((errors + 1))
        fi
    }

    local alonso_env="${PROJECT_ROOT}/instances/${ALONSO_INSTANCE}/.env"
    local sancho_env="${PROJECT_ROOT}/instances/${SANCHO_INSTANCE}/.env"

    # Services healthy
    _check "Alonso Core healthy" "curl -sf http://localhost:${ALONSO_PORT}/healthz"
    _check "Sancho Core healthy" "curl -sf http://localhost:${SANCHO_PORT}/healthz"

    # Brain containers healthy
    local alonso_session=$(grep '^DINA_SESSION=' "$alonso_env" | cut -d= -f2)
    local sancho_session=$(grep '^DINA_SESSION=' "$sancho_env" | cut -d= -f2)
    for brain in "brain-${alonso_session}" "brain-${sancho_session}"; do
        for i in $(seq 1 20); do
            local h=$(docker inspect "$brain" --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
            [ "$h" = "healthy" ] && break
            sleep 3
        done
    done
    _check "Alonso Brain healthy" "docker inspect brain-${alonso_session} --format '{{.State.Health.Status}}' | grep -q healthy"
    _check "Sancho Brain healthy" "docker inspect brain-${sancho_session} --format '{{.State.Health.Status}}' | grep -q healthy"

    # .env has test URLs, not production
    _check "Alonso .env → test infra" "grep 'test-mailbox.dinakernel.com' $alonso_env && grep 'test-pds.dinakernel.com' $alonso_env"
    _check "Sancho .env → test infra" "grep 'test-mailbox.dinakernel.com' $sancho_env && grep 'test-pds.dinakernel.com' $sancho_env"
    _check "No production URLs" "! grep -l 'DINA_MSGBOX_URL=wss://mailbox.dinakernel.com' $alonso_env $sancho_env"

    # Test infrastructure reachable
    _check "Test MsgBox reachable" "curl -sf https://test-mailbox.dinakernel.com/healthz"
    _check "Test AppView reachable" "curl -sf https://test-appview.dinakernel.com/health"
    _check "Test PDS reachable" "curl -sf https://test-pds.dinakernel.com/xrpc/_health"

    # PDS handles on test-pds
    local alonso_handle=$(grep '^DINA_COMMUNITY_PDS_HANDLE=' "$alonso_env" | cut -d= -f2)
    local sancho_handle=$(grep '^DINA_COMMUNITY_PDS_HANDLE=' "$sancho_env" | cut -d= -f2)
    _check "Alonso handle on test-pds" "echo '${alonso_handle}' | grep -q 'test-pds.dinakernel.com'"
    _check "Sancho handle on test-pds" "echo '${sancho_handle}' | grep -q 'test-pds.dinakernel.com'"

    # Telegram bots started
    _check "Alonso Telegram started" "docker logs brain-${alonso_session} 2>&1 | grep -q 'telegram.*started\|telegram.*polling\|telegram_bot.*ready'"
    _check "Sancho Telegram started" "docker logs brain-${sancho_session} 2>&1 | grep -q 'telegram.*started\|telegram.*polling\|telegram_bot.*ready'"

    # dina-agent from PyPI
    pip install --upgrade dina-agent >/dev/null 2>&1
    _check "dina-agent installed" "pip show dina-agent"
    _check "dina setup-agent available" "dina setup-agent --help"

    echo ""
    if [ $errors -eq 0 ]; then
        info "All ${total} infrastructure checks passed."
    else
        fail "${errors}/${total} infrastructure checks failed. Fix before running Telethon tests."
    fi
    echo ""
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

    # Start OpenClaw if not running
    if ! docker inspect -f '{{.State.Running}}' "${OPENCLAW_CONTAINER}" 2>/dev/null | grep -q true; then
        build_openclaw
        start_openclaw "${ALONSO_PORT}"
    else
        info "OpenClaw container already running."
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
