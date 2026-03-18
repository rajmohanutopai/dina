#!/usr/bin/env bash
# ============================================================================
# Dina Manual Smoke Test
# ============================================================================
#
# Run this after install.sh to verify Dina is working end-to-end.
# No Python, no pytest — just curl + jq.
#
# Usage:
#   ./scripts/manual_smoke_test.sh
#   CORE_URL=http://localhost:8100 ./scripts/manual_smoke_test.sh
#
# Prerequisites:
#   - Dina running (docker compose up -d)
#   - curl, jq installed
#   - secrets/client_token exists
# ============================================================================

set -euo pipefail

CORE_URL="${CORE_URL:-http://localhost:8100}"
BRAIN_URL="${BRAIN_URL:-http://localhost:8200}"
TOKEN_FILE="${DINA_TOKEN_FILE:-secrets/client_token}"

# Colors
G='\033[32m' R='\033[31m' Y='\033[33m' C='\033[36m' B='\033[1m' D='\033[2m' X='\033[0m'

pass=0 fail=0 skip=0

check() {
    local name="$1" ; shift
    if "$@" >/dev/null 2>&1; then
        echo -e "  ${G}✓${X} $name"
        ((pass++))
    else
        echo -e "  ${R}✗${X} $name"
        ((fail++))
    fi
}

check_output() {
    local name="$1" expected="$2" ; shift 2
    local output
    output=$("$@" 2>/dev/null) || true
    if echo "$output" | grep -q "$expected"; then
        echo -e "  ${G}✓${X} $name"
        ((pass++))
    else
        echo -e "  ${R}✗${X} $name ${D}(expected '$expected')${X}"
        ((fail++))
    fi
}

skip_check() {
    echo -e "  ${Y}○${X} $1 ${D}(skipped: $2)${X}"
    ((skip++))
}

# ── Load auth ──────────────────────────────────────────────────────────────

if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    AUTH="Authorization: Bearer $TOKEN"
else
    echo -e "${R}No token file at $TOKEN_FILE — run install.sh first${X}"
    exit 1
fi

echo ""
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${X}"
echo -e "${B}  Dina Manual Smoke Test${X}"
echo -e "${D}  Core: $CORE_URL  Brain: $BRAIN_URL${X}"
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${X}"
echo ""

# ══════════════════════════════════════════════════════════════════════════
echo -e "${C}§1 Health${X}"
# ══════════════════════════════════════════════════════════════════════════

check_output "Core healthy" '"status"' \
    curl -sf "$CORE_URL/healthz"

check_output "Brain healthy" '"status"' \
    curl -sf "$BRAIN_URL/healthz"

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§2 Identity${X}"
# ══════════════════════════════════════════════════════════════════════════

DID=$(curl -sf -H "$AUTH" "$CORE_URL/v1/did" 2>/dev/null | jq -r '.did // empty' 2>/dev/null || true)
if [ -n "$DID" ]; then
    echo -e "  ${G}✓${X} DID exists: ${D}$DID${X}"
    ((pass++))
else
    echo -e "  ${R}✗${X} No DID returned"
    ((fail++))
fi

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§3 Personas${X}"
# ══════════════════════════════════════════════════════════════════════════

PERSONAS=$(curl -sf -H "$AUTH" "$CORE_URL/v1/personas" 2>/dev/null || true)
if echo "$PERSONAS" | jq -e '.personas' >/dev/null 2>&1; then
    NAMES=$(echo "$PERSONAS" | jq -r '.personas[]' 2>/dev/null | tr '\n' ', ')
    echo -e "  ${G}✓${X} Personas: ${D}${NAMES%, }${X}"
    ((pass++))
else
    echo -e "  ${R}✗${X} Cannot list personas"
    ((fail++))
fi

# Create a test persona (idempotent)
PCREATE=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"name":"general","tier":"default","passphrase":"test"}' \
    "$CORE_URL/v1/personas" 2>/dev/null || true)
check_output "Create/reopen general persona" 'vault.*open\|status.*created\|status.*exists' \
    echo "$PCREATE"

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§4 Vault Store + Query${X}"
# ══════════════════════════════════════════════════════════════════════════

TAG="smoke_$(date +%s)"

# Store
STORE_RESP=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"persona\":\"general\",\"item\":{\"type\":\"note\",\"summary\":\"$TAG manual smoke test\",\"body_text\":\"This is a manual smoke test item with tag $TAG\",\"source\":\"manual\"}}" \
    "$CORE_URL/v1/vault/store" 2>/dev/null || true)

