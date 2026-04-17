#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose-test-stack.yml"
PROJECT="dina-test"
MANIFEST=".test-stack.json"
KEY_DIR=".test-stack-keys"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

wait_healthy() {
  local name="$1" url="$2" retries="${3:-60}"
  echo -n "  $name: "
  for i in $(seq 1 "$retries"); do
    if curl -sf "$url" > /dev/null 2>&1; then
      echo "healthy"
      return 0
    fi
    sleep 1
  done
  echo "FAILED (timeout after ${retries}s)"
  return 1
}

wait_tcp() {
  local name="$1" host="$2" port="$3" retries="${4:-30}"
  echo -n "  $name: "
  for i in $(seq 1 "$retries"); do
    if python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('$host',$port)); s.close()" 2>/dev/null; then
      echo "healthy"
      return 0
    fi
    sleep 1
  done
  echo "FAILED (timeout after ${retries}s)"
  return 1
}

do_compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

health_check_all() {
  local FAILED=0
  local CHECKED=0
  # 5 actors × 2 (core + brain) = 10 local health checks. Infrastructure
  # (PLC/PDS/AppView/MsgBox) lives on Hetzner and is not probed here —
  # tests that need it will surface infra outages directly.
  local TOTAL=10
  local FAIL_LIST=""

  _check() {
    local name="$1" url="$2" retries="${3:-30}"
    for i in $(seq 1 "$retries"); do
      if curl -sf "$url" > /dev/null 2>&1; then
        CHECKED=$((CHECKED + 1))
        printf "\r  Health checks: %s/%s " "$CHECKED" "$TOTAL"
        return 0
      fi
      sleep 1
    done
    CHECKED=$((CHECKED + 1))
    FAIL_LIST="$FAIL_LIST $name"
    FAILED=1
    printf "\r  Health checks: %s/%s " "$CHECKED" "$TOTAL"
    return 1
  }
  _check_tcp() {
    local name="$1" host="$2" port="$3" retries="${4:-30}"
    for i in $(seq 1 "$retries"); do
      if python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('$host',$port)); s.close()" 2>/dev/null; then
        CHECKED=$((CHECKED + 1))
        printf "\r  Health checks: %s/%s " "$CHECKED" "$TOTAL"
        return 0
      fi
      sleep 1
    done
    CHECKED=$((CHECKED + 1))
    FAIL_LIST="$FAIL_LIST $name"
    FAILED=1
    printf "\r  Health checks: %s/%s " "$CHECKED" "$TOTAL"
    return 1
  }

  printf "  Health checks: 0/%s " "$TOTAL"
  _check "alonso-core"     "http://localhost:19100/healthz" || true
  _check "sancho-core"     "http://localhost:19300/healthz" || true
  _check "chairmaker-core" "http://localhost:19500/healthz" || true
  _check "albert-core"     "http://localhost:19700/healthz" || true
  _check "busdriver-core"  "http://localhost:19900/healthz" || true
  _check "alonso-brain"    "http://localhost:19200/healthz" || true
  _check "sancho-brain"    "http://localhost:19400/healthz" || true
  _check "chairmaker-brain" "http://localhost:19600/healthz" || true
  _check "albert-brain"    "http://localhost:19800/healthz" || true
  _check "busdriver-brain" "http://localhost:20000/healthz" || true

  if [ "$FAILED" -eq 0 ]; then
    printf "\r  Health checks: %s/%s ✓                    \n" "$TOTAL" "$TOTAL"
  else
    printf "\r  Health checks: FAILED —%s\n" "$FAIL_LIST"
  fi
  return $FAILED
}

extract_keys() {
  printf "  Extracting service keys... "
  rm -rf "$KEY_DIR"
  for actor in alonso sancho chairmaker albert busdriver; do
    for role in core brain; do
      dir="$KEY_DIR/$actor/$role"
      mkdir -p "$dir"
      do_compose exec -T "$actor-$role" \
        cat "/run/secrets/service_keys/private/${role}_ed25519_private.pem" \
        > "$dir/${role}_ed25519_private.pem" 2>/dev/null || true
    done
  done
  echo "done"
}

