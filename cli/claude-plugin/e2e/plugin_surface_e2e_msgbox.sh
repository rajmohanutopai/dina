#!/usr/bin/env bash
# Hosted Home Node Lite acceptance test for the coding-agent plugin surface.
#
# This boots two real HNL Core processes and one HNL Brain process, provisions
# throwaway did:plc identities on the deployed test PDS, pairs a real
# dina-agent identity over hosted MsgBox, and exercises:
#
#   session + memory + vault metadata + reminders + Ask
#   service publish + AppView discovery + D2D Tier-1 invocation
#   owner-approved PeerLens publish + AppView discovery
#   owner-approved delegation + Talk delivery to a second HNL node
#
# Mobile is not involved. The only deterministic substitute is the scripted
# LLM; identity, signing, storage, PDS, AppView, MsgBox, and workflow approvals
# are the real product paths.
#
#   cli/claude-plugin/e2e/plugin_surface_e2e_msgbox.sh
#
# Optional overrides:
#   DINA_E2E_MSGBOX_URL
#   DINA_E2E_PDS_URL
#   DINA_E2E_PDS_DOMAIN
#   DINA_E2E_KEEP_WORK=1   # retains credentials/logs; use carefully
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PY="${DINA_E2E_PYTHON:-$REPO/.venv/bin/python}"
DINA="${DINA_E2E_DINA:-$REPO/.venv/bin/dina}"
RELAY="${DINA_E2E_MSGBOX_URL:-wss://test-mailbox.dinakernel.com/ws}"
PDS_URL="${DINA_E2E_PDS_URL:-https://test-pds.dinakernel.com}"
PDS_DOMAIN="${DINA_E2E_PDS_DOMAIN:-test-pds.dinakernel.com}"
STAMP="$(date +%s)$$"
# The deployed test PDS applies a conservative total-handle length cap. Keep
# generated labels short while retaining enough entropy from timestamp + PID.
OWNER_HANDLE="pn${STAMP}.${PDS_DOMAIN}"
RECEIVER_HANDLE="pr${STAMP}.${PDS_DOMAIN}"
WORK="$(mktemp -d /tmp/dina-plugin-surface.XXXXXX)"
OWNER_PORT=""
RECEIVER_PORT=""
BRAIN_PORT=""
OWNER_PID=""
RECEIVER_PID=""
BRAIN_PID=""
KEEP_ON_FAIL="${DINA_E2E_KEEP_WORK:-0}"
PASSED=0

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
  kill_port "$BRAIN_PORT"
  kill_port "$OWNER_PORT"
  kill_port "$RECEIVER_PORT"
  [ -z "$BRAIN_PID" ] || kill "$BRAIN_PID" 2>/dev/null || true
  [ -z "$OWNER_PID" ] || kill "$OWNER_PID" 2>/dev/null || true
  [ -z "$RECEIVER_PID" ] || kill "$RECEIVER_PID" 2>/dev/null || true
  if [ "$KEEP_ON_FAIL" -eq 1 ] && [ "$PASSED" -ne 1 ]; then
    echo "Preserved failed harness at $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $*" >&2
  echo "--- owner Core log ---" >&2
  tail -100 "$WORK/owner.log" 2>/dev/null >&2 || true
  echo "--- Brain log ---" >&2
  tail -100 "$WORK/brain.log" 2>/dev/null >&2 || true
  echo "--- receiver Core log ---" >&2
  tail -80 "$WORK/receiver.log" 2>/dev/null >&2 || true
  exit 1
}

wait_health() {
  local url="$1" label="$2" tries="${3:-180}" i
  for i in $(seq 1 "$tries"); do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' "$url/healthz" 2>/dev/null || true)" = 200 ] && return 0
    sleep 0.5
  done
  fail "$label did not become healthy"
}

