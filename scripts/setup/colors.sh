#!/usr/bin/env bash
# colors.sh — shared color definitions and status helpers
#
# Source this from any Dina script:
#   source scripts/setup/colors.sh
#
# Provides: GREEN, YELLOW, RED, CYAN, BOLD, DIM, RESET
#           ok(), skip(), fail(), warn(), info()

if [ -t 1 ]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    REVERSE='\033[7m'
    RESET='\033[0m'
else
    GREEN='' YELLOW='' RED='' CYAN='' BOLD='' DIM='' REVERSE='' RESET=''
fi

ok()   { echo -e "  ${GREEN}[ok]${RESET}   $1"; }
skip() { echo -e "  ${DIM}[skip]${RESET} $1"; }
fail() { echo -e "  ${RED}[fail]${RESET} $1" >&2; exit 1; }
warn() { echo -e "  ${YELLOW}[warn]${RESET} $1"; }
info() { echo -e "  ${DIM}[....]${RESET} $1"; }
