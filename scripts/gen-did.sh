#!/usr/bin/env bash
# gen-did.sh — Generate an Ed25519 keypair and derive a did:key.
# Stores the keypair at ~/.dina/identity/ (same location as v0.4).
set -euo pipefail

IDENTITY_DIR="${HOME}/.dina/identity"
mkdir -p "$IDENTITY_DIR"

if [ -f "$IDENTITY_DIR/ed25519.key" ]; then
    echo "Keypair already exists at $IDENTITY_DIR/ed25519.key"
    echo "Delete it first if you want to regenerate."
    exit 1
fi

echo "Generating Ed25519 keypair..."
openssl genpkey -algorithm ed25519 -out "$IDENTITY_DIR/ed25519.key"
openssl pkey -in "$IDENTITY_DIR/ed25519.key" -pubout -out "$IDENTITY_DIR/ed25519.pub"
chmod 600 "$IDENTITY_DIR/ed25519.key"

echo "Keypair written to $IDENTITY_DIR/"
echo "Use 'dina-core' to derive the did:key from this keypair."