wait_log() {
  local file="$1" pattern="$2" label="$3" tries="${4:-180}" i
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

[ -x "$PY" ] || fail "missing $PY"
[ -x "$DINA" ] || fail "missing $DINA"
export PYTHONPATH="$REPO/cli/src${PYTHONPATH:+:$PYTHONPATH}"
mkdir -p \
  "$WORK/owner-vault" \
  "$WORK/receiver-vault" \
  "$WORK/brain-keys" \
  "$WORK/agent" \
  "$WORK/runner"

OWNER_PORT="$(freeport)"
RECEIVER_PORT="$(freeport)"
BRAIN_PORT="$(freeport)"
OWNER_URL="http://127.0.0.1:$OWNER_PORT"
RECEIVER_URL="http://127.0.0.1:$RECEIVER_PORT"
BRAIN_URL="http://127.0.0.1:$BRAIN_PORT"

echo "[1/11] Create a dedicated Brain service identity"
BRAIN_DID="$(
  KEY_PATH="$WORK/brain-keys/brain.ed25519" "$PY" - <<'PY'
import os
from pathlib import Path
import base58
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

path = Path(os.environ["KEY_PATH"])
seed = os.urandom(32)
path.write_bytes(seed)
path.chmod(0o600)
public = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
    Encoding.Raw, PublicFormat.Raw
)
print("did:key:z" + base58.b58encode(b"\xed\x01" + public).decode("ascii"))
PY
)"
[ -n "$BRAIN_DID" ] || fail "Brain DID generation failed"

SCRIPTED_PATH="$WORK/scripted.json" STAMP="$STAMP" "$PY" - <<'PY'
import json
import os
import time

stamp = os.environ["STAMP"]
memory_code = f"plugin-memory-{stamp}"
# Long enough to stay valid while the three HNL processes boot and the coding
# agent pairs, but short enough for Brain's 30-second fire loop to exercise the
# real pending -> fired transition during this acceptance run.
reminder_due = int(time.time() * 1000) + 90_000
rules = [
    # This field exists only in vault_search's result envelope. Keeping it
    # before the question rule makes the second agentic turn converge while
    # proving that Ask actually executed the retrieval tool.
    {
        "match": '"personas_searched":',
        "content": f"The saved plugin acceptance code is {memory_code}.",
    },
    # schedule_reminder's tool result appears only on the second Remember turn.
    {
        "match": '"status":"scheduled"',
        "content": "The memory and its reminder are ready.",
    },
    {
        "match": "what is the saved plugin acceptance code",
        "content": "",
        "toolCalls": [
            {
                "id": "e2e-vault-search",
                "name": "vault_search",
                "arguments": {"query": memory_code, "persona": "general"},
            }
        ],
    },
    {
        "match": "plugin acceptance timed memory",
        "content": "",
        "toolCalls": [
            {
                "id": "e2e-reminder-route",
                "name": "route_to_persona",
                "arguments": {"persona": "general", "secondary": []},
            },
            {
                "id": "e2e-reminder-create",
                "name": "schedule_reminder",
                "arguments": {
                    "message": f"Plugin acceptance automatic reminder {stamp}",
                    "due_at": reminder_due,
                    "persona": "general",
                },
            },
        ],
    },
    {
        "match": "plugin acceptance memory",
        "content": "Memory classified for the general vault.",
    },
    {
        "match": "route 42",
        "content": json.dumps(
            {
                "status": "on_route",
                "eta_minutes": 7,
                "route_name": "Route 42",
                "vehicle_type": "Bus",
                "stop_name": "Castro",
                "stop_distance_m": 1450,
                "message": "Route 42 is on route. The next bus reaches Castro in about 7 minutes.",
            },
            separators=(",", ":"),
        ),
    },
    {
        "match": "",
        "content": '{"status":"not_found","message":"No matching service."}',
    },
]
with open(os.environ["SCRIPTED_PATH"], "w", encoding="utf-8") as handle:
    json.dump({"rules": rules}, handle, separators=(",", ":"))
PY

