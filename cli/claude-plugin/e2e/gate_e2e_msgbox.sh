#!/usr/bin/env bash
# HIGH-FIDELITY end-to-end test for the Dina coding-gate plugin — the REAL flow.
#
# Unlike gate_e2e.sh (fast, direct HTTP, admin shortcut), this exercises what a
# real install does:
#   • a real MsgBox relay (local by default, or DINA_E2E_MSGBOX_URL);
#   • a Core that connects as a Home Node (did:key by default, or did:plc when
#     DINA_PDS_PROVISION=1 + DINA_PDS_HANDLE are supplied);
#   • a REAL pairing ceremony: mint a code (admin's job, via the debug channel),
#     assemble a `dina1:` setup code, and `dina configure` — completing
#     /v1/pair/complete over MsgBox and registering a real device with its own key;
#   • gate calls driven through `dina gate-hook` + the supervisor over MsgBox.
#
# The only thing a script can't own is Claude Code ITSELF dispatching the hook;
# we feed the supervisor the byte-identical PreToolUse stdin it would send.
#
#   Local:  cli/claude-plugin/e2e/gate_e2e_msgbox.sh
#   Hosted test fleet:
#     DINA_E2E_MSGBOX_URL=wss://test-mailbox.dinakernel.com/ws \
#     DINA_PDS_PROVISION=1 DINA_PDS_URL=https://test-pds.dinakernel.com \
#     DINA_PDS_HANDLE=<short-unique>.test-pds.dinakernel.com \
#       cli/claude-plugin/e2e/gate_e2e_msgbox.sh
#
#   Needs:  msgbox/dina-msgbox (prebuilt) or Go; core-server deps installed; the
#           `dina` CLI importable (.venv or pip install -e cli).
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../../.." && pwd)
SUPERVISOR="$REPO/cli/claude-plugin/dina/bin/dina-gate"

# --- tooling ---------------------------------------------------------------
PY="${DINA_E2E_PYTHON:-}"; [ -z "$PY" ] && { [ -x "$REPO/.venv/bin/python" ] && PY="$REPO/.venv/bin/python" || PY="$(command -v python3 || true)"; }
DINA_BIN="${DINA_E2E_DINA:-}"; [ -z "$DINA_BIN" ] && { [ -x "$REPO/.venv/bin/dina" ] && DINA_BIN="$REPO/.venv/bin/dina" || DINA_BIN="$(command -v dina || true)"; }
RELAY_BIN="$REPO/msgbox/dina-msgbox"
EXTERNAL_RELAY_WS="${DINA_E2E_MSGBOX_URL:-}"
[ -n "$PY" ]         || { echo "SETUP FAIL: no python3"; exit 3; }
[ -n "$DINA_BIN" ]   || { echo "SETUP FAIL: 'dina' not found"; exit 3; }
[ -x "$SUPERVISOR" ] || { echo "SETUP FAIL: supervisor not executable"; exit 3; }
if [ -z "$EXTERNAL_RELAY_WS" ] && [ ! -x "$RELAY_BIN" ]; then
  command -v go >/dev/null 2>&1 || { echo "SETUP FAIL: no relay binary at $RELAY_BIN and no 'go' to build it"; exit 3; }
fi
export PYTHONPATH="$REPO/cli/src${PYTHONPATH:+:$PYTHONPATH}"

