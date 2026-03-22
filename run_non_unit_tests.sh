#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Dina Non-Unit Tests
# ---------------------------------------------------------------------------
# Runs non-unit test suites against the Docker test stack.
# The stack must be running (via ./prepare_non_unit_env.sh up).
#
# Usage:
#   ./run_non_unit_tests.sh                                 # default suites
#   ./run_non_unit_tests.sh --all                           # include install-pexpect
#   ./run_non_unit_tests.sh --run integration,e2e           # specific suites (faster)
#   ./run_non_unit_tests.sh --run integration               # single suite
#   ./run_non_unit_tests.sh --json                          # JSON output
#
# Default: integration,e2e,release,install,user_stories,appview_integration
# --all adds: install-pexpect (slow shell lifecycle tests)
# Use --run to select a subset for faster development cycles.
# ---------------------------------------------------------------------------

DEFAULT_SUITES="integration,e2e,release,install,user_stories,appview_integration"
ALL_SUITES="integration,e2e,release,install,user_stories,appview_integration,install-pexpect"
SUITES=""
EXTRA_ARGS=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      SUITES="$2"
      shift 2
      ;;
    --all)
      SUITES="$ALL_SUITES"
      shift
      ;;
    --json-file)
      EXTRA_ARGS+=("$1" "$2")
      shift 2
      ;;
    --json|--verbose|-v|--no-color)
      EXTRA_ARGS+=("$1")
      shift
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

SUITES="${SUITES:-$DEFAULT_SUITES}"

# Verify stack is ready (no Docker lifecycle — must be prepared first).
python3 -c "
import sys; sys.path.insert(0, '.')
from tests.shared.test_stack import TestStackServices
try:
    TestStackServices().assert_ready()
    print('Test stack verified.')
except Exception as e:
    print(f'ERROR: Test stack not ready: {e}')
    print('Run: ./prepare_non_unit_env.sh up')
    sys.exit(1)
"

# Extract alonso Core URL and client token from test stack for install tests.
# test_post_install.py uses DINA_CORE_URL + DINA_CLIENT_TOKEN to skip the
# slow pexpect install and test against the already-running stack instead.
eval "$(python3 -c "
import sys, json; sys.path.insert(0, '.')
from tests.shared.test_stack import TestStackServices
ts = TestStackServices()
print(f'export DINA_CORE_URL={ts.core_url(\"alonso\")}')
print(f'export DINA_CLIENT_TOKEN={ts.client_token}')
")"

# Run selected suites via test_status.py for structured table output.
# Env vars tell conftest files to use real clients against the union stack.
DINA_INTEGRATION=docker \
DINA_E2E=docker \
DINA_RELEASE=docker \
DINA_RATE_LIMIT=100000 \
DINA_CORE_URL="$DINA_CORE_URL" \
DINA_CLIENT_TOKEN="$DINA_CLIENT_TOKEN" \
DATABASE_URL="postgresql://dina:dina@localhost:5433/dina_trust" \
  python scripts/test_status.py --suite "$SUITES" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
