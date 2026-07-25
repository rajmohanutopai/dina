#!/usr/bin/env bash
# Hosted, two-Home-Node E2E for the HIGH-risk coding approval bridge.
#
# This is intentionally stronger than a route or worker test. It proves:
#   coding agent -> laptop Core -> hosted MsgBox -> phone Core -> owner approval
#   -> authenticated decision sync -> laptop restart -> one exact retry allowed.
#
# The test provisions two throwaway did:plc identities on the test PDS. It
# requires the repository Python venv and installed workspace dependencies.
#
#   cli/claude-plugin/e2e/phone_approval_e2e_msgbox.sh
#
# Optional overrides:
#   DINA_E2E_MSGBOX_URL
#   DINA_E2E_PDS_URL
#   DINA_E2E_PDS_DOMAIN
#   DINA_E2E_PHONE_HANDLE
#   DINA_E2E_LAPTOP_HANDLE
#   DINA_E2E_KEEP_WORK=1   # retains credentials/logs on failure; use carefully
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PY="${DINA_E2E_PYTHON:-$REPO/.venv/bin/python}"
DINA="${DINA_E2E_DINA:-$REPO/.venv/bin/dina}"
RELAY="${DINA_E2E_MSGBOX_URL:-wss://test-mailbox.dinakernel.com/ws}"
PDS_URL="${DINA_E2E_PDS_URL:-https://test-pds.dinakernel.com}"
PDS_DOMAIN="${DINA_E2E_PDS_DOMAIN:-test-pds.dinakernel.com}"
STAMP="$(date +%s)$$"
PHONE_HANDLE="${DINA_E2E_PHONE_HANDLE:-ph${STAMP}.${PDS_DOMAIN}}"
LAPTOP_HANDLE="${DINA_E2E_LAPTOP_HANDLE:-lp${STAMP}.${PDS_DOMAIN}}"
WORK="$(mktemp -d /tmp/dina-phone-approval.XXXXXX)"
PHONE_PORT=""
LAPTOP_PORT=""
PHONE_PID=""
LAPTOP_PID=""
KEEP_ON_FAIL="${DINA_E2E_KEEP_WORK:-0}"

freeport() {
  "$PY" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}
kill_port() {
  local port="$1" pids
  [ -z "$port" ] && return 0
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  [ -z "$pids" ] || kill $pids 2>/dev/null || true
  sleep 0.5
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
}
cleanup() {
  kill_port "$PHONE_PORT"
  kill_port "$LAPTOP_PORT"
  [ -z "$PHONE_PID" ] || kill "$PHONE_PID" 2>/dev/null || true
  [ -z "$LAPTOP_PID" ] || kill "$LAPTOP_PID" 2>/dev/null || true
  if [ "$KEEP_ON_FAIL" -eq 1 ]; then
    echo "Preserved failed harness at $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $*" >&2
  echo "--- phone log ---" >&2
  tail -80 "$WORK/phone.log" 2>/dev/null >&2 || true
  echo "--- laptop log ---" >&2
  tail -120 "$WORK/laptop.log" 2>/dev/null >&2 || true
  exit 1
}

wait_health() {
  local url="$1" label="$2" tries="${3:-160}" i
  for i in $(seq 1 "$tries"); do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' "$url/healthz" 2>/dev/null || true)" = 200 ] && return 0
    sleep 0.5
  done
  fail "$label did not become healthy"
}

wait_log() {
  local file="$1" pattern="$2" label="$3" tries="${4:-120}" i
  for i in $(seq 1 "$tries"); do
    grep -Eq "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.5
  done
  fail "$label not observed: $pattern"
}

node_did() {
  "$PY" -c "import json; print(json.load(open('$1/core.lock'))['nodeDid'])"
}

debug_dispatch() {
  local url="$1" payload="$2"
  curl -sS "$url/v1/debug/dispatch" -H 'content-type: application/json' -d "$payload"
}

setup_code() {
  NODE_DID="$1" CODE="$2" DEVICE="$3" RELAY="$RELAY" "$PY" -c '
import base64,json,os
p={"v":1,"msgbox_url":os.environ["RELAY"],"homenode_did":os.environ["NODE_DID"],"transport":"msgbox","device_name":os.environ["DEVICE"],"code":os.environ["CODE"]}
print("dina1:"+base64.urlsafe_b64encode(json.dumps(p,separators=(",",":")).encode()).decode().rstrip("="))'
}