ITEM_ID=$(echo "$STORE_RESP" | jq -r '.id // empty' 2>/dev/null || true)
if [ -n "$ITEM_ID" ]; then
    echo -e "  ${G}✓${X} Stored item: ${D}$ITEM_ID${X}"
    ((pass++))
else
    echo -e "  ${R}✗${X} Store failed: ${D}${STORE_RESP:0:100}${X}"
    ((fail++))
fi

# Query (FTS5)
QUERY_RESP=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"persona\":\"general\",\"query\":\"$TAG\",\"mode\":\"fts5\",\"include_content\":true}" \
    "$CORE_URL/v1/vault/query" 2>/dev/null || true)

FOUND=$(echo "$QUERY_RESP" | jq -r ".items[] | select(.id==\"$ITEM_ID\") | .id" 2>/dev/null || true)
if [ "$FOUND" = "$ITEM_ID" ]; then
    echo -e "  ${G}✓${X} FTS5 query found the item"
    ((pass++))
else
    echo -e "  ${R}✗${X} FTS5 query did not find item ${D}$ITEM_ID${X}"
    ((fail++))
fi

# GetItem by ID
GET_RESP=$(curl -sf -H "$AUTH" "$CORE_URL/v1/vault/item/$ITEM_ID?persona=general" 2>/dev/null || true)
check_output "GetItem by ID" "$TAG" echo "$GET_RESP"

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§5 KV Store${X}"
# ══════════════════════════════════════════════════════════════════════════

KV_KEY="smoke_kv_$TAG"
curl -sf -X PUT -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"value\":\"hello from smoke test\"}" \
    "$CORE_URL/v1/vault/kv/$KV_KEY" >/dev/null 2>&1

KV_VAL=$(curl -sf -H "$AUTH" "$CORE_URL/v1/vault/kv/$KV_KEY" 2>/dev/null | jq -r '.value // empty' 2>/dev/null || true)
if [ "$KV_VAL" = "hello from smoke test" ]; then
    echo -e "  ${G}✓${X} KV round-trip OK"
    ((pass++))
else
    echo -e "  ${R}✗${X} KV round-trip failed: got '${KV_VAL:0:50}'"
    ((fail++))
fi

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§6 PII Scrubbing${X}"
# ══════════════════════════════════════════════════════════════════════════

PII_RESP=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"text":"Call Rajmohan at 9876543210 or raj@example.com"}' \
    "$CORE_URL/v1/pii/scrub" 2>/dev/null || true)

SCRUBBED=$(echo "$PII_RESP" | jq -r '.scrubbed // empty' 2>/dev/null || true)
if echo "$SCRUBBED" | grep -qv "9876543210"; then
    echo -e "  ${G}✓${X} Phone scrubbed"
    ((pass++))
else
    echo -e "  ${R}✗${X} Phone NOT scrubbed: ${D}${SCRUBBED:0:60}${X}"
    ((fail++))
fi

if echo "$SCRUBBED" | grep -qv "raj@example.com"; then
    echo -e "  ${G}✓${X} Email scrubbed"
    ((pass++))
else
    echo -e "  ${R}✗${X} Email NOT scrubbed"
    ((fail++))
fi

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§7 Staging Pipeline${X}"
# ══════════════════════════════════════════════════════════════════════════

STG_ID=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"connector_id\":\"smoke-test\",\"source\":\"gmail\",\"source_id\":\"smoke-$TAG\",\"type\":\"email\",\"summary\":\"Smoke test email\",\"body\":\"Content of smoke test\",\"sender\":\"test@example.com\"}" \
    "$CORE_URL/v1/staging/ingest" 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)

if [ -n "$STG_ID" ]; then
    echo -e "  ${G}✓${X} Staging ingest: ${D}$STG_ID${X}"
    ((pass++))
else
    echo -e "  ${R}✗${X} Staging ingest failed"
    ((fail++))
fi

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§8 Brain Reasoning${X}"
# ══════════════════════════════════════════════════════════════════════════

# Check if Brain has an LLM configured
REASON_RESP=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"prompt":"What is 2+2? Answer in one word."}' \
    "$CORE_URL/api/v1/reason" 2>/dev/null || true)

REASON_CONTENT=$(echo "$REASON_RESP" | jq -r '.content // empty' 2>/dev/null || true)
if [ -n "$REASON_CONTENT" ]; then
    echo -e "  ${G}✓${X} Brain reasoning: ${D}${REASON_CONTENT:0:60}${X}"
    ((pass++))
