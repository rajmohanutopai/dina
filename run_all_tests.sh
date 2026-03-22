#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Dina Full Test Suite
# ============================================================================
# Runs unit tests, tears down old stack, brings up fresh Docker stack,
# runs non-unit tests, and produces a combined report (terminal + HTML).
#
# Usage:
#   ./run_all_tests.sh                                  # unit + default non-unit
#   ./run_all_tests.sh --all                            # include install-pexpect
#   ./run_all_tests.sh --run integration,e2e            # unit + specific non-unit (faster)
#   ./run_all_tests.sh --continue                       # don't stop on first failure
#   ./run_all_tests.sh --unit-only                      # unit tests only (no Docker)
#   ./run_all_tests.sh --skip-unit                      # non-unit only (stack must be up)
#   ./run_all_tests.sh --skip-prepare                   # reuse running stack (no down/up)
#
# Non-unit suite selection (passed to run_non_unit_tests.sh):
#   Default:  integration,e2e,release,install,user_stories,appview_integration
#   --all:    adds install-pexpect (slow shell lifecycle tests)
#   --run X:  exactly X (comma-separated suite names, for faster dev cycles)
#
# Available non-unit suites:
#   integration, e2e, release, install, user_stories, appview_integration, install-pexpect
# ============================================================================

CONTINUE=false
SKIP_UNIT=false
UNIT_ONLY=false
SKIP_PREPARE=false
RUN_SUITES=""
ALL_MODE=false
EXTRA_ARGS=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue)       CONTINUE=true; shift ;;
    --skip-unit)      SKIP_UNIT=true; shift ;;
    --unit-only)      UNIT_ONLY=true; shift ;;
    --skip-prepare)   SKIP_PREPARE=true; shift ;;
    --all)            ALL_MODE=true; shift ;;
    --run)            RUN_SUITES="$2"; shift 2 ;;
    --verbose|-v)     EXTRA_ARGS+=("$1"); shift ;;
    --no-color)       EXTRA_ARGS+=("$1"); shift ;;
    --help|-h)
      head -26 "$0" | tail -23
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run: $0 --help" >&2
      exit 1
      ;;
  esac
done

TMPDIR_BASE="$(mktemp -d)"
UNIT_JSON="$TMPDIR_BASE/unit.json"
NONUNIT_JSON="$TMPDIR_BASE/nonunit.json"
FAILURES=0
T0=$SECONDS

# ---------------------------------------------------------------------------
# Helper: format seconds into human-readable
# ---------------------------------------------------------------------------
fmt_time() {
  local secs="$1"
  if (( secs >= 60 )); then
    echo "$((secs / 60))m$((secs % 60))s"
  else
    echo "${secs}s"
  fi
}

# ---------------------------------------------------------------------------
# 1. Unit Tests
# ---------------------------------------------------------------------------
if [ "$SKIP_UNIT" = false ]; then
  echo ""
  echo "============================================"
  echo "  Phase 1: Unit Tests"
  echo "============================================"
  echo ""

  UNIT_RC=0
  python scripts/test_status.py --unit --mock --json-file "$UNIT_JSON" \
    ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} || UNIT_RC=$?

  if [ "$UNIT_RC" -ne 0 ]; then
    FAILURES=$((FAILURES + 1))
    if [ "$CONTINUE" = false ]; then
      echo ""
      echo "UNIT TESTS FAILED — stopping (use --continue to proceed)"
      rm -rf "$TMPDIR_BASE"
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 2. Prepare Docker Stack (down → up)
# ---------------------------------------------------------------------------
if [ "$UNIT_ONLY" = false ] && [ "$SKIP_PREPARE" = false ]; then
  echo ""
  echo "============================================"
  echo "  Phase 2: Preparing Docker test stack..."
  echo "============================================"
  echo ""

  # Clean tear-down first, then fresh start (suppress verbose Docker output)
  echo "  Tearing down old stack..."
  ./prepare_non_unit_env.sh down > /dev/null 2>&1 || true
  echo "  Done."

  echo "  Building and starting fresh stack..."
  if ! ./prepare_non_unit_env.sh up > /dev/null 2>&1; then
    echo ""
    echo "ERROR: Docker stack preparation failed. Run ./prepare_non_unit_env.sh up manually for details."
    rm -rf "$TMPDIR_BASE"
    exit 1
  fi
  echo "  Stack ready."
fi

# ---------------------------------------------------------------------------
# 3. Non-Unit Tests
# ---------------------------------------------------------------------------
if [ "$UNIT_ONLY" = false ]; then
  echo ""
  echo "============================================"
  echo "  Phase 3: Non-Unit Tests"
  echo "============================================"
  echo ""

  NONUNIT_ARGS=()
  if [ -n "$RUN_SUITES" ]; then
    NONUNIT_ARGS+=(--run "$RUN_SUITES")
  elif [ "$ALL_MODE" = true ]; then
    NONUNIT_ARGS+=(--all)
  fi

  NONUNIT_RC=0
  ./run_non_unit_tests.sh ${NONUNIT_ARGS[@]+"${NONUNIT_ARGS[@]}"} \
    --json-file "$NONUNIT_JSON" \
    ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} || NONUNIT_RC=$?

  if [ "$NONUNIT_RC" -ne 0 ]; then
    FAILURES=$((FAILURES + 1))
  fi
