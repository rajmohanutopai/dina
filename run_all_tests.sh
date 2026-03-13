#!/usr/bin/env bash
# ============================================================================
# Dina — Run All Tests
# ============================================================================
#
# Runs test suites in sequence, stopping on first failure by default.
#
# Suites (name → --area alias):
#   1. integration    Core Go + Brain Python integration (test_status.py --restart)
#   2. user-story     User stories against multi-node stack (run_user_story_tests.sh)
#   3. release        Release scenarios (test_release.py)
#   4. appview-unit   AppView TypeScript unit tests (npm run test:unit)
#   5. appview-int    AppView TypeScript integration tests (npm run test:integration)
#
# Usage:
#   ./run_all_tests.sh                              # Run all 5 suites
#   ./run_all_tests.sh --continue                   # Don't stop on failure
#   ./run_all_tests.sh --skip 1                     # Skip suite 1
#   ./run_all_tests.sh --only 2                     # Run only suite 2
#   ./run_all_tests.sh --area appview-int            # Run only appview integration
#   ./run_all_tests.sh --area appview-int,user-story # Run appview-int + user-story
#   ./run_all_tests.sh --area integration,release    # Run integration + release
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
# Suite definitions: name → number
# ---------------------------------------------------------------------------
TOTAL_SUITES=5
VALID_AREAS="integration user-story release appview-unit appview-int"

area_to_num() {
    case "$1" in
        integration)  echo 1 ;;
        user-story)   echo 2 ;;
        release)      echo 3 ;;
        appview-unit) echo 4 ;;
        appview-int)  echo 5 ;;
        *)            echo 0 ;;
    esac
}

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
STOP_ON_FAIL=true
SKIP=()
ONLY=""
AREA_FILTER=()

show_help() {
    cat <<'HELPEOF'
Usage: ./run_all_tests.sh [OPTIONS]

Options:
  --continue           Don't stop on first failure, run all suites
  --skip N             Skip suite N (can be repeated)
  --only N             Run only suite N
  --area AREAS         Comma-separated area names to run (overrides --only/--skip)
  --help, -h           Show this help

Areas:
  integration          Suite 1: Core + Brain integration tests
  user-story           Suite 2: User story tests (multi-node)
  release              Suite 3: Release scenario tests
  appview-unit         Suite 4: AppView TypeScript unit tests
  appview-int          Suite 5: AppView TypeScript integration tests

Examples:
  ./run_all_tests.sh --area appview-int,user-story
  ./run_all_tests.sh --area integration --continue
  ./run_all_tests.sh --only 4
HELPEOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --continue)  STOP_ON_FAIL=false ;;
        --skip)      SKIP+=("$2"); shift ;;
        --only)      ONLY="$2"; shift ;;
        --area)
            IFS=',' read -ra _areas <<< "$2"
            for a in "${_areas[@]}"; do
                a=$(echo "$a" | xargs)  # trim whitespace
                _num=$(area_to_num "$a")
                if [ "$_num" = "0" ]; then
                    echo "Unknown area: $a"
                    echo "Valid areas: $VALID_AREAS"
                    exit 1
                fi
                AREA_FILTER+=("$_num")
            done
            shift
            ;;
        --help|-h)   show_help ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
    shift
done

