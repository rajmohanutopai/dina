#!/usr/bin/env bash
# Drive a DISTINCT product query ("organic strawberries") so the resulting card
# is unambiguously identifiable in the a11y tree (all prior cards are bananas),
# then extract THAT card's rendered text and assert the fix:
#   - price reads "$X.XX" (currency folded in), NOT a bare number
#   - NO "to <store>" caption on the price
# Image rendering to the agent is degraded, so we read accessibility text — the
# ground truth of what rendered. One round-trip; read /tmp/verify_card.txt after.
set -uo pipefail
cd "$(dirname "$0")"
SIM=6D57099D-48DA-430D-B4BB-1A2BF1EBACB7
Q="How much are organic strawberries at Corner Market?"

echo "### STEP 1: tap composer Ask + type the distinct query"
idb ui tap --udid "$SIM" 70 756 >/dev/null 2>&1; sleep 1.2
idb ui text --udid "$SIM" "$Q" >/dev/null 2>&1; sleep 1.0
idb ui tap --udid "$SIM" 366 755 >/dev/null 2>&1   # send arrow (fallback coords)
echo "  sent: $Q"

echo "### STEP 2: wait for the round-trip (discovery -> drcarl -> daemon -> reply)"
for s in $(seq 5 5 70); do sleep 5; done
echo "  waited 70s"

echo "### STEP 3: dump a11y tree + isolate the strawberry card"
idb ui describe-all --udid "$SIM" --json > /tmp/ui_verify.json 2>/dev/null
python3 - <<'PY'
import json, re
els = json.load(open('/tmp/ui_verify.json'))
if isinstance(els, dict): els = els.get('value') or els.get('elements') or [els]
def yof(e):
    s = e.get('AXFrame') or (e.get('frame') if isinstance(e.get('frame'),str) else '')
    n = re.findall(r'-?\d+\.?\d*', s or '')
    return float(n[1]) if len(n)>=4 else None
rows=[]
for e in els:
    if not isinstance(e,dict): continue
    l=(e.get('AXLabel') or e.get('label') or '').strip()
    y=yof(e)
    if l and y is not None: rows.append((y,l))
rows.sort()
# product title: the stub echoes the requested product, so look for 'strawberr'
titles=[(y,l) for (y,l) in rows if 'strawberr' in l.lower() and 'how much' not in l.lower()]
print("strawberry title matches:", [(int(y),l) for y,l in titles])
if not titles:
    print("RESULT: no strawberry CARD title yet (reply may still be in flight or title shows product differently).")
    print("Nearby labels in viewport (y 0..820):")
    for y,l in rows:
        if 0 <= y <= 820: print(f"  y={int(y):4d} {l}")
else:
    ty=titles[-1][0]
    # the card body spans from the title down to just before the next ASK/REMEMBER/DINA marker
    after=[(y,l) for (y,l) in rows if y> ty]
    end=ty+260
    for y,l in after:
        if l in ('ASK','REMEMBER','DINA') or l.endswith('PM') or l.endswith('AM'):
            end=min(end,y);
    card=[(y,l) for (y,l) in rows if ty-12 <= y <= ty+230]
    print(f"=== STRAWBERRY CARD (title y={int(ty)}) ===")
    for y,l in card: print(f"  y={int(y):5d}  {l}")
    blob=" || ".join(l for _,l in card)
    money=re.search(r'[$€£¥₹]\s?\d', blob)
    print("\n=== ASSERTIONS ===")
    print("currency-formatted price present:", bool(money), (money.group(0) if money else ''))
    print("bad 'to Corner Market' caption  :", 'to Corner Market' in blob, "(must be False)")
    print("has a Store row                 :", any('store' in l.lower() and 'example' not in l.lower() for _,l in card))
PY
echo "### DONE"
