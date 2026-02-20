#!/usr/bin/env bash
# install.sh — First-time Dina Home Node setup.
# Generates BRAIN_TOKEN, prompts for passphrase (Security mode),
# creates data directories, and validates prerequisites.
set -euo pipefail

echo "╔══════════════════════════════════════╗"
echo "║     Dina Home Node — First Setup     ║"
echo "╚══════════════════════════════════════╝"
echo

# Check prerequisites
for cmd in docker openssl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd is required but not installed."
        exit 1
    fi
done

# Create directories
echo "Creating data directories..."
mkdir -p data/vault data/inbox data/pds data/models secrets

# Generate BRAIN_TOKEN
if [ -f secrets/brain_token ]; then
    echo "BRAIN_TOKEN already exists. Skipping generation."
else
    echo "Generating BRAIN_TOKEN..."
    openssl rand -hex 32 > secrets/brain_token
    chmod 600 secrets/brain_token
    echo "BRAIN_TOKEN generated."
fi

# Security mode: prompt for passphrase
echo
echo "Security mode: If your Home Node restarts, should Dina unlock"
echo "automatically (Convenience) or wait for your passphrase (Security)?"
echo
echo "  1) Convenience — auto-unlock on reboot (keyfile on disk)"
echo "  2) Security    — manual unlock required (passphrase-protected)"
echo
read -rp "Choose [1/2]: " mode
case "$mode" in
    2)
        echo "Security mode selected."
        echo "You will be prompted for a passphrase when Dina starts."
        echo '{"security_mode": "security"}' > data/config.json
        ;;
    *)
        echo "Convenience mode selected."
        echo '{"security_mode": "convenience"}' > data/config.json
        ;;
esac

echo
echo "Setup complete. Run 'docker compose up' to start Dina."