write_manifest() {
  cat > "$MANIFEST" <<MANIFEST
{
  "project": "$PROJECT",
  "compose_file": "$COMPOSE_FILE",
  "mode": "fixed",
  "actors": {
    "alonso":     {"core": "http://localhost:19100", "brain": "http://localhost:19200"},
    "sancho":     {"core": "http://localhost:19300", "brain": "http://localhost:19400"},
    "chairmaker": {"core": "http://localhost:19500", "brain": "http://localhost:19600"},
    "albert":     {"core": "http://localhost:19700", "brain": "http://localhost:19800"},
    "busdriver":  {"core": "http://localhost:19900", "brain": "http://localhost:20000"}
  },
  "services": {
    "plc":      "https://plc.directory",
    "pds":      "https://test-pds.dinakernel.com",
    "appview":  "https://test-appview.dinakernel.com",
    "msgbox":   "wss://test-mailbox.dinakernel.com"
  },
  "secrets": {
    "client_token": "secrets/client_token",
    "key_dir": "$KEY_DIR",
    "alonso_keys":  "$KEY_DIR/alonso",
    "sancho_keys":  "$KEY_DIR/sancho",
    "chairmaker_keys": "$KEY_DIR/chairmaker",
    "albert_keys":  "$KEY_DIR/albert",
    "busdriver_keys": "$KEY_DIR/busdriver"
  }
}
MANIFEST
}

