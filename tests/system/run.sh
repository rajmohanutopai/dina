#!/usr/bin/env bash
# System tests — all services real, zero mocks.
#
# Layout:
#   check_sanity/   — health, identity, vault, D2D, PII, auth, AppView
#   user_stories/   — full user journeys (purchase advice, etc.)
#
# Usage:
#   ./tests/system/run.sh                                # all tests
#   ./tests/system/run.sh -k "TestHealth"                # filter by name
#   ./tests/system/run.sh tests/system/check_sanity/     # sanity only
#   ./tests/system/run.sh tests/system/user_stories/     # stories only
#   SYSTEM_RESTART=0 ./tests/system/run.sh               # reuse containers
set -euo pipefail
cd "$(dirname "$0")/../.."

# Activate venv if present and not already active
if [ -z "${VIRTUAL_ENV:-}" ] && [ -f .venv/bin/activate ]; then
    # shellcheck disable=SC1091
    source .venv/bin/activate
fi

# Session ID for Docker project isolation.
# Port allocation is handled by conftest.py (auto-scans for free ports).
if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
    SESSION_ID="${DINA_TEST_SESSION:-$(openssl rand -hex 2 | tr -d '\n' | head -c 3)}"
    export COMPOSE_PROJECT_NAME="dina-system-${SESSION_ID}"
fi

# If first arg is a path, use it as the test target; otherwise default to all
if [[ "${1:-}" == tests/* ]]; then
    TARGET="$1"
    shift
else
    TARGET="tests/system/"
fi

python -m pytest "$TARGET" -v --tb=short "$@"
