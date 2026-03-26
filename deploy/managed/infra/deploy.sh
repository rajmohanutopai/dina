#!/usr/bin/env bash
# deploy.sh — Deploy Dina shared infrastructure
#
# Configuration is read from infra.env (gitignored).
# See infra.env.example for the template.
#
# Usage:
#   ./deploy.sh              # full deploy (first time)
#   ./deploy.sh update       # pull latest code and restart
#   ./deploy.sh status       # check services
#   ./deploy.sh logs [svc]   # tail logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# ── Load config ──
if [ ! -f "$SCRIPT_DIR/infra.env" ]; then
    echo "Error: infra.env not found. Copy infra.env.example to infra.env and fill in."
    exit 1
fi
source "$SCRIPT_DIR/infra.env"

: "${REMOTE:?REMOTE not set in infra.env}"
: "${REMOTE_DIR:?REMOTE_DIR not set in infra.env}"
: "${DOMAIN:?DOMAIN not set in infra.env}"
: "${PDS_HOST:?PDS_HOST not set in infra.env}"
: "${MSGBOX_HOST:?MSGBOX_HOST not set in infra.env}"
: "${APPVIEW_HOST:?APPVIEW_HOST not set in infra.env}"

# ── Colors ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}▸${NC} $*"; }
warn()  { echo -e "${YELLOW}▸${NC} $*"; }

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
# Auto-generated from infra.env. Do not edit manually.

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
    info "Building and starting services..."
    ssh "$REMOTE" "
        cd $REMOTE_DIR/deploy
        docker compose -f docker-compose.infra.yml build
        docker compose -f docker-compose.infra.yml up -d
    "
    info "Services started"
}

# ── Step 7: Push AppView schema ──
push_schema() {
    info "Pushing AppView schema..."
    ssh "$REMOTE" "
        cd $REMOTE_DIR/deploy
        # Wait for postgres
        for i in \$(seq 1 30); do
            docker compose -f docker-compose.infra.yml exec -T postgres pg_isready -U dina -d dina_trust >/dev/null 2>&1 && break
            sleep 2
        done
        # Push schema from web container
        docker compose -f docker-compose.infra.yml exec -T appview-web sh -c '
            DATABASE_URL=\$DATABASE_URL npx drizzle-kit push --force 2>/dev/null
        '
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
    info "Deployment complete!"
    echo ""
    echo "  MsgBox:  wss://$MSGBOX_HOST"
    echo "  PDS:     https://$PDS_HOST"
    echo "  AppView: https://$APPVIEW_HOST"
    echo ""
    echo "  Home Nodes connect with:"
    echo "    DINA_MSGBOX_URL=wss://$MSGBOX_HOST"
    echo "    dina-admin appview set https://$APPVIEW_HOST"
}

# ── Main ──
case "${1:-deploy}" in
    deploy)
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
        generate_caddyfile
        sync_files
        prepare_compose
        ssh "$REMOTE" "cd $REMOTE_DIR/deploy && docker compose -f docker-compose.infra.yml build && docker compose -f docker-compose.infra.yml up -d"
        health_check
        ;;
    status)
        ssh "$REMOTE" "cd $REMOTE_DIR/deploy && docker compose -f docker-compose.infra.yml ps"
        ;;
    logs)
        ssh "$REMOTE" "cd $REMOTE_DIR/deploy && docker compose -f docker-compose.infra.yml logs --tail 50 ${2:-}"
        ;;
    *)
        echo "Usage: $0 [deploy|update|status|logs [service]]"
        ;;
esac