start_phone() {
  : > "$WORK/phone.log"
  (
    cd "$REPO/apps/home-node-lite/core-server" || exit 1
    DINA_VAULT_DIR="$WORK/phone-vault" \
    DINA_CORE_HOST=127.0.0.1 DINA_CORE_PORT="$PHONE_PORT" \
    DINA_MSGBOX_URL="$RELAY" DINA_MSGBOX_ENABLED=true \
    DINA_ENDPOINT_MODE=test DINA_DEBUG_MODE=1 DINA_RATE_LIMIT=100000 DINA_LOG_LEVEL=info \
    DINA_PDS_PROVISION=1 DINA_PDS_URL="$PDS_URL" \
    DINA_PDS_HANDLE="$PHONE_HANDLE" npm start
  ) > "$WORK/phone.log" 2>&1 &
  PHONE_PID=$!
  wait_health "http://127.0.0.1:$PHONE_PORT" phone
  wait_log "$WORK/phone.log" '"step":"msgbox_connect","status":"ok"' 'phone MsgBox subscription'
}

start_laptop() {
  local with_setup="$1"
  : > "$WORK/laptop.log"
  if [ "$with_setup" = yes ]; then
    (
      cd "$REPO/apps/home-node-lite/core-server" || exit 1
      DINA_VAULT_DIR="$WORK/laptop-vault" \
      DINA_CORE_HOST=127.0.0.1 DINA_CORE_PORT="$LAPTOP_PORT" \
      DINA_MSGBOX_URL="$RELAY" DINA_MSGBOX_ENABLED=true \
      DINA_ENDPOINT_MODE=test DINA_DEBUG_MODE=1 DINA_RATE_LIMIT=100000 DINA_LOG_LEVEL=info \
      DINA_PDS_PROVISION=1 DINA_PDS_URL="$PDS_URL" \
      DINA_PDS_HANDLE="$LAPTOP_HANDLE" \
      DINA_APPROVAL_PHONE_SETUP_CODE="$PHONE_SETUP" npm start
    ) > "$WORK/laptop.log" 2>&1 &
  else
    (
      cd "$REPO/apps/home-node-lite/core-server" || exit 1
      DINA_VAULT_DIR="$WORK/laptop-vault" \
      DINA_CORE_HOST=127.0.0.1 DINA_CORE_PORT="$LAPTOP_PORT" \
      DINA_MSGBOX_URL="$RELAY" DINA_MSGBOX_ENABLED=true \
      DINA_ENDPOINT_MODE=test DINA_DEBUG_MODE=1 DINA_RATE_LIMIT=100000 DINA_LOG_LEVEL=info \
      DINA_PDS_PROVISION=1 DINA_PDS_URL="$PDS_URL" \
      DINA_PDS_HANDLE="$LAPTOP_HANDLE" npm start
    ) > "$WORK/laptop.log" 2>&1 &
  fi
  LAPTOP_PID=$!
  wait_health "http://127.0.0.1:$LAPTOP_PORT" laptop
  wait_log "$WORK/laptop.log" '"step":"msgbox_connect","status":"ok"' 'laptop MsgBox subscription'
  wait_log "$WORK/laptop.log" \
    'owner-phone approval synchronization (enabled|restored)' \
    'phone approval worker'
}

[ -x "$PY" ] || fail "missing $PY"
[ -x "$DINA" ] || fail "missing $DINA"
export PYTHONPATH="$REPO/cli/src${PYTHONPATH:+:$PYTHONPATH}"
mkdir -p "$WORK/phone-vault" "$WORK/laptop-vault" "$WORK/agent" "$WORK/proj"
echo test > "$WORK/proj/notes.txt"
PHONE_PORT="$(freeport)"
LAPTOP_PORT="$(freeport)"
PHONE_URL="http://127.0.0.1:$PHONE_PORT"
LAPTOP_URL="http://127.0.0.1:$LAPTOP_PORT"

echo "[1/10] Boot phone-side Home Node with real test-PDS identity"
start_phone
PHONE_DID="$(node_did "$WORK/phone-vault")"
echo "       phone: $PHONE_DID"

echo "[2/10] Mint phone-side coding-agent pairing authority"
PHONE_CODE="$(debug_dispatch "$PHONE_URL" '{"method":"POST","path":"/v1/pair/initiate","body":{"device_name":"Laptop approvals","role":"agent","scope":"coding"}}' | "$PY" -c 'import json,sys;print(json.load(sys.stdin).get("code", ""))')"
[ -n "$PHONE_CODE" ] || fail "phone pairing code missing"
PHONE_SETUP="$(setup_code "$PHONE_DID" "$PHONE_CODE" 'Laptop approvals')"

echo "[3/10] Boot laptop Home Node and pair its dedicated approval identity"
start_laptop yes
LAPTOP_DID="$(node_did "$WORK/laptop-vault")"
echo "       laptop: $LAPTOP_DID"

echo "[4/10] Pair a real coding agent to the laptop over hosted MsgBox"
LAPTOP_CODE="$(debug_dispatch "$LAPTOP_URL" '{"method":"POST","path":"/v1/pair/initiate","body":{"device_name":"E2E coding agent","role":"agent","scope":"coding"}}' | "$PY" -c 'import json,sys;print(json.load(sys.stdin).get("code", ""))')"
[ -n "$LAPTOP_CODE" ] || fail "laptop pairing code missing"
LAPTOP_SETUP="$(setup_code "$LAPTOP_DID" "$LAPTOP_CODE" 'E2E coding agent')"
"$DINA" configure --headless --role agent --setup-code "$LAPTOP_SETUP" --config-dir "$WORK/agent" > "$WORK/configure.log" 2>&1 || fail "coding agent pairing failed"
export DINA_CONFIG_DIR="$WORK/agent/.dina/cli"

