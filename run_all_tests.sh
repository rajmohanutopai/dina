#!/usr/bin/env bash
# ============================================================================
# Dina — Run All Tests
# ============================================================================
#
# Runs the three main test suites in sequence, stopping on first failure:
#
#   1. Integration tests   (test_status.py --restart)
#      Core Go + Brain Python unit/integration with real Docker services.
#
#   2. User Story tests    (run_user_story_tests.sh --brief)
#      Six end-to-end user stories against a multi-node stack, zero mocks.
#
#   3. Release tests       (test_release.py)
#      23 release scenarios (REL-001..REL-023) against release Docker stack.
#
# Each suite rebuilds its Docker stack from scratch (--restart / fresh
# containers) to avoid stale code.
#
# Usage:
#   ./run_all_tests.sh              # Run all three suites
#   ./run_all_tests.sh --continue   # Don't stop on failure, run all suites
#   ./run_all_tests.sh --skip 1     # Skip suite 1 (integration)
#   ./run_all_tests.sh --skip 2     # Skip suite 2 (user stories)
#   ./run_all_tests.sh --skip 3     # Skip suite 3 (release)
#   ./run_all_tests.sh --only 2     # Run only suite 2
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"

# Activate venv if present and not already active
if [ -z "${VIRTUAL_ENV:-}" ] && [ -f .venv/bin/activate ]; then
    # shellcheck disable=SC1091
    source .venv/bin/activate
fi

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    BOLD="\033[1m"
    DIM="\033[2m"
    GREEN="\033[32m"
    RED="\033[1;31m"
    CYAN="\033[36m"
    RESET="\033[0m"
else
    BOLD="" DIM="" GREEN="" RED="" CYAN="" RESET=""
fi

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
STOP_ON_FAIL=true
SKIP=()
ONLY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --continue)  STOP_ON_FAIL=false ;;
        --skip)      SKIP+=("$2"); shift ;;
        --only)      ONLY="$2"; shift ;;
        --help|-h)
            head -25 "$0" | tail -19
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
    shift
done

should_run() {
    local suite_num="$1"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$suite_num" ]; then
        return 1
    fi
    for s in "${SKIP[@]+"${SKIP[@]}"}"; do
        if [ "$s" = "$suite_num" ]; then
            return 1
        fi
    done
    return 0
}

# ---------------------------------------------------------------------------
# State tracking
# ---------------------------------------------------------------------------
RESULTS=()
TOTAL_START=$SECONDS
EXIT_CODE=0

print_summary() {
    local total_elapsed=$(( SECONDS - TOTAL_START ))
    local total_mins=$(( total_elapsed / 60 ))
    local total_secs=$(( total_elapsed % 60 ))

    echo ""
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}  All Tests — Summary  (${total_mins}m${total_secs}s total)${RESET}"
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo ""
    for r in "${RESULTS[@]}"; do
        echo -e "  $r"
    done
    echo ""

    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "  ${GREEN}${BOLD}All suites passed.${RESET}"
    else
        echo -e "  ${RED}${BOLD}Some suites failed.${RESET}"
    fi
    echo ""
}

run_suite() {
    local num="$1"
    local name="$2"
    shift 2

    echo ""
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}  [$num/3] $name${RESET}"
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo ""

    local start=$SECONDS
    "$@"
    local rc=$?
    local elapsed=$(( SECONDS - start ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))

    if [ $rc -eq 0 ]; then
        RESULTS+=("${GREEN}PASS${RESET}  [$num] $name  (${mins}m${secs}s)")
    else
        RESULTS+=("${RED}FAIL${RESET}  [$num] $name  (${mins}m${secs}s)")
        EXIT_CODE=1
    fi

    return $rc
}

# ---------------------------------------------------------------------------
# Suite 1: Integration tests
# ---------------------------------------------------------------------------
if should_run 1; then
    if ! run_suite 1 "Integration Tests" \
        python scripts/test_status.py --restart; then
        if [ "$STOP_ON_FAIL" = true ]; then
            echo -e "\n${RED}Suite 1 failed. Stopping. Use --continue to run all suites.${RESET}"
            print_summary
            exit 1
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Suite 2: User Story tests
# ---------------------------------------------------------------------------
if should_run 2; then
    if ! run_suite 2 "User Story Tests" \
        ./run_user_story_tests.sh --brief; then
        if [ "$STOP_ON_FAIL" = true ]; then
            echo -e "\n${RED}Suite 2 failed. Stopping. Use --continue to run all suites.${RESET}"
            print_summary
            exit 1
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Suite 3: Release tests
# ---------------------------------------------------------------------------
if should_run 3; then
    run_suite 3 "Release Tests" \
        python scripts/test_release.py || true
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary
exit $EXIT_CODE
