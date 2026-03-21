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
  echo "=== Health checks ==="
  wait_healthy "alonso-core (19100)"     "http://localhost:19100/healthz" || FAILED=1
  wait_healthy "sancho-core (19300)"     "http://localhost:19300/healthz" || FAILED=1
  wait_healthy "chairmaker-core (19500)" "http://localhost:19500/healthz" || FAILED=1
  wait_healthy "albert-core (19700)"     "http://localhost:19700/healthz" || FAILED=1
  wait_healthy "alonso-brain (19200)"    "http://localhost:19200/healthz" || FAILED=1
  wait_healthy "sancho-brain (19400)"    "http://localhost:19400/healthz" || FAILED=1
  wait_healthy "chairmaker-brain (19600)" "http://localhost:19600/healthz" || FAILED=1
  wait_healthy "albert-brain (19800)"    "http://localhost:19800/healthz" || FAILED=1
  wait_healthy "plc (2582)"             "http://localhost:2582/healthz" || FAILED=1
  wait_healthy "pds (2583)"             "http://localhost:2583/xrpc/_health" || FAILED=1
  wait_healthy "appview (3001)"         "http://localhost:3001/health" || FAILED=1
  wait_tcp     "postgres (5433)"        "localhost" 5433 || FAILED=1
  return $FAILED
}

extract_keys() {
  echo "=== Extracting service keys ==="
  rm -rf "$KEY_DIR"
  for actor in alonso sancho chairmaker albert; do
    for role in core brain; do
      dir="$KEY_DIR/$actor/$role"
      mkdir -p "$dir"
      do_compose exec -T "$actor-$role" \
        cat "/run/secrets/service_keys/private/${role}_ed25519_private.pem" \
        > "$dir/${role}_ed25519_private.pem" 2>/dev/null || true
    done
  done
  echo "  Keys extracted to $KEY_DIR/"
}

write_manifest() {
  echo "=== Writing manifest ==="
  cat > "$MANIFEST" <<MANIFEST
{
  "project": "$PROJECT",
  "compose_file": "$COMPOSE_FILE",
  "mode": "fixed",
  "actors": {
    "alonso":     {"core": "http://localhost:19100", "brain": "http://localhost:19200"},
    "sancho":     {"core": "http://localhost:19300", "brain": "http://localhost:19400"},
    "chairmaker": {"core": "http://localhost:19500", "brain": "http://localhost:19600"},
    "albert":     {"core": "http://localhost:19700", "brain": "http://localhost:19800"}
  },
  "services": {
    "plc":      "http://localhost:2582",
    "pds":      "http://localhost:2583",
    "postgres": "postgresql://dina:dina@localhost:5433/dina_trust",
    "appview":  "http://localhost:3001"
  },
  "secrets": {
    "client_token": "secrets/client_token",
    "key_dir": "$KEY_DIR",
    "alonso_keys":  "$KEY_DIR/alonso",
    "sancho_keys":  "$KEY_DIR/sancho",
    "chairmaker_keys": "$KEY_DIR/chairmaker",
    "albert_keys":  "$KEY_DIR/albert"
  }
}
MANIFEST
}

usage() {
  cat <<'USAGE'
Usage: ./prepare_non_unit_env.sh [command]

Commands:
  up        Build, start, health-check, extract keys, write manifest (default)
  down      Tear down the test stack and remove volumes (images kept)
  purge     Tear down and remove all images (including postgres, pds, etc.)
  purge-dina  Tear down and remove only Dina images (keep postgres, pds, plc)
  restart   Tear down then bring up fresh
  status    Health-check all services (no start/stop)
  keys      Re-extract service keys from running containers
  logs      Show last 50 lines from all containers
  ps        Show container status
  help      Show this help

Examples:
  ./prepare_non_unit_env.sh up           # bring up the stack
  ./prepare_non_unit_env.sh down         # tear down
  ./prepare_non_unit_env.sh status       # check health
  ./prepare_non_unit_env.sh logs         # view logs
  ./prepare_non_unit_env.sh purge-dina   # remove Dina images (keep infra)
USAGE
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_up() {
  echo "=== Tearing down any existing test stack ==="
  do_compose down -v --remove-orphans 2>/dev/null || true

  echo "=== Building all images ==="
  do_compose build

  echo "=== Starting all services ==="
  do_compose up -d --wait

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
  echo "=== Tearing down test stack ==="
  do_compose down -v --remove-orphans
  rm -f "$MANIFEST"
  rm -rf "$KEY_DIR"
  echo "=== Stack removed (images kept for faster rebuild) ==="
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