echo "[2/11] Boot owner HNL Core with test-PDS identity and hosted MsgBox"
(
  cd "$REPO/apps/home-node-lite/core-server" || exit 1
  DINA_VAULT_DIR="$WORK/owner-vault" \
  DINA_CORE_HOST=127.0.0.1 DINA_CORE_PORT="$OWNER_PORT" \
  DINA_BRAIN_DID="$BRAIN_DID" DINA_BRAIN_URL="$BRAIN_URL" \
  DINA_MSGBOX_URL="$RELAY" DINA_MSGBOX_ENABLED=true \
  DINA_ENDPOINT_MODE=test DINA_DEBUG_MODE=1 \
  DINA_RATE_LIMIT=100000 DINA_LOG_LEVEL=info \
  DINA_PDS_PROVISION=1 DINA_PDS_URL="$PDS_URL" \
  DINA_PDS_HANDLE="$OWNER_HANDLE" npm start
) > "$WORK/owner.log" 2>&1 &
OWNER_PID=$!
wait_health "$OWNER_URL" "owner Core"
wait_log "$WORK/owner.log" '"step":"msgbox_connect","status":"ok"' "owner MsgBox subscription"
OWNER_DID="$(node_did "$WORK/owner-vault")"

echo "[3/11] Boot receiver HNL Core with a second test identity"
(
  cd "$REPO/apps/home-node-lite/core-server" || exit 1
  DINA_VAULT_DIR="$WORK/receiver-vault" \
  DINA_CORE_HOST=127.0.0.1 DINA_CORE_PORT="$RECEIVER_PORT" \
  DINA_MSGBOX_URL="$RELAY" DINA_MSGBOX_ENABLED=true \
  DINA_ENDPOINT_MODE=test DINA_DEBUG_MODE=1 \
  DINA_RATE_LIMIT=100000 DINA_LOG_LEVEL=info \
  DINA_PDS_PROVISION=1 DINA_PDS_URL="$PDS_URL" \
  DINA_PDS_HANDLE="$RECEIVER_HANDLE" npm start
) > "$WORK/receiver.log" 2>&1 &
RECEIVER_PID=$!
wait_health "$RECEIVER_URL" "receiver Core"
wait_log "$WORK/receiver.log" '"step":"msgbox_connect","status":"ok"' "receiver MsgBox subscription"
RECEIVER_DID="$(node_did "$WORK/receiver-vault")"

echo "[4/11] Boot HNL Brain with deterministic Ask and Tier-1 execution"
(
  cd "$REPO/apps/home-node-lite/brain-server" || exit 1
  DINA_BRAIN_HOST=127.0.0.1 DINA_BRAIN_PORT="$BRAIN_PORT" \
  DINA_CORE_URL="$OWNER_URL" \
  DINA_SERVICE_KEY_DIR="$WORK/brain-keys" \
  DINA_BRAIN_SERVICE_KEY_FILE=brain.ed25519 \
  DINA_BRAIN_DID="$BRAIN_DID" DINA_OWNER_DID="$OWNER_DID" \
  DINA_ENDPOINT_MODE=test DINA_BRAIN_LOG_LEVEL=info \
  DINA_BRAIN_LLM_PROVIDER=scripted \
  DINA_BRAIN_SCRIPTED_LLM_FILE="$WORK/scripted.json" npm start
) > "$WORK/brain.log" 2>&1 &
BRAIN_PID=$!
wait_health "$BRAIN_URL" "Brain"

echo "[5/11] Pair separate coding-agent and delegation-runner identities"
PAIR_CODE="$(
  debug_dispatch "$OWNER_URL" \
    '{"method":"POST","path":"/v1/pair/initiate","body":{"device_name":"Plugin surface E2E","role":"agent","scope":"coding"}}' \
    | "$PY" -c 'import json,sys;print(json.load(sys.stdin).get("code", ""))'
)"
[ -n "$PAIR_CODE" ] || fail "pairing code missing"
SETUP_CODE="$(setup_code "$OWNER_DID" "$PAIR_CODE" "Plugin surface E2E")"
"$DINA" configure \
  --headless \
  --role agent \
  --setup-code "$SETUP_CODE" \
  --config-dir "$WORK/agent" > "$WORK/configure.log" 2>&1 \
  || fail "agent pairing failed"
