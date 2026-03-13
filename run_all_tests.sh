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
TOTAL_START=$SECONDS

# Activate venv if present and not already active
if [ -z "${VIRTUAL_ENV:-}" ] && [ -f .venv/bin/activate ]; then
    # shellcheck disable=SC1091
    source .venv/bin/activate
fi

# Tell sub-scripts not to tear down Docker stacks they didn't start.
# Each stack uses an isolated project name (dina-main, dina-e2e,
# dina-release, dina-system-{id}) so they can't accidentally destroy
# each other's containers.
export DINA_REUSE_DOCKER=1

# Clean up stale containers from the old default "dina" project.
# Compose files use container_name (global), so leftover containers
# from the unnamed project block the new named-project containers.
docker compose down -v --remove-orphans 2>/dev/null || true

# ---------------------------------------------------------------------------
# Docker image pre-build: build ALL images once, up front.
#
# All compose files use the same 4 Dockerfiles (core/, brain/, plc/,
# appview/).  BuildKit shares layer cache across image names, so building
# once with the most comprehensive compose file (docker-compose-system.yml)
# populates the cache.  Every subsequent `docker compose up --build` in
# sub-scripts will be a cache hit (~2-5s instead of 60-90s).
#
# After pre-building, we set DINA_SKIP_DOCKER_BUILD=1 so sub-scripts
# use `docker compose up -d` (no --build) for instant startup.
# ---------------------------------------------------------------------------
prebuild_docker_images() {
    echo ""
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}  Pre-building Docker images (one-time)${RESET}"
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo ""
    local t0=$SECONDS

    # Build from system compose (has core, brain, plc, appview, keygen).
    # This populates BuildKit cache for all Dockerfiles.
    echo -e "  ${DIM}Building core, brain, plc, appview images...${RESET}"
    docker compose -f docker-compose-system.yml build 2>&1 | tail -5
    local rc1=$?

    # Also build cli (needed by release + E2E) and release-specific services.
    if [ -f docker-compose-release.yml ]; then
        echo -e "  ${DIM}Building cli, dummy-agent images...${RESET}"
        docker compose -f docker-compose-release.yml build dummy-agent 2>&1 | tail -3
    fi
    if [ -f docker-compose-e2e.yml ]; then
        echo -e "  ${DIM}Building E2E cli image...${RESET}"
        docker compose -f docker-compose-e2e.yml build cli-alonso 2>&1 | tail -3
    fi

    local elapsed=$(( SECONDS - t0 ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))

    if [ $rc1 -eq 0 ]; then
        echo -e "  ${GREEN}Docker images built (${mins}m${secs}s)${RESET}"
        export DINA_SKIP_DOCKER_BUILD=1
    else
        echo -e "  ${RED}Docker image build failed — sub-scripts will rebuild individually${RESET}"
    fi
    echo ""
}

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
    # Sub-commands piped through tee lose isatty() detection.
    # FORCE_COLOR tells them to emit ANSI codes anyway.
    export FORCE_COLOR=1
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

# Pre-build if any Docker-dependent suite will run
NEEDS_DOCKER=false
for i in 2 3; do should_run "$i" && NEEDS_DOCKER=true && break; done
if [ "$NEEDS_DOCKER" = true ]; then
    prebuild_docker_images
fi

# ---------------------------------------------------------------------------
# State tracking
# ---------------------------------------------------------------------------
RESULTS=()
EXIT_CODE=0

