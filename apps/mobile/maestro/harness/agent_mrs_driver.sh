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
# Usage (from repo root):
#   apps/mobile/maestro/harness/agent_mrs_driver.sh risky   # MRS-08
#   apps/mobile/maestro/harness/agent_mrs_driver.sh vault   # MRS-07
#
# Env overrides: DINA, MAESTRO, UDID.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

DINA="${DINA:-.venv/bin/dina}"
MAESTRO="${MAESTRO:-/opt/homebrew/opt/maestro/bin/maestro}"
UDID="${UDID:-6D57099D-48DA-430D-B4BB-1A2BF1EBACB7}"
FLOWS="apps/mobile/maestro/agent"
SCENARIO="${1:-risky}"

fail() { echo "MRS-agent[$SCENARIO] FAIL — $1"; exit 1; }
maestro() { "$MAESTRO" --udid "$UDID" test "$1" 2>&1 | grep -vE "WARNING|^$"; }

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
    status="$("$DINA" validate-status "$pid" 2>&1 | grep '^status:' | awk '{print $2}')"
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
    # like validate). Approve on-device → validate-status flips to approved.
    out="$("$DINA" task --dry-run "Fetch my new email" 2>&1)"
    echo "$out"
    pid="$(echo "$out" | grep -oE 'prop-intent-[a-f0-9]+' | head -1)"
    [ -n "$pid" ] || fail "no proposal id from task --dry-run"
    echo "proposal=$pid"
    maestro "$FLOWS/task_approval.yaml" || fail "approval flow failed"
    sleep 3
    status="$("$DINA" validate-status "$pid" 2>&1 | grep '^status:' | awk '{print $2}')"
    [ "$status" = "approved" ] || fail "validate-status=$status (expected approved)"
    echo "MRS-06 PASS — agent task delegation gated + approved on device"
    ;;

  *)
    fail "unknown scenario '$SCENARIO' (expected: risky | vault | task)"
    ;;
esac