# --- workspace + teardown --------------------------------------------------
WORK=$(mktemp -d 2>/dev/null || mktemp -d -t dina-gate-msgbox)
RELAY_PORT=""; CORE_PORT=""; RELAY_PID=""; CORE_PID=""
kill_port() { local p="$1" pids; [ -z "$p" ] && return; pids=$(lsof -ti "tcp:$p" 2>/dev/null || true); [ -n "$pids" ] && kill $pids 2>/dev/null; sleep 0.4; pids=$(lsof -ti "tcp:$p" 2>/dev/null || true); [ -n "$pids" ] && kill -9 $pids 2>/dev/null; }
cleanup() {
  kill_port "$CORE_PORT"; kill_port "$RELAY_PORT"
  [ -n "$CORE_PID" ]  && kill "$CORE_PID"  2>/dev/null
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

mkdir -p "$WORK/vault" "$WORK/relay-data" "$WORK/proj" "$WORK/agent"
echo "hello, project notes" > "$WORK/proj/notes.txt"
freeport() { "$PY" -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"; }
CORE_PORT=$(freeport)
if [ -n "$EXTERNAL_RELAY_WS" ]; then
  RELAY_WS="$EXTERNAL_RELAY_WS"
else
  RELAY_PORT=$(freeport)
  RELAY_WS="ws://127.0.0.1:$RELAY_PORT/ws"
fi
CORE_URL="http://127.0.0.1:$CORE_PORT"

waitfor() { # url  label  tries
  local i; for i in $(seq 1 "${3:-60}"); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true)" = "200" ] && return 0; sleep 0.5; done
  echo "SETUP FAIL: $2 did not come up ($1)"; return 1
}

# --- 1) MsgBox relay -------------------------------------------------------
if [ -n "$EXTERNAL_RELAY_WS" ]; then
  echo "using external MsgBox relay: $RELAY_WS"
else
  echo "starting MsgBox relay on :$RELAY_PORT …"
  if [ -x "$RELAY_BIN" ]; then
    ( MSGBOX_LISTEN_ADDR=":$RELAY_PORT" MSGBOX_DATA_DIR="$WORK/relay-data" MSGBOX_LOG_LEVEL=warn "$RELAY_BIN" ) > "$WORK/relay.log" 2>&1 &
  else
    ( cd "$REPO/msgbox" && MSGBOX_LISTEN_ADDR=":$RELAY_PORT" MSGBOX_DATA_DIR="$WORK/relay-data" MSGBOX_LOG_LEVEL=warn go run ./cmd/dina-msgbox ) > "$WORK/relay.log" 2>&1 &
  fi
  RELAY_PID=$!
  waitfor "http://127.0.0.1:$RELAY_PORT/healthz" "relay" 60 || { tail -10 "$WORK/relay.log"; exit 3; }
fi

# --- 2) Core, connected to the relay (did:key, debug channel on) -----------
echo "starting Core on :$CORE_PORT, subscribing to the relay …"
( cd "$REPO/apps/home-node-lite/core-server" && \
  DINA_VAULT_DIR="$WORK/vault" DINA_CORE_HOST=127.0.0.1 DINA_CORE_PORT="$CORE_PORT" \
  DINA_MSGBOX_URL="$RELAY_WS" DINA_MSGBOX_ENABLED=true DINA_ENDPOINT_MODE=test \
  DINA_DEBUG_MODE=1 DINA_RATE_LIMIT=100000 DINA_LOG_LEVEL=info npm start ) > "$WORK/core.log" 2>&1 &
CORE_PID=$!
waitfor "$CORE_URL/healthz" "Core" 80 || { tail -20 "$WORK/core.log"; exit 3; }

# Wait for the Home Node DID (lock) AND the relay subscription.
NODE_DID=""
for _ in $(seq 1 60); do
  NODE_DID=$("$PY" -c "import json;print(json.load(open('$WORK/vault/core.lock')).get('nodeDid') or '')" 2>/dev/null || true)
  [ -n "$NODE_DID" ] && break; sleep 0.5
done
[ -n "$NODE_DID" ] || { echo "SETUP FAIL: no nodeDid in core.lock"; tail -20 "$WORK/core.log"; exit 3; }
sub=""
for _ in $(seq 1 50); do
  grep -q '"step":"msgbox_connect","status":"ok"' "$WORK/core.log" && { sub=1; break; }; sleep 0.5
done
[ -n "$sub" ] || { echo "SETUP FAIL: Core never reported msgbox_connect=connected"; grep -i msgbox "$WORK/core.log" | tail -5; exit 3; }
echo "Core up + subscribed. Home Node DID: ${NODE_DID:0:28}…"

# --- 3) mint a real CODING-agent pairing code (admin's role, via the loopback
#        debug channel). scope:coding is what the app's "pair a coding agent"
#        stamps — it's required for /v1/agent/gate (Item C), so a plain runner
#        pairing would (correctly) be denied the gate.
CODE=$(curl -s "$CORE_URL/v1/debug/dispatch" -H 'content-type: application/json' \
  -d '{"method":"POST","path":"/v1/pair/initiate","body":{"device_name":"local-agent","role":"agent","scope":"coding"}}' \
  | "$PY" -c "import json,sys;print(json.load(sys.stdin).get('code') or '')")
[ -n "$CODE" ] || { echo "SETUP FAIL: could not mint a pairing code via debug dispatch"; exit 3; }

# --- 4) assemble the dina1: setup code -------------------------------------
SETUP=$(NODE_DID="$NODE_DID" CODE="$CODE" RELAY_WS="$RELAY_WS" "$PY" -c '
import base64,json,os
p={"v":1,"msgbox_url":os.environ["RELAY_WS"],"homenode_did":os.environ["NODE_DID"],
   "transport":"msgbox","device_name":"local-agent","code":os.environ["CODE"]}
print("dina1:"+base64.urlsafe_b64encode(json.dumps(p,separators=(",",":")).encode()).decode().rstrip("="))')

# --- 5) REAL pairing over MsgBox: dina configure ---------------------------
echo "pairing the agent over MsgBox (dina configure --setup-code) …"
"$DINA_BIN" configure --headless --role agent --setup-code "$SETUP" --config-dir "$WORK/agent" > "$WORK/configure.log" 2>&1 || {
  echo "SETUP FAIL: dina configure did not complete"; cat "$WORK/configure.log"; exit 3; }
AGENT_CFG="$WORK/agent/.dina/cli"
[ -f "$AGENT_CFG/config.json" ] || { echo "SETUP FAIL: no agent config at $AGENT_CFG"; exit 3; }
grep -q '"transport_mode"[ ]*:[ ]*"msgbox"' "$AGENT_CFG/config.json" || { echo "SETUP FAIL: agent config is not msgbox transport"; cat "$AGENT_CFG/config.json"; exit 3; }
# Registration is proven by the gate cases below: an unregistered device's
# SIGNED gate call would fail auth (401), so a SAFE→allow means the real device
# authenticated over MsgBox as an authorized agent.
echo "paired over MsgBox. Running gate cases over MsgBox …"
echo ""

# --- assertions (all over the MsgBox transport) ----------------------------
export DINA_CONFIG_DIR="$AGENT_CFG"   # msgbox transport comes from config.json
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok    %-30s exit=%s\n' "$1" "$3"; else FAIL=$((FAIL+1)); printf '  FAIL  %-30s expected=%s got=%s %s\n' "$1" "$2" "$3" "${4:-}"; fi; }
with_session() {
  printf '%s' "$1" | "$PY" -c '
import json, sys
raw = sys.stdin.read()
try:
    event = json.loads(raw)
    if isinstance(event, dict) and event.get("tool_name"):
        event.setdefault("session_id", "claude-msgbox-e2e")
        print(json.dumps(event), end="")
    else:
        print(raw, end="")
except Exception:
    print(raw, end="")
'
}
gate() { with_session "$1" | "$DINA_BIN" gate-hook >"$WORK/out" 2>"$WORK/err"; echo $?; }

rc=$(gate "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"notes.txt\"},\"cwd\":\"$WORK/proj\"}");            check "SAFE project read (msgbox)"   0 "$rc"
rc=$(gate "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$WORK/vault/keyfile\"}}");                        check "BLOCKED seed read (msgbox)"   2 "$rc"
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $WORK/vault/keyfile\"}}");                      check "BLOCKED bash cat seed"        2 "$rc"
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin main\"},\"cwd\":\"$WORK/proj\"}");  check "MODERATE git push (ask)"      0 "$rc"
if grep -q '"permissionDecision": "ask"' "$WORK/out"; then PASS=$((PASS+1)); printf '  ok    %-30s\n' "  ↳ emitted ask JSON"; else FAIL=$((FAIL+1)); printf '  FAIL  %-30s (no ask JSON)\n' "  ↳ emitted ask JSON"; fi

