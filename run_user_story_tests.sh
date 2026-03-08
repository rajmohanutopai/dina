#!/usr/bin/env bash
# ============================================================================
# Dina User Story Tests — proving the value proposition end-to-end.
# ============================================================================
#
# Ten user stories, each demonstrating a capability no other system has.
# Every test runs against a real multi-node stack: Go Core, Python Brain,
# AT Protocol PDS, AppView, Postgres — zero mocks.
#
# Each run gets a 3-char session ID (e.g. AzA) and auto-allocated ports,
# so multiple runs can execute in parallel without conflicts.
#
# Requires:
#   Docker          — full system stack (2 Core+Brain, PDS, AppView, Postgres)
#   GOOGLE_API_KEY  — optional, for real LLM reasoning tests
#
# Usage:
#   ./run_user_story_tests.sh                          # sanity (default, skips Stories 06-10)
#   ./run_user_story_tests.sh --all                    # all 10 stories
#   ./run_user_story_tests.sh --brief                  # all 10 stories, banner + results only
#   ./run_user_story_tests.sh --all --brief            # same as --brief
#   ./run_user_story_tests.sh --story 5                # run only Story 05 (verbose)
#   ./run_user_story_tests.sh --story 5 --brief        # run only Story 05 (brief)
#   ./run_user_story_tests.sh --list                   # list all stories
#   GOOGLE_API_KEY=<key> ./run_user_story_tests.sh     # with LLM tests
#   ./run_user_story_tests.sh -k "sancho"              # single story (pytest -k filter)
#   SYSTEM_RESTART=0 ./run_user_story_tests.sh         # reuse containers
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# Activate venv if present and not already active
if [ -z "${VIRTUAL_ENV:-}" ] && [ -f .venv/bin/activate ]; then
    # shellcheck disable=SC1091
    source .venv/bin/activate
fi

# ---------------------------------------------------------------------------
# Session ID + port allocation
# ---------------------------------------------------------------------------

# Generate 3-char session ID for Docker project isolation.
# Port allocation is handled by conftest.py (auto-scans for free ports,
# retries on conflict — no TOCTOU race).
SESSION_ID="${DINA_TEST_SESSION:-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 3 || true)}"
export COMPOSE_PROJECT_NAME="dina-system-${SESSION_ID}"
# conftest.py reads PORT_CORE_ALONSO as starting hint; defaults to 19300.
PORT_BASE="${DINA_TEST_PORT_BASE:-19300}"
export PORT_CORE_ALONSO="$PORT_BASE"

# -- Parse flags --
BRIEF=false
MODE="sanity"
STORY=""
PYTEST_ARGS=()
SKIP_NEXT=false
for i in "$@"; do
    if [ "$SKIP_NEXT" = true ]; then
        SKIP_NEXT=false
        continue
    fi
    case "$i" in
        --brief)  BRIEF=true ;;
        --all)    MODE="all" ;;
        --sanity) MODE="sanity" ;;
        --list)
            echo ""
            echo "  Available stories:"
            echo ""
            echo "    1  The Purchase Journey     (13 tests)  — trust-weighted product search"
            echo "    2  The Sancho Moment          (7 tests)  — D2D messaging + contextual nudge"
            echo "    3  The Dead Internet Filter    (8 tests)  — AT Protocol trust verification"
            echo "    4  The Persona Wall           (11 tests)  — cross-persona access control"
            echo "    5  The Agent Gateway          (10 tests)  — external agent safety layer"
            echo "    6  The License Renewal        (10 tests)  — LLM extraction + deterministic scheduling"
            echo "    7  The Daily Briefing          (5 tests)  — silence-first notification triage"
            echo "    8  Move to a New Machine       (5 tests)  — data portability & DID stability"
            echo "    9  Connector Credential Expiry (5 tests)  — graceful degradation & recovery"
            echo "   10  The Operator Journey        (5 tests)  — bootstrap idempotency & admin lifecycle"
            echo ""
            echo "  Usage: ./run_user_story_tests.sh --story 5"
            echo ""
            exit 0
            ;;
        --story)
            # Next arg is the story number
            SKIP_NEXT=true
            ;;
        *)
            PYTEST_ARGS+=("$i")
            ;;
    esac
