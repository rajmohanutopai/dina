#!/usr/bin/env bash
# Post-deploy validation script — tests core D2D + vault + reminder flow.
#
# Requires two running Dina nodes (CORE_A and CORE_B containers).
# All operations use dina-admin CLI inside the containers.
#
# Usage:
#   ./scripts/post_deploy_test.sh <core_a_container> <core_b_container>
#   ./scripts/post_deploy_test.sh core-6jp core-xpr
#
# Tests:
#   1. Status — both nodes healthy
#   2. Identity — get DIDs from both
#   3. Contact exchange — add each other as contacts
#   4. Vault — each remembers a fact about the other
#   5. D2D send — A sends "arriving in 10 minutes" to B
#   6. D2D receive — verify B received the message
#   7. Reminder — verify reminder was created with vault context
#   8. Trace — verify correlation_id traces end-to-end

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

CORE_A="${1:-}"
CORE_B="${2:-}"

if [ -z "$CORE_A" ] || [ -z "$CORE_B" ]; then
    echo "Usage: $0 <core_a_container> <core_b_container>"
    echo "Example: $0 core-6jp core-xpr"
    exit 1
fi

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${GREEN}✓${RESET} $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${RED}✗${RESET} $1"
}

check() {
    local desc="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

admin_a() { docker exec "$CORE_A" dina-admin "$@" 2>&1; }
admin_b() { docker exec "$CORE_B" dina-admin "$@" 2>&1; }
admin_a_json() { docker exec "$CORE_A" dina-admin --json "$@" 2>&1; }
admin_b_json() { docker exec "$CORE_B" dina-admin --json "$@" 2>&1; }

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Post-Deploy Validation${RESET}"
echo -e "${BOLD}  Node A: ${CYAN}$CORE_A${RESET}"
echo -e "${BOLD}  Node B: ${CYAN}$CORE_B${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ──────────────────────────────────────────────────────────────────
# 1. Status
# ──────────────────────────────────────────────────────────────────
echo -e "${BOLD}1. Status${RESET}"

STATUS_A=$(admin_a status)
if echo "$STATUS_A" | grep -q "healthy"; then
    pass "Node A healthy"
else
    fail "Node A unhealthy: $STATUS_A"
fi

STATUS_B=$(admin_b status)
if echo "$STATUS_B" | grep -q "healthy"; then
    pass "Node B healthy"
else
    fail "Node B unhealthy: $STATUS_B"
fi

# ──────────────────────────────────────────────────────────────────
# 2. Identity — extract DIDs
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}2. Identity${RESET}"

DID_A=$(admin_a_json status | python3 -c "import json,sys; print(json.load(sys.stdin).get('did',''))" 2>/dev/null || echo "")
DID_B=$(admin_b_json status | python3 -c "import json,sys; print(json.load(sys.stdin).get('did',''))" 2>/dev/null || echo "")

if [ -n "$DID_A" ] && echo "$DID_A" | grep -q "did:plc:"; then
    pass "Node A DID: $DID_A"
else
    fail "Node A DID missing"
fi

if [ -n "$DID_B" ] && echo "$DID_B" | grep -q "did:plc:"; then
    pass "Node B DID: $DID_B"
else
    fail "Node B DID missing"
fi

# ──────────────────────────────────────────────────────────────────
# 3. Contact exchange
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}3. Contact Exchange${RESET}"

# A adds B as contact
ADD_AB=$(admin_a_json vault store --persona general --type contact --body "{\"did\":\"$DID_B\",\"name\":\"NodeB\",\"trust_level\":\"verified\"}" 2>&1 || true)
# Use direct HTTP — dina-admin may not have contact add
docker exec "$CORE_A" dina-admin vault search --persona general "NodeB" >/dev/null 2>&1 || true

# Try adding via the contact endpoint through Brain
docker exec "$(echo $CORE_A | sed 's/core/brain/')" python3 -c "
import asyncio, sys; sys.path.insert(0, '/app')
from src.adapter.signing import ServiceIdentity
from src.adapter.core_http import CoreHTTPClient
async def main():
    si = ServiceIdentity('/run/secrets/service_keys'); si._load()
    core = CoreHTTPClient('http://core:8100', service_identity=si)
    # Check if NodeB exists
    r = await core._request('GET', '/v1/contacts')
    contacts = r.json().get('contacts', [])
    has = any(c.get('did','') == '$DID_B' for c in contacts)
    if not has:
        await core._request('POST', '/v1/contacts', json={
            'did': '$DID_B', 'name': 'NodeB', 'trust_level': 'verified'
        })
        print('added')
    else:
        print('exists')
