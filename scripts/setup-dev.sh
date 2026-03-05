#!/usr/bin/env bash
# setup-dev.sh — Set up the local development environment.
# Installs Go and Python dependencies, prepares local service-key directories.
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

echo "Preparing service-key directories..."
mkdir -p secrets/service_keys/core secrets/service_keys/brain secrets/service_keys/public

echo "=== Done ==="
