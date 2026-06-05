#!/usr/bin/env bash
#
# run_mrs.sh — Manual Release Sanity (MRS) master runner.
#
# Drives the automatable MRS scenarios on the dev-client fast loop (the iOS
# sim under Maestro + the paired `dina` agent CLI + the cloud test infra).
# Fail-localized: each scenario reports PASS / FAIL / SKIP and the run tallies
# at the end. Phase 1 is a hard gate (single-Dina core); later phases continue
# so one flaky external dep doesn't mask the rest.
#
# Prereqs (set up ONCE — see project memory + the per-phase notes):
#   - Metro on the --no-dev loop:  (cd apps/mobile && npm run start:e2e)
#   - the iOS sim booted, the Dina app installed + onboarded, foregrounded
#   - a `dina` agent paired (apps/mobile/maestro/agent/pair_code.yaml +
#     `dina configure --headless --role agent …`); config at ./.dina/cli
#   - GEMINI_API_KEY exported (Talk harness runs a real-LLM sender)
#
# Usage (from repo root):
#   apps/mobile/maestro/run_mrs.sh                 # phased, stop if Phase 1 fails
#   apps/mobile/maestro/run_mrs.sh --continue      # run everything, never stop
#   apps/mobile/maestro/run_mrs.sh --only agent    # one phase: core|durability|
#                                                  #   agent|talk|services|peerlens|logs
#
# Env overrides: UDID, MAESTRO, DINA, MOBILE_DID, PROVIDER_CORE_URL.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

UDID="${UDID:-6D57099D-48DA-430D-B4BB-1A2BF1EBACB7}"
MAESTRO="${MAESTRO:-/opt/homebrew/opt/maestro/bin/maestro}"
DINA="${DINA:-.venv/bin/dina}"
MOBILE_DID="${MOBILE_DID:-did:plc:s6mbp7pokaqsh5nko26wie5u}"
PROVIDER_CORE_URL="${PROVIDER_CORE_URL:-http://127.0.0.1:18298}"
M="apps/mobile/maestro"

CONTINUE=0
ONLY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --continue) CONTINUE=1 ;;
    --only) shift; ONLY="${1:-}" ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
  shift
done

PASS=(); FAILED=(); SKIP=()
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
flow()  { "$MAESTRO" --udid "$UDID" test "$1" >/dev/null 2>&1; }
ok()    { PASS+=("$1");   echo "  ✓ PASS  $1"; }
bad()   { FAILED+=("$1"); echo "  ✗ FAIL  $1"; }
skip()  { SKIP+=("$1");   echo "  ↷ SKIP  $1 — $2"; }

print_summary() {
  echo ""
  echo "═══════════════ MRS SUMMARY ═══════════════"
  echo "  PASS:  ${#PASS[@]}   ${PASS[*]:-}"
  echo "  FAIL:  ${#FAILED[@]}   ${FAILED[*]:-}"
  echo "  SKIP:  ${#SKIP[@]}   ${SKIP[*]:-}"
  echo "═══════════════════════════════════════════"
}

# Run a Maestro flow as one MRS check. $1=label $2=flow-path
check_flow() {
  echo "→ $1"
  if flow "$2"; then ok "$1"; else bad "$1"; return 1; fi
}
# Run a shell driver as one MRS check. $1=label $2..=command
check_cmd() {
  local label="$1"; shift
  echo "→ $label"
  if "$@" >/tmp/mrs_"$label".log 2>&1; then ok "$label"; else bad "$label"; tail -5 /tmp/mrs_"$label".log; return 1; fi
}

# ── Phase 1 — single-Dina core (HARD GATE) ─────────────────────────────
if want core; then
  echo "═══ Phase 1: core (MRS-01/02/12-smoke) ═══"
  check_flow "tabs_smoke"       "$M/tabs_smoke.yaml"
  gate=$?
  check_flow "remember_recall"  "$M/remember_recall.yaml" || gate=1
  check_flow "persona_routing"  "$M/persona_routing.yaml" || gate=1
  check_flow "remember_reminder" "$M/remember_reminder.yaml" || true   # reminder with/without
  check_flow "ask_reminder"     "$M/ask_reminder.yaml" || true
  check_flow "own_identity"     "$M/own_identity.yaml" || true
  if [ "$gate" -ne 0 ] && [ "$CONTINUE" -eq 0 ]; then
    echo "Phase 1 hard gate failed — stopping (use --continue to override)."
    print_summary; exit 1
  fi
