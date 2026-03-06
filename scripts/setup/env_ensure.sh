#!/usr/bin/env bash
# env_ensure.sh — port utilities and required .env key backfill
#
# Source this from install.sh or run.sh:
#   source scripts/setup/env_ensure.sh
#
# Requires: colors.sh sourced first
#
# Functions:
#   port_free PORT                — returns 0 if TCP port is free
#   find_free_port START_PORT     — prints first free port starting from START_PORT (step 100)
#   ensure_required_env ENV_FILE  — backfill missing required keys in .env
#   check_install_complete DIR    — returns 0 if all mandatory install artifacts exist

# Check if a TCP port is free (returns 0 if free, 1 if in use).
port_free() {
    ! nc -z localhost "$1" 2>/dev/null
}

# Find a free port starting from $1, stepping by 100.
find_free_port() {
    local port="$1"
    local max_attempts=20
    local i=0
    while [ $i -lt $max_attempts ]; do
        if port_free "$port"; then
            echo "$port"
            return 0
        fi
        port=$((port + 100))
        i=$((i + 1))
    done
    # Fallback: return original
    echo "$1"
}

# Check that all mandatory install artifacts exist.
# Returns 0 if complete, 1 if something is missing.
# Sets INSTALL_MISSING (space-separated list of missing items).
#
# Verifies actual PEM files, not just directories — runtime is fail-closed
# with DINA_SERVICE_KEY_STRICT=1 and will reject empty key directories.
check_install_complete() {
    local dir="$1"
    local secrets="${dir}/secrets"
    local keys="${secrets}/service_keys"
    local env_file="${dir}/.env"
    INSTALL_MISSING=""

    [ -d "${secrets}" ]                                          || INSTALL_MISSING="${INSTALL_MISSING} secrets/"
    [ -f "${secrets}/wrapped_seed.bin" ]                          || INSTALL_MISSING="${INSTALL_MISSING} wrapped_seed.bin"
    [ -f "${secrets}/master_seed.salt" ]                          || INSTALL_MISSING="${INSTALL_MISSING} master_seed.salt"
    [ -f "${secrets}/seed_password" ]                             || INSTALL_MISSING="${INSTALL_MISSING} seed_password"
    [ -f "${keys}/core/core_ed25519_private.pem" ]                || INSTALL_MISSING="${INSTALL_MISSING} core_private.pem"
    [ -f "${keys}/brain/brain_ed25519_private.pem" ]              || INSTALL_MISSING="${INSTALL_MISSING} brain_private.pem"
    [ -f "${keys}/public/core_ed25519_public.pem" ]               || INSTALL_MISSING="${INSTALL_MISSING} core_public.pem"
    [ -f "${keys}/public/brain_ed25519_public.pem" ]              || INSTALL_MISSING="${INSTALL_MISSING} brain_public.pem"
    [ -f "${env_file}" ]                                          || INSTALL_MISSING="${INSTALL_MISSING} .env"

    [ -z "${INSTALL_MISSING}" ]
}

# Backfill missing required keys in an existing .env file.
# Idempotent: skips keys that already exist.
ensure_required_env() {
    local env_file="$1"
    [ -f "$env_file" ] || return 0

    local secrets_dir
    secrets_dir="$(dirname "$env_file")/secrets"

    # Session ID
    if ! grep -q "^DINA_SESSION=" "$env_file" 2>/dev/null; then
        local session
        if [ -f "${secrets_dir}/session_id" ]; then
            session=$(cat "${secrets_dir}/session_id")
        else
            session=$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 3 || true)
        fi
        echo "" >> "$env_file"
        echo "# Session ID — scopes container names and Docker resources" >> "$env_file"
        echo "DINA_SESSION=${session}" >> "$env_file"
        ok "Added DINA_SESSION=${session} to .env"
    fi

    # Compose project name (checked independently — older installs may have
    # DINA_SESSION but not COMPOSE_PROJECT_NAME)
    if ! grep -q "^COMPOSE_PROJECT_NAME=" "$env_file" 2>/dev/null; then
        local cpn_session
        cpn_session=$(sed -n 's/^DINA_SESSION=\(.*\)$/\1/p' "$env_file" 2>/dev/null || true)
        if [ -n "$cpn_session" ]; then
            echo "COMPOSE_PROJECT_NAME=dina-${cpn_session}" >> "$env_file"
            ok "Added COMPOSE_PROJECT_NAME=dina-${cpn_session} to .env"
        fi
    fi

    # Host ports (each checked independently, avoiding sibling collisions)
    local existing_core existing_pds
    existing_core=$(sed -n 's/^DINA_CORE_PORT=\(.*\)$/\1/p' "$env_file" 2>/dev/null || true)
    existing_pds=$(sed -n 's/^DINA_PDS_PORT=\(.*\)$/\1/p' "$env_file" 2>/dev/null || true)

    if [ -z "$existing_core" ]; then
        local core_port
        core_port=$(find_free_port 8100)
        # Avoid colliding with the sibling PDS port already in .env
        if [ -n "$existing_pds" ] && [ "$core_port" = "$existing_pds" ]; then
            core_port=$(find_free_port $((core_port + 100)))
        fi
        echo "DINA_CORE_PORT=${core_port}" >> "$env_file"
        ok "Added DINA_CORE_PORT=${core_port} to .env"
        existing_core="$core_port"
    fi
    if [ -z "$existing_pds" ]; then
        local pds_port
        pds_port=$(find_free_port 2583)
        # Avoid colliding with the sibling Core port already in .env
        if [ "$pds_port" = "$existing_core" ]; then
            pds_port=$(find_free_port $((pds_port + 100)))
        fi
        echo "DINA_PDS_PORT=${pds_port}" >> "$env_file"
        ok "Added DINA_PDS_PORT=${pds_port} to .env"
    fi

    # Service key provisioning mode
    if ! grep -q "^DINA_SERVICE_KEY_INIT=" "$env_file" 2>/dev/null; then
        echo "DINA_SERVICE_KEY_INIT=0" >> "$env_file"
        ok "Added DINA_SERVICE_KEY_INIT=0 to .env"
    fi
    if ! grep -q "^DINA_SERVICE_KEY_STRICT=" "$env_file" 2>/dev/null; then
        echo "DINA_SERVICE_KEY_STRICT=1" >> "$env_file"
        ok "Added DINA_SERVICE_KEY_STRICT=1 to .env"
    fi

    # PDS secrets (each checked independently)
    if ! grep -q "^DINA_PDS_JWT_SECRET=" "$env_file" 2>/dev/null; then
        echo "DINA_PDS_JWT_SECRET=$(openssl rand -hex 32)" >> "$env_file"
        ok "Added DINA_PDS_JWT_SECRET to .env"
    fi
    if ! grep -q "^DINA_PDS_ADMIN_PASSWORD=" "$env_file" 2>/dev/null; then
        echo "DINA_PDS_ADMIN_PASSWORD=$(openssl rand -hex 16)" >> "$env_file"
        ok "Added DINA_PDS_ADMIN_PASSWORD to .env"
    fi
    if ! grep -q "^DINA_PDS_ROTATION_KEY_HEX=" "$env_file" 2>/dev/null; then
        echo "DINA_PDS_ROTATION_KEY_HEX=$(openssl rand -hex 32)" >> "$env_file"
        ok "Added DINA_PDS_ROTATION_KEY_HEX to .env"
    fi

    chmod 600 "$env_file"
}
