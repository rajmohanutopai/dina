#!/usr/bin/env bash
# Build all three images in the right order (base → provider / user).
#
# Default: pulls dina-agent from PyPI — the folder is self-contained and can
# be copied to dina-mobile as-is.
#
# Local-dev mode: use the uncommitted ../../cli instead of PyPI:
#   DINA_AGENT_SRC=local ./docker/openclaw/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BUILD_ARGS=()
CONTEXT="$SCRIPT_DIR"

if [ "${DINA_AGENT_SRC:-pypi}" = "local" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    if [ ! -d "$REPO_ROOT/cli" ]; then
        echo "ERROR: DINA_AGENT_SRC=local but $REPO_ROOT/cli doesn't exist." >&2
        exit 1
    fi
    # Copy cli/ into the build context so the Dockerfile can reach it.
    rm -rf "$SCRIPT_DIR/.cli-src"
    cp -R "$REPO_ROOT/cli" "$SCRIPT_DIR/.cli-src"
    BUILD_ARGS+=(--build-arg "DINA_AGENT_PKG=/tmp/dina-cli")
    # Prepend a local install step by overriding the Dockerfile stage.
    # Simpler: let the Dockerfile COPY from .cli-src and install from there.
    # Implemented below via sed-injected stage.
    TMP_DF="$SCRIPT_DIR/Dockerfile.base.local"
    awk '/^RUN pip install --break-system-packages/ {
        print "COPY .cli-src /tmp/dina-cli"
    }
    { print }' "$SCRIPT_DIR/Dockerfile.base" > "$TMP_DF"
    BASE_DF="$TMP_DF"
    cleanup() { rm -rf "$TMP_DF" "$SCRIPT_DIR/.cli-src"; }
    trap cleanup EXIT
else
    BASE_DF="$SCRIPT_DIR/Dockerfile.base"
fi

echo "==> Building dina-openclaw-base (source: ${DINA_AGENT_SRC:-pypi})"
docker build \
    -f "$BASE_DF" \
    ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} \
    -t dina-openclaw-base:latest \
    "$CONTEXT"

echo "==> Building dina-openclaw-provider"
docker build \
    -f "$SCRIPT_DIR/Dockerfile.provider" \
    -t dina-openclaw-provider:latest \
    "$CONTEXT"

echo "==> Building dina-openclaw-user"
docker build \
    -f "$SCRIPT_DIR/Dockerfile.user" \
    -t dina-openclaw-user:latest \
    "$CONTEXT"

echo "==> Done."
docker images | grep -E "^dina-openclaw-(base|provider|user)\s" || true
