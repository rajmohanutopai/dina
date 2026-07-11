#!/usr/bin/env bash
# =============================================================================
# MRS FULL — the whole Must-Run-Scenarios suite, thoroughly, via Playwright.
#
# There is NO single built-in command because the rows split by infra need.
# This wrapper runs BOTH thorough tiers and prints one summary.
#
#   TIER 1  functional / judged   MRS-01 02 03 06 07 08 09 13
#           Live Gemini + an LLM judge grades every answer; single node
#           (auto-starts its own core+brain).
#           Prereqs: a Gemini key in env  +  the dist-e2e autopilot bundle
#                    (this script builds it if missing).
#
#   TIER 2  relay / two-humans     MRS-04 05 10   (+MRS-14 log hygiene)
#           Real 2nd Dinas (alonso/sancho) over MsgBox. Each spec self-skips
#           if the nodes aren't reachable, so this never falsely fails.
#           Start them first:
#             cd dina-nodes && ./start.sh alonso sancho && ./connect.sh alonso sancho
#
#   Usage:
#     bash scripts/test/mrs_full.sh                  # both tiers
#     bash scripts/test/mrs_full.sh --functional-only
#     bash scripts/test/mrs_full.sh --relay-only
#     bash scripts/test/mrs_full.sh --rebuild-bundle # force a fresh dist-e2e build
#
#   NOTE: the hermetic, no-infra, SCRIPTED subset (CI gate; NOT "thorough")
#   is separate:  npm run test:e2e:pr
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
WEB=apps/home-node-lite/web

MODE=all; REBUILD=0
for a in "$@"; do
  case "$a" in
    --functional-only|--relay-only) MODE="$a" ;;
    --rebuild-bundle) REBUILD=1 ;;
    *) echo "unknown arg: $a"; exit 2 ;;
  esac
done

names=(); results=()
record() { names+=("$1"); results+=("$2"); }
key="${DINA_GEMINI_API_KEY:-${GEMINI_API_KEY:-}}"

# ── TIER 1: functional / judged ──────────────────────────────────────────────
if [ "$MODE" != "--relay-only" ]; then
  echo "══ TIER 1: functional / judged — MRS-01/02/03/06/07/08/09/13 ══"
  if [ -z "$key" ]; then
    echo "  ⏭  SKIP: no Gemini key (export DINA_GEMINI_API_KEY=…). Judged rows can't run."
    record "functional (judged)" SKIP
  else
    ok=1
    if [ $REBUILD -eq 1 ] || [ ! -d "$WEB/dist-e2e" ]; then
      echo "  • building the dist-e2e autopilot bundle (expo export — slow)…"
      ( cd "$WEB" && npm run build:bundle:e2e ) || ok=0
    fi
    if [ $ok -eq 0 ]; then
      echo "  ❌ dist-e2e bundle build failed"
      record "functional (judged)" FAIL
    elif ( cd "$WEB" && npm run test:e2e:functional ); then
      record "functional (judged)" PASS
    else
      record "functional (judged)" FAIL
    fi
  fi
fi

# ── TIER 2: relay / two-humans ───────────────────────────────────────────────
if [ "$MODE" != "--functional-only" ]; then
  echo "══ TIER 2: relay / two-humans — MRS-04/05/10 (+MRS-14) ══"
  echo "   (each spec self-skips if the dina-nodes aren't reachable)"
  if ( cd "$WEB" && npm run test:e2e:relay ); then
    record "relay (two-humans)" PASS
  else
    record "relay (two-humans)" FAIL
  fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo; echo "═══════════════ MRS FULL SUMMARY ═══════════════"
overall=0
for i in "${!names[@]}"; do
  m="✅"; case "${results[$i]}" in FAIL) m="❌"; overall=1;; SKIP) m="⏭ ";; esac
  printf "  %s  %s\n" "$m" "${names[$i]}"
done
echo "════════════════════════════════════════════════"
[ $overall -eq 0 ] && echo "MRS: ✅ all RUN tiers passed" || echo "MRS: ❌ see ❌ above"
echo "(hermetic scripted subset, no infra: npm run test:e2e:pr)"
exit $overall