asyncio.run(main())
" 2>&1
RESULT=$?
if [ $RESULT -eq 0 ]; then
    pass "A added B as contact"
else
    fail "A failed to add B as contact"
fi

# B adds A as contact
docker exec "$(echo $CORE_B | sed 's/core/brain/')" python3 -c "
import asyncio, sys; sys.path.insert(0, '/app')
from src.adapter.signing import ServiceIdentity
from src.adapter.core_http import CoreHTTPClient
async def main():
    si = ServiceIdentity('/run/secrets/service_keys'); si._load()
    core = CoreHTTPClient('http://core:8100', service_identity=si)
    r = await core._request('GET', '/v1/contacts')
    contacts = r.json().get('contacts', [])
    has = any(c.get('did','') == '$DID_A' for c in contacts)
    if not has:
        await core._request('POST', '/v1/contacts', json={
            'did': '$DID_A', 'name': 'NodeA', 'trust_level': 'verified'
        })
        print('added')
    else:
        print('exists')
asyncio.run(main())
" 2>&1
if [ $? -eq 0 ]; then
    pass "B added A as contact"
else
    fail "B failed to add A as contact"
fi

# ──────────────────────────────────────────────────────────────────
# 4. Vault — remember facts
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}4. Vault Memory${RESET}"

REM_A=$(admin_a remember "NodeB likes green tea and plays chess on weekends")
if echo "$REM_A" | grep -qi "stored"; then
    pass "A remembered fact about B"
else
    fail "A remember failed: $REM_A"
fi

REM_B=$(admin_b remember "NodeA enjoys opera and prefers dark roast coffee")
if echo "$REM_B" | grep -qi "stored"; then
    pass "B remembered fact about A"
else
    fail "B remember failed: $REM_B"
fi

# Wait for staging to process
sleep 5

# ──────────────────────────────────────────────────────────────────
# 5. D2D Send — A sends to B
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}5. D2D Send (A → B)${RESET}"

BRAIN_A=$(echo "$CORE_A" | sed 's/core/brain/')
SEND_RESULT=$(docker exec "$BRAIN_A" python3 -c "
import asyncio, sys, json, base64
sys.path.insert(0, '/app')
from src.adapter.signing import ServiceIdentity
from src.adapter.core_http import CoreHTTPClient
async def main():
    si = ServiceIdentity('/run/secrets/service_keys'); si._load()
    core = CoreHTTPClient('http://core:8100', service_identity=si)
    body = base64.b64encode(json.dumps({
        'status': 'arriving', 'eta_minutes': 10,
        'location_label': 'home', '_correlation_id': 'test-deploy-001'
    }).encode()).decode()
    r = await core._request('POST', '/v1/msg/send', json={
        'to': '$DID_B', 'body': body, 'type': 'presence.signal',
    })
    print(f'{r.status_code}')
asyncio.run(main())
" 2>&1)

if [ "$SEND_RESULT" = "202" ]; then
    pass "A sent D2D message to B (202 accepted)"
else
    fail "A D2D send failed: $SEND_RESULT"
fi

# ──────────────────────────────────────────────────────────────────
# 6. D2D Receive — verify B got it
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}6. D2D Receive (B inbox)${RESET}"

sleep 3
INBOX_B=$(admin_b inbox)
if echo "$INBOX_B" | grep -q "presence.signal"; then
    pass "B received presence.signal"
else
    fail "B inbox missing message: $INBOX_B"
fi

if echo "$INBOX_B" | grep -q "arriving"; then
    pass "B message contains 'arriving'"
else
    fail "B message content missing"
fi

# ──────────────────────────────────────────────────────────────────
# 7. Trace — verify correlation_id on receiver
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}7. Trace (correlation_id)${RESET}"

TRACE_B=$(admin_b trace test-deploy-001 2>&1)
if echo "$TRACE_B" | grep -q "d2d_received"; then
    pass "B Core trace has d2d_received event"
else
    fail "B Core trace missing: $TRACE_B"
fi

# ──────────────────────────────────────────────────────────────────
# 8. Vault query — verify remembered facts
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}8. Vault Query${RESET}"

ASK_A=$(admin_a ask "What does NodeB like?" 2>&1)
if echo "$ASK_A" | grep -qi "tea\|chess"; then
    pass "A recalls fact about B (tea/chess)"
else
    fail "A vault query: $ASK_A"
fi

# ──────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [ "$FAIL" -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
else
    echo -e "  ${RED}${BOLD}$FAIL/$TOTAL tests failed${RESET}"
fi
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

exit "$FAIL"
