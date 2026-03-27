#!/usr/bin/env bash
# switch_infra.sh — Switch all 3 test nodes between local and production infrastructure.
#
# Usage:
#   ./scripts/switch_infra.sh local       # local MsgBox (localhost:7700) + local AppView (localhost:3000)
#   ./scripts/switch_infra.sh production   # Hetzner MsgBox + AppView (dinakernel.com)
#   ./scripts/switch_infra.sh status       # show current setting

set -euo pipefail

DIRS=(
  "/Users/rajmohan/TestEnv/dina"
  "/Users/rajmohan/TestEnv/Sancho/dina"
  "/Users/rajmohan/TestEnv/Alonso/dina"
)

LOCAL_MSGBOX="ws://host.docker.internal:7700"
PROD_MSGBOX="wss://mailbox.dinakernel.com"
PROD_APPVIEW="https://appview.dinakernel.com"
LOCAL_APPVIEW="http://host.docker.internal:3000"

case "${1:-status}" in
  local)
    for dir in "${DIRS[@]}"; do
      sed -i '' "s|DINA_MSGBOX_URL=.*|DINA_MSGBOX_URL=$LOCAL_MSGBOX|" "$dir/docker-compose.override.yml"
      # Update KNOWN_PEERS endpoints to local MsgBox
      sed -i '' "s|wss://mailbox.dinakernel.com|$LOCAL_MSGBOX|g" "$dir/docker-compose.override.yml"
    done
    for node in core-dna core-6jp core-xpr; do
      docker exec $node dina-admin msgbox set "$LOCAL_MSGBOX" 2>/dev/null || true
      docker exec $node dina-admin appview set "$LOCAL_APPVIEW" 2>/dev/null || true
    done
    echo "Switched to LOCAL infrastructure"
    echo "  MsgBox:  $LOCAL_MSGBOX"
    echo "  AppView: $LOCAL_APPVIEW"
    echo ""
    echo "Restarting cores..."
    for dir in "${DIRS[@]}"; do
      (cd "$dir" && docker compose up -d --force-recreate core 2>/dev/null) &
    done
    wait
    echo "Done. All cores restarted."
    ;;

  production|prod)
    for dir in "${DIRS[@]}"; do
      sed -i '' "s|DINA_MSGBOX_URL=.*|DINA_MSGBOX_URL=$PROD_MSGBOX|" "$dir/docker-compose.override.yml"
      # Update KNOWN_PEERS endpoints to production MsgBox
      sed -i '' "s|ws://host.docker.internal:7700|$PROD_MSGBOX|g" "$dir/docker-compose.override.yml"
    done
    for node in core-dna core-6jp core-xpr; do
      docker exec $node dina-admin msgbox set "$PROD_MSGBOX" 2>/dev/null || true
      docker exec $node dina-admin appview set "$PROD_APPVIEW" 2>/dev/null || true
    done
    echo "Switched to PRODUCTION infrastructure (dinakernel.com)"
    echo "  MsgBox:  $PROD_MSGBOX"
    echo "  AppView: $PROD_APPVIEW"
    echo ""
    echo "Restarting cores..."
    for dir in "${DIRS[@]}"; do
      (cd "$dir" && docker compose up -d --force-recreate core 2>/dev/null) &
    done
    wait
    echo "Done. All cores restarted."
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
    echo "Usage: $0 [local|production|status]"
    ;;
esac
