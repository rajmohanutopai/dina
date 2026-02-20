#!/usr/bin/env bash
# setup-dev.sh — Set up the local development environment.
# Installs Go and Python dependencies, generates a dev BRAIN_TOKEN.
set -euo pipefail

echo "=== Dina Dev Setup ==="

# Go
echo "Installing Go dependencies..."
(cd core && go mod download)

# Python
echo "Installing Python dependencies..."
(cd brain && pip install -e ".[dev]")
echo "Downloading spaCy model..."
python -m spacy download en_core_web_sm

# Generate dev BRAIN_TOKEN if not present
if [ ! -f secrets/brain_token ]; then
    echo "Generating BRAIN_TOKEN..."
    mkdir -p secrets
    openssl rand -hex 32 > secrets/brain_token
    echo "BRAIN_TOKEN written to secrets/brain_token"
fi

echo "=== Done ==="
