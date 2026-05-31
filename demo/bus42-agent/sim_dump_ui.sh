#!/usr/bin/env bash
# Dump the iOS sim's accessibility tree (labels + frames) so we can drive
# taps deterministically instead of guessing pixel coords. Output is compact.
set -uo pipefail
SIM=6D57099D-48DA-430D-B4BB-1A2BF1EBACB7
idb ui describe-all --udid "$SIM" --json > /tmp/sim_ui.json 2>/tmp/sim_ui.err
echo "describe-all exit=$? bytes=$(wc -c </tmp/sim_ui.json 2>/dev/null)"
[ -s /tmp/sim_ui.err ] && { echo "--- stderr ---"; head -5 /tmp/sim_ui.err; }
python3 - <<'PY'
import json
try:
    els = json.load(open('/tmp/sim_ui.json'))
except Exception as e:
    print("PARSE FAIL:", e); raise SystemExit
if isinstance(els, dict):
    els = els.get('value') or els.get('elements') or [els]
def center(f):
    if not f: return None
    return (round(f['x']+f['width']/2), round(f['y']+f['height']/2))
print(f"elements: {len(els)}")
for e in els:
    t = e.get('type') or e.get('AXType') or ''
    lbl = e.get('AXLabel') or e.get('label') or ''
    val = e.get('AXValue') or e.get('value') or ''
    f = e.get('AXFrame') or e.get('frame')
    c = center(f)
    # only print interactive / labelled things to keep it readable
    if t in ('Button','TextField','TextView','SecureTextField') or lbl or val:
        print(f"  [{t}] label={lbl!r} value={val!r} center={c}")
PY
