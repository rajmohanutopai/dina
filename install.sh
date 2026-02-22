#!/usr/bin/env bash
# install.sh — Bootstrap Dina Home Node
# Creates directories, generates secrets, sets permissions.
#
# Usage: ./install.sh

set -euo pipefail

DINA_DIR="${DINA_DIR:-$(pwd)}"
SECRETS_DIR="${DINA_DIR}/secrets"
DATA_DIR="${DINA_DIR}/data"

echo "=== Dina Home Node Setup ==="
echo "Directory: ${DINA_DIR}"
echo ""

# --- Create directories ---

mkdir -p "${SECRETS_DIR}"
mkdir -p "${DATA_DIR}/vault"
mkdir -p "${DATA_DIR}/identity"
mkdir -p "${DATA_DIR}/backups"

echo "[ok] Directories created"

# --- Generate secrets ---

if [ ! -f "${SECRETS_DIR}/brain_token" ]; then
    # Generate a 256-bit random token (base64url, no padding)
    python3 -c "import secrets; print(secrets.token_urlsafe(32), end='')" \
        > "${SECRETS_DIR}/brain_token" 2>/dev/null \
        || openssl rand -base64 32 | tr -d '\n' > "${SECRETS_DIR}/brain_token"
    echo "[ok] Generated brain_token"
else
    echo "[skip] brain_token already exists"
fi

# --- Lock permissions ---

chmod 700 "${SECRETS_DIR}"
chmod 600 "${SECRETS_DIR}"/*
chmod 700 "${DATA_DIR}"
chmod 700 "${DATA_DIR}/vault"
chmod 700 "${DATA_DIR}/identity"

echo "[ok] Permissions locked (secrets: 600, dirs: 700)"

# --- Create .env if missing ---

if [ ! -f "${DINA_DIR}/.env" ]; then
    cat > "${DINA_DIR}/.env" << 'ENVEOF'
# Dina Home Node Configuration
# Copy this to .env and customize

# Ports (defaults shown)
# DINA_CORE_PORT=8100
# DINA_BRAIN_PORT=8200
# DINA_LLM_PORT=8080

# Rate limiting
# DINA_RATE_LIMIT=100

# Dead drop spool limit (bytes, default 10MB)
# DINA_SPOOL_MAX=10485760

# LLM configuration
# DINA_LLM_URL=http://llm:8080
# DINA_LLM_MODEL=gemma-2b-it-q4_k_m.gguf

# Cloud LLM (optional — leave empty for local-only)
# DINA_CLOUD_LLM=gemini
# GOOGLE_API_KEY=your-key-here
# ANTHROPIC_API_KEY=your-key-here

# Logging
# DINA_LOG_LEVEL=INFO
ENVEOF
    echo "[ok] Created .env template"
else
    echo "[skip] .env already exists"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your configuration"
echo "  2. docker compose up -d"
echo "  3. Open http://localhost:8100/healthz to verify"
echo ""
echo "For local LLM support:"
echo "  1. Place model file in ./data/models/"
echo "  2. docker compose --profile local-llm up -d"
