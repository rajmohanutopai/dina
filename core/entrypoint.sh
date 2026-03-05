#!/bin/sh
# entrypoint.sh — Copy Docker secrets to dina-readable files, then drop to dina.
#
# Docker Compose (non-Swarm) mounts /run/secrets/* as root:root 0400 on some
# platforms (e.g. rootless Docker, Ubuntu VMs), making them unreadable by the
# non-root "dina" user (UID 10001). This script runs as root, copies each
# secret to /tmp/secrets/ owned by dina, rewrites the _FILE env vars to point
# there, then drops privileges via gosu. The secret never touches process
# environment — it stays in a file, readable only by dina.

set -e

SECRET_DIR="/tmp/secrets"
mkdir -p "$SECRET_DIR"

# copy_secret SRC DEST
#   Copies a root-owned secret file to a dina-owned location.
copy_secret() {
    src="$1"
    dest="$2"
    if [ -f "$src" ]; then
        cp "$src" "$dest"
        chown dina:dina "$dest"
        chmod 0400 "$dest"
    fi
}

# Service keys — ensure the dina user owns the private key directory.
# The bind-mounted host dir may be root:root; the Go binary runs as dina.
if [ -d "/run/secrets/service_keys/private" ]; then
    chown -R dina:dina /run/secrets/service_keys/private || true
fi
# Public key directory is read-only at runtime by default.
# During explicit provisioning mode (DINA_SERVICE_KEY_INIT=1), keep writable.
if [ -d "/run/secrets/service_keys/public" ]; then
    if [ "${DINA_SERVICE_KEY_INIT:-0}" = "1" ]; then
        chown -R dina:dina /run/secrets/service_keys/public || true
    fi
fi

# Client token (optional — for pre-registered admin access).
copy_secret "/run/secrets/client_token" "$SECRET_DIR/client_token"
if [ -f "$SECRET_DIR/client_token" ]; then
    export DINA_CLIENT_TOKEN_FILE="$SECRET_DIR/client_token"
fi

# Seed wrapping files — copy to vault path on first start.
# Core expects master_seed.wrapped + master_seed.salt in DINA_VAULT_PATH.
VAULT_PATH="${DINA_VAULT_PATH:-/data/vault}"
mkdir -p "$VAULT_PATH"

if [ -f "/run/secrets/wrapped_seed" ] && [ ! -f "$VAULT_PATH/master_seed.wrapped" ]; then
    cp "/run/secrets/wrapped_seed" "$VAULT_PATH/master_seed.wrapped"
    chown dina:dina "$VAULT_PATH/master_seed.wrapped"
    chmod 0600 "$VAULT_PATH/master_seed.wrapped"
fi

if [ -f "/run/secrets/identity_salt" ] && [ ! -f "$VAULT_PATH/master_seed.salt" ]; then
    cp "/run/secrets/identity_salt" "$VAULT_PATH/master_seed.salt"
    chown dina:dina "$VAULT_PATH/master_seed.salt"
    chmod 0600 "$VAULT_PATH/master_seed.salt"
fi

# Seed password (Server Mode — non-empty file means auto-unlock).
copy_secret "/run/secrets/seed_password" "$SECRET_DIR/seed_password"
if [ -f "$SECRET_DIR/seed_password" ] && [ -s "$SECRET_DIR/seed_password" ]; then
    export DINA_SEED_PASSWORD_FILE="$SECRET_DIR/seed_password"
fi

# Ensure admin socket directory exists and is writable by dina.
# Socket is container-internal; dina-admin runs inside via docker exec.
ADMIN_SOCK_DIR="${DINA_ADMIN_SOCKET%/*}"
if [ -n "$ADMIN_SOCK_DIR" ] && [ "$ADMIN_SOCK_DIR" != "$DINA_ADMIN_SOCKET" ]; then
    mkdir -p "$ADMIN_SOCK_DIR"
    chown dina:dina "$ADMIN_SOCK_DIR"
    chmod 0750 "$ADMIN_SOCK_DIR"
fi

# Drop privileges and exec the Go binary.
exec gosu dina "$@"
