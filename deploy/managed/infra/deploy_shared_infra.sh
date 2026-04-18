#!/usr/bin/env bash
# deploy_shared_infra.sh — Deploy Dina SHARED infrastructure (not a Home Node)
#
# This deploys the provider services that multiple Home Nodes connect to:
#   - Community PDS  (AT Protocol, hosts user trust repos)
#   - MsgBox         (D2D encrypted mailbox, WebSocket + HTTP)
#   - AppView        (Trust Network, 5 xRPC endpoints)
#   - Jetstream      (PDS firehose consumer)
#   - PostgreSQL     (AppView database)
#
# This does NOT deploy a Home Node (Core + Brain + vault).
# Home Nodes run locally and connect to these services outbound.
#
# Configuration is read from infra-{env}.env (gitignored).
# See infra.env.example for the template.
#
# Usage:
#   ./deploy_shared_infra.sh deploy prod     # deploy to production
#   ./deploy_shared_infra.sh deploy test     # deploy to test environment
#   ./deploy_shared_infra.sh update prod     # pull latest code and restart
#   ./deploy_shared_infra.sh status test     # check services
#   ./deploy_shared_infra.sh logs test       # tail logs
#   ./deploy_shared_infra.sh logs prod pds   # tail logs for a specific service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# ── Parse arguments ──
ACTION="${1:-}"
ENV_NAME="${2:-}"

# For 'logs' command, the service name shifts to $3
LOG_SERVICE="${3:-}"

if [ -z "$ACTION" ] || [ -z "$ENV_NAME" ]; then
    echo "Error: environment is required."
    echo ""
    echo "Usage: $0 <action> <env> [service]"
    echo ""
    echo "  Actions:  deploy | update | status | logs"
    echo "  Envs:     prod | test"
    echo ""
    echo "  Examples:"
    echo "    $0 deploy prod          # first-time deploy to production"
    echo "    $0 deploy test          # first-time deploy to test"
    echo "    $0 update prod          # update production"
    echo "    $0 status test          # check test services"
    echo "    $0 logs test msgbox     # tail msgbox logs in test"
    exit 1
fi

if [ "$ENV_NAME" != "prod" ] && [ "$ENV_NAME" != "test" ]; then
    echo "Error: environment must be 'prod' or 'test', got '$ENV_NAME'"
    exit 1
fi

# ── Load config ──
ENV_FILE="$SCRIPT_DIR/infra-${ENV_NAME}.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found."
    echo ""
    echo "Create it from infra.env.example:"
    echo "  cp infra.env.example infra-${ENV_NAME}.env"
    echo "  # edit infra-${ENV_NAME}.env with your ${ENV_NAME} settings"
    exit 1
fi
source "$ENV_FILE"

: "${REMOTE:?REMOTE not set in infra-${ENV_NAME}.env}"
: "${REMOTE_DIR:?REMOTE_DIR not set in infra-${ENV_NAME}.env}"
: "${DOMAIN:?DOMAIN not set in infra-${ENV_NAME}.env}"
: "${PDS_HOST:?PDS_HOST not set in infra-${ENV_NAME}.env}"
: "${MSGBOX_HOST:?MSGBOX_HOST not set in infra-${ENV_NAME}.env}"
: "${APPVIEW_HOST:?APPVIEW_HOST not set in infra-${ENV_NAME}.env}"

# Compose project name — isolates prod/test containers and volumes
COMPOSE_PROJECT="${COMPOSE_PROJECT:-dina-infra-${ENV_NAME}}"

# ── Colors ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}▸${NC} $*"; }
warn()  { echo -e "${YELLOW}▸${NC} $*"; }

ENV_LABEL="$(echo "$ENV_NAME" | tr '[:lower:]' '[:upper:]')"

