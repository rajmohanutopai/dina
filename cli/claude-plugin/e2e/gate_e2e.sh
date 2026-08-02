#!/usr/bin/env bash
# Repeatable end-to-end test for the Dina coding-gate plugin.
#
# Boots a THROWAWAY core-server on an ephemeral port, uses a separate admin
# did:key to mint a real single-use pairing code, pairs the CLI's did:key as an
# agent with `coding` scope, then drives real tool calls through `dina
# gate-hook` AND the supervisor against the live Core. This deliberately avoids
# the false-positive shortcut of testing the gate with an admin identity.
#
#   Usage:  cli/claude-plugin/e2e/gate_e2e.sh
#   Exit 0 iff every case matches. Needs: the repo's core-server deps installed
#   (npm install) and the `dina` CLI importable (pip install -e cli, or .venv).
#   Overrides: DINA_E2E_PORT, DINA_E2E_DINA, DINA_E2E_PYTHON.
#
# NOT set -e: we run every check and report a summary rather than abort on the
# first failure.
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../../.." && pwd)          # e2e -> claude-plugin -> cli -> repo
SUPERVISOR="$REPO/cli/claude-plugin/dina/bin/dina-gate"

# --- locate python + the dina CLI -----------------------------------------
PY="${DINA_E2E_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x "$REPO/.venv/bin/python" ]; then PY="$REPO/.venv/bin/python"; else PY="$(command -v python3 || true)"; fi
fi
DINA_BIN="${DINA_E2E_DINA:-}"
if [ -z "$DINA_BIN" ]; then
  if [ -x "$REPO/.venv/bin/dina" ]; then DINA_BIN="$REPO/.venv/bin/dina"; else DINA_BIN="$(command -v dina || true)"; fi
fi
[ -n "$PY" ]       || { echo "SETUP FAIL: no python3 found"; exit 3; }
[ -n "$DINA_BIN" ] || { echo "SETUP FAIL: 'dina' not found (pip install -e cli, or use .venv)"; exit 3; }
[ -x "$SUPERVISOR" ] || { echo "SETUP FAIL: supervisor not executable: $SUPERVISOR"; exit 3; }
export PYTHONPATH="$REPO/cli/src${PYTHONPATH:+:$PYTHONPATH}"