done
# Second pass to extract --story value (bash positional parsing)
SKIP_NEXT=false
for i in "$@"; do
    if [ "$SKIP_NEXT" = true ]; then
        STORY="$i"
        SKIP_NEXT=false
        continue
    fi
    if [ "$i" = "--story" ]; then
        SKIP_NEXT=true
    fi
done

# -- Map --story N to the correct test file --
STORY_FILE=""
if [ -n "$STORY" ]; then
    MODE="all"  # don't apply sanity filter when running a single story
    case "$STORY" in
        1|01) STORY_FILE="tests/system/user_stories/test_01_purchase_journey.py" ;;
        2|02) STORY_FILE="tests/system/user_stories/test_02_sancho_moment.py" ;;
        3|03) STORY_FILE="tests/system/user_stories/test_03_dead_internet_filter.py" ;;
        4|04) STORY_FILE="tests/system/user_stories/test_04_persona_wall.py" ;;
        5|05) STORY_FILE="tests/system/user_stories/test_05_agent_gateway.py" ;;
        6|06) STORY_FILE="tests/system/user_stories/test_06_license_renewal.py" ;;
        7|07) STORY_FILE="tests/system/user_stories/test_07_daily_briefing.py" ;;
        8|08) STORY_FILE="tests/system/user_stories/test_08_move_to_new_machine.py" ;;
        9|09) STORY_FILE="tests/system/user_stories/test_09_connector_expiry.py" ;;
        10)   STORY_FILE="tests/system/user_stories/test_10_operator_journey.py" ;;
        *)
            echo "Error: --story must be 1-10 (got: $STORY)"
            exit 1
            ;;
    esac
fi

# In sanity mode (verbose, non-brief), skip Stories 06-10 unless user passed -k.
# Brief mode always runs all stories regardless of MODE.
if [ "$MODE" = "sanity" ] && [ "$BRIEF" = false ]; then
    has_k=false
    for arg in "${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"}"; do
        if [ "$arg" = "-k" ]; then has_k=true; break; fi
    done
    if [ "$has_k" = false ]; then
        PYTEST_ARGS+=("-k" "not (test_06_license_renewal or test_07_daily_briefing or test_08_move_to_new_machine or test_09_connector_expiry or test_10_operator_journey)")
    fi
