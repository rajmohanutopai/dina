#!/usr/bin/env bash
# Sync source code from dev (OpenSource/dina) to test env (TestEnv/dina)
# WITHOUT touching secrets, data, config, or venv. Only syncs code.
#
# Usage: ./scripts/sync-to-testenv.sh
# Then in TestEnv/dina: docker compose build && docker compose up -d
set -euo pipefail

SRC="/Users/rajmohan/OpenSource/dina"
DST="/Users/rajmohan/TestEnv/dina"

echo "=== Syncing source code only: $SRC → $DST ==="

# Sync ONLY code directories — never touch secrets, data, config, or state.
# Uses --exclude to protect everything that install.sh creates.
rsync -a \
  --exclude='.git' \
  --exclude='.venv' \
  --exclude='node_modules' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='dist/' \
  --exclude='build/' \
  --exclude='*.egg-info' \
  --exclude='.test-stack-keys' \
  --exclude='.env' \
  --exclude='docker-compose.override.yml' \
  --exclude='secrets/' \
  --exclude='data/' \
  --exclude='config.json' \
  --exclude='keyfile' \
  --exclude='wrapped_seed.bin' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite-wal' \
  --exclude='*.sqlite-shm' \
  --exclude='core/dina-core' \
  --exclude='run.sh' \
  "$SRC/" "$DST/"

echo "=== Sync complete (code only, secrets/data untouched) ==="
echo "Next steps:"
echo "  cd $DST"
echo "  docker compose build core brain"
echo "  docker compose up -d"