export DINA_CONFIG_DIR="$WORK/agent/.dina/cli"

RUNNER_PAIR_CODE="$(
  debug_dispatch "$OWNER_URL" \
    '{"method":"POST","path":"/v1/pair/initiate","body":{"device_name":"Plugin runner E2E","role":"agent","scope":"runner"}}' \
    | "$PY" -c 'import json,sys;print(json.load(sys.stdin).get("code", ""))'
)"
[ -n "$RUNNER_PAIR_CODE" ] || fail "runner pairing code missing"
RUNNER_SETUP_CODE="$(setup_code "$OWNER_DID" "$RUNNER_PAIR_CODE" "Plugin runner E2E")"
"$DINA" configure \
  --headless \
  --role agent \
  --setup-code "$RUNNER_SETUP_CODE" \
  --config-dir "$WORK/runner" > "$WORK/runner-configure.log" 2>&1 \
  || fail "runner pairing failed"
RUNNER_CONFIG_DIR="$WORK/runner/.dina/cli"

echo "[6/11] Run session, memory, vault, reminder, and Ask acceptance"
echo "[7/11] Publish, discover, and invoke a Tier-1 service"
echo "[8/11] Approve and publish a durable PeerLens review"
echo "[9/11] Approve, claim, and complete one external-agent delegation"
echo "[10/11] Deny one Talk; approve and durably deliver another"
REPO="$REPO" \
OWNER_URL="$OWNER_URL" RECEIVER_URL="$RECEIVER_URL" \
OWNER_DID="$OWNER_DID" RECEIVER_DID="$RECEIVER_DID" \
RUNNER_CONFIG_DIR="$RUNNER_CONFIG_DIR" \
STAMP="$STAMP" "$PY" - <<'PY' || fail "plugin surface assertions failed"
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from dina_cli.client import DinaClient, DinaClientError
from dina_cli.config import load_config

owner_url = os.environ["OWNER_URL"]
receiver_url = os.environ["RECEIVER_URL"]
owner_did = os.environ["OWNER_DID"]
receiver_did = os.environ["RECEIVER_DID"]
runner_config_dir = os.environ["RUNNER_CONFIG_DIR"]
stamp = os.environ["STAMP"]