should_run() {
    local suite_num="$1"
    # --area takes precedence over --only/--skip
    if [ ${#AREA_FILTER[@]} -gt 0 ]; then
        for a in "${AREA_FILTER[@]}"; do
            if [ "$a" = "$suite_num" ]; then
                return 0
            fi
        done
        return 1
    fi
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

# Count how many suites will actually run (for the [N/M] display)
SUITES_TO_RUN=0
for i in $(seq 1 $TOTAL_SUITES); do
    if should_run "$i"; then
        SUITES_TO_RUN=$((SUITES_TO_RUN + 1))
    fi
done
SUITE_COUNTER=0

# ---------------------------------------------------------------------------
# State tracking
# ---------------------------------------------------------------------------
RESULTS=()
TOTAL_START=$SECONDS
EXIT_CODE=0

# ---------------------------------------------------------------------------
# LLM cost tracking
# ---------------------------------------------------------------------------
LLM_COST_DIR=$(mktemp -d /tmp/dina-llm-cost-XXXXXX)
export DINA_LLM_COST_DIR="$LLM_COST_DIR"
LLM_TOTAL_CALLS=0
LLM_TOTAL_TOKENS_IN=0
LLM_TOTAL_TOKENS_OUT=0
LLM_TOTAL_COST="0.0"

# Collect LLM usage from temp files written by test conftests.
collect_llm_cost() {
    for f in "$LLM_COST_DIR"/*.json; do
        [ -f "$f" ] || continue
        local data
        data=$(python3 -c "
import json, sys
with open('$f') as fh:
    d = json.load(fh)
print(d.get('total_calls',0))
print(d.get('total_tokens_in',0))
print(d.get('total_tokens_out',0))
print(d.get('total_cost_usd',0.0))
" 2>/dev/null) || continue
        local calls tokens_in tokens_out cost
        calls=$(echo "$data" | sed -n '1p')
        tokens_in=$(echo "$data" | sed -n '2p')
        tokens_out=$(echo "$data" | sed -n '3p')
        cost=$(echo "$data" | sed -n '4p')
        LLM_TOTAL_CALLS=$((LLM_TOTAL_CALLS + ${calls:-0}))
        LLM_TOTAL_TOKENS_IN=$((LLM_TOTAL_TOKENS_IN + ${tokens_in:-0}))
        LLM_TOTAL_TOKENS_OUT=$((LLM_TOTAL_TOKENS_OUT + ${tokens_out:-0}))
        LLM_TOTAL_COST=$(python3 -c "print(round($LLM_TOTAL_COST + ${cost:-0.0}, 6))")
        rm -f "$f"
    done
}

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

    # LLM cost summary
    if [ "$LLM_TOTAL_CALLS" -gt 0 ]; then
        echo -e "${BOLD}${CYAN}  ── LLM Usage ──${RESET}"
        echo -e "  Calls: ${LLM_TOTAL_CALLS}   Tokens in: ${LLM_TOTAL_TOKENS_IN}   Tokens out: ${LLM_TOTAL_TOKENS_OUT}"
        local usd eur gbp inr cny jpy
        usd=$(python3 -c "print(f'{round($LLM_TOTAL_COST, 2)}')")
        eur=$(python3 -c "print(f'{round($LLM_TOTAL_COST * 0.92, 2)}')")
        gbp=$(python3 -c "print(f'{round($LLM_TOTAL_COST * 0.79, 2)}')")
        inr=$(python3 -c "print(f'{round($LLM_TOTAL_COST * 84.5, 2)}')")
        cny=$(python3 -c "print(f'{round($LLM_TOTAL_COST * 7.25, 2)}')")
        jpy=$(python3 -c "print(f'{round($LLM_TOTAL_COST * 149.5, 2)}')")
        echo -e "  ${BOLD}Estimated cost: \$${usd} USD  │  €${eur}  │  £${gbp}  │  ₹${inr}  │  ¥${cny} CNY  │  ¥${jpy} JPY${RESET}"
        echo ""
    fi
}

run_suite() {
    local num="$1"
    local name="$2"
    shift 2

    SUITE_COUNTER=$((SUITE_COUNTER + 1))

    echo ""
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}  [${SUITE_COUNTER}/${SUITES_TO_RUN}] $name${RESET}"
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo ""

    local start=$SECONDS
    "$@"
    local rc=$?
    local elapsed=$(( SECONDS - start ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))

    if [ $rc -eq 0 ]; then
        RESULTS+=("${GREEN}PASS${RESET}  [${SUITE_COUNTER}] $name  (${mins}m${secs}s)")
    else
        RESULTS+=("${RED}FAIL${RESET}  [${SUITE_COUNTER}] $name  (${mins}m${secs}s)")
        EXIT_CODE=1
    fi

    return $rc
}

handle_failure() {
    local suite_counter="$1"
    collect_llm_cost
    echo -e "\n${RED}Suite ${suite_counter} failed. Stopping. Use --continue to run all suites.${RESET}"
    print_summary
    exit 1
}

# ---------------------------------------------------------------------------
# Suite 1: Integration tests
# ---------------------------------------------------------------------------
if should_run 1; then
    if ! run_suite 1 "Integration Tests" \
        python3 scripts/test_status.py --restart; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
    collect_llm_cost
fi

# ---------------------------------------------------------------------------
# Suite 2: User Story tests
# ---------------------------------------------------------------------------
if should_run 2; then
    if ! run_suite 2 "User Story Tests" \
        ./run_user_story_tests.sh --brief; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
    collect_llm_cost
fi

# ---------------------------------------------------------------------------
# Suite 3: Release tests
# ---------------------------------------------------------------------------
if should_run 3; then
    if ! run_suite 3 "Release Tests" \
        python3 scripts/test_release.py; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
    collect_llm_cost
fi

# ---------------------------------------------------------------------------
# Suite 4: AppView Unit tests
# ---------------------------------------------------------------------------
if should_run 4; then
    if ! run_suite 4 "AppView Unit Tests" \
        bash -c "cd appview && npx tsx test_appview.ts --suite unit"; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Suite 5: AppView Integration tests
# ---------------------------------------------------------------------------
if should_run 5; then
    if ! run_suite 5 "AppView Integration Tests" \
        bash -c "cd appview && npx tsx test_appview.ts --suite integration --restart"; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary
rm -rf "$LLM_COST_DIR" 2>/dev/null || true
exit $EXIT_CODE
