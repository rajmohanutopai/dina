#!/usr/bin/env bash
# cleanup_test_trust.sh — Delete trust records published by a specific PDS account.
#
# Usage:
#   ./scripts/cleanup_test_trust.sh list   <email> <password>   # list records
#   ./scripts/cleanup_test_trust.sh delete <email> <password>   # delete all records
#
# Examples:
#   ./scripts/cleanup_test_trust.sh list   sancho@dina.test dina-test-pw
#   ./scripts/cleanup_test_trust.sh delete sancho@dina.test dina-test-pw

set -euo pipefail

PDS_URL="${DINA_PDS_URL:-https://test-pds.dinakernel.com}"

ACTION="${1:-}"
EMAIL="${2:-}"
PASSWORD="${3:-}"

if [ -z "$ACTION" ] || [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
    echo "Usage: $0 <list|delete> <email> <password>"
    echo ""
    echo "Examples:"
    echo "  $0 list   sancho@dina.test dina-test-pw"
    echo "  $0 delete sancho@dina.test dina-test-pw"
    echo ""
    echo "Set DINA_PDS_URL to override PDS (default: https://test-pds.dinakernel.com)"
    exit 1
fi

COLLECTIONS=(
    "com.dina.trust.attestation"
    "com.dina.trust.vouch"
    "com.dina.trust.endorsement"
    "com.dina.trust.flag"
    "com.dina.trust.reaction"
    "com.dina.trust.reply"
)

# Authenticate
SESSION=$(curl -sf -X POST "$PDS_URL/xrpc/com.atproto.server.createSession" \
    -H "Content-Type: application/json" \
    -d "{\"identifier\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" 2>&1)

TOKEN=$(echo "$SESSION" | python3 -c "import json,sys; print(json.load(sys.stdin).get('accessJwt',''))" 2>/dev/null)
DID=$(echo "$SESSION" | python3 -c "import json,sys; print(json.load(sys.stdin).get('did',''))" 2>/dev/null)

if [ -z "$TOKEN" ] || [ -z "$DID" ]; then
    echo "Authentication failed for $EMAIL"
    exit 1
fi

echo "Account: $EMAIL"
echo "DID:     $DID"
echo "PDS:     $PDS_URL"
echo ""

case "$ACTION" in
    list)
        total=0
        for col in "${COLLECTIONS[@]}"; do
            records=$(curl -sf "$PDS_URL/xrpc/com.atproto.repo.listRecords?repo=$DID&collection=$col&limit=100" \
                -H "Authorization: Bearer $TOKEN" 2>/dev/null)
            count=$(echo "$records" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('records',[])))" 2>/dev/null)
            if [ "$count" != "0" ] && [ -n "$count" ]; then
                echo "  $col → $count records"
                # Show first few
                echo "$records" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for r in d.get('records', [])[:3]:
    v = r.get('value', {})
    text = v.get('text', v.get('searchContent', ''))[:60]
    print(f'    {text}')
" 2>/dev/null
                total=$((total + count))
            fi
        done
        echo ""
        echo "Total: $total records"
        ;;

    delete)
        deleted=0
        for col in "${COLLECTIONS[@]}"; do
            records=$(curl -sf "$PDS_URL/xrpc/com.atproto.repo.listRecords?repo=$DID&collection=$col&limit=100" \
                -H "Authorization: Bearer $TOKEN" 2>/dev/null)
            rkeys=$(echo "$records" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for r in d.get('records', []):
    uri = r.get('uri', '')
    rkey = uri.split('/')[-1] if '/' in uri else ''
    if rkey: print(rkey)
" 2>/dev/null)

            for rkey in $rkeys; do
                curl -sf -X POST "$PDS_URL/xrpc/com.atproto.repo.deleteRecord" \
                    -H "Authorization: Bearer $TOKEN" \
                    -H "Content-Type: application/json" \
                    -d "{\"repo\":\"$DID\",\"collection\":\"$col\",\"rkey\":\"$rkey\"}" > /dev/null 2>&1
                deleted=$((deleted + 1))
                echo "  Deleted: $col/$rkey"
            done
        done
        echo ""
        echo "Deleted $deleted records from $EMAIL"
        echo "AppView will remove them within ~10 seconds."
        ;;

    *)
        echo "Unknown action: $ACTION. Use 'list' or 'delete'."
        exit 1
        ;;
esac