def dispatch(base, method, path, body=None, query=None):
    payload = {"method": method, "path": path}
    if body is not None:
        payload["body"] = body
    if query is not None:
        payload["query"] = query
    req = urllib.request.Request(
        base + "/v1/debug/dispatch",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read()
    except urllib.error.HTTPError as exc:
        raise AssertionError(
            f"debug {method} {path} failed: HTTP {exc.code} {exc.read().decode()}"
        ) from exc
    return json.loads(raw) if raw else {}


def approve(task_id):
    result = dispatch(owner_url, "POST", f"/v1/workflow/tasks/{task_id}/approve", {})
    task_status = (result.get("task") or {}).get("status")
    if not result.get("ok") and task_status not in {"queued", "running", "completed"}:
        raise AssertionError(f"approval failed for {task_id}: {result}")


def poll(label, fn, predicate, timeout=100, interval=1):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = fn()
            if predicate(last):
                return last
        except Exception as exc:
            last = {"error": repr(exc)}
        time.sleep(interval)
    raise AssertionError(f"{label} timed out; last={last}")


client = DinaClient(load_config())
session = ""
try:
    started = client.session_start("plugin-surface-e2e")
    session = started["session_id"]
    assert started["status"] == "open"

    memory_code = f"plugin-memory-{stamp}"
    memory_text = f"Plugin acceptance memory code: {memory_code}"
    remembered = client.remember(
        memory_text,
        session=session,
        source_id=f"remember-{stamp}",
        persona="general",
    )
    assert remembered["status"] in {"processing", "stored"}, remembered
    if remembered["status"] != "stored":
        remembered = poll(
            "staged Remember completion",
            lambda: client.remember_check(remembered["id"], session=session),
            lambda r: r.get("status") in {"stored", "failed", "denied"},
            timeout=60,
        )
    assert remembered["status"] == "stored", remembered
    assert remembered["persona"] == "general", remembered

    # Prove Remember preserved the exact source value in Core, independently
    # of the scripted model's final Ask wording.
    remembered_rows = dispatch(
        owner_url,
        "POST",
        "/v1/vault/query",
        {"mode": "fts5", "text": memory_code, "limit": 10},
        {"persona": "general"},
    )
    assert any(
        memory_code
        in " ".join(
            str(row.get(field) or "")
            for field in ("summary", "body", "content_l0", "content_l1")
        )
        for row in remembered_rows.get("items", [])
    ), remembered_rows

    vaults = client.list_vaults(session=session)
    general = next(v for v in vaults["vaults"] if v["name"] == "general")
    assert general["readable"] is True, vaults
    assert all("contents" not in v and "items" not in v for v in vaults["vaults"])

    reminder_text = f"Plugin acceptance automatic reminder {stamp}"
    timed = client.remember(
        f"Plugin acceptance timed memory {stamp}",
        session=session,
        source_id=f"remember-timed-{stamp}",
        persona="general",
    )
    assert timed["status"] in {"processing", "stored"}, timed
    if timed["status"] != "stored":
        timed = poll(
            "timed Remember completion",
            lambda: client.remember_check(timed["id"], session=session),
            lambda r: r.get("status") in {"stored", "failed", "denied"},
            timeout=60,
        )
    assert timed["status"] == "stored", timed
    reminders = poll(
        "automatic Remember reminder",
        lambda: client.list_reminders(session=session, limit=50),
        lambda r: any(
            item.get("message") == reminder_text for item in r.get("reminders", [])
        ),
        timeout=30,
    )
    reminder = next(r for r in reminders["reminders"] if r["message"] == reminder_text)
    reminder_id = reminder["id"]

    asked = client.ask("What is the saved plugin acceptance code?", session=session)
    if asked.get("status") != "complete":
        request_id = asked.get("request_id")
        assert request_id, asked
        asked = poll(
            "Ask completion",
            lambda: client.ask_status(request_id, session=session),
            lambda r: r.get("status") in {"complete", "failed"},
            timeout=30,
        )
    assert asked.get("status") == "complete", asked
    answer = asked.get("content") or (asked.get("answer") or {}).get("text") or ""
    assert memory_code in answer, asked

    service_rkey = f"route42-{stamp}"
    service_name = f"Route 42 Plugin E2E {stamp}"
    service_config = {
        "isDiscoverable": True,
        "discoverability": "public",
        "status": "active",
        "name": service_name,
        "description": f"Plugin acceptance service {stamp}",
        "vaultPersona": "general",
        "capabilities": {
            "eta_query": {
                "category": "transit",
                "responsePolicy": "auto",
                "instruction": (
                    "You are the live dispatcher for city bus Route 42. "
                    "Reply with the current status and ETA."
                ),
            }
        },
        "capabilitySchemas": {
            "eta_query": {
                "params": {
                    "type": "object",
                    "required": ["route_id"],
                    "properties": {"route_id": {"type": "string"}},
                },
                "result": {
                    "type": "object",
                    "required": ["status"],
                    "properties": {
                        "status": {"type": "string"},
                        "eta_minutes": {"type": "integer"},
                        "route_name": {"type": "string"},
                        "vehicle_type": {"type": "string"},
                        "stop_name": {"type": "string"},
                        "stop_distance_m": {"type": "integer"},
                        "message": {"type": "string"},
                    },
                },
                "schemaHash": "e2e-eta-schema-v1",
                "defaultTtlSeconds": 60,
            }
        },
    }
    service_publish_request = f"service-publish-{stamp}"
    published_service = client.publish_service(
        rkey=service_rkey,
        config=service_config,
        session=session,
        request_id=service_publish_request,
    )
    assert published_service["status"] == "pending_approval", published_service
    approve(published_service["task_id"])
    service_save = poll(
        "approved service save",
        lambda: client.action_status(
            action="service_publish",
            request_id=service_publish_request,
            session=session,
        ),
        lambda r: r.get("status") in {"completed", "failed", "cancelled"},
        timeout=30,
    )
    assert service_save["status"] == "completed", service_save
    assert service_save["rkey"] == service_rkey, service_save
    service_receipt = poll(
        "service PDS publication",
        lambda: client.service_publication_status(rkey=service_rkey, session=session),
        lambda r: r.get("publication_status") in {"published", "failed"},
        timeout=80,
    )
    assert service_receipt["publication_status"] == "published", service_receipt

    discovered = poll(
        "service AppView ingestion",
        lambda: client.find_services(
            session=session,
            capability="eta_query",
            query=stamp,
            limit=20,
        ),
        lambda r: any(
            (m.get("service") or {}).get("did") == owner_did
            and (m.get("service") or {}).get("name") == service_name
            for m in r.get("matches", [])
        ),
        timeout=120,
        interval=2,
    )
    match = next(
        m
        for m in discovered["matches"]
        if (m.get("service") or {}).get("did") == owner_did
        and (m.get("service") or {}).get("name") == service_name
    )
    service = match["service"]
    service_uri = service.get("uri") or service_receipt["uri"]
    assert "eta_query" in service.get("capabilities", []), service
    capability_schema = (service.get("capabilitySchemas") or {}).get(
        "eta_query", {}
    )
    schema_hash = capability_schema.get("schemaHash")
    service_invoke_request = f"service-invoke-{stamp}"
    invoke = client.send_service_query(
        to_did=owner_did,
        capability="eta_query",
        params={"route_id": "42"},
        session=session,
        request_id=service_invoke_request,
        service_name=service_name,
        ttl_seconds=60,
        schema_hash=schema_hash or "",
        service_uri=service_uri,
        origin_channel="agent",
    )
    assert invoke["status"] == "pending_approval", invoke
    approve(invoke["task_id"])
    sent_query = poll(
        "approved service invocation",
        lambda: client.action_status(
            action="service_invoke",
            request_id=service_invoke_request,
            session=session,
        ),
        lambda r: r.get("status") in {"completed", "failed", "cancelled"},
        timeout=30,
    )
    assert sent_query["status"] == "completed", sent_query
    assert sent_query.get("service_task_id"), sent_query
    service_result = poll(
        "Tier-1 service result",
        lambda: client.service_query_status(
            task_id=sent_query["service_task_id"], session=session
        ),
        lambda r: r.get("status") in {"completed", "failed", "expired", "cancelled"},
        timeout=90,
    )
    assert service_result["status"] == "completed", service_result
    result_envelope = service_result.get("result") or {}
    capability_result = result_envelope.get("result") or result_envelope
    assert capability_result.get("eta_minutes") == 7, service_result

    review_request = f"review-{stamp}"
    review_subject = f"dina-plugin-e2e-{stamp}"
    review = client.publish_review(
        session=session,
        request_id=review_request,
        record={
            "subject": {
                "type": "product",
                "identifier": review_subject,
                "name": f"Plugin E2E Chair {stamp}",
            },
            "category": "furniture",
            "sentiment": "positive",
            "text": f"Plugin acceptance review {stamp}",
            "tags": ["plugin-e2e"],
            "confidence": "high",
        },
    )
    assert review["status"] == "pending_approval", review
    approve(review["task_id"])
    review_receipt = poll(
        "PeerLens PDS publication",
        lambda: client.review_status(request_id=review_request, session=session),
        lambda r: r.get("publish_status") in {"published", "failed"},
        timeout=80,
    )
    assert review_receipt["publish_status"] == "published", review_receipt
    peer_search = poll(
        "PeerLens AppView ingestion",
        lambda: client.search_peerlens(
            session=session,
            query=f"Plugin acceptance review {stamp}",
            author_did=owner_did,
            limit=20,
        ),
        lambda r: any(
            hit.get("authorDid") == owner_did
            and (
                hit.get("subjectId") == review_subject
                or (hit.get("subject") or {}).get("identifier") == review_subject
            )
            for hit in r.get("results", [])
        ),
        timeout=120,
        interval=2,
    )
    assert peer_search["results"]

    delegated = client.delegate(
        runner="openclaw",
        description=f"Plugin acceptance delegation {stamp}",
        input_data={"stamp": stamp},
        session=session,
        request_id=f"delegate-{stamp}",
    )
    assert delegated["status"] == "pending_approval", delegated
    approve(delegated["task_id"])
    delegation_status = poll(
        "delegation enqueue",
        lambda: client.action_status(
            action="delegate", request_id=f"delegate-{stamp}", session=session
        ),
        lambda r: r.get("status") in {"completed", "failed", "cancelled"},
        timeout=30,
    )
    assert delegation_status["status"] == "completed", delegation_status
    assert delegation_status["delegation_submit_status"] == "queued", delegation_status
    assert delegation_status["runner"] == "openclaw", delegation_status

    # The coding-agent identity can submit work but cannot consume runner work.
    # Scope is derived from its paired device record, not a caller-supplied field.
    try:
        client.claim_task(runner_filter="openclaw")
    except DinaClientError as exc:
        assert "Access denied" in str(exc), exc
    else:
        raise AssertionError("coding-scoped agent unexpectedly claimed runner work")

    delegation_task_id = delegation_status["delegation_task_id"]
    runner_env = os.environ.copy()
    runner_env["DINA_CONFIG_DIR"] = runner_config_dir
    runner_env["EXPECTED_TASK_ID"] = delegation_task_id
    runner_env["E2E_STAMP"] = stamp
    runner = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import json
import os
from dina_cli.client import DinaClient
from dina_cli.config import load_config

client = DinaClient(load_config())
try:
    task = client.claim_task(runner_filter="openclaw")
    assert task is not None, "runner found no delegated task"
    assert task["id"] == os.environ["EXPECTED_TASK_ID"], task
    client.task_complete(
        task["id"],
        json.dumps(
            {"status": "completed", "stamp": os.environ["E2E_STAMP"]},
            separators=(",", ":"),
        ),
        assigned_runner="openclaw",
    )
finally:
    client.close()
""",
        ],
        env=runner_env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert runner.returncode == 0, {
        "returncode": runner.returncode,
        "stderr": runner.stderr[-2_000:],
    }
    delegation_completed = poll(
        "delegation runner completion",
        lambda: client.action_status(
            action="delegate", request_id=f"delegate-{stamp}", session=session
        ),
        lambda r: r.get("delegation_status") == "completed",
        timeout=30,
    )
    assert delegation_completed["delegation_status"] == "completed", delegation_completed
    assert delegation_completed["delegation_result"] == {
        "status": "completed",
        "stamp": stamp,
    }, delegation_completed

    dispatch(
        owner_url,
        "POST",
        "/v1/contacts",
        {
            "did": receiver_did,
            "display_name": "Plugin Receiver",
            "trust_level": "verified",
        },
    )
    dispatch(
        receiver_url,
        "POST",
        "/v1/contacts",
        {
            "did": owner_did,
            "display_name": "Plugin Owner",
            "trust_level": "verified",
        },
    )
    denied_text = f"Plugin Talk denied {stamp}"
    denied = client.talk(
        contact="Plugin Receiver",
        text=denied_text,
        session=session,
        request_id=f"talk-denied-{stamp}",
    )
    assert denied["status"] == "pending_approval", denied
    cancelled = dispatch(
        owner_url,
        "POST",
        f"/v1/workflow/tasks/{denied['task_id']}/cancel",
        {"reason": "e2e_owner_denied"},
    )
    assert (cancelled.get("task") or {}).get("status") == "cancelled", cancelled
    try:
        client.action_status(
            action="talk",
            request_id=f"talk-denied-{stamp}",
            session=session,
        )
    except DinaClientError as exc:
        assert "Access denied" in str(exc), exc
    else:
        raise AssertionError("denied Talk unexpectedly continued")

    talk_text = f"Plugin Talk acceptance {stamp}"
    talked = client.talk(
        contact="Plugin Receiver",
        text=talk_text,
        session=session,
        request_id=f"talk-{stamp}",
    )
    assert talked["status"] == "pending_approval", talked
    approve(talked["task_id"])
    talk_status = poll(
        "Talk delivery",
        lambda: client.action_status(
            action="talk", request_id=f"talk-{stamp}", session=session
        ),
        lambda r: r.get("status") in {"completed", "failed", "cancelled"},
        timeout=40,
    )
    assert talk_status["status"] == "completed", talk_status
    assert talk_status["delivery_status"] in {"sent", "queued"}, talk_status
    assert talk_status["recipient_did"] == receiver_did, talk_status

    receiver_items = []

    def claim_receiver_staging():
        batch = dispatch(
            receiver_url,
            "POST",
            "/v1/staging/claim",
            query={"limit": 50},
        )
        receiver_items.extend(batch.get("items", []))
        return receiver_items

    poll(
        "receiver durable Talk staging",
        claim_receiver_staging,
        lambda items: any(
            talk_text in str((item.get("data") or {}).get("body") or "")
            for item in items
        ),
        timeout=60,
    )
    receiver_bodies = [
        str((item.get("data") or {}).get("body") or "") for item in receiver_items
    ]
    assert any(talk_text in body for body in receiver_bodies), receiver_items
    assert all(denied_text not in body for body in receiver_bodies), receiver_items

    # The Brain process, not this test, must perform the first fire. The agent
    # list surface exposes fired rows, so poll it until the automatic loop's
    # durable transition is visible.
    fired = poll(
        "automatic reminder firing",
        lambda: client.list_reminders(session=session, limit=50),
        lambda r: any(
            item.get("id") == reminder_id and item.get("status") == "fired"
            for item in r.get("reminders", [])
        ),
        timeout=180,
    )
    assert any(
        item.get("id") == reminder_id and item.get("status") == "fired"
        for item in fired["reminders"]
    ), fired
    second_fire = dispatch(
        owner_url,
        "POST",
        "/v1/reminders/fire",
        {"now": int(time.time() * 1000) + 1_000},
    )
    assert all(
        item.get("id") != reminder_id for item in second_fire.get("fired", [])
    ), second_fire
finally:
    if session:
        client.session_end(session)
    client.close()
PY

wait_log \
  "$WORK/receiver.log" \
  '\[d2d:handleInboundD2D\]' \
  "receiver Talk ingress" \
  120

echo "[11/11] Verify the acceptance run did not expose content in process logs"
if grep -Eq \
  'Plugin acceptance memory|Plugin acceptance reminder|Plugin acceptance review|Plugin Talk acceptance' \
  "$WORK/owner.log" "$WORK/brain.log" "$WORK/receiver.log"; then
  fail "user content appeared in HNL process logs"
fi

PASSED=1
printf '\nHNL PLUGIN SURFACE E2E: PASS\n'
printf '  owner DID:    %s\n' "$OWNER_DID"
printf '  receiver DID: %s\n' "$RECEIVER_DID"
printf '  agent transport: hosted MsgBox\n'
printf '  public reads: test AppView\n'
printf '  public writes: test PDS\n'
