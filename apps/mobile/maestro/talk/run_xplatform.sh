#!/usr/bin/env bash
# Cross-platform two-Dina Talk test (MRS-04): iOS Sancho ↔ Android Alonso
# over real MsgBox. Maestro drives each device's REAL UI; the apps talk
# over the wire. DIDs are per-onboarding — override via env or edit here.
set -uo pipefail
MAESTRO="${MAESTRO:-/opt/homebrew/opt/maestro/bin/maestro}"
IOS="${IOS:-6D57099D-48DA-430D-B4BB-1A2BF1EBACB7}"
AND="${AND:-emulator-5554}"
SANCHO_DID="${SANCHO_DID:-did:plc:s6mbp7pokaqsh5nko26wie5u}"
ALONSO_DID="${ALONSO_DID:-did:plc:22xjwfzivf5id3ic2cjrigxw}"
DIR="$(cd "$(dirname "$0")" && pwd)"
run() { echo "── $1 ──"; "$MAESTRO" test --udid="$2" "${@:3}" 2>&1 | grep -vE "WARNING|picocli|reflect"; }

run "1/3 iOS Sancho setup"  "$IOS" -e ALONSO_DID="$ALONSO_DID" "$DIR/01_sancho_setup.yaml" | tail -20
run "2/3 Android Alonso send" "$AND" -e SANCHO_DID="$SANCHO_DID" "$DIR/02_alonso_send.yaml" | tail -20
run "3/3 iOS Sancho assert"  "$IOS" "$DIR/03_sancho_assert.yaml" | tail -20
