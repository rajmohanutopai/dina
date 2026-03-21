#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose-test-stack.yml"
PROJECT="dina-test"
MANIFEST=".test-stack.json"
KEY_DIR=".test-stack-keys"

echo "=== Tearing down any existing test stack ==="
docker compose -p $PROJECT -f $COMPOSE_FILE down -v --remove-orphans 2>/dev/null || true

echo "=== Building all images ==="
docker compose -p $PROJECT -f $COMPOSE_FILE build

echo "=== Starting all services ==="
docker compose -p $PROJECT -f $COMPOSE_FILE up -d --wait

echo "=== Health checks ==="
FAILED=0

# Helper: wait for HTTP health endpoint, exit non-zero if timeout
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
  FAILED=1
  return 1
}

# Core nodes
wait_healthy "alonso-core (19100)"     "http://localhost:19100/healthz" || true
wait_healthy "sancho-core (19300)"     "http://localhost:19300/healthz" || true
wait_healthy "chairmaker-core (19500)" "http://localhost:19500/healthz" || true
wait_healthy "albert-core (19700)"     "http://localhost:19700/healthz" || true

# Brain nodes
wait_healthy "alonso-brain (19200)"     "http://localhost:19200/healthz" || true
wait_healthy "sancho-brain (19400)"     "http://localhost:19400/healthz" || true
wait_healthy "chairmaker-brain (19600)" "http://localhost:19600/healthz" || true
wait_healthy "albert-brain (19800)"     "http://localhost:19800/healthz" || true

# Infrastructure services
wait_healthy "plc (2582)"      "http://localhost:2582/healthz" || true
wait_healthy "pds (2583)"      "http://localhost:2583/xrpc/_health" || true
wait_healthy "appview (3001)"  "http://localhost:3001/health" || true

# Postgres (different check)
echo -n "  postgres (5433): "
if pg_isready -h localhost -p 5433 > /dev/null 2>&1; then
  echo "healthy"
else
  echo "FAILED"
  FAILED=1
fi

# Fail hard if any service is unhealthy
if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "ERROR: One or more services failed health checks."
  echo "Fix the Docker stack before running tests."
  exit 1
fi

echo "=== Extracting service keys from containers ==="
# Integration tests sign requests with Ed25519 service keys.
# The union stack provisions keys via keygen init containers into Docker volumes.
# Extract alonso's keys so tests can sign as brain → Core or core → Brain.
rm -rf "$KEY_DIR"
for actor in alonso sancho chairmaker albert; do
  for role in core brain; do
    dir="$KEY_DIR/$actor/$role"
    mkdir -p "$dir"
    docker compose -p $PROJECT -f $COMPOSE_FILE exec -T "$actor-$role" \
      cat "/run/secrets/service_keys/private/${role}_ed25519_private.pem" \
      > "$dir/${role}_ed25519_private.pem" 2>/dev/null || true
  done
  # Also grab public keys
  pubdir="$KEY_DIR/$actor/public"
  mkdir -p "$pubdir"
  docker compose -p $PROJECT -f $COMPOSE_FILE exec -T "$actor-core" \
    sh -c 'cat /run/secrets/service_keys/public/*' \
    > "$pubdir/public_keys.pem" 2>/dev/null || true
done
echo "  Keys extracted to $KEY_DIR/"

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

echo "=== Test stack ready ==="
