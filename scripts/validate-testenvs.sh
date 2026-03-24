#!/usr/bin/env bash
# Validate all TestEnv instances are up-to-date and healthy.
# Usage: ./scripts/validate-testenvs.sh
set -euo pipefail

SRC="/Users/rajmohan/OpenSource/dina"
GIT_HASH=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo "?")
VERSION=$(cat "$SRC/VERSION" 2>/dev/null || echo "?")
EXPECTED="${VERSION}+${GIT_HASH}"

echo "Expected version: ${EXPECTED}"
echo ""

ALL_OK=true

check_env() {
  local name="$1" port="$2" venv="$3"

  # Core healthz
  local core_ver
  core_ver=$(curl -sf "http://localhost:${port}/healthz" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "unreachable")

  # CLI version (package version only — git hash is cwd-dependent)
  local cli_ver
  cli_ver=$($venv/bin/dina --version 2>&1 | awk '{print $NF}' | cut -d'+' -f1)

  # Pairing
  local paired
  paired=$($venv/bin/dina status 2>&1 | grep "Paired:" | awk '{print $2}')

  local core_ok="PASS"
  [ "$core_ver" != "$EXPECTED" ] && core_ok="FAIL ($core_ver)" && ALL_OK=false

  local pair_ok="PASS"
  [ "$paired" != "yes" ] && pair_ok="FAIL" && ALL_OK=false

  printf "  %-12s Core: %-8s  CLI: %-8s  Paired: %-4s\n" "$name" "$core_ok" "$cli_ver" "$pair_ok"
}

check_env "Default" 8100 "/Users/rajmohan/TestEnv/dina/.venv"
check_env "Sancho"  9100 "/Users/rajmohan/TestEnv/Sancho/dina/.venv"
check_env "Alonso"  9150 "/Users/rajmohan/TestEnv/Alonso/dina/.venv"

echo ""
if [ "$ALL_OK" = true ]; then
  echo "All environments OK."
else
  echo "ISSUES FOUND — check above."
fi
