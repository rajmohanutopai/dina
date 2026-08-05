#!/usr/bin/env bash
#
# MRS-06/07/08 — drive the paired `dina` agent CLI and assert the mobile
# approval surface with Maestro. This is the "agent peer-side" half of the
# hybrid model: the CLI issues the agent request, a Maestro flow approves on
# the device, and the CLI confirms the request unblocked.
#
# Preconditions (set up once per suite — see agent/pair_code.yaml):
#   - the iOS app is onboarded + foregrounded on the sim, on the --no-dev loop
#   - a `dina` agent is paired (config at ./.dina/cli — run from repo root)
#   - .venv/bin/dina exists (the agent CLI)
#
# Usage (from repo root) — scenario is the 1st arg:
#   task         MRS-06  agent task delegation gated by a MODERATE approval
#   vault        MRS-07  agent locked-vault read gated + unblocked by approval
#   risky        MRS-08  HIGH-risk action approved through the native confirm
#   deny         MRS-08  HIGH-risk action DENIED on device (the refuse half)
#   safe         MRS-08  SAFE action auto-approved, NO card (the ladder bottom)
#   blocked      MRS-08  BLOCKED action denied outright, NO card (ladder top)
#   cross_vault  MRS-07 C3  health grant must NOT leak to finance (re-prompt)
#   new_session  MRS-07 C4  session grant must NOT carry to a new session
#
# Env overrides: DINA, MAESTRO, UDID.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

DINA="${DINA:-.venv/bin/dina}"
MAESTRO="${MAESTRO:-/opt/homebrew/opt/maestro/bin/maestro}"
UDID="${UDID:-6D57099D-48DA-430D-B4BB-1A2BF1EBACB7}"
MRS_PLATFORM="${MRS_PLATFORM:-ios}"
FLOWS="apps/mobile/maestro/agent"
SCENARIO="${1:-risky}"

fail() { echo "MRS-agent[$SCENARIO] FAIL — $1"; exit 1; }
maestro() {
  local source="$1" prepared="$1" rc
  if [ "$MRS_PLATFORM" = "ios" ]; then
    prepared="$(dirname "$source")/.mrs-ios-activation-$$-$(basename "$source")"
    awk '
      function nudge() {
        print "- tapOn:"
        print "    point: 50%,8%"
        print "- waitForAnimationToEnd"
        print "- extendedWaitUntil:"
        print "    visible:"
        print "      id: root-layout-boot-ready"
        print "    timeout: 60000"
      }
      /^- launchApp$/ { print; nudge(); next }
      /^- launchApp:/ { in_launch = 1; print; next }
      in_launch && /^- / { nudge(); in_launch = 0 }
      { print }
      END { if (in_launch) nudge() }
    ' "$source" > "$prepared"
  fi
  "$MAESTRO" --udid "$UDID" test "$prepared" 2>&1 | grep -vE "WARNING|^$"
  rc=${PIPESTATUS[0]}
  [ "$prepared" = "$source" ] || rm -f "$prepared"
  return "$rc"
}

# Start a fresh session; echo the sess-id. (Agents can't list sessions, so we
# capture the id from the start output.)
start_session() {
  "$DINA" session start --name "$1" 2>&1 | grep -oE 'sess-[a-f0-9]+' | head -1
}
end_session() { "$DINA" session end "$1" >/dev/null 2>&1 || true; }