# ── Confirmation ──
confirm_deploy() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Dina Shared Infrastructure — ${CYAN}${ENV_LABEL}${GREEN} Deployment${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  This will deploy the following to ${YELLOW}${REMOTE}${NC}:"
    echo ""
    echo "    PDS:     https://${PDS_HOST}"
    echo "    MsgBox:  wss://${MSGBOX_HOST}"
    echo "    AppView: https://${APPVIEW_HOST}"
    echo ""
    echo "  Remote dir: ${REMOTE_DIR}"
    echo "  Project:    ${COMPOSE_PROJECT}"
    echo ""
    echo "  Services: Caddy (TLS), PDS, MsgBox, Jetstream,"
    echo "            PostgreSQL, Ingester, Scorer, AppView Web"
    echo ""
    if [ "$ENV_NAME" = "prod" ]; then
        echo -e "  ${RED}⚠  PRODUCTION deployment. This affects live users.${NC}"
    else
        echo -e "  ${CYAN}ℹ  TEST deployment. Isolated from production.${NC}"
    fi
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
    echo ""
    read -rp "  Type 'yes, deploy ${ENV_NAME}' to proceed: " answer
    if [ "$answer" != "yes, deploy ${ENV_NAME}" ]; then
        echo "  Aborted."
        exit 0
    fi
    echo ""
}

# ── Step 1: Ensure remote has Docker ──
setup_remote() {
    info "Checking Docker on remote..."
    ssh "$REMOTE" 'command -v docker >/dev/null 2>&1' || {
        info "Installing Docker..."
        ssh "$REMOTE" 'curl -fsSL https://get.docker.com | sh'
    }
    ssh "$REMOTE" 'docker compose version >/dev/null 2>&1' || {
        info "Installing Docker Compose plugin..."
        ssh "$REMOTE" 'apt-get update && apt-get install -y docker-compose-plugin'
    }
    info "Docker ready"
}

# ── Step 2: Generate Caddyfile from config ──
generate_caddyfile() {
    info "Generating Caddyfile..."
    cat > "$SCRIPT_DIR/Caddyfile" << EOF
# Auto-generated for ${ENV_LABEL} from infra-${ENV_NAME}.env. Do not edit manually.

${PDS_HOST} {
	reverse_proxy pds:3000
}

${MSGBOX_HOST} {
	reverse_proxy msgbox:7700
}

${APPVIEW_HOST} {
	reverse_proxy appview-web:3000
}
EOF
}

# ── Step 3: Generate compose with correct hostnames ──
prepare_compose() {
    info "Preparing compose..."
    ssh "$REMOTE" "
        cd $REMOTE_DIR/deploy
        # Inject PDS hostname from config
        sed -i 's|PDS_HOSTNAME:.*|PDS_HOSTNAME: $PDS_HOST|' docker-compose.infra.yml
        # Fix build context paths
        sed -i 's|context: ../../msgbox|context: ../msgbox|g' docker-compose.infra.yml
        sed -i 's|context: ../../appview|context: ../appview|g' docker-compose.infra.yml
    "
}

# ── Step 4: Sync project files ──
sync_files() {
    info "Syncing project to $REMOTE:$REMOTE_DIR..."
    ssh "$REMOTE" "mkdir -p $REMOTE_DIR"

    # Deployment files (compose, Caddyfile, deploy script)
    rsync -az --delete \
        --exclude='infra-*.env' \
        --exclude='infra.env' \
        --exclude='.env' \
        "$SCRIPT_DIR/" \
        "$REMOTE:$REMOTE_DIR/deploy/"

    # MsgBox source
    rsync -az --delete \
        --exclude='data/' \
        "$PROJECT_ROOT/msgbox/" \
        "$REMOTE:$REMOTE_DIR/msgbox/"

    # AppView source
    rsync -az --delete \
        --exclude='node_modules' \
        --exclude='dist' \
        --exclude='.env' \
        "$PROJECT_ROOT/appview/" \
        "$REMOTE:$REMOTE_DIR/appview/"

    info "Files synced"
}