HIGH_EVENT="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git reset --hard\"},\"cwd\":\"$WORK/proj\",\"session_id\":\"claude-phone-e2e\"}"
gate() {
  printf '%s' "$HIGH_EVENT" | "$DINA" gate-hook > "$WORK/gate.out" 2> "$WORK/gate.err"
}

echo "[5/10] Submit HIGH-risk action; verify fail-closed pending state"
if gate; then fail "HIGH-risk action unexpectedly allowed before approval"; else GATE_RC=$?; fi
[ "$GATE_RC" -eq 2 ] || fail "HIGH-risk initial gate returned $GATE_RC, expected 2"
TASK_ID="$(grep -o 'coding-gate-[0-9a-f]*' "$WORK/gate.err" | head -1 || true)"
[ -n "$TASK_ID" ] || fail "source coding task id not found"
echo "       source task: $TASK_ID"

echo "[6/10] Wait for authenticated mirror on phone"
MIRROR_ID=""
for _ in $(seq 1 50); do
  PHONE_TASKS="$(debug_dispatch "$PHONE_URL" '{"method":"GET","path":"/v1/workflow/tasks","query":{"kind":"approval","state":"pending_approval","limit":"50"}}' || true)"
  MIRROR_ID="$(printf '%s' "$PHONE_TASKS" | "$PY" -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
for t in d.get("tasks",[]):
    try: p=json.loads(t.get("payload", ""))
    except Exception: continue
    if p.get("type")=="remote_coding_gate_v1": print(t.get("id", "")); break
' 2>/dev/null || true)"
  [ -n "$MIRROR_ID" ] && break
  sleep 1
 done
[ -n "$MIRROR_ID" ] || fail "phone mirror never appeared"
echo "       mirror task: $MIRROR_ID"

echo "[7/10] Approve only on phone-side owner surface"
APPROVE_PAYLOAD="$(printf '{\"method\":\"POST\",\"path\":\"/v1/workflow/tasks/%s/approve\",\"body\":{}}' "$MIRROR_ID")"
APPROVE_STATUS="$(
  curl -sS -o "$WORK/phone-approve.json" -w '%{http_code}' \
    "$PHONE_URL/v1/debug/dispatch" \
    -H 'content-type: application/json' \
    -d "$APPROVE_PAYLOAD"
)"
[ "$APPROVE_STATUS" = 200 ] || fail "phone approval failed (HTTP $APPROVE_STATUS)"

echo "[8/10] Wait for laptop to authenticate decision and persist queued receipt"
SOURCE_STATE=""
for _ in $(seq 1 50); do
  SOURCE_JSON="$(debug_dispatch "$LAPTOP_URL" "$(printf '{\"method\":\"GET\",\"path\":\"/v1/workflow/tasks/%s\"}' "$TASK_ID")" || true)"
  SOURCE_STATE="$(printf '%s' "$SOURCE_JSON" | "$PY" -c 'import json,sys
try: print(json.load(sys.stdin).get("task",{}).get("status", ""))
except Exception: print("")' 2>/dev/null || true)"
  [ "$SOURCE_STATE" = queued ] && break
  sleep 1
 done
[ "$SOURCE_STATE" = queued ] || fail "laptop source task did not become queued (last=$SOURCE_STATE)"

echo "[9/10] Restart laptop with no setup code; verify persisted phone target + receipt"
kill_port "$LAPTOP_PORT"
[ -z "$LAPTOP_PID" ] || kill "$LAPTOP_PID" 2>/dev/null || true
LAPTOP_PID=""
sleep 1
start_laptop no
RESTART_DID="$(node_did "$WORK/laptop-vault")"
[ "$RESTART_DID" = "$LAPTOP_DID" ] || fail "laptop DID changed across restart"

echo "[10/10] Exact retry allowed once; second retry denied"
if gate; then FIRST_RC=0; else FIRST_RC=$?; fi
[ "$FIRST_RC" -eq 0 ] || fail "approved durable retry returned $FIRST_RC"
if gate; then SECOND_RC=0; else SECOND_RC=$?; fi
[ "$SECOND_RC" -eq 2 ] || fail "second retry returned $SECOND_RC, expected 2"

printf '\nLIVE TWO-NODE PHONE APPROVAL E2E: PASS\n'
printf '  phone DID:  %s\n' "$PHONE_DID"
printf '  laptop DID: %s\n' "$LAPTOP_DID"
printf '  mirror:     %s\n' "$MIRROR_ID"
printf '  receipt survived restart; retry exits: %s then %s\n' "$FIRST_RC" "$SECOND_RC"