HIGH_EVENT="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git reset --hard\"},\"cwd\":\"$WORK/proj\"}"
rc=$(gate "$HIGH_EVENT"); check "HIGH waits for Dina" 2 "$rc"
TASK_ID=$(grep -o 'coding-gate-[0-9a-f]*' "$WORK/err" | head -1)
if [ -n "$TASK_ID" ]; then PASS=$((PASS+1)); printf '  ok    %-30s\n' "  ↳ created approval task"; else FAIL=$((FAIL+1)); printf '  FAIL  %-30s (no task id)\n' "  ↳ created approval task"; fi
if [ -n "$TASK_ID" ]; then
  APPROVE_BODY=$(printf '{"method":"POST","path":"/v1/workflow/tasks/%s/approve","body":{}}' "$TASK_ID")
  # debug/dispatch forwards the routed response status as its own HTTP status
  # and returns only the routed body, so read curl's status rather than looking
  # for a synthetic `status` field in the JSON body.
  APPROVE_STATUS=$(curl -sS -o "$WORK/approve.json" -w '%{http_code}' \
    "$CORE_URL/v1/debug/dispatch" -H 'content-type: application/json' -d "$APPROVE_BODY")
  check "  ↳ owner approved task" 200 "$APPROVE_STATUS"
  rc=$(gate "$HIGH_EVENT"); check "  ↳ approved retry runs" 0 "$rc"
  rc=$(gate "$HIGH_EVENT"); check "  ↳ permit is single-use" 2 "$rc"
fi
rc=$(gate "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status\"},\"cwd\":\"$WORK/proj\"}");            check "SAFE git status"              0 "$rc"

# The supervisor over MsgBox (the exact command Claude Code runs).
DINA_DIR=$(dirname "$DINA_BIN")
rc=$(with_session "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"notes.txt\"},\"cwd\":\"$WORK/proj\"}" | PATH="$DINA_DIR:$PATH" "$SUPERVISOR" >/dev/null 2>&1; echo $?)
check "supervisor SAFE (msgbox)"     0 "$rc"
rc=$(with_session "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $WORK/vault/keyfile\"}}" | PATH="$DINA_DIR:$PATH" "$SUPERVISOR" >/dev/null 2>&1; echo $?)
check "supervisor BLOCKED (msgbox)"  2 "$rc"

# Fail-closed: an unreachable relay cannot become an allow. Override only this
# call so the same assertion works against both the local and hosted test relay.
rc=$(with_session "{\"tool_name\":\"Read\",\"tool_input\":{}}" \
  | env DINA_MSGBOX_URL="ws://127.0.0.1:1/ws" "$DINA_BIN" gate-hook \
      >"$WORK/out" 2>"$WORK/err"; echo $?)
check "relay DOWN → fail-closed" 2 "$rc"

echo ""
echo "E2E (MsgBox) summary: $PASS passed, $FAIL failed."
[ "$FAIL" -eq 0 ] || { echo "GATE E2E (MsgBox): FAILED"; exit 1; }
echo "GATE E2E (MsgBox): ALL PASSED — real relay + real pairing + real sealed-box transport"
