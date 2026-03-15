#!/usr/bin/env bash
# test_install.sh — Run install black-box tests (pexpect-based)
#
# Drives install.sh via PTY like a real user and verifies:
#   - secrets, keys, .env created correctly
#   - containers healthy, DID reachable
#   - idempotent rerun (no identity rotation)
#   - startup modes (auto-start vs manual-start)
#   - failure paths (corrupt seed, missing Docker, bad permissions)
#
# Requires: Docker running, pexpect installed.
#
# Usage:
#   ./scripts/test_install.sh                  # all install tests
#   ./scripts/test_install.sh -k "lifecycle"   # single test
#   ./scripts/test_install.sh --quick          # failures + blackbox only (skip slow rerun/modes)

set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/setup/colors.sh

echo ""
echo -e "${BOLD}Install Tests${RESET}"
echo -e "${DIM}Black-box pexpect tests for install.sh + run.sh${RESET}"
echo ""

# Check prerequisites
if ! docker info >/dev/null 2>&1; then
    fail "Docker not running — install tests need Docker"
fi

if ! python3 -c "import pexpect" 2>/dev/null; then
    fail "pexpect not installed. Run: pip install pexpect"
fi

# Parse args
PYTEST_ARGS=("-v" "--tb=short")
QUICK=false

for arg in "$@"; do
    case "$arg" in
        --quick)
            QUICK=true
            ;;
        *)
            PYTEST_ARGS+=("$arg")
            ;;
    esac
done

if [ "$QUICK" = true ]; then
    echo -e "${DIM}Quick mode: running failures + blackbox only${RESET}"
    PYTEST_ARGS+=("tests/install/test_install_failures.py" "tests/install/test_install_blackbox.py")
else
    PYTEST_ARGS+=("tests/install/")
fi

echo ""
python3 -m pytest "${PYTEST_ARGS[@]}"