case "$SCENARIO" in
  risky)
    # MRS-08 — HIGH-risk intent (transfer_money) → approval card → approve
    # through the native confirm → validate-status flips to approved.
    sid="$(start_session mrs8)"
    [ -n "$sid" ] || fail "could not start session"
    echo "session=$sid"
    out="$("$DINA" validate --session "$sid" transfer_money "Move \$500 to savings" \
            --context '{"amount":500,"to":"savings"}' 2>&1)"
    echo "$out"
    pid="$(echo "$out" | grep -oE 'prop-intent-[a-f0-9]+' | head -1)"
    [ -n "$pid" ] || { end_session "$sid"; fail "no proposal id from validate"; }
    echo "proposal=$pid"
    maestro "$FLOWS/risky_action_approval.yaml" || { end_session "$sid"; fail "approval flow failed"; }
    sleep 3
    status="$("$DINA" validate-status --session "$sid" "$pid" 2>&1 | grep '^status:' | awk '{print $2}')"
    end_session "$sid"
    [ "$status" = "approved" ] || fail "validate-status=$status (expected approved)"
    echo "MRS-08 PASS — agent HIGH-risk action approved on device"
    ;;

  vault)
    # MRS-07 — agent ask for SENSITIVE data blocks on a vault-read approval;
    # approving on-device unblocks the ask. The ask call blocks, so run it in
    # the background and confirm it returns AFTER the approval.
    sid="$(start_session mrs7)"
    [ -n "$sid" ] || fail "could not start session"
    echo "session=$sid"
    askout="$(mktemp)"
    ( "$DINA" ask --session "$sid" "What is my blood pressure and HbA1c?" >"$askout" 2>&1 ) &
    askpid=$!
    # Wait for the ask to block on approval (or finish early).
    for _ in $(seq 1 40); do
      grep -qiE "awaiting approval|approve" "$askout" && break
      kill -0 "$askpid" 2>/dev/null || break
      sleep 1
    done
    maestro "$FLOWS/vault_read_approval.yaml" || { kill "$askpid" 2>/dev/null; end_session "$sid"; fail "approval flow failed"; }
    # The ask should now unblock and complete.
    wait "$askpid"
    echo "--- ask output ---"; cat "$askout"
    end_session "$sid"
    # Pass = the ask completed without an access-denied / timeout (approval unblocked it).
    if grep -qiE "access denied|timed out|did not complete" "$askout"; then
      rm -f "$askout"; fail "ask did not unblock cleanly"
    fi
    rm -f "$askout"
    echo "MRS-07 PASS — agent vault read gated + unblocked by on-device approval"
    ;;

  task)
    # MRS-06 — agent task delegation is gated by a MODERATE intent approval
    # before any runner executes. `--dry-run` validates the intent + raises
    # the card WITHOUT needing a configured runner, then returns (decoupled,
    # like validate). Approve on-device → the durable pending card clears.
    out="$("$DINA" task --dry-run "Fetch my new email" 2>&1)"
    echo "$out"
    pid="$(echo "$out" | grep -oE 'prop-intent-[a-f0-9]+' | head -1)"
    [ -n "$pid" ] || fail "no proposal id from task --dry-run"
    echo "proposal=$pid"
    maestro "$FLOWS/task_approval.yaml" || fail "approval flow failed"
    # `task --dry-run` deliberately ends its temporary session before it
    # returns, so a later agent-authenticated `validate-status` call cannot
    # reuse that session. The end-to-end assertion here is therefore the
    # durable approval card itself: it was created by the real task gate,
    # approved on-device, and removed from the pending inbox.
    echo "MRS-06 PASS — agent task delegation gated + approved on device"
    ;;

  deny)
    # MRS-08 (deny) — HIGH-risk intent → approval card → DENY on device →
    # validate-status flips to denied. Proves the operator can REFUSE, not just
    # approve (the other half of the gate).
    sid="$(start_session mrs8deny)"
    [ -n "$sid" ] || fail "could not start session"
    echo "session=$sid"
    out="$("$DINA" validate --session "$sid" transfer_money "Move \$500 to savings" \
            --context '{"amount":500,"to":"savings"}' 2>&1)"
    echo "$out"
    pid="$(echo "$out" | grep -oE 'prop-intent-[a-f0-9]+' | head -1)"
    [ -n "$pid" ] || { end_session "$sid"; fail "no proposal id from validate"; }
    echo "proposal=$pid"
    maestro "$FLOWS/risky_action_deny.yaml" || { end_session "$sid"; fail "deny flow failed"; }
    sleep 3
    status="$("$DINA" validate-status --session "$sid" "$pid" 2>&1 | grep '^status:' | awk '{print $2}')"
    end_session "$sid"
    [ "$status" = "denied" ] || fail "validate-status=$status (expected denied)"
    echo "MRS-08 PASS (deny) — agent HIGH-risk action DENIED on device"
    ;;

  safe)
    # MRS-08 (SAFE rung) — a SAFE action (search) auto-approves with NO card.
    # The gatekeeper policy is deterministic, so the CLI returns the verdict
    # promptly without raising an on-device approval.
    sid="$(start_session mrs-safe)"
    [ -n "$sid" ] || fail "could not start session"
    out="$("$DINA" validate --session "$sid" search "best ergonomic chair" 2>&1)"
    echo "$out"
    end_session "$sid"
    if echo "$out" | grep -qiE "approved|safe|auto|allow" && ! echo "$out" | grep -qiE "pending|await"; then
      echo "MRS-08 PASS (safe) — SAFE action auto-approved, no card"
    else
      fail "SAFE not auto-approved (out: $out)"
    fi
    ;;

  blocked)
    # MRS-08 (BLOCKED rung) — a BLOCKED action (read_vault) is denied outright,
    # NO card, no chance to approve.
    sid="$(start_session mrs-blk)"
    [ -n "$sid" ] || fail "could not start session"
    out="$("$DINA" validate --session "$sid" read_vault "health records" 2>&1)"
    echo "$out"
    end_session "$sid"
    if echo "$out" | grep -qiE "denied|blocked|not allowed|forbidden" && ! echo "$out" | grep -qiE "pending|await"; then
      echo "MRS-08 PASS (blocked) — BLOCKED action denied outright, no card"
    else
      fail "BLOCKED not denied outright (out: $out)"
    fi
    ;;

  cross_vault)
    # MRS-07 (C3) — approving a HEALTH read (session scope) must NOT grant
    # FINANCE. A finance ask on the SAME session must RE-PROMPT (each vault is
    # gated independently — a grant must not leak across personas).
    sid="$(start_session mrs-xvault)"
    [ -n "$sid" ] || fail "could not start session"
    echo "session=$sid"
    askh="$(mktemp)"
    ( "$DINA" ask --session "$sid" "What is my blood pressure and HbA1c?" >"$askh" 2>&1 ) & hpid=$!
    for _ in $(seq 1 40); do grep -qiE "awaiting approval|approve" "$askh" && break; kill -0 "$hpid" 2>/dev/null || break; sleep 1; done
    maestro "$FLOWS/vault_read_approval.yaml" || { kill "$hpid" 2>/dev/null; end_session "$sid"; fail "health approval flow failed"; }
    wait "$hpid"
    askf="$(mktemp)"; blocked=0
    ( "$DINA" ask --session "$sid" "What is my bank balance and account number?" >"$askf" 2>&1 ) & fpid=$!
    for _ in $(seq 1 40); do
      if grep -qiE "awaiting approval|approve" "$askf"; then blocked=1; break; fi
      kill -0 "$fpid" 2>/dev/null || break; sleep 1
    done
    kill "$fpid" 2>/dev/null || true
    wait "$fpid" 2>/dev/null || true
    if [ "$blocked" -eq 1 ]; then
      "$MAESTRO" --udid "$UDID" test -e PERSONA=finance "$FLOWS/vault_read_deny.yaml" \
        >/dev/null 2>&1 || { end_session "$sid"; fail "finance approval cleanup failed"; }
    fi
    end_session "$sid"; echo "--- finance ask ---"; cat "$askf"; rm -f "$askh" "$askf"
    [ "$blocked" -eq 1 ] || fail "finance ask did NOT re-prompt — cross-vault grant leak"
    echo "MRS-07 PASS (C3) — health grant did NOT leak to finance (re-prompted)"
    ;;

  new_session)
    # MRS-07 (C4) — a session-scope grant must NOT carry into a NEW session.
    # Approve health in session 1, end it, then the same ask in session 2 must
    # RE-PROMPT (session keying = the grant dies with the session).
    s1="$(start_session mrs-ns1)"
    [ -n "$s1" ] || fail "could not start session 1"
    askh="$(mktemp)"
    ( "$DINA" ask --session "$s1" "What is my HbA1c?" >"$askh" 2>&1 ) & p1=$!
    for _ in $(seq 1 40); do grep -qiE "awaiting approval|approve" "$askh" && break; kill -0 "$p1" 2>/dev/null || break; sleep 1; done
    maestro "$FLOWS/vault_read_approval.yaml" || { kill "$p1" 2>/dev/null; end_session "$s1"; fail "approval flow failed"; }
    wait "$p1"; end_session "$s1"; rm -f "$askh"
    s2="$(start_session mrs-ns2)"
    [ -n "$s2" ] || fail "could not start session 2"
    askh2="$(mktemp)"; blocked=0
    ( "$DINA" ask --session "$s2" "What is my HbA1c?" >"$askh2" 2>&1 ) & p2=$!
    for _ in $(seq 1 40); do
      if grep -qiE "awaiting approval|approve" "$askh2"; then blocked=1; break; fi
      kill -0 "$p2" 2>/dev/null || break; sleep 1
    done
    kill "$p2" 2>/dev/null || true
    wait "$p2" 2>/dev/null || true
    if [ "$blocked" -eq 1 ]; then
      "$MAESTRO" --udid "$UDID" test -e PERSONA=health "$FLOWS/vault_read_deny.yaml" \
        >/dev/null 2>&1 || { end_session "$s2"; fail "session-2 approval cleanup failed"; }
    fi
    end_session "$s2"; echo "--- session-2 ask ---"; cat "$askh2"; rm -f "$askh2"
    [ "$blocked" -eq 1 ] || fail "new session did NOT re-prompt — session grant leaked across sessions"
    echo "MRS-07 PASS (C4) — session grant did NOT carry to a new session (re-prompted)"
    ;;

  *)
    fail "unknown scenario '$SCENARIO' (expected: task | vault | risky | deny | safe | blocked | cross_vault | new_session)"
    ;;
esac
