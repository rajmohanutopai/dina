#!/usr/bin/env bash
#
# Boot a LOCAL grants-service for the credits Maestro happy-path test.
#
# Apple DeviceCheck is STUBBED (GRANTS_FAKE_DEVICECHECK=1) because it
# cannot run on a simulator — but the OpenRouter provisioner is REAL, so
# a successful claim mints a genuine $0.25-capped key. The management key
# is read from the gitignored infra-test.env (never hardcoded).
#
# Pair with cleanup_local_grants.sh afterwards to revoke minted keys.
#
# Usage:  apps/mobile/maestro/harness/run_local_grants.sh
# Listens on :8300. Point the app at it with
#   EXPO_PUBLIC_DINA_GRANTS_URL=http://localhost:8300
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
INFRA_ENV="$ROOT/deploy/managed/infra/infra-test.env"
DB_PATH="$ROOT/apps/grants-service/.e2e-grants.sqlite"

if [ ! -f "$INFRA_ENV" ]; then
  echo "FATAL: $INFRA_ENV not found (need OPENROUTER_PROVISIONING_KEY)." >&2
  exit 1
fi

# Pull ONLY the one var out of infra-test.env (avoid sourcing the whole
# file, which clobbers PATH and other vars).
OR_KEY="$(grep -E '^[[:space:]]*OPENROUTER_PROVISIONING_KEY=' "$INFRA_ENV" | head -1 | sed -E 's/^[^=]*=//')"
if [ -z "$OR_KEY" ]; then
  echo "FATAL: OPENROUTER_PROVISIONING_KEY missing/empty in infra-test.env." >&2
  exit 1
fi

# Fresh ledger each run so the happy path always mints.
rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" 2>/dev/null || true

echo "[harness] booting local grants-service on :8300 (FAKE DeviceCheck, REAL OpenRouter mint)"
cd "$ROOT/apps/grants-service"

# Dummy DeviceCheck secrets satisfy loadConfig's secret check; the stub
# (GRANTS_FAKE_DEVICECHECK=1) ignores them entirely.
exec env \
  GRANTS_PORT=8300 \
  GRANTS_HOST=127.0.0.1 \
  GRANTS_DB_PATH="$DB_PATH" \
  GRANTS_ENABLED_IOS=true \
  GRANTS_PAUSED=false \
  GRANTS_GRANT_USD=0.25 \
  GRANTS_FAKE_DEVICECHECK=1 \
  OPENROUTER_PROVISIONING_KEY="$OR_KEY" \
  APPLE_TEAM_ID=DEV \
  DEVICECHECK_KEY_ID=DEV \
  DEVICECHECK_PRIVATE_KEY=DEV \
  npx tsx src/bin.ts