fi

# ── Phase 2 — durability (MRS-13) ──────────────────────────────────────
if want durability; then
  echo "═══ Phase 2: durability (MRS-13) ═══"
  check_flow "restart_persists" "$M/durability/restart_persists.yaml" || true
fi

# ── Phase 3 — agent: task / security / approvals (MRS-06/07/08) ────────
if want agent; then
  echo "═══ Phase 3: agent (MRS-06/07/08) ═══"
  check_cmd "agent_task"  "$M/harness/agent_mrs_driver.sh" task  || true
  check_cmd "agent_vault" "$M/harness/agent_mrs_driver.sh" vault || true
  check_cmd "agent_risky" "$M/harness/agent_mrs_driver.sh" risky || true
fi

# ── Phase 4 — Talk + quarantine (MRS-04/05) ────────────────────────────
if want talk; then
  echo "═══ Phase 4: talk (MRS-04/05) ═══"
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    skip "talk" "GEMINI_API_KEY not set (Talk harness runs a real-LLM sender)"
  else
    # MRS-04 enrichment: contact the mobile, send an actionable peer msg, assert
    # the enriched reminder ("cold brew") on the receiver.
    flow "$M/talk/01_sancho_setup.yaml" || true
    if npx tsx "$M/harness/live_d2d_send_to_mobile.ts" \
         --to "$MOBILE_DID" --text "Coming over tomorrow morning" --name Alonso \
         >/tmp/mrs_talk_send.log 2>&1; then
      check_flow "talk_enrichment" "$M/talk/03_sancho_assert.yaml" || true
    else
      bad "talk_enrichment(send)"; tail -5 /tmp/mrs_talk_send.log
    fi
    # MRS-05 quarantine: unknown sender (NOT a contact) → quarantine card.
    if npx tsx "$M/harness/live_d2d_send_to_mobile.ts" \
         --to "$MOBILE_DID" --text "Hello from a stranger" --name Stranger \
         >/tmp/mrs_quar_send.log 2>&1; then
      check_flow "quarantine" "$M/talk/quarantine_assert.yaml" || true
    else
      bad "quarantine(send)"; tail -5 /tmp/mrs_quar_send.log
    fi
  fi
fi

# ── Phase 5 — services (MRS-10) ────────────────────────────────────────
if want services; then
  echo "═══ Phase 5: services (MRS-10) ═══"
  # Needs a live provider on PROVIDER_CORE_URL (boot a provider lite-Core +
  # publish an eta_query listing + run the stub_eta daemon — see
  # demo/dina-services-demo/{put_service_config.ts,run_daemon.py} and
  # services/SERVICES_HARNESS.md). Skip cleanly if no provider is up.
  if curl -fsS "$PROVIDER_CORE_URL/healthz" >/dev/null 2>&1; then
    check_flow "bus_eta" "$M/services/bus_eta.yaml" || true
  else
    skip "bus_eta" "no provider on $PROVIDER_CORE_URL (see services/SERVICES_HARNESS.md)"
  fi
fi

# ── Phase 6 — PeerLens (MRS-09) ────────────────────────────────────────
if want peerlens; then
  echo "═══ Phase 6: peerlens (MRS-09) ═══"
  check_flow "peerlens_search" "$M/peerlens/search_and_review.yaml" || true
fi

# ── Phase 7 — log-hygiene gate (MRS-14) ────────────────────────────────
if want logs; then
  echo "═══ Phase 7: log hygiene (MRS-14) ═══"
  if [ -n "${MRS_LOGFILES:-}" ]; then
    if OWNER_DID="$MOBILE_DID" "$M/harness/log_hygiene_check.sh" $MRS_LOGFILES >/tmp/mrs_logs.log 2>&1; then
      ok "log_hygiene"
    else
      bad "log_hygiene"; tail -15 /tmp/mrs_logs.log
    fi
  else
    skip "log_hygiene" "set MRS_LOGFILES to the captured iOS/Android log paths"
  fi
fi

print_summary
[ "${#FAILED[@]}" -eq 0 ]