# --- workspace + guaranteed teardown --------------------------------------
WORK=$(mktemp -d 2>/dev/null || mktemp -d -t dina-gate-e2e)
PORT="${DINA_E2E_PORT:-}"
cleanup() {
  if [ -n "${PORT:-}" ]; then
    local pids
    pids=$(lsof -ti "tcp:$PORT" 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null
    sleep 0.5
    pids=$(lsof -ti "tcp:$PORT" 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  fi
  [ -n "${CORE_PID:-}" ] && kill "$CORE_PID" 2>/dev/null
  rm -rf "$WORK"
}
CORE_PID=""
trap cleanup EXIT INT TERM

mkdir -p "$WORK/cfg" "$WORK/vault" "$WORK/proj"
echo "hello, project notes" > "$WORK/proj/notes.txt"
export DINA_CONFIG_DIR="$WORK/cfg"
export DINA_PLUGIN_DEV_MODE=1
export DINA_AGENT_HOST_CONFIG_DIR="$WORK/cfg"
export DINA_CLI_BIN="$DINA_BIN"

# --- generate separate agent + admin identities ---------------------------
DID=$("$PY" - <<'PYEOF'
from dina_cli.signing import CLIIdentity
i = CLIIdentity(); i.generate(); print(i.did())
PYEOF
)
[ -n "$DID" ] || { echo "SETUP FAIL: could not generate a CLI identity"; exit 3; }
export ADMIN_IDENTITY_DIR="$WORK/admin-identity"
ADMIN_DID=$("$PY" - <<'PYEOF'
import os
from pathlib import Path
from dina_cli.signing import CLIIdentity
i = CLIIdentity(Path(os.environ["ADMIN_IDENTITY_DIR"]))
i.generate()
print(i.did())
PYEOF
)
[ -n "$ADMIN_DID" ] || { echo "SETUP FAIL: could not generate an admin identity"; exit 3; }

# --- pick a free port + wire the CLI to a direct local transport ----------
[ -n "$PORT" ] || PORT=$("$PY" -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); p=s.getsockname()[1]; s.close(); print(p)")
CORE_URL="http://127.0.0.1:$PORT"
export DINA_CORE_URL="$CORE_URL" DINA_TRANSPORT="direct"
cat > "$WORK/cfg/config.json" <<JSON
{"core_url":"$CORE_URL","transport_mode":"direct","device_name":"gate-e2e","role":"agent"}
JSON
chmod 600 "$WORK/cfg/config.json"

# --- boot a throwaway Core (separate admin DID, no msgbox) -----------------
echo "booting core-server on $CORE_URL (admin DID = ${ADMIN_DID:0:24}…) …"
(
  cd "$REPO/apps/home-node-lite/core-server" && \
  DINA_VAULT_DIR="$WORK/vault" DINA_ADMIN_DID="$ADMIN_DID" DINA_MSGBOX_ENABLED=0 \
  DINA_RATE_LIMIT=100000 DINA_CORE_PORT="$PORT" DINA_CORE_HOST=127.0.0.1 \
  DINA_LOG_LEVEL=warn npm start
) > "$WORK/core.log" 2>&1 &
CORE_PID=$!

up=""
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$CORE_URL/healthz" 2>/dev/null || true)
  if [ "$code" = "200" ]; then up=1; break; fi
  sleep 0.5
done
[ -n "$up" ] || { echo "SETUP FAIL: Core did not come up on $CORE_URL"; echo "--- core.log ---"; tail -20 "$WORK/core.log"; exit 3; }
[ -f "$WORK/vault/keyfile" ] || { echo "SETUP FAIL: expected the convenience seed at $WORK/vault/keyfile"; exit 3; }

# Exercise the production privilege boundary: admin fixes role+scope at
# initiate, while the unpaired agent can only redeem that one code with its
# public key. All subsequent gate calls are signed by the paired coding agent.
"$PY" - <<'PYEOF'
import json
import os
from pathlib import Path

from dina_cli.client import DinaClient
from dina_cli.config import load_config, save_config
from dina_cli.signing import CLIIdentity

client = DinaClient(load_config())
admin = CLIIdentity(Path(os.environ["ADMIN_IDENTITY_DIR"]))
admin.load()
agent = CLIIdentity()
agent.load()

client._identity = admin
issued = client._request(
    client._core,
    "POST",
    "/v1/pair/initiate",
    json={"device_name": "gate-e2e", "role": "agent", "scope": "coding"},
).json()

client._identity = agent
paired = client._request(
    client._core,
    "POST",
    "/v1/pair/complete",
    json={
        "code": issued["code"],
        "device_name": "gate-e2e",
        "public_key_multibase": agent.public_key_multibase(),
    },
).json()
save_config({
    **json.loads(Path(os.environ["DINA_CONFIG_DIR"], "config.json").read_text()),
    "device_id": paired["device_id"],
})
PYEOF
pair_rc=$?
[ "$pair_rc" -eq 0 ] || { echo "SETUP FAIL: coding-agent pairing failed"; tail -30 "$WORK/core.log"; exit 3; }
echo "Core up. Running gate cases…"
echo ""

# --- assertions ------------------------------------------------------------
PASS=0; FAIL=0
check() { # label  expected_exit  actual_exit  [note]
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok    %-28s exit=%s\n' "$1" "$3"
  else FAIL=$((FAIL+1)); printf '  FAIL  %-28s expected=%s got=%s  %s\n' "$1" "$2" "$3" "${4:-}"; fi
}
with_session() {
  printf '%s' "$1" | "$PY" -c '
import json, sys
raw = sys.stdin.read()
try:
    event = json.loads(raw)
    if isinstance(event, dict) and event.get("tool_name"):
        event.setdefault("session_id", "claude-gate-e2e")
        print(json.dumps(event), end="")
    else:
        print(raw, end="")
except Exception:
    print(raw, end="")
'
}
gate() { with_session "$1" | "$DINA_BIN" gate-hook >"$WORK/out" 2>"$WORK/err"; echo $?; }

# --- default profile (network_protection) ---------------------------------
# Pairing selects the default owner profile. Dina always enforces the kernel
# boundary (vault/seed/key paths); ordinary dev work — including VCS writes —
# is delegated to the interactive owner's host permission UI: silent exit 0
# with NO hook JSON, so Claude/Codex applies its own confirmation rules.
rc=$(gate "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"notes.txt\"},\"cwd\":\"$WORK/proj\"}");            check "SAFE project read"       0 "$rc"
rc=$(gate "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$WORK/vault/keyfile\"}}");                        check "BLOCKED seed read"       2 "$rc"
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $WORK/vault/keyfile\"}}");                      check "BLOCKED bash cat seed"   2 "$rc"
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin main\"},\"cwd\":\"$WORK/proj\"}");  check "default: git push host-managed" 0 "$rc"
if grep -q '"hookSpecificOutput"' "$WORK/out"; then FAIL=$((FAIL+1)); printf '  FAIL  %-28s (unexpected hook JSON under default profile)\n' "  ↳ silent host delegation"; else PASS=$((PASS+1)); printf '  ok    %-28s\n' "  ↳ silent host delegation"; fi
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git reset --hard\",\"description\":\"Reset the repository\"},\"cwd\":\"$WORK/proj\"}"); check "default: git reset host-managed" 0 "$rc"

