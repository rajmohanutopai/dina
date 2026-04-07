#!/usr/bin/env bash
# switch_infra.sh — Switch all 3 test nodes between test and production infrastructure.
#
# Usage:
#   ./scripts/switch_infra.sh test-remote   # Hetzner test (test-*.dinakernel.com)
#   ./scripts/switch_infra.sh production    # Hetzner production (*.dinakernel.com)
#   ./scripts/switch_infra.sh status        # show current setting

set -euo pipefail

DIRS=(
  "/Users/rajmohan/TestEnv/dina"
  "/Users/rajmohan/TestEnv/Sancho/dina"
  "/Users/rajmohan/TestEnv/Alonso/dina"
)

TEST_MSGBOX="wss://test-mailbox.dinakernel.com"
TEST_APPVIEW="https://test-appview.dinakernel.com"
PROD_MSGBOX="wss://mailbox.dinakernel.com"
PROD_APPVIEW="https://appview.dinakernel.com"

switch_to() {
    local msgbox="$1" appview="$2" label="$3"
    for dir in "${DIRS[@]}"; do
      sed -i '' "s|DINA_MSGBOX_URL=.*|DINA_MSGBOX_URL=$msgbox|" "$dir/docker-compose.override.yml"
      # Update any KNOWN_PEERS MsgBox references
      sed -i '' "s|wss://test-mailbox.dinakernel.com|$msgbox|g" "$dir/docker-compose.override.yml"
      sed -i '' "s|wss://mailbox.dinakernel.com|$msgbox|g" "$dir/docker-compose.override.yml"
    done
    for node in core-dna core-6jp core-xpr; do
      docker exec $node dina-admin msgbox set "$msgbox" 2>/dev/null || true
      docker exec $node dina-admin appview set "$appview" 2>/dev/null || true
    done
    echo "Switched to $label"
    echo "  MsgBox:  $msgbox"
    echo "  AppView: $appview"
    echo ""
    echo "Restarting cores..."
    for dir in "${DIRS[@]}"; do
      (cd "$dir" && docker compose up -d --force-recreate core 2>/dev/null) &
    done
    wait
    echo "Done. All cores restarted."
}

case "${1:-status}" in
  test-remote)
    switch_to "$TEST_MSGBOX" "$TEST_APPVIEW" "TEST-REMOTE infrastructure (test-*.dinakernel.com)"
    ;;

  production|prod)
    switch_to "$PROD_MSGBOX" "$PROD_APPVIEW" "PRODUCTION infrastructure (*.dinakernel.com)"
    ;;

  status)
    echo "Current MsgBox URLs:"
    for dir in "${DIRS[@]}"; do
      name=$(basename $(dirname "$dir"))
      url=$(grep DINA_MSGBOX_URL "$dir/docker-compose.override.yml" | head -1 | sed 's/.*=//')
      echo "  $name: $url"
    done
    ;;

  *)
    echo "Usage: $0 [test-remote|production|status]"
    ;;
esac