# ── Step 5: Generate secrets if not present ──
generate_secrets() {
    info "Checking secrets..."
    ssh "$REMOTE" 'cd '"$REMOTE_DIR"'/deploy && if [ ! -f .env ]; then
        PG=$(openssl rand -hex 16)
        PA=$(openssl rand -hex 16)
        PJ=$(openssl rand -base64 32)
        RK=$(openssl ecparam -name secp256k1 -genkey -noout 2>/dev/null | openssl ec -text -noout 2>/dev/null | grep priv -A 3 | tail -n +2 | tr -d ":\n ")
        printf "POSTGRES_PASSWORD=%s\nPDS_ADMIN_PASSWORD=%s\nPDS_JWT_SECRET=%s\nPDS_ROTATION_KEY=%s\n" "$PG" "$PA" "$PJ" "$RK" > .env
        chmod 600 .env
        echo "Secrets generated"
    else
        echo ".env exists, keeping"
    fi'
}

# ── Step 6: Build and start ──
start_services() {
    info "Building and starting services (project: ${COMPOSE_PROJECT})..."
    ssh "$REMOTE" "
        cd $REMOTE_DIR/deploy
        COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.infra.yml build
        COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.infra.yml up -d
    "
    info "Services started"
}

# ── Step 7: Push AppView schema ──
push_schema() {
    info "Pushing AppView schema..."
    ssh "$REMOTE" "
        cd $REMOTE_DIR
        # Wait for postgres
        for i in \$(seq 1 30); do
            COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f deploy/docker-compose.infra.yml exec -T postgres pg_isready -U dina -d dina_trust >/dev/null 2>&1 && break
            sleep 2
        done
        # Build the migrator stage (has drizzle-kit + drizzle.config.ts + schema)
        docker build --target migrator -t ${COMPOSE_PROJECT}-migrator appview/
        # Run migrator on the compose network
        PG_PASS=\$(grep POSTGRES_PASSWORD deploy/.env | cut -d= -f2)
        docker run --rm \
            --network ${COMPOSE_PROJECT}_default \
            -e DATABASE_URL=postgresql://dina:\${PG_PASS}@postgres:5432/dina_trust \
            ${COMPOSE_PROJECT}-migrator
    "
    info "Schema pushed"
}

# ── Step 8: Health check ──
health_check() {
    info "Running health checks..."
    sleep 5

    for svc in "$MSGBOX_HOST/healthz" "$APPVIEW_HOST/health" "$PDS_HOST/xrpc/_health"; do
        if curl -sf "https://$svc" >/dev/null 2>&1; then
            info "  ✓ https://$svc"
        else
            warn "  ✗ https://$svc (may need a moment for TLS)"
        fi
    done

    echo ""
    info "${ENV_LABEL} deployment complete!"
    echo ""
    echo "  MsgBox:  wss://$MSGBOX_HOST"
    echo "  PDS:     https://$PDS_HOST"
    echo "  AppView: https://$APPVIEW_HOST"
    echo ""
    echo "  Home Nodes connect with:"
    echo "    DINA_MSGBOX_URL=wss://$MSGBOX_HOST"
    echo "    DINA_APPVIEW_URL=https://$APPVIEW_HOST"
    echo "    DINA_COMMUNITY_PDS_URL=https://$PDS_HOST"
}

# ── Main ──
case "$ACTION" in
    deploy)
        confirm_deploy
        setup_remote
        generate_caddyfile
        sync_files
        generate_secrets
        prepare_compose
        start_services
        push_schema
        health_check
        ;;
    update)
        confirm_deploy
        generate_caddyfile
        sync_files
        prepare_compose
        ssh "$REMOTE" "
            cd $REMOTE_DIR/deploy
            COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.infra.yml build
            COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.infra.yml up -d
        "
        health_check
        ;;
    status)
        ssh "$REMOTE" "cd $REMOTE_DIR/deploy && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.infra.yml ps"
        ;;
    logs)
        ssh "$REMOTE" "cd $REMOTE_DIR/deploy && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.infra.yml logs --tail 50 ${LOG_SERVICE}"
        ;;
    *)
        echo "Unknown action: $ACTION"
        echo "Usage: $0 <deploy|update|status|logs> <prod|test> [service]"
        exit 1
        ;;
esac