fi

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
    # Args: $1=s01_result .. $10=s10_result  (empty if not run yet)
    local s01="${1:-}" s02="${2:-}" s03="${3:-}" s04="${4:-}" s05="${5:-}" s06="${6:-}"
    local s07="${7:-}" s08="${8:-}" s09="${9:-}" s10="${10:-}"

    local mode_label=""
    if [ -n "$STORY" ]; then
        mode_label="  ${DIM}(--story ${STORY} — running only Story $(printf '%02d' "$STORY"))${R}"
    elif [ "$MODE" = "sanity" ] && [ "$BRIEF" = false ]; then
        mode_label="  ${DIM}(sanity — use --all or --brief for Stories 06-10)${R}"
    fi

    # Box: 2 leading spaces + ║ + 100 inner + ║ = 104 display columns
    echo -e "${B}  ╔════════════════════════════════════════════════════════════════════════════════════════════════════╗${R}"
    echo -e "${B}  ║${R}${BOLD}     DINA User Story Tests                                                                          ${B}║${R}"
    printf "  ${B}║${R}${D}     Stack: 2x Go Core + 2x Python Brain + PDS + AppView + Postgres -- session %-4s ports %s+     ${B}║${R}\n" "${SESSION_ID}" "${PORT_BASE}"
    echo -e "${B}  ╠════════════════════════════════════════════════════════════════════════════════════════════════════╣${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 01 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}01${R} ${BOLD}The Purchase Journey${R}"
    if [ -n "$s01" ]; then printf "%86s" "$s01"; else printf "%73s" "13 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}\"I need a chair\"${R}${D} -> 5 reviewers created (3 verified Ring 2, 2 unverified Ring 1)               ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Dina checks health vault (back pain, needs lumbar), finance vault (budget 10-20K INR)          ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Trust-weighted reviews: skip CheapChair (low trust score), recommends ErgoMax Elite            ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 02 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}02${R} ${BOLD}The Sancho Moment${R}"
    if [ -n "$s02" ]; then printf "%89s" "$s02"; else printf "%76s" "7 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}Sancho arrives${R}${D} -> Sancho's Dina contacts your Dina (D2D encrypted, Ed25519 signed)             ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Your Dina searches vault by Sancho's DID, finds: \"his mother had a fall\", \"likes cardamom tea\" ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Nudge: \"Sancho 15 min away. Ask about his sick mother. Make cardamom tea.\"                     ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 03 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}03${R} ${BOLD}The Dead Internet Filter${R}"
    if [ -n "$s03" ]; then printf "%82s" "$s03"; else printf "%69s" "8 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}\"Is this video AI?\"${R}${D} -> Dina resolves creator DID via AT Protocol Trust Network                 ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Elena (Ring 3): 200 attestations, 15 peer vouches, 2yr history -> \"authentic, trusted creator\" ${B}║${R}"
    echo -e "${B}  ║${R}${D}     BotFarm (Ring 1): 0 attestations, 3-day-old account -> \"unverified, check other sources\"       ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 04 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}04${R} ${BOLD}The Persona Wall${R}"
    if [ -n "$s04" ]; then printf "%90s" "$s04"; else printf "%77s" "11 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}Shopping agent asks \"any health conditions?\"${R}${D} -> Guardian blocks cross-persona access           ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Health (restricted): \"L4-L5 herniation\" withheld. Proposes \"chronic back pain\" only            ${B}║${R}"
    echo -e "${B}  ║${R}${D}     User approves minimal disclosure. PII scrubber confirms no diagnosis leaked                    ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Story 05 ──────────────────────────────────────────────────────────
    printf "  ${B}║${R}  ${G}05${R} ${BOLD}The Agent Gateway${R}"
    if [ -n "$s05" ]; then printf "%89s" "$s05"; else printf "%76s" "10 tests"; fi
    echo -e "  ${B}║${R}"
    echo -e "${B}  ║${R}     ${BOLD}OpenClaw/Perplexity Computer wants to send email${R}${D} -> pairs with Home Node, asks Dina first      ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Dina checks: safe? matches your rules? PII leaking? \"send_email\" -> MODERATE, asks you first   ${B}║${R}"
    echo -e "${B}  ║${R}${D}     Safe tasks (web search) pass silently. Rogue agent with no auth -> 401, blocked at the gate    ${B}║${R}"
    echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

    # ── Stories 06-10 (shown in --all mode or --brief mode) ─────────────
    if [ "$MODE" = "all" ] || [ "$BRIEF" = true ]; then
        printf "  ${B}║${R}  ${G}06${R} ${BOLD}The License Renewal${R}"
        if [ -n "$s06" ]; then printf "%87s" "$s06"; else printf "%74s" "10 tests"; fi
        echo -e "  ${B}║${R}"
        echo -e "${B}  ║${R}     ${BOLD}User uploads license scan${R}${D} -> Brain LLM extracts fields with per-field confidence scores        ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Deterministic reminder fires 30 days before expiry (no LLM). Brain composes contextual nudge   ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Delegation: Brain generates strict JSON for RTO_Bot. Guardian flags for human review           ${B}║${R}"
        echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

        # ── Story 07 ──────────────────────────────────────────────────────────
        printf "  ${B}║${R}  ${G}07${R} ${BOLD}The Daily Briefing${R}"
        if [ -n "$s07" ]; then printf "%88s" "$s07"; else printf "%75s" "5 tests"; fi
        echo -e "  ${B}║${R}"
        echo -e "${B}  ║${R}     ${BOLD}Noise all day, one calm summary${R}${D} -> Tier 3 events queued silently in vault KV                   ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Fiduciary event (transfer_money) interrupts immediately — silence would cause harm              ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Daily briefing retrieves queued items, clears queue. Silence First enforced by design           ${B}║${R}"
        echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

        # ── Story 08 ──────────────────────────────────────────────────────────
        printf "  ${B}║${R}  ${G}08${R} ${BOLD}Move to a New Machine${R}"
        if [ -n "$s08" ]; then printf "%85s" "$s08"; else printf "%72s" "5 tests"; fi
        echo -e "  ${B}║${R}"
        echo -e "${B}  ║${R}     ${BOLD}Laptop dying, move Dina${R}${D} -> vault data exportable, DID stable across machines                  ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Node B operates independently: own DID (same method), vault store/query works                  ${B}║${R}"
        echo -e "${B}  ║${R}${D}     YOUR data, YOUR identity, YOUR machine. Google has nothing to do with it                      ${B}║${R}"
        echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

        # ── Story 09 ──────────────────────────────────────────────────────────
        printf "  ${B}║${R}  ${G}09${R} ${BOLD}Connector Credential Expiry${R}"
        if [ -n "$s09" ]; then printf "%79s" "$s09"; else printf "%66s" "5 tests"; fi
        echo -e "  ${B}║${R}"
        echo -e "${B}  ║${R}     ${BOLD}Gmail OAuth expires${R}${D} -> connector status: expired. Vault, identity fully operational            ${B}║${R}"
        echo -e "${B}  ║${R}${D}     User reconfigures credentials -> connector resumes. No cascade, no crash                      ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Isolation guarantee: one connector down, everything else still works                           ${B}║${R}"
        echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"

        # ── Story 10 ──────────────────────────────────────────────────────────
        printf "  ${B}║${R}  ${G}10${R} ${BOLD}The Operator Journey${R}"
        if [ -n "$s10" ]; then printf "%86s" "$s10"; else printf "%73s" "5 tests"; fi
        echo -e "  ${B}║${R}"
        echo -e "${B}  ║${R}     ${BOLD}Re-run install script${R}${D} -> DID unchanged (idempotent). No rotation, no orphaned data             ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Lock vault for maintenance: health endpoint still accessible. Unlock: operations resume        ${B}║${R}"
        echo -e "${B}  ║${R}${D}     Identity is derived from master seed — immutable after bootstrap, stable across lifecycle      ${B}║${R}"
        echo -e "${B}  ║${R}                                                                                                    ${B}║${R}"
    fi
    echo -e "${B}  ╚════════════════════════════════════════════════════════════════════════════════════════════════════╝${R}"

    if [ -n "$mode_label" ]; then
        echo -e "$mode_label"
    fi
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

    # Log directory for grouped test output
    LOG_DIR="/tmp/dina-user-story-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$LOG_DIR"

    # Run pytest with verbose + short tracebacks to capture failure details.
    # Port conflicts are handled inside conftest.py (auto re-allocation).
    TEST_PATH="${STORY_FILE:-tests/system/user_stories/}"
    python -m pytest "$TEST_PATH" \
        -v --tb=short --no-header \
        ${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"} > "$LOG_DIR/raw_pytest.log" 2>&1 || true

    OUTPUT=$(cat "$LOG_DIR/raw_pytest.log")

    # Generate grouped log file from pytest output
    python3 -c "
import re, sys, os
from datetime import datetime
from collections import OrderedDict

raw = open('$LOG_DIR/raw_pytest.log').read()
lines = raw.splitlines()

# Story metadata
STORIES = {
    '01': 'The Purchase Journey',
    '02': 'The Sancho Moment',
    '03': 'The Dead Internet Filter',
    '04': 'The Persona Wall',
    '05': 'The Agent Gateway',
    '06': 'The License Renewal',
    '07': 'The Daily Briefing',
    '08': 'Move to a New Machine',
    '09': 'Connector Credential Expiry',
    '10': 'The Operator Journey',
}

# Parse per-test results from verbose lines
# Format: tests/system/.../test_0X_name.py::test_0X_YY_name PASSED/FAILED/SKIPPED/ERROR
test_results = OrderedDict()  # story_num -> [(test_name, status)]
result_re = re.compile(r'(test_(\d{2})_\w+\.py)::(\S+)\s+(PASSED|FAILED|SKIPPED|ERROR)')
for line in lines:
    m = result_re.search(line)
    if m:
        story = m.group(2)
        test_name = m.group(3)
        status = m.group(4)
        test_results.setdefault(story, []).append((test_name, status))

# Parse failure tracebacks from FAILURES section
# Header format: ___ TestClass.test_name ___ (with dots and spaces)
failures = {}  # test_name -> traceback_text
in_failures = False
current_test = None
current_lines = []

for line in lines:
    if '= FAILURES =' in line or '= ERRORS =' in line:
        in_failures = True
        continue
    if in_failures and line.startswith('='):
        if current_test:
            failures[current_test] = '\n'.join(current_lines)
        in_failures = False
        continue
    if in_failures:
        header = re.match(r'^_+ (.+?) _+$', line)
        if header:
            if current_test:
                failures[current_test] = '\n'.join(current_lines)
            # Normalize 'TestClass.test_name' to 'TestClass::test_name'
            current_test = header.group(1).strip().replace('.', '::')
            current_lines = []
        elif current_test is not None:
            current_lines.append(line)
if current_test and current_test not in failures:
    failures[current_test] = '\n'.join(current_lines)

# Write grouped log
log_path = '$LOG_DIR/grouped.log'
with open(log_path, 'w') as f:
    f.write('=' * 80 + '\n')
    f.write(f'DINA User Story Test Log — {datetime.now():%Y-%m-%d %H:%M:%S}\n')
    f.write('=' * 80 + '\n\n')

    for story_num in sorted(test_results.keys()):
        results = test_results[story_num]
        name = STORIES.get(story_num, 'Unknown')
        passed = sum(1 for _, s in results if s == 'PASSED')
        failed = sum(1 for _, s in results if s == 'FAILED')
        errored = sum(1 for _, s in results if s == 'ERROR')
        skipped = sum(1 for _, s in results if s == 'SKIPPED')
        total = len(results)

        status_parts = []
        if passed: status_parts.append(f'{passed} passed')
        if failed: status_parts.append(f'{failed} failed')
        if errored: status_parts.append(f'{errored} errors')
        if skipped: status_parts.append(f'{skipped} skipped')

        f.write(f'Story {story_num}: {name} ({total} tests: {\", \".join(status_parts)})\n')
        f.write('-' * 80 + '\n\n')

        for test_name, status in results:
            if status == 'PASSED':
                icon = 'PASS'
            elif status == 'FAILED':
                icon = 'FAIL'
            elif status == 'ERROR':
                icon = 'ERR '
            else:
                icon = 'SKIP'
            f.write(f'  [{icon}]  {test_name}\n')

            # Append failure details inline
            if status in ('FAILED', 'ERROR') and test_name in failures:
                tb = failures[test_name].rstrip()
                for tb_line in tb.splitlines():
                    f.write(f'         {tb_line}\n')
                f.write('\n')

        f.write('\n')

    # Grand total
    all_tests = [(t, s) for results in test_results.values() for t, s in results]
    tp = sum(1 for _, s in all_tests if s == 'PASSED')
    tf = sum(1 for _, s in all_tests if s == 'FAILED')
    te = sum(1 for _, s in all_tests if s == 'ERROR')
    ts = sum(1 for _, s in all_tests if s == 'SKIPPED')
    f.write('=' * 80 + '\n')
    f.write(f'Total: {len(all_tests)} tests — {tp} passed, {tf} failed, {te} errors, {ts} skipped\n')
    f.write('=' * 80 + '\n')
" 2>/dev/null || true

    # Parse per-file results from pytest -v output
    s01_passed=$(echo "$OUTPUT" | grep -c "test_01_purchase_journey.*PASSED" || true)
    s01_failed=$(echo "$OUTPUT" | grep -c "test_01_purchase_journey.*FAILED" || true)
    s01_errored=$(echo "$OUTPUT" | grep -c "test_01_purchase_journey.* ERROR" || true)
    s01_skipped=$(echo "$OUTPUT" | grep -c "test_01_purchase_journey.*SKIPPED" || true)
    s01_total=$((s01_passed + s01_failed + s01_errored + s01_skipped))

    s02_passed=$(echo "$OUTPUT" | grep -c "test_02_sancho_moment.*PASSED" || true)
    s02_failed=$(echo "$OUTPUT" | grep -c "test_02_sancho_moment.*FAILED" || true)
    s02_errored=$(echo "$OUTPUT" | grep -c "test_02_sancho_moment.* ERROR" || true)
    s02_skipped=$(echo "$OUTPUT" | grep -c "test_02_sancho_moment.*SKIPPED" || true)
    s02_total=$((s02_passed + s02_failed + s02_errored + s02_skipped))

    s03_passed=$(echo "$OUTPUT" | grep -c "test_03_dead_internet.*PASSED" || true)
    s03_failed=$(echo "$OUTPUT" | grep -c "test_03_dead_internet.*FAILED" || true)
    s03_errored=$(echo "$OUTPUT" | grep -c "test_03_dead_internet.* ERROR" || true)
    s03_skipped=$(echo "$OUTPUT" | grep -c "test_03_dead_internet.*SKIPPED" || true)
    s03_total=$((s03_passed + s03_failed + s03_errored + s03_skipped))

    s04_passed=$(echo "$OUTPUT" | grep -c "test_04_persona_wall.*PASSED" || true)
    s04_failed=$(echo "$OUTPUT" | grep -c "test_04_persona_wall.*FAILED" || true)
    s04_errored=$(echo "$OUTPUT" | grep -c "test_04_persona_wall.* ERROR" || true)
    s04_skipped=$(echo "$OUTPUT" | grep -c "test_04_persona_wall.*SKIPPED" || true)
    s04_total=$((s04_passed + s04_failed + s04_errored + s04_skipped))

    s05_passed=$(echo "$OUTPUT" | grep -c "test_05_agent_gateway.*PASSED" || true)
    s05_failed=$(echo "$OUTPUT" | grep -c "test_05_agent_gateway.*FAILED" || true)
    s05_errored=$(echo "$OUTPUT" | grep -c "test_05_agent_gateway.* ERROR" || true)
    s05_skipped=$(echo "$OUTPUT" | grep -c "test_05_agent_gateway.*SKIPPED" || true)
    s05_total=$((s05_passed + s05_failed + s05_errored + s05_skipped))

    s06_passed=$(echo "$OUTPUT" | grep -c "test_06_license_renewal.*PASSED" || true)
    s06_failed=$(echo "$OUTPUT" | grep -c "test_06_license_renewal.*FAILED" || true)
    s06_errored=$(echo "$OUTPUT" | grep -c "test_06_license_renewal.* ERROR" || true)
    s06_skipped=$(echo "$OUTPUT" | grep -c "test_06_license_renewal.*SKIPPED" || true)
    s06_total=$((s06_passed + s06_failed + s06_errored + s06_skipped))

    s07_passed=$(echo "$OUTPUT" | grep -c "test_07_daily_briefing.*PASSED" || true)
    s07_failed=$(echo "$OUTPUT" | grep -c "test_07_daily_briefing.*FAILED" || true)
    s07_errored=$(echo "$OUTPUT" | grep -c "test_07_daily_briefing.* ERROR" || true)
    s07_skipped=$(echo "$OUTPUT" | grep -c "test_07_daily_briefing.*SKIPPED" || true)
    s07_total=$((s07_passed + s07_failed + s07_errored + s07_skipped))

    s08_passed=$(echo "$OUTPUT" | grep -c "test_08_move_to_new_machine.*PASSED" || true)
    s08_failed=$(echo "$OUTPUT" | grep -c "test_08_move_to_new_machine.*FAILED" || true)
    s08_errored=$(echo "$OUTPUT" | grep -c "test_08_move_to_new_machine.* ERROR" || true)
    s08_skipped=$(echo "$OUTPUT" | grep -c "test_08_move_to_new_machine.*SKIPPED" || true)
    s08_total=$((s08_passed + s08_failed + s08_errored + s08_skipped))

    s09_passed=$(echo "$OUTPUT" | grep -c "test_09_connector_expiry.*PASSED" || true)
    s09_failed=$(echo "$OUTPUT" | grep -c "test_09_connector_expiry.*FAILED" || true)
    s09_errored=$(echo "$OUTPUT" | grep -c "test_09_connector_expiry.* ERROR" || true)
    s09_skipped=$(echo "$OUTPUT" | grep -c "test_09_connector_expiry.*SKIPPED" || true)
    s09_total=$((s09_passed + s09_failed + s09_errored + s09_skipped))

    s10_passed=$(echo "$OUTPUT" | grep -c "test_10_operator_journey.*PASSED" || true)
    s10_failed=$(echo "$OUTPUT" | grep -c "test_10_operator_journey.*FAILED" || true)
    s10_errored=$(echo "$OUTPUT" | grep -c "test_10_operator_journey.* ERROR" || true)
    s10_skipped=$(echo "$OUTPUT" | grep -c "test_10_operator_journey.*SKIPPED" || true)
    s10_total=$((s10_passed + s10_failed + s10_errored + s10_skipped))

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
    if [ "$s05_total" -gt 0 ]; then
        s05_r=$(format_result "$s05_passed" "$s05_total")
    else s05_r=""; fi
    if [ "$s06_total" -gt 0 ]; then
        s06_r=$(format_result "$s06_passed" "$s06_total")
    else s06_r=""; fi
    if [ "$s07_total" -gt 0 ]; then
        s07_r=$(format_result "$s07_passed" "$s07_total")
    else s07_r=""; fi
    if [ "$s08_total" -gt 0 ]; then
        s08_r=$(format_result "$s08_passed" "$s08_total")
    else s08_r=""; fi
    if [ "$s09_total" -gt 0 ]; then
        s09_r=$(format_result "$s09_passed" "$s09_total")
    else s09_r=""; fi
    if [ "$s10_total" -gt 0 ]; then
        s10_r=$(format_result "$s10_passed" "$s10_total")
    else s10_r=""; fi

    print_banner "$s01_r" "$s02_r" "$s03_r" "$s04_r" "$s05_r" "$s06_r" "$s07_r" "$s08_r" "$s09_r" "$s10_r"

    # Overall summary
    total_passed=$((s01_passed + s02_passed + s03_passed + s04_passed + s05_passed + s06_passed + s07_passed + s08_passed + s09_passed + s10_passed))
    total_all=$((s01_total + s02_total + s03_total + s04_total + s05_total + s06_total + s07_total + s08_total + s09_total + s10_total))
    total_failed=$((s01_failed + s02_failed + s03_failed + s04_failed + s05_failed + s06_failed + s07_failed + s08_failed + s09_failed + s10_failed))
    total_errored=$((s01_errored + s02_errored + s03_errored + s04_errored + s05_errored + s06_errored + s07_errored + s08_errored + s09_errored + s10_errored))
    total_skipped=$((s01_skipped + s02_skipped + s03_skipped + s04_skipped + s05_skipped + s06_skipped + s07_skipped + s08_skipped + s09_skipped + s10_skipped))
    echo ""
    if [ "$total_failed" -eq 0 ] && [ "$total_errored" -eq 0 ] && [ "$total_all" -gt 0 ]; then
        echo -e "  ${GREEN}${BOLD}${total_passed}/${total_all} passed${R}"
        if [ "$total_skipped" -gt 0 ]; then
            echo -e "  ${DIM}${total_skipped} skipped (set GOOGLE_API_KEY for LLM tests)${R}"
        fi
        echo -e "  ${DIM}Zero mocks. Real stack. Real crypto. Real trust.${R}"
    elif [ "$total_all" -gt 0 ]; then
        if [ "$total_errored" -gt 0 ]; then
            echo -e "  ${RED}${BOLD}${total_errored} errors${R}, ${total_failed} failed, ${total_passed}/${total_all} passed"
        else
            echo -e "  ${RED}${BOLD}${total_failed} failed${R}, ${total_passed}/${total_all} passed"
        fi
    else
        echo -e "  ${YELLOW}No tests collected.${R}"
    fi
    echo ""
    echo -e "  ${DIM}Logs: ${LOG_DIR}/grouped.log${R}"
    echo ""

    [ "$total_failed" -eq 0 ] && [ "$total_errored" -eq 0 ] && exit 0 || exit 1
fi

# ============================================================================
# Verbose mode (default): show banner, then full pytest output
# ============================================================================
print_banner "" "" "" "" "" "" "" "" "" ""

# -- API key notice --
if [ -z "${GOOGLE_API_KEY:-}" ]; then
    echo ""
    echo -e "  ${YELLOW}Note:${RESET} GOOGLE_API_KEY not set -- LLM reasoning tests will be skipped."
    echo -e "  ${DIM}Set it to run the full demo including personalized advice generation.${RESET}"
fi

echo ""

# -- Run tests --
# Port conflicts are handled inside conftest.py (auto re-allocation).
TEST_PATH="${STORY_FILE:-tests/system/user_stories/}"
python -m pytest "$TEST_PATH" \
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