# ---------------------------------------------------------------------------
# Suite output capture (for grand summary + HTML report)
# ---------------------------------------------------------------------------
SUITE_OUTPUT_DIR=$(mktemp -d /tmp/dina-suite-output-XXXXXX)

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
    local suite_log="$SUITE_OUTPUT_DIR/suite_${num}.log"
    "$@" 2>&1 | tee "$suite_log"
    local rc=${PIPESTATUS[0]}
    local elapsed=$(( SECONDS - start ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))

    if [ $rc -eq 0 ]; then
        RESULTS+=("${GREEN}PASS${RESET}  [${SUITE_COUNTER}] $name  (${mins}m${secs}s)")
    else
        RESULTS+=("${RED}FAIL${RESET}  [${SUITE_COUNTER}] $name  (${mins}m${secs}s)")
        EXIT_CODE=1
    fi

    # Write metadata for report generation
    local passed_bool="true"
    [ $rc -ne 0 ] && passed_bool="false"
    printf '{"number":%d,"name":"%s","elapsed_s":%d,"passed":%s}\n' \
        "$num" "$name" "$elapsed" "$passed_bool" \
        > "$SUITE_OUTPUT_DIR/suite_${num}.meta.json"

    return $rc
}

generate_report() {
    if [ -d "$SUITE_OUTPUT_DIR" ]; then
        python3 scripts/generate_test_report.py \
            "$SUITE_OUTPUT_DIR" \
            $(( SECONDS - TOTAL_START )) \
            2>/dev/null || true
    fi
}

handle_failure() {
    local suite_counter="$1"
    collect_llm_cost
    # Wait for background Group B and print its output before exiting
    drain_group_b
    echo -e "\n${RED}Suite ${suite_counter} failed. Stopping. Use --continue to run all suites.${RESET}"
    print_summary
    generate_report
    exit 1
}

# drain_group_b: wait for background AppView suites and print their buffered output.
# Safe to call multiple times (clears PID after first call).
drain_group_b() {
    if [ -n "$GROUP_B_PID" ]; then
        wait $GROUP_B_PID || true
        GROUP_B_PID=""

        if [ -s "$GROUP_B_OUTPUT" ]; then
            echo ""
            echo -e "${DIM}  ── AppView suite output (ran in parallel) ──${RESET}"
            cat "$GROUP_B_OUTPUT"
        fi

        while IFS='|' read -r status name elapsed_str; do
            [ -z "$status" ] && continue
            if [ "$status" = "PASS" ]; then
                RESULTS+=("${GREEN}PASS${RESET}  $name  ($elapsed_str)")
            else
                RESULTS+=("${RED}FAIL${RESET}  $name  ($elapsed_str)")
                EXIT_CODE=1
            fi
        done < "$GROUP_B_RESULTS"
    fi
}

# ---------------------------------------------------------------------------
# Parallel execution: independent suites run concurrently.
#   Group A (Python — shares local Go/Brain + Docker):  1, 2, 3 (sequential)
#   Group B (TypeScript — npm, no Docker overlap):      4, 5 (sequential)
# Groups A and B run in parallel.  Group B output is buffered and printed
# in order after Group A finishes, so the terminal stays readable.
# ---------------------------------------------------------------------------

# Temp files for Group B communication
GROUP_B_OUTPUT=$(mktemp /tmp/dina-group-b-output-XXXXXX)
GROUP_B_RESULTS=$(mktemp /tmp/dina-group-b-results-XXXXXX)

# run_suite_bg: like run_suite but writes result to a file (for background use)
run_suite_bg() {
    local result_file="$1"
    shift
    local num="$1"
    local name="$2"
    shift 2

    echo ""
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}  $name${RESET}"
    echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
    echo ""

    local start=$SECONDS
    local suite_log="$SUITE_OUTPUT_DIR/suite_${num}.log"
    "$@" 2>&1 | tee "$suite_log"
    local rc=${PIPESTATUS[0]}
    local elapsed=$(( SECONDS - start ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))

    if [ $rc -eq 0 ]; then
        echo "PASS|$name|${mins}m${secs}s" >> "$result_file"
    else
        echo "FAIL|$name|${mins}m${secs}s" >> "$result_file"
    fi

    # Write metadata for report generation
    local passed_bool="true"
    [ $rc -ne 0 ] && passed_bool="false"
    printf '{"number":%d,"name":"%s","elapsed_s":%d,"passed":%s}\n' \
        "$num" "$name" "$elapsed" "$passed_bool" \
        > "$SUITE_OUTPUT_DIR/suite_${num}.meta.json"

    return $rc
}