usage() {
  cat <<'USAGE'
Usage: ./prepare_non_unit_env.sh [command]

Commands:
  up        Build, start, health-check, extract keys, write manifest (default)
  down      Tear down (preserves PDS/PLC identity volumes)
  down-all  Tear down and remove ALL volumes (wipes identities — needs re-setup)
  purge     Tear down and remove all images (including postgres, pds, etc.)
  purge-dina  Tear down and remove only Dina images (keep postgres, pds, plc)
  restart   Tear down then bring up fresh (preserves identities)
  status    Health-check all services (no start/stop)
  keys      Re-extract service keys from running containers
  logs      Show last 50 lines from all containers
  ps        Show container status
  help      Show this help

Examples:
  ./prepare_non_unit_env.sh up           # bring up the stack
  ./prepare_non_unit_env.sh down         # tear down (identity preserved)
  ./prepare_non_unit_env.sh down-all     # tear down + wipe ALL volumes
  ./prepare_non_unit_env.sh status       # check health
  ./prepare_non_unit_env.sh logs         # view logs
USAGE
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_up() {
  # --- Tear down (preserve volumes — identity + PDS/PLC persist) ---
  printf "  Tearing down existing stack... "
  do_compose down --remove-orphans >/dev/null 2>&1 || true
  echo "done"

  # --- Build ---
  printf "  Building images... "
  if ! do_compose build >/dev/null 2>&1; then
    echo "FAILED"
    exit 1
  fi
  echo "done"

  # --- Verify + restore identity state if needed ---
  # Validates each actor's identity (DID, key paths) against fixture.
  # Restores from saved state if missing, corrupted, or mismatched.
  local ID_STATE="tests/fixtures/identity-state"
  if [ -d "$ID_STATE" ]; then
    python3 scripts/seed_test_identities.py --check-and-restore
    if [ $? -ne 0 ]; then
      echo "  WARNING: Identity restore had issues — Core may create new DIDs on first boot"
    fi
  fi

  # --- Start ---
  printf "  Starting services... "
  if ! do_compose up -d >/dev/null 2>&1; then
    echo "FAILED — retrying with --force-recreate"
    do_compose up -d --force-recreate >/dev/null 2>&1 || true
  fi
  echo "done"

  # --- Wait for healthy (in-place progress) ---
  for i in $(seq 1 120); do
    HEALTHY=$(do_compose ps --format "{{.Name}} {{.Status}}" 2>/dev/null | grep -c "healthy" || true)
    WITH_HC=$(do_compose ps --format "{{.Name}} {{.Status}}" 2>/dev/null | grep -cE "healthy|unhealthy|starting" || true)
    TOTAL=$(do_compose ps --format "{{.Name}}" 2>/dev/null | wc -l | tr -d ' ')
    printf "\r  Waiting for healthy: %s/%s containers (%s total) " "$HEALTHY" "$WITH_HC" "$TOTAL"
    if [ "$HEALTHY" = "$WITH_HC" ] && [ "$WITH_HC" -gt 0 ]; then
      printf "\r  Waiting for healthy: %s/%s containers (%s total) ✓\n" "$HEALTHY" "$WITH_HC" "$TOTAL"
      break
    fi
    if [ "$i" = "120" ]; then
      printf "\r  Waiting for healthy: %s/%s containers — TIMEOUT\n" "$HEALTHY" "$WITH_HC"
      do_compose ps 2>/dev/null
      exit 1
    fi
    sleep 2
  done

  if ! health_check_all; then
    echo ""
    echo "ERROR: One or more services failed health checks."
    echo "  Run: ./prepare_non_unit_env.sh logs"
    exit 1
  fi

  extract_keys
  write_manifest
  echo "=== Test stack ready ==="
}


cmd_down() {
  printf "  Tearing down test stack (preserving volumes)... "
  do_compose down --remove-orphans >/dev/null 2>&1 || true
  rm -f "$MANIFEST"
  rm -rf "$KEY_DIR"
  echo "done"
}

cmd_down_all() {
  printf "  Tearing down test stack (removing ALL volumes)... "
  do_compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$MANIFEST"
  rm -rf "$KEY_DIR"
  echo "done"
}

cmd_purge() {
  echo "=== Purging test stack (containers + volumes + images) ==="
  do_compose down -v --remove-orphans --rmi all 2>/dev/null || true
  docker image prune -f 2>/dev/null || true
  rm -f "$MANIFEST"
  rm -rf "$KEY_DIR"
  echo "=== Stack and all images removed (including dangling layers) ==="
}

cmd_purge_dina() {
  echo "=== Purging Dina images only (keeping postgres, pds, plc, jetstream) ==="
  do_compose down -v --remove-orphans 2>/dev/null || true
  # Remove only Dina-built images (core, brain, keygen, appview, dummy-agent)
  docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep "^dina-test-" \
    | grep -v -E "postgres|pds|plc|jetstream" \
    | xargs -r docker rmi 2>/dev/null || true
  docker image prune -f 2>/dev/null || true
  rm -f "$MANIFEST"
  rm -rf "$KEY_DIR"
  echo "=== Dina images removed, infra images kept (dangling layers pruned) ==="
}

cmd_restart() {
  cmd_down
  echo ""
  cmd_up
}

cmd_status() {
  if health_check_all; then
    echo "=== All services healthy ==="
  else
    echo ""
    echo "ERROR: One or more services unhealthy."
    exit 1
  fi
}

cmd_keys() {
  extract_keys
  write_manifest
}

cmd_logs() {
  do_compose logs --tail=50
}

cmd_ps() {
  do_compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

CMD="${1:-help}"
START_TIME=$SECONDS

case "$CMD" in
  up)       cmd_up ;;
  down)     cmd_down ;;
  down-all) cmd_down_all ;;
  purge)      cmd_purge ;;
  purge-dina) cmd_purge_dina ;;
  restart)    cmd_restart ;;
  status)   cmd_status ;;
  keys)     cmd_keys ;;
  logs)     cmd_logs ;;
  ps)       cmd_ps ;;
  help|-h|--help) usage ;;
  *)
    echo "Unknown command: $CMD"
    echo ""
    usage
    exit 1
    ;;
esac

ELAPSED=$(( SECONDS - START_TIME ))
MINS=$(( ELAPSED / 60 ))
SECS=$(( ELAPSED % 60 ))
if [ "$MINS" -gt 0 ]; then
  echo "  [total: ${MINS}m${SECS}s]"
else
  echo "  [total: ${SECS}s]"
fi
