#!/usr/bin/env bash
# =============================================================================
# Home Node (TypeScript stack) — FULL STATUS. Run-and-wait; prints one green/red
# summary. Runs each workspace's Jest SEQUENTIALLY with --runInBand (parallel
# Jest has OOM'd this machine), then the composite typecheck, then the hermetic
# PR-tier browser E2E (agent-safety + PeerLens; boots its own core+brain).
#
#   Usage:  bash scripts/test/home_node_status.sh [--no-e2e]
#
# OUT OF SCOPE here (need external things — run separately, see docs/E2E_TESTING.md):
#   - judged / functional E2E tier  -> needs a Gemini key (DINA_E2E_LIVE_JUDGE=1)
#   - relay E2E tier (Talk/services)-> needs the dina-nodes running
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

RUN_E2E=1
[ "${1:-}" = "--no-e2e" ] && RUN_E2E=0

names=(); results=(); details=()
record() { names+=("$1"); results+=("$2"); details+=("$3"); }

echo "### Home Node status — started $(date '+%H:%M:%S') ###"

# --- 1. composite typecheck --------------------------------------------------
echo; echo "── typecheck (tsc --noEmit across all workspaces) ──"
out=$(npm run typecheck 2>&1); code=$?
printf '%s\n' "$out" | grep -E 'error TS|npm error code|Found [0-9]+ error' | head -4
[ $code -eq 0 ] && record "typecheck" "PASS" "" || record "typecheck" "FAIL" "tsc errors"

# --- 2. Jest per workspace (sequential, --runInBand — no OOM) -----------------
for d in packages/*/ apps/home-node-lite/*/ apps/mobile/; do
  pj="${d}package.json"; [ -f "$pj" ] || continue
  t=$(node -e "try{process.stdout.write((require('./$pj').scripts||{}).test||'')}catch(e){}")
  case "$t" in *jest*) ;; *) continue ;; esac
  echo; echo "── jest: ${d%/} ──"
  out=$( cd "$d" && npx jest --runInBand 2>&1 ); code=$?
  line=$(printf '%s\n' "$out" | grep -E '^Tests:' | tail -1)
  echo "${line:-<no Tests: summary>}"
  if [ $code -eq 0 ]; then
    record "jest:${d%/}" "PASS" "${line#Tests: }"
  else
    fails=$(printf '%s\n' "$out" | grep -E '✕|FAIL ' | head -3 | tr '\n' ' ')
    echo "  FAILS: $fails"
    record "jest:${d%/}" "FAIL" "$fails"
  fi
done

# --- 3. hermetic PR-tier E2E -------------------------------------------------
if [ $RUN_E2E -eq 1 ]; then
  echo; echo "── E2E (hermetic PR tier: agent-safety + PeerLens) ──"
  out=$( cd apps/home-node-lite/web && npm run test:e2e:pr 2>&1 ); code=$?
  printf '%s\n' "$out" | grep -E 'passed|failed|✘' | tail -2
  [ $code -eq 0 ] && record "e2e:pr" "PASS" "" || record "e2e:pr" "FAIL" "see output above"
fi

# --- summary -----------------------------------------------------------------
echo; echo "================= HOME NODE STATUS ================="
overall=0
for i in "${!names[@]}"; do
  mark="✅"; [ "${results[$i]}" = "FAIL" ] && { mark="❌"; overall=1; }
  printf "  %s  %-30s %s\n" "$mark" "${names[$i]}" "${details[$i]}"
done
echo "==================================================="
[ $overall -eq 0 ] && echo "OVERALL: ✅ GREEN" || echo "OVERALL: ❌ RED (see ❌ rows)"
echo "(out of scope: judged E2E → Gemini key; relay E2E → dina-nodes)"
exit $overall