# --- owner escalates to full_supervision (versioned owner-console route) ---
# The owner surface is the loopback console capability, exactly as the product
# uses it: `x-dina-owner-capability` from `<vaultDir>/owner_capability`.
OWNER_CAP=$(cat "$WORK/vault/owner_capability" 2>/dev/null || true)
if [ -z "$OWNER_CAP" ]; then
  FAIL=$((FAIL+1)); printf '  FAIL  %-28s (no owner_capability in vault dir)\n' "owner escalates to full_supervision"
else
  POLICY_VERSION=$(curl -fsS -H "x-dina-owner-capability: $OWNER_CAP" \
      "$CORE_URL/v1/owner/agent-policies" | \
    DINA_E2E_AGENT_DID="$DID" "$PY" -c '
import json, os, sys
policies = json.load(sys.stdin)["policies"]
me = [p for p in policies if p["agent_did"] == os.environ["DINA_E2E_AGENT_DID"]]
print(me[0]["policy_version"] if me else "")
')
  esc_rc=1
  if [ -n "$POLICY_VERSION" ]; then
    curl -fsS -X PUT \
        -H "x-dina-owner-capability: $OWNER_CAP" \
        -H "content-type: application/json" \
        -d "{\"profile\":\"full_supervision\",\"expected_version\":$POLICY_VERSION}" \
        "$CORE_URL/v1/owner/agent-policies/$DID" >"$WORK/escalate.out" 2>&1 && \
      grep -q '"profile":"full_supervision"' "$WORK/escalate.out" && esc_rc=0
  fi
  check "owner escalates to full_supervision" 0 "$esc_rc" "$(tail -c 200 "$WORK/escalate.out" 2>/dev/null)"
fi

# --- full_supervision: MODERATE asks locally; HIGH waits for Dina ----------
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin main\"},\"cwd\":\"$WORK/proj\"}");  check "MODERATE git push (ask)" 0 "$rc"
if grep -q '"permissionDecision": "ask"' "$WORK/out"; then PASS=$((PASS+1)); printf '  ok    %-28s\n' "  ↳ emitted ask JSON"; else FAIL=$((FAIL+1)); printf '  FAIL  %-28s (no ask JSON on stdout)\n' "  ↳ emitted ask JSON"; fi