fi

# ---------------------------------------------------------------------------
# 4. Combined Grand Summary + HTML Report
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  Combined Grand Summary"
echo "============================================"

python3 - "$UNIT_JSON" "$NONUNIT_JSON" <<'PYEOF'
import json, sys, os

SEP = '\u2500'

def fmt_dur(secs):
    if secs >= 60:
        return f'{int(secs)//60}m{int(secs)%60}s'.rjust(7)
    elif secs >= 1:
        return f'{secs:.1f}s'.rjust(7)
    else:
        return f'{secs*1000:.0f}ms'.rjust(7)

NAME_MAP = {
    'core': 'Core (Go)', 'brain': 'Brain (Py)', 'cli': 'CLI (Py)',
    'admin_cli': 'Admin CLI', 'appview': 'AppView (TS)',
    'integration': 'Integration', 'e2e': 'E2E (Docker)',
    'release': 'Release', 'user_stories': 'User Stories',
    'install': 'Install', 'appview_integration': 'AppView Int',
    'install-pexpect': 'Install (pexp)',
}

rows = []  # (name, total, pass, skip, fail, xfail, wall_time)

for path in sys.argv[1:]:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        continue
    try:
        data = json.load(open(path))
    except (json.JSONDecodeError, IOError):
        continue
    for key, suite in data.items():
        if key.startswith('_'):
            continue
        s = suite.get('summary', {})
        rows.append((
            NAME_MAP.get(key, key),
            s.get('total', 0),
            s.get('passed', 0),
            s.get('skipped', 0),
            s.get('failed', 0),
            s.get('xfail', 0),
            s.get('wall_time_s', s.get('duration_s', 0)),
        ))

if not rows:
    print('  No test results to summarize.')
    sys.exit(0)

use_color = sys.stdout.isatty()
RED = '\033[31m' if use_color else ''
BOLD = '\033[1m' if use_color else ''
RESET = '\033[0m' if use_color else ''

any_xfail = any(xf > 0 for _, _, _, _, _, xf, _ in rows)
xf_hdr = ' | XFail' if any_xfail else ''
xf_sep = f'\u253c{SEP * 6}' if any_xfail else ''

print(f' {"Suite":<14} | {"Total":>5}'
      f' | {"Pass":>4} | {"Skip":>4} | {"Fail":>4}'
      f'{xf_hdr}'
      f' | {"Time":>7} | Progress')
rule = (f'{SEP * 16}\u253c{SEP * 7}'
        f'\u253c{SEP * 6}\u253c{SEP * 6}\u253c{SEP * 6}'
        f'{xf_sep}'
        f'\u253c{SEP * 9}\u253c{SEP * 10}')
print(rule)

gt = gp = gs = gf = gx = 0
g_time = 0.0
for name, t, p, s, f, xf, dur in rows:
    gt += t; gp += p; gs += s; gf += f; gx += xf; g_time += dur
    pct = (p / t * 100) if t else 0
    xf_col = f' | {xf:>4}' if any_xfail else ''
    fail_str = f'{RED}{f:>4}{RESET}' if f > 0 else f'{f:>4}'
    print(f' {name:<14} | {t:>5}'
          f' | {p:>4} | {s:>4} | {fail_str}'
          f'{xf_col}'
          f' | {fmt_dur(dur)} | {pct:>5.1f}%')

print(rule)
gpct = (gp / gt * 100) if gt else 0
xf_tot = f' | {gx:>4}' if any_xfail else ''
gfail = f'{RED}{gf:>4}{RESET}' if gf > 0 else f'{gf:>4}'
print(f' {BOLD}{"TOTAL":<14}{RESET} | {gt:>5}'
      f' | {gp:>4} | {gs:>4} | {gfail}'
      f'{xf_tot}'
      f' | {fmt_dur(g_time)} | {gpct:>5.1f}%')
PYEOF

ELAPSED=$((SECONDS - T0))

# Generate HTML report from JSON files
python3 scripts/generate_test_report.py \
  "$UNIT_JSON" "$NONUNIT_JSON" \
  --elapsed "$ELAPSED" 2>/dev/null || true

echo ""
echo "  [total: $(fmt_time $ELAPSED)]"

# Cleanup
rm -rf "$TMPDIR_BASE"

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "  SOME SUITES FAILED ($FAILURES failure(s))"
  exit 1
else
  echo ""
  echo "  ALL TESTS PASSED"
fi
