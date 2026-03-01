#!/usr/bin/env bash
# ============================================================================
# Dina User Story Tests — proving the value proposition end-to-end.
# ============================================================================
#
# Four user stories, each demonstrating a capability no other system has.
# Every test runs against a real multi-node stack: Go Core, Python Brain,
# AT Protocol PDS, AppView, Postgres — zero mocks.
#
# Requires:
#   Docker          — full system stack (2 Core+Brain, PDS, AppView, Postgres)
#   GOOGLE_API_KEY  — optional, for real LLM reasoning tests
#
# Usage:
#   ./run_user_story_tests.sh                          # verbose (default)
#   ./run_user_story_tests.sh --brief                  # banner + results only
#   GOOGLE_API_KEY=<key> ./run_user_story_tests.sh     # with LLM tests
#   ./run_user_story_tests.sh -k "sancho"              # single story
#   SYSTEM_RESTART=0 ./run_user_story_tests.sh         # reuse containers
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# -- Parse --brief flag --
BRIEF=false
PYTEST_ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--brief" ]; then
        BRIEF=true
    else
        PYTEST_ARGS+=("$arg")
    fi
done

# -- Colors (if terminal supports them) --
if [ -t 1 ]; then
    BOLD="\033[1m"
    DIM="\033[2m"
    CYAN="\033[36m"
    GREEN="\033[32m"
    YELLOW="\033[33m"
    RED="\033[31m"
    WHITE="\033[37m"
    ITALIC="\033[3m"
    RESET="\033[0m"
else
    BOLD="" DIM="" CYAN="" GREEN="" YELLOW="" RED="" WHITE="" ITALIC="" RESET=""
fi

# -- Banner helper --
B="${BOLD}${CYAN}"  # box color
R="${RESET}"
D="${DIM}"
I="${ITALIC}"
G="${GREEN}"
Y="${YELLOW}"

# Box layout: 2 leading spaces + ║ + 100 inner + ║ = 104 display columns
# Border:     2 leading spaces + ╔ + 100 ═ chars + ╗ = 104 display columns

print_banner() {
    # Args: $1=s01_result  $2=s02_result  $3=s03_result  $4=s04_result  (empty if not run yet)
    local s01="${1:-}" s02="${2:-}" s03="${3:-}" s04="${4:-}"

    # Box: 2 leading spaces + ║ + 100 inner + ║ = 104 display columns
    echo -e "${B}  ╔════════════════════════════════════════════════════════════════════════════════════════════════════╗${R}"
    echo -e "${B}  ║${R}${BOLD}     DINA User Story Tests                                                                          ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Stack: 2x Go Core + 2x Python Brain + PDS + AppView + Postgres + SQLCipher -- zero mocks       ${B}║${R}"
    echo -e "${B}  ╠════════════════════════════════════════════════════════════════════════════════════════════════════╣${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 01 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}01${R} ${BOLD}The Purchase Journey${R}"
    if [ -n "$s01" ]; then printf "%73s" "$s01"; else printf "%73s" "13 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}\"I need a chair\"${R}${D} -> 5 reviewers created (3 verified Ring 2, 2 unverified Ring 1)               ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Dina checks health vault (back pain, needs lumbar), finance vault (budget 10-20K INR)          ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Trust-weighted reviews: skip CheapChair (low trust score), recommends ErgoMax Elite            ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 02 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}02${R} ${BOLD}The Sancho Moment${R}"
    if [ -n "$s02" ]; then printf "%76s" "$s02"; else printf "%76s" "7 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}Sancho arrives${R}${D} -> Sancho's Dina contacts your Dina (D2D encrypted, Ed25519 signed)             ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Your Dina searches vault by Sancho's DID, finds: \"his mother had a fall\", \"likes cardamom tea\" ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Nudge: \"Sancho 15 min away. Ask about his sick mother. Make cardamom tea.\"                     ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 03 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}03${R} ${BOLD}The Dead Internet Filter${R}"
    if [ -n "$s03" ]; then printf "%69s" "$s03"; else printf "%69s" "8 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}\"Is this video AI?\"${R}${D} -> Dina resolves creator DID via AT Protocol Trust Network                 ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Elena (Ring 3): 200 attestations, 15 peer vouches, 2yr history -> \"authentic, trusted creator\" ${B}║${R}"
    echo -e "${B}  ║${R}${D}     BotFarm (Ring 1): 0 attestations, 3-day-old account -> \"unverified, check other sources\"       ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 04 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}04${R} ${BOLD}The License Renewal${R}"
    if [ -n "$s04" ]; then printf "%74s" "$s04"; else printf "%74s" "10 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}User uploads license scan${R}${D} -> Brain LLM extracts fields with per-field confidence scores        ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Deterministic reminder fires 30 days before expiry (no LLM). Brain composes contextual nudge   ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Delegation: Brain generates strict JSON for RTO_Bot. Guardian flags for human review           ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"
    echo -e "${B}  ╚════════════════════════════════════════════════════════════════════════════════════════════════════╝${R}"
}

# -- Format result string with color --
format_result() {
    local passed=$1 total=$2
    if [ "$passed" -eq "$total" ]; then
        echo -e "${GREEN}${BOLD}${passed}/${total} passed${R}"
    else
        echo -e "${RED}${BOLD}${passed}/${total} passed${R}"
    fi
}

