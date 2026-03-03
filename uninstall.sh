#!/usr/bin/env bash
# uninstall.sh — Stop and remove Dina Home Node containers
#
# Usage:
#   ./uninstall.sh           # stop containers, preserve data
#   ./uninstall.sh --purge   # stop containers AND remove all data

set -euo pipefail

DINA_DIR="${DINA_DIR:-$(pwd)}"
PURGE=false

for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=true ;;
    esac
done

# Colors
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    BOLD='\033[1m'
    RESET='\033[0m'
else
    GREEN='' YELLOW='' RED='' BOLD='' RESET=''
fi

echo ""
echo -e "${BOLD}Dina Home Node — Uninstall${RESET}"
echo ""

# Detect compose command
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    echo -e "  ${YELLOW}[warn]${RESET} Docker Compose not found — skipping container cleanup"
    COMPOSE=""
fi

# Stop containers
if [ -n "${COMPOSE}" ]; then
    if [ "${PURGE}" = true ]; then
        echo -e "  Stopping containers and removing volumes..."
        $COMPOSE down -v 2>/dev/null || true
    else
        echo -e "  Stopping containers..."
        $COMPOSE down 2>/dev/null || true
    fi
    echo -e "  ${GREEN}[ok]${RESET} Containers stopped"
fi

# Purge local files
if [ "${PURGE}" = true ]; then
    echo -e "  Removing secrets..."
    rm -rf "${DINA_DIR}/secrets"
    echo -e "  ${GREEN}[ok]${RESET} Secrets removed"

    if [ -f "${DINA_DIR}/.env" ]; then
        echo -e "  Removing .env..."
        rm -f "${DINA_DIR}/.env"
        echo -e "  ${GREEN}[ok]${RESET} .env removed"
    fi

    echo ""
    echo -e "  ${RED}${BOLD}All data removed.${RESET}"
    echo -e "  Your DID and recovery phrase are the only way to restore your identity."
else
    echo ""
    echo -e "  ${GREEN}Data preserved.${RESET} Docker volumes and secrets are intact."
    echo -e "  To restart: ${GREEN}docker compose up -d${RESET}"
    echo -e "  To remove everything: ${YELLOW}./uninstall.sh --purge${RESET}"
fi

echo ""
