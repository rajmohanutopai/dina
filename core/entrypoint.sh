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

# Brain token (required).
copy_secret "/run/secrets/brain_token" "$SECRET_DIR/brain_token"
if [ -f "$SECRET_DIR/brain_token" ]; then
    export DINA_BRAIN_TOKEN_FILE="$SECRET_DIR/brain_token"
fi

# Client token (optional — for pre-registered admin access).
copy_secret "/run/secrets/client_token" "$SECRET_DIR/client_token"
if [ -f "$SECRET_DIR/client_token" ]; then
    export DINA_CLIENT_TOKEN_FILE="$SECRET_DIR/client_token"
fi

# Drop privileges and exec the Go binary.
exec gosu dina "$@"