# ============================================================================
# Brief mode: run quietly, show banner with results
# ============================================================================
if [ "$BRIEF" = true ]; then

    # Show "running..." while tests execute
    echo ""
    echo -e "  ${DIM}Running tests...${R}"

    # Run pytest with verbose to capture PASSED/FAILED/SKIPPED per test
    TMPFILE=$(mktemp)
    python -m pytest tests/system/user_stories/ \
        -v --tb=no --no-header \
        ${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"} > "$TMPFILE" 2>&1 || true

    OUTPUT=$(cat "$TMPFILE")
    rm -f "$TMPFILE"

    # Parse per-file results from pytest -v output
    s01_passed=$(echo "$OUTPUT" | grep -c "test_01_purchase_journey.*PASSED" || true)
    s01_failed=$(echo "$OUTPUT" | grep -c "test_01_purchase_journey.*FAILED" || true)
    s01_skipped=$(echo "$OUTPUT" | grep -c "test_01_purchase_journey.*SKIPPED" || true)
    s01_total=$((s01_passed + s01_failed + s01_skipped))

    s02_passed=$(echo "$OUTPUT" | grep -c "test_02_sancho_moment.*PASSED" || true)
    s02_failed=$(echo "$OUTPUT" | grep -c "test_02_sancho_moment.*FAILED" || true)
    s02_skipped=$(echo "$OUTPUT" | grep -c "test_02_sancho_moment.*SKIPPED" || true)
    s02_total=$((s02_passed + s02_failed + s02_skipped))

    s03_passed=$(echo "$OUTPUT" | grep -c "test_03_dead_internet.*PASSED" || true)
    s03_failed=$(echo "$OUTPUT" | grep -c "test_03_dead_internet.*FAILED" || true)
    s03_skipped=$(echo "$OUTPUT" | grep -c "test_03_dead_internet.*SKIPPED" || true)
    s03_total=$((s03_passed + s03_failed + s03_skipped))

    s04_passed=$(echo "$OUTPUT" | grep -c "test_04_license_renewal.*PASSED" || true)
    s04_failed=$(echo "$OUTPUT" | grep -c "test_04_license_renewal.*FAILED" || true)
    s04_skipped=$(echo "$OUTPUT" | grep -c "test_04_license_renewal.*SKIPPED" || true)
    s04_total=$((s04_passed + s04_failed + s04_skipped))

    # Clear "Running tests..." line
    echo -e "\033[2A\033[J"

    # Build result strings
    if [ "$s01_total" -gt 0 ]; then
        s01_r=$(format_result "$s01_passed" "$s01_total")
    else s01_r=""; fi
    if [ "$s02_total" -gt 0 ]; then
        s02_r=$(format_result "$s02_passed" "$s02_total")
    else s02_r=""; fi
    if [ "$s03_total" -gt 0 ]; then
        s03_r=$(format_result "$s03_passed" "$s03_total")
    else s03_r=""; fi
    if [ "$s04_total" -gt 0 ]; then
        s04_r=$(format_result "$s04_passed" "$s04_total")
    else s04_r=""; fi

    print_banner "$s01_r" "$s02_r" "$s03_r" "$s04_r"

    # Overall summary
    total_passed=$((s01_passed + s02_passed + s03_passed + s04_passed))
    total_all=$((s01_total + s02_total + s03_total + s04_total))
    total_failed=$((s01_failed + s02_failed + s03_failed + s04_failed))
    total_skipped=$((s01_skipped + s02_skipped + s03_skipped + s04_skipped))
    echo ""
    if [ "$total_failed" -eq 0 ] && [ "$total_all" -gt 0 ]; then
        echo -e "  ${GREEN}${BOLD}${total_passed}/${total_all} passed${R}"
        if [ "$total_skipped" -gt 0 ]; then
            echo -e "  ${DIM}${total_skipped} skipped (set GOOGLE_API_KEY for LLM tests)${R}"
        fi
        echo -e "  ${DIM}Zero mocks. Real stack. Real crypto. Real trust.${R}"
    elif [ "$total_all" -gt 0 ]; then
        echo -e "  ${RED}${BOLD}${total_failed} failed${R}, ${total_passed}/${total_all} passed  ${DIM}-- run without --brief for details${R}"
    else
        echo -e "  ${YELLOW}No tests collected.${R}"
    fi
    echo ""

    [ "$total_failed" -eq 0 ] && exit 0 || exit 1
fi

# ============================================================================
# Verbose mode (default): show banner, then full pytest output
# ============================================================================
print_banner "" "" "" ""

# -- API key notice --
if [ -z "${GOOGLE_API_KEY:-}" ]; then
    echo ""
    echo -e "  ${YELLOW}Note:${RESET} GOOGLE_API_KEY not set -- LLM reasoning tests will be skipped."
    echo -e "  ${DIM}Set it to run the full demo including personalized advice generation.${RESET}"
fi

echo ""

# -- Run tests --
python -m pytest tests/system/user_stories/ \
    -v --tb=long -s \
    --no-header \
    ${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"}

EXIT_CODE=$?

# -- Summary --
echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}All stories passed.${RESET}  ${DIM}Zero mocks. Real stack. Real crypto. Real trust.${RESET}"
else
    echo -e "  ${RED}${BOLD}Some tests failed.${RESET}  ${DIM}Run with --tb=long for details.${RESET}"
fi
echo ""

exit $EXIT_CODE
