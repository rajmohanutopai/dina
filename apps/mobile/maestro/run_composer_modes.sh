#!/usr/bin/env bash
# Hybrid runner for the composer-modes test (docs/COMPOSER_MODES_DESIGN.md).
#
# Why hybrid: Maestro can assert the chip strip and (post-tap) the Talk
# navigation, but it CANNOT drive the small RN horizontal ScrollView that holds
# the 6 mode chips — only an OS-level swipe (idb on iOS, adb on Android) scrolls
# it. So this script:
#   1. maestro test composer_modes.yaml          — stable chips render
#   2. OS swipe to scroll the strip + tap Talk    — idb (iOS) / adb (Android)
#   3. maestro test composer_talk_assert.yaml     — Talk navigated to the picker
#
# Usage:
#   run_composer_modes.sh ios   <UDID>
#   run_composer_modes.sh android <SERIAL>
set -euo pipefail

PLATFORM="${1:?usage: run_composer_modes.sh <ios|android> <device-id>}"
DEVICE="${2:?usage: run_composer_modes.sh <ios|android> <device-id>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAESTRO="${MAESTRO_BIN:-maestro}"

echo "== [1/3] chips render (maestro) =="
"$MAESTRO" --device "$DEVICE" test "$HERE/composer_modes.yaml"

# Pull the Talk chip's bounds (and a couple of on-strip anchors) from the live
# hierarchy. Maestro reports iOS bounds in points, Android in pixels — the same
# space idb/adb consume per platform, so no conversion is needed.
read_bounds() { # $1 = resource-id ; echoes "x1 y1 x2 y2" or nothing
  "$MAESTRO" --device "$DEVICE" hierarchy 2>/dev/null \
    | python3 -c "
import sys, json
rid = sys.argv[1]
def walk(n):
    yield n
    for c in (n.get('children') or []): yield from walk(c)
try:
    h = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for n in walk(h):
    a = n.get('attributes', {}) or {}
    if a.get('resource-id') == rid:
        b = a.get('bounds','')
        import re
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', b)
        if m: print(' '.join(m.groups())); break
" "$1"
}

center() { echo "$(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))"; }

os_swipe() { # x1 y1 x2 y2
  if [ "$PLATFORM" = "ios" ]; then
    idb ui swipe --udid "$DEVICE" "$1" "$2" "$3" "$4" --duration 0.4
  else
    adb -s "$DEVICE" shell input swipe "$1" "$2" "$3" "$4" 400
  fi
}
os_tap() { # x y
  if [ "$PLATFORM" = "ios" ]; then
    idb ui tap --udid "$DEVICE" "$1" "$2"
  else
    adb -s "$DEVICE" shell input tap "$1" "$2"
  fi
}

echo "== [2/3] scroll strip + tap Talk ($PLATFORM swipe) =="
ASK=$(read_bounds index-mode-chip-ask)
# With no paired agent Reviews is visible at rest. A paired agent inserts Task,
# so Reviews can be clipped; Services remains the rightmost stable anchor.
RIGHT=$(read_bounds index-mode-chip-reviews)
[ -n "$RIGHT" ] || RIGHT=$(read_bounds index-mode-chip-services)
[ -n "$ASK" ] || { echo "FAIL: ask chip not found"; exit 1; }
[ -n "$RIGHT" ] || { echo "FAIL: right-side composer anchor not found"; exit 1; }
read -r AX1 AY1 AX2 AY2 <<<"$ASK"
read -r RX1 RY1 RX2 RY2 <<<"$RIGHT"
read -r ACX ACY <<<"$(center "$AX1" "$AY1" "$AX2" "$AY2")"
read -r RCX RCY <<<"$(center "$RX1" "$RY1" "$RX2" "$RY2")"
# Drag from the rightmost visible chip toward Ask (content moves left and
# reveals Reviews + Talk). Two passes guarantee Talk clears the clip edge.
os_swipe "$RCX" "$RCY" "$ACX" "$ACY"; sleep 1
os_swipe "$RCX" "$RCY" "$ACX" "$ACY"; sleep 1
REV=$(read_bounds index-mode-chip-reviews)
[ -n "$REV" ] || { echo "FAIL: reviews chip not in hierarchy after swipe"; exit 1; }
TALK=$(read_bounds index-mode-chip-talk)
[ -n "$TALK" ] || { echo "FAIL: talk chip not in hierarchy"; exit 1; }
read -r TX1 TY1 TX2 TY2 <<<"$TALK"
read -r TCX TCY <<<"$(center "$TX1" "$TY1" "$TX2" "$TY2")"
echo "Talk now at center ($TCX,$TCY) — tapping"
os_tap "$TCX" "$TCY"; sleep 2

echo "== [3/3] Talk navigated to the contact picker (maestro) =="
"$MAESTRO" --device "$DEVICE" test "$HERE/composer_talk_assert.yaml"

echo "PASS: composer modes ($PLATFORM / $DEVICE)"