# HIGH is not a local Claude confirmation: the first attempt blocks and creates
# a Dina task. Owner approval mints a payload-bound, single-use permit; the exact
# retry consumes it even if Claude rewrites presentation-only text, and a third
# attempt blocks again.
HIGH_EVENT="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git reset --hard\",\"description\":\"Reset the repository\"},\"cwd\":\"$WORK/proj\"}"
HIGH_RETRY="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git reset --hard\",\"description\":\"Discard local changes\"},\"cwd\":\"$WORK/proj\"}"
rc=$(gate "$HIGH_EVENT"); check "HIGH waits for Dina" 2 "$rc"
TASK_ID=$(grep -o 'coding-gate-[0-9a-f]*' "$WORK/err" | head -1)
if [ -n "$TASK_ID" ]; then PASS=$((PASS+1)); printf '  ok    %-28s\n' "  ↳ created approval task"; else FAIL=$((FAIL+1)); printf '  FAIL  %-28s (no task id)\n' "  ↳ created approval task"; fi
if [ -n "$TASK_ID" ]; then
  DINA_E2E_TASK_ID="$TASK_ID" "$PY" - <<'PYEOF' >/dev/null 2>&1
import os
from pathlib import Path
from dina_cli.client import DinaClient
from dina_cli.config import load_config
from dina_cli.signing import CLIIdentity

client = DinaClient(load_config())
admin = CLIIdentity(Path(os.environ["ADMIN_IDENTITY_DIR"]))
admin.load()
client._identity = admin
client._request(
    client._core,
    "POST",
    f"/v1/workflow/tasks/{os.environ['DINA_E2E_TASK_ID']}/approve",
    json={},
)
PYEOF
  approve_rc=$?
  check "  ↳ owner approved task" 0 "$approve_rc"
  rc=$(gate "$HIGH_RETRY"); check "  ↳ metadata-safe retry runs" 0 "$rc"
  rc=$(gate "$HIGH_RETRY"); check "  ↳ permit is single-use" 2 "$rc"
fi
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status\"},\"cwd\":\"$WORK/proj\"}");            check "SAFE git status"         0 "$rc"
rc=$(gate "{ this is not json");                                                                                    check "malformed stdin"         2 "$rc"
rc=$(gate "{\"tool_input\":{}}");                                                                                   check "missing tool_name"       2 "$rc"

# Fail-closed: Core unreachable (dead port) must BLOCK, never allow.
rc=$(with_session "{\"tool_name\":\"Read\",\"tool_input\":{}}" | env DINA_CORE_URL="http://127.0.0.1:1" "$DINA_BIN" gate-hook >/dev/null 2>&1; echo $?)
check "unreachable Core (fail-closed)" 2 "$rc"

# The supervisor — the exact command Claude Code runs. Needs `dina` on PATH.
DINA_DIR=$(dirname "$DINA_BIN")
rc=$(with_session "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"notes.txt\"},\"cwd\":\"$WORK/proj\"}" | PATH="$DINA_DIR:$PATH" "$SUPERVISOR" >/dev/null 2>&1; echo $?)
check "supervisor SAFE"         0 "$rc"
rc=$(with_session "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $WORK/vault/keyfile\"}}" | PATH="$DINA_DIR:$PATH" "$SUPERVISOR" >/dev/null 2>&1; echo $?)
check "supervisor BLOCKED"      2 "$rc"
# Supervisor with dina NOT on PATH → block (never run a tool ungated).
rc=$(printf '%s' "{\"tool_name\":\"Read\",\"tool_input\":{}}" | env -i PATH="$WORK" "$SUPERVISOR" >/dev/null 2>&1; echo $?)
check "supervisor missing-dina" 2 "$rc"

echo ""
echo "E2E summary: $PASS passed, $FAIL failed."
[ "$FAIL" -eq 0 ] || { echo "GATE E2E: FAILED"; exit 1; }
echo "GATE E2E: ALL PASSED"
