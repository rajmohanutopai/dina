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
#   - MOBILE_DID exported = the DEVICE's own did:plc (read it from the app:
#     People tab → your identity card, or run `--only core` and read the
#     own_identity assertion). There is NO default — a stale pinned DID
#     silently breaks Talk (wrong recipient) + log-hygiene (wrong allowlist).
#
# Usage (from repo root):
#   apps/mobile/maestro/run_mrs.sh                 # default phases, stop if Phase 1 fails
#   apps/mobile/maestro/run_mrs.sh --continue      # run everything, never stop
#   apps/mobile/maestro/run_mrs.sh --only agent    # one phase (see PHASES below)
#
# PHASES (default sequence): core durability agent talk services peerlens logs
#                            guided_demo vault composer four_laws
# OPT-IN only (excluded from the default sweep — run via --only):
#   onboarding  — ERASES + re-onboards the app (would wipe the state the other
#                 phases need), so it never runs in the default sequence.
#   credits     — mints REAL OpenRouter keys (costs money); see
#                 harness/run_local_grants.sh.
#
# Env overrides: UDID, MAESTRO, DINA, MOBILE_DID, PROVIDER_CORE_URL,
#                CONTACT_PEER_URL (enables the contact-services leg).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

UDID="${UDID:-6D57099D-48DA-430D-B4BB-1A2BF1EBACB7}"
MAESTRO="${MAESTRO:-/opt/homebrew/opt/maestro/bin/maestro}"
DINA="${DINA:-.venv/bin/dina}"
# NO stale default — must be the device's actual did:plc. Phases that need it
# (talk, logs) skip cleanly when it's unset rather than use a wrong DID.
MOBILE_DID="${MOBILE_DID:-}"
PROVIDER_CORE_URL="${PROVIDER_CORE_URL:-http://127.0.0.1:18298}"
CONTACT_PEER_URL="${CONTACT_PEER_URL:-}"
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
# `want` is true for default-sequence phases when ONLY is empty, or when ONLY
# names this phase. Opt-in phases (onboarding, credits) use `want_optin`, which
# is true ONLY when explicitly requested — never in the default sweep.
want()       { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
want_optin() { [ "$ONLY" = "$1" ]; }
flow()   { "$MAESTRO" --udid "$UDID" test "$1" >/dev/null 2>&1; }
flow_e() { local f="$1"; shift; "$MAESTRO" --udid "$UDID" test "$@" "$f" >/dev/null 2>&1; }
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
# The owner-vs-agent gate is the spec's #1 blocker, so this phase exercises the
# FULL matrix, not just the happy path: the risk ladder (safe→moderate→high→
# blocked) in both approve + deny directions, and the session-scope invariants
# (no cross-vault leak, no cross-session carry).
if want agent; then
  echo "═══ Phase 3: agent (MRS-06/07/08 — full matrix) ═══"
  check_cmd "agent_task"        "$M/harness/agent_mrs_driver.sh" task        || true  # MODERATE approve
  check_cmd "agent_vault"       "$M/harness/agent_mrs_driver.sh" vault       || true  # locked-vault approve
  check_cmd "agent_risky"       "$M/harness/agent_mrs_driver.sh" risky       || true  # HIGH approve
  check_cmd "agent_deny"        "$M/harness/agent_mrs_driver.sh" deny        || true  # HIGH deny
  check_cmd "agent_safe"        "$M/harness/agent_mrs_driver.sh" safe        || true  # SAFE auto, no card
  check_cmd "agent_blocked"     "$M/harness/agent_mrs_driver.sh" blocked     || true  # BLOCKED, no card
  check_cmd "agent_cross_vault" "$M/harness/agent_mrs_driver.sh" cross_vault || true  # C3 no cross-vault leak
  check_cmd "agent_new_session" "$M/harness/agent_mrs_driver.sh" new_session || true  # C4 no cross-session carry
fi

# ── Phase 4 — Talk + quarantine (MRS-04/05) ────────────────────────────
if want talk; then
  echo "═══ Phase 4: talk (MRS-04/05) ═══"
  if [ -z "$MOBILE_DID" ]; then
    skip "talk" "MOBILE_DID unset — export the device's own did:plc (see header)"
  elif [ -z "${GEMINI_API_KEY:-}" ]; then
    skip "talk" "GEMINI_API_KEY not set (Talk harness runs a real-LLM sender)"
  else
    # MRS-04 enrichment. The receiver MUST have the sender as a contact BEFORE
    # the message arrives (the mutual-contact gate decides enrich-vs-quarantine).
    # The sender DID is minted by the harness, so we use its did-file/wait-file
    # handoff: background the send → read the minted DID → add THAT exact DID as
    # a contact + seed the cold-brew memory (01_sancho_setup) → release the send.
    # (The previous wiring ran 01_sancho_setup with an UNSET ALONSO_DID, so the
    # real sender was never a contact → the message quarantined → enrichment
    # could never actually be proven.)
    didf="$(mktemp)"; gof="${didf}.go"; rm -f "$gof"
    npx tsx "$M/harness/live_d2d_send_to_mobile.ts" \
      --to "$MOBILE_DID" --text "Coming over tomorrow morning" --name Alonso \
      --did-file "$didf" --wait-file "$gof" >/tmp/mrs_talk_send.log 2>&1 &
    send_pid=$!
    for _ in $(seq 1 60); do [ -s "$didf" ] && break; sleep 1; done
    sender_did="$(cat "$didf" 2>/dev/null || true)"
    if [ -z "$sender_did" ]; then
      bad "talk_enrichment(send)"; tail -5 /tmp/mrs_talk_send.log
      kill "$send_pid" 2>/dev/null || true
    else
      echo "→ talk_enrichment (sender=$sender_did)"
      if flow_e "$M/talk/01_sancho_setup.yaml" -e ALONSO_DID="$sender_did"; then
        touch "$gof"                        # release the held send
        wait "$send_pid" || { bad "talk_enrichment(send)"; tail -5 /tmp/mrs_talk_send.log; }
        check_flow "talk_enrichment" "$M/talk/03_sancho_assert.yaml" || true
      else
        bad "talk_enrichment(setup)"; touch "$gof"; wait "$send_pid" 2>/dev/null || true
      fi
    fi
    rm -f "$didf" "$gof"

    # MRS-05 quarantine: a DIFFERENT fresh sender that is NOT added as a contact
    # → the receiver quarantines it. (No handoff — we WANT a stranger.)
    if npx tsx "$M/harness/live_d2d_send_to_mobile.ts" \
         --to "$MOBILE_DID" --text "Hello from a stranger" --name Stranger \
         >/tmp/mrs_quar_send.log 2>&1; then
      check_flow "quarantine" "$M/talk/quarantine_assert.yaml" || true
    else
      bad "quarantine(send)"; tail -5 /tmp/mrs_quar_send.log
    fi
  fi
fi

# ── Phase 5 — services (MRS-10 public + Contact Services) ──────────────
if want services; then
  echo "═══ Phase 5: services (MRS-10) ═══"
  # MRS-10 public bus-ETA. Needs a live provider on PROVIDER_CORE_URL (boot a
  # provider lite-Core + publish an eta_query listing + run the stub_eta
  # daemon — see demo/dina-services-demo/{put_service_config.ts,run_daemon.py}
  # and services/SERVICES_HARNESS.md). Skip cleanly if no provider is up.
  if curl -fsS "$PROVIDER_CORE_URL/healthz" >/dev/null 2>&1; then
    check_flow "bus_eta" "$M/services/bus_eta.yaml" || true
  else
    skip "bus_eta" "no provider on $PROVIDER_CORE_URL (see services/SERVICES_HARNESS.md)"
  fi

  # Contact Services (known_only, contact-gated). Needs a peer lite-Core that
  # publishes a talk/known_only availability listing + issues an offer to this
  # device (harness/contact_services_offer.ts). Conditional on CONTACT_PEER_URL.
  if [ -n "$CONTACT_PEER_URL" ] && curl -fsS "$CONTACT_PEER_URL/healthz" >/dev/null 2>&1; then
    check_flow "contact_schedule"       "$M/services/contact_schedule.yaml"       || true
    check_flow "contact_schedule_query" "$M/services/contact_schedule_query.yaml" || true
  else
    skip "contact_services" "set CONTACT_PEER_URL to a peer running harness/contact_services_offer.ts (see services/SERVICES_HARNESS.md)"
  fi
fi

# ── Phase 6 — PeerLens (MRS-09) ────────────────────────────────────────
if want peerlens; then
  echo "═══ Phase 6: peerlens (MRS-09) ═══"
  check_flow "peerlens_search"   "$M/peerlens/search_and_review.yaml" || true
  check_flow "peerlens_reviewer" "$M/peerlens/reviewer_dashboard.yaml" || true
fi

# ── Phase 7 — log-hygiene gate (MRS-14) ────────────────────────────────
if want logs; then
  echo "═══ Phase 7: log hygiene (MRS-14) ═══"
  if [ -z "$MOBILE_DID" ]; then
    skip "log_hygiene" "MOBILE_DID unset — needed to allowlist the owner DID"
  elif [ -n "${MRS_LOGFILES:-}" ]; then
    if OWNER_DID="$MOBILE_DID" "$M/harness/log_hygiene_check.sh" $MRS_LOGFILES >/tmp/mrs_logs.log 2>&1; then
      ok "log_hygiene"
    else
      bad "log_hygiene"; tail -15 /tmp/mrs_logs.log
    fi
  else
    skip "log_hygiene" "set MRS_LOGFILES to the captured iOS/Android log paths"
  fi
fi

# ── Phase 8 — guided demo (MRS-GD-01) ──────────────────────────────────
if want guided_demo; then
  echo "═══ Phase 8: guided demo (MRS-GD-01) ═══"
  check_flow "guided_demo" "$M/guided_demo/entry_and_cleanup.yaml" || true
fi

# ── Phase 9 — custom vault lifecycle (create + persist) ────────────────
if want vault; then
  echo "═══ Phase 9: custom vault (create + persist across restart) ═══"
  check_flow "vault_create_persist" "$M/vault_create_persist.yaml" || true
fi

# ── Phase 10 — composer modes (chip strip + Talk nav) ──────────────────
if want composer; then
  echo "═══ Phase 10: composer modes ═══"
  # Hybrid runner — Maestro asserts the chips, idb/adb performs the OS-swipe
  # that drives the RN horizontal ScrollView (Maestro can't).
  check_cmd "composer_modes" "$M/run_composer_modes.sh" || true
fi

# ── Phase 11 — Four Laws (B4 Sancho-moment; B1 Silence-tier deferred) ──
if want four_laws; then
  echo "═══ Phase 11: Four Laws ═══"
  # Law 4 (Anti-Her): a loneliness signal redirects to a HUMAN, never to Dina.
  # Deterministic — the Anti-Her pre-screen has a regex Pass-1 + a fixed
  # redirect string, so this is reliably assertable.
  check_flow "sancho_moment" "$M/four_laws/sancho_moment.yaml" || true
  # Law 1 (Silence First): the fiduciary/solicited/engagement classifier +
  # the briefing surface (chat-card-briefing) both exist, but a Maestro flow
  # cannot deterministically force a SPECIFIC tier — priority is content-
  # classified on inbound events. Reliably asserting "Engagement stays silent /
  # Fiduciary interrupts" needs a debug priority-inject seam (post an event
  # with a pinned priority); that test-seam is not built yet.
  skip "silence_tiers" "needs a debug priority-inject seam — classifier+briefing exist, no deterministic per-tier trigger"
fi

# ── OPT-IN: onboarding (create-new identity) — ERASES the app ──────────
# Never in the default sweep (it wipes the onboarded state the phases above
# rely on). Run standalone: run_mrs.sh --only onboarding.
if want_optin onboarding; then
  echo "═══ OPT-IN: onboarding (create-new did:plc) — ERASES the app ═══"
  check_flow "onboarding_create" "$M/onboarding_create.yaml" || true
fi

print_summary
[ "${#FAILED[@]}" -eq 0 ]
