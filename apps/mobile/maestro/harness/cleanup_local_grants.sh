#!/usr/bin/env bash
#
# Revoke every OpenRouter key the local grants harness minted this run,
# reading the or_key_id (key hash) straight from the e2e ledger and
# DELETE-ing it with the management key. Leaves no real keys behind.
#
# Usage:  apps/mobile/maestro/harness/cleanup_local_grants.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
INFRA_ENV="$ROOT/deploy/managed/infra/infra-test.env"
DB_PATH="$ROOT/apps/grants-service/.e2e-grants.sqlite"

OR_KEY="$(grep -E '^[[:space:]]*OPENROUTER_PROVISIONING_KEY=' "$INFRA_ENV" | head -1 | sed -E 's/^[^=]*=//')"
[ -z "$OR_KEY" ] && { echo "FATAL: no management key." >&2; exit 1; }
[ -f "$DB_PATH" ] || { echo "[cleanup] no e2e ledger — nothing to revoke."; exit 0; }

# Pull the minted key hashes out of the ledger via node (better-sqlite3 is
# already a grants-service dep).
HASHES="$(cd "$ROOT/apps/grants-service" && node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  for (const r of db.prepare("SELECT or_key_id FROM grants").all()) console.log(r.or_key_id);
' "$DB_PATH" 2>/dev/null || true)"

if [ -z "$HASHES" ]; then echo "[cleanup] ledger empty — nothing to revoke."; exit 0; fi

n=0
while IFS= read -r h; do
  [ -z "$h" ] && continue
  code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
    "https://openrouter.ai/api/v1/keys/$h" \
    -H "Authorization: Bearer $OR_KEY")"
  echo "[cleanup] DELETE key ${h:0:8}… -> HTTP $code"
  n=$((n+1))
done <<< "$HASHES"
echo "[cleanup] revoked $n key(s)."