else
    REASON_ERR=$(echo "$REASON_RESP" | jq -r '.error // .detail // empty' 2>/dev/null || true)
    if echo "$REASON_ERR" | grep -qi "timeout\|unavailable\|503"; then
        skip_check "Brain reasoning" "LLM not available or timed out"
    else
        echo -e "  ${R}✗${X} Brain reasoning failed: ${D}${REASON_ERR:0:80}${X}"
        ((fail++))
    fi
fi

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§9 Reminders${X}"
# ══════════════════════════════════════════════════════════════════════════

REM_ID=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"type\":\"one_time\",\"message\":\"Smoke test reminder\",\"trigger_at\":$(($(date +%s) + 86400)),\"persona\":\"general\"}" \
    "$CORE_URL/v1/reminder" 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)

if [ -n "$REM_ID" ]; then
    echo -e "  ${G}✓${X} Reminder created: ${D}$REM_ID${X}"
    ((pass++))
else
    echo -e "  ${R}✗${X} Reminder creation failed"
    ((fail++))
fi

PENDING=$(curl -sf -H "$AUTH" "$CORE_URL/v1/reminders/pending" 2>/dev/null | jq '.reminders | length' 2>/dev/null || echo 0)
if [ "$PENDING" -ge 1 ]; then
    echo -e "  ${G}✓${X} Pending reminders: $PENDING"
    ((pass++))
else
    echo -e "  ${R}✗${X} No pending reminders found"
    ((fail++))
fi

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§10 Contacts${X}"
# ══════════════════════════════════════════════════════════════════════════

curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"did":"did:plc:smoketest","name":"Smoke Contact","trust_level":"trusted"}' \
    "$CORE_URL/v1/contacts" >/dev/null 2>&1

CONTACTS=$(curl -sf -H "$AUTH" "$CORE_URL/v1/contacts" 2>/dev/null || true)
if echo "$CONTACTS" | jq -e '.[] | select(.did=="did:plc:smoketest")' >/dev/null 2>&1; then
    echo -e "  ${G}✓${X} Contact added and retrievable"
    ((pass++))
else
    # Try nested format
    if echo "$CONTACTS" | jq -e '.contacts[]? | select(.did=="did:plc:smoketest")' >/dev/null 2>&1; then
        echo -e "  ${G}✓${X} Contact added and retrievable"
        ((pass++))
    else
        echo -e "  ${R}✗${X} Contact not found after add"
        ((fail++))
    fi
fi

# Clean up
curl -sf -X DELETE -H "$AUTH" "$CORE_URL/v1/contacts/did:plc:smoketest" >/dev/null 2>&1 || true

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§11 Security${X}"
# ══════════════════════════════════════════════════════════════════════════

# No auth → 401
NO_AUTH_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "$CORE_URL/v1/personas" 2>/dev/null || echo "000")
if [ "$NO_AUTH_CODE" = "401" ]; then
    echo -e "  ${G}✓${X} No-auth request rejected (401)"
    ((pass++))
else
    echo -e "  ${R}✗${X} No-auth request got $NO_AUTH_CODE (expected 401)"
    ((fail++))
fi

# Wrong token → 401
BAD_AUTH_CODE=$(curl -sf -o /dev/null -w "%{http_code}" -H "Authorization: Bearer WRONG_TOKEN" "$CORE_URL/v1/personas" 2>/dev/null || echo "000")
if [ "$BAD_AUTH_CODE" = "401" ]; then
    echo -e "  ${G}✓${X} Bad token rejected (401)"
    ((pass++))
else
    echo -e "  ${R}✗${X} Bad token got $BAD_AUTH_CODE (expected 401)"
    ((fail++))
fi

# ══════════════════════════════════════════════════════════════════════════
echo -e "\n${C}§12 AT Protocol${X}"
# ══════════════════════════════════════════════════════════════════════════

ATPROTO=$(curl -sf "$CORE_URL/.well-known/atproto-did" 2>/dev/null || true)
if echo "$ATPROTO" | grep -q "did:"; then
    echo -e "  ${G}✓${X} AT Protocol DID: ${D}${ATPROTO:0:40}${X}"
    ((pass++))
else
    skip_check "AT Protocol DID" "PDS not configured"
fi

# ══════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${X}"
total=$((pass + fail + skip))
if [ $fail -eq 0 ]; then
    echo -e "  ${G}${B}ALL PASS${X}  ${pass}/${total} passed, ${skip} skipped"
else
    echo -e "  ${R}${B}FAILED${X}   ${pass} passed, ${fail} failed, ${skip} skipped"
fi
echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${X}"
echo ""

exit $fail
