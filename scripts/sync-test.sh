#!/usr/bin/env bash
# sync-test.sh — Copy the working tree to a test directory, respecting .gitignore
#
# Usage:
#   ./scripts/sync-test.sh ~/OpenSource/worktrees/test1/dina
#
# Copies all files (including uncommitted changes) while skipping
# .git/, .env, secrets/, and anything in .gitignore.

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <target-directory>"
    echo "Example: $0 ~/OpenSource/worktrees/test1/dina"
    exit 1
fi

TARGET="$1"
SOURCE="${DINA_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

mkdir -p "${TARGET}"

rsync -av --delete \
    --filter=':- .gitignore' \
    --exclude='.git/' \
    --exclude='.env' \
    --exclude='secrets/' \
    "${SOURCE}/" "${TARGET}/"

echo ""
echo "Synced to ${TARGET}"