# Determine which groups have work
GROUP_A_HAS_WORK=false
GROUP_B_HAS_WORK=false
for i in 1 2 3; do should_run "$i" && GROUP_A_HAS_WORK=true && break; done
for i in 4 5;   do should_run "$i" && GROUP_B_HAS_WORK=true && break; done

# --- Launch Group B in background (output buffered to file) ---
GROUP_B_PID=""
GROUP_B_LAUNCHED=false
if [ "$GROUP_B_HAS_WORK" = true ] && [ "$GROUP_A_HAS_WORK" = true ]; then
    GROUP_B_LAUNCHED=true
    echo -e "\n${DIM}  Running Python suites and AppView suites in parallel...${RESET}\n"
    (
        if should_run 4; then
            run_suite_bg "$GROUP_B_RESULTS" 4 "AppView Unit Tests" \
                bash -c "cd appview && npx tsx test_appview.ts --suite unit" || true
        fi
        if should_run 5; then
            run_suite_bg "$GROUP_B_RESULTS" 5 "AppView Integration Tests" \
                bash -c "cd appview && npx tsx test_appview.ts --suite integration --restart" || true
        fi
    ) > "$GROUP_B_OUTPUT" 2>&1 &
    GROUP_B_PID=$!
fi

# --- Group A: foreground (sequential: 1 → 2 → 3) ---
if should_run 1; then
    if ! run_suite 1 "Integration Tests" \
        python3 scripts/test_status.py --restart; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
    collect_llm_cost
fi

if should_run 2; then
    if ! run_suite 2 "User Story Tests" \
        ./run_user_story_tests.sh --brief; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
    collect_llm_cost
fi

if should_run 3; then
    if ! run_suite 3 "Release Tests" \
        python3 scripts/test_release.py; then
        if [ "$STOP_ON_FAIL" = true ]; then
            handle_failure $SUITE_COUNTER
        fi
    fi
    collect_llm_cost
fi

# --- Wait for Group B and print its buffered output in order ---
drain_group_b

if [ "$GROUP_B_LAUNCHED" = false ] && [ "$GROUP_B_HAS_WORK" = true ]; then
    # Group B wasn't launched in parallel — run in foreground now
    if should_run 4; then
        if ! run_suite 4 "AppView Unit Tests" \
            bash -c "cd appview && npx tsx test_appview.ts --suite unit"; then
            if [ "$STOP_ON_FAIL" = true ]; then
                handle_failure $SUITE_COUNTER
            fi
        fi
    fi
    if should_run 5; then
        if ! run_suite 5 "AppView Integration Tests" \
            bash -c "cd appview && npx tsx test_appview.ts --suite integration --restart"; then
            if [ "$STOP_ON_FAIL" = true ]; then
                handle_failure $SUITE_COUNTER
            fi
        fi
    fi
fi

rm -f "$GROUP_B_OUTPUT" "$GROUP_B_RESULTS" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Docker cleanup: tear down all isolated project stacks we may have started.
# Each stack uses a unique project name so this is safe and targeted.
# ---------------------------------------------------------------------------
cleanup_docker() {
    echo -e "\n${DIM}  Cleaning up Docker stacks...${RESET}"
    for project in dina-release dina-e2e dina-main; do
        docker compose -p "$project" down -v --remove-orphans 2>/dev/null || true
    done
    # User story stacks use dina-system-{id} — clean any leftover.
    for proj in $(docker compose ls -q 2>/dev/null | grep '^dina-system-' || true); do
        docker compose -p "$proj" down -v --remove-orphans 2>/dev/null || true
    done
}

# Run cleanup on exit (success or failure) to avoid stale containers.
trap cleanup_docker EXIT

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary
generate_report
rm -rf "$LLM_COST_DIR" 2>/dev/null || true
rm -rf "$SUITE_OUTPUT_DIR" 2>/dev/null || true
exit $EXIT_CODE
