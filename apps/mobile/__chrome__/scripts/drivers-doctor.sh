#!/usr/bin/env bash
#
# drivers-doctor.sh — verify which __chrome__ drivers are ready on this
# machine. Prints a green / yellow / red status per driver and exits 0
# regardless (doctoring is informational, not a gate).
#
# Per docs/HOME_NODE_LITE_WEB_UI_TASKS.md §4.6.5 "Driver setup tasks".
#

set -u

# ANSI colours, with a no-tty fallback so logs piped to a file stay
# readable. `$'…'` is the standard bash way to embed real escape
# bytes — `'\033'` would print the literal four characters.
if [ -t 1 ]; then
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[1;33m'
  RED=$'\033[0;31m'
  RESET=$'\033[0m'
else
  GREEN=''
  YELLOW=''
  RED=''
  RESET=''
fi

ok()    { printf "  %s✅%s %s\n" "$GREEN" "$RESET" "$*"; }
warn()  { printf "  %s⚠️%s  %s\n" "$YELLOW" "$RESET" "$*"; }
miss()  { printf "  %s❌%s %s\n" "$RED" "$RESET" "$*"; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile_dir="$(cd "$script_dir/../.." && pwd)"
# Canonicalise the dist path so the doctor output doesn't carry the
# `../` segment from the apps/mobile-relative reach into the sibling
# apps/home-node-lite tree.
spa_dist="$(cd "$mobile_dir/.." && pwd)/home-node-lite/web/dist"

printf "\nDriver doctor — checking the three __chrome__ surfaces:\n\n"

# ────────────────────────────────────────────────────────────────────
# Web driver — Claude Chrome plugin + RNW bundle
# ────────────────────────────────────────────────────────────────────
printf "web driver (Chrome plugin + RNW bundle)\n"
if [ -f "$spa_dist/index.html" ]; then
  size=$(du -sh "$spa_dist" | awk '{print $1}')
  ok "SPA bundle present at $spa_dist ($size)"
else
  warn "SPA bundle missing — run 'npm run web:export' from apps/mobile/"
fi
if pgrep -f "http.server 18290" >/dev/null 2>&1; then
  ok "static server running on :18290"
else
  warn "static server not running — start with __chrome__/scripts/web-export.sh"
fi
# The Chrome plugin itself is checked by the operator via Claude:
# "list connected browsers" must return a local Chrome.
printf "  (Chrome plugin status: ask Claude to list_connected_browsers)\n"
printf "\n"

# ────────────────────────────────────────────────────────────────────
# iOS driver — idb + booted simulator
# ────────────────────────────────────────────────────────────────────
printf "ios driver (idb + iOS simulator)\n"
if command -v idb >/dev/null 2>&1; then
  ok "idb installed ($(idb --version 2>/dev/null || echo 'version unknown'))"
else
  miss "idb missing — pip3 install fb-idb"
fi
if command -v idb_companion >/dev/null 2>&1; then
  ok "idb_companion installed"
else
  miss "idb_companion missing — brew install facebook/fb/idb-companion"
fi
if command -v xcrun >/dev/null 2>&1; then
  booted=$(xcrun simctl list devices 2>/dev/null | grep -c "Booted" || true)
  if [ "$booted" -gt 0 ]; then
    ok "$booted iOS simulator(s) booted"
  else
    warn "no iOS simulator booted — 'xcrun simctl boot \"iPhone 15 Pro\"'"
  fi
else
  miss "xcrun not on PATH — install Xcode command-line tools"
fi
printf "\n"

# ────────────────────────────────────────────────────────────────────
# Android driver — adb + emulator
# ────────────────────────────────────────────────────────────────────
printf "android driver (adb + Android emulator)\n"
if command -v adb >/dev/null 2>&1; then
  ok "adb installed ($(adb version 2>/dev/null | head -1))"
  devices=$(adb devices 2>/dev/null | tail -n +2 | grep -c "device$" || true)
  if [ "$devices" -gt 0 ]; then
    ok "$devices Android device(s) connected"
  else
    warn "no Android device connected — boot an emulator first"
  fi
else
  miss "adb missing — brew install --cask android-commandlinetools"
fi
if command -v emulator >/dev/null 2>&1; then
  ok "android emulator binary on PATH"
else
  warn "android emulator binary not on PATH (only matters if you want to launch one from CLI)"
fi
printf "\n"

printf "Done. See __chrome__/DRIVERS.md for installation details.\n"
