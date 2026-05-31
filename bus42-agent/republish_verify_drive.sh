#!/usr/bin/env bash
# 1) republish Corner Market's service.profile, 2) poll AppView discovery until
# it returns the provider, 3) drive the banana price query (known-good routing),
# 4) extract the NEWEST price card from the a11y tree and assert the fix.
# Self-contained; read /tmp/rvd.out after.
set -uo pipefail
cd "$(dirname "$0")"
SIM=6D57099D-48DA-430D-B4BB-1A2BF1EBACB7
Q="How much are organic bananas at Corner Market?"

echo "### STEP A: raw discovery BEFORE republish"
curl -s -m 8 "https://test-appview.dinakernel.com/xrpc/com.dinakernel.service.search?capability=price_check" 2>/dev/null | head -c 400
echo

echo
echo "### STEP B: republish Corner Market"
DINA_CORE_URL=http://127.0.0.1:18299 DINA_SERVICE_KEY_DIR=/tmp/drcarl-key-dir DINA_SERVICE_NAME="Corner Market" \
  npx tsx put_service_config_price.ts 2>&1 | grep -iE "PUT succeeded|error|fail|status" | head -5

echo
echo "### STEP C: poll discovery until Corner Market appears (max ~120s)"
FOUND=0
for i in $(seq 1 24); do
  body=$(curl -s -m 8 "https://test-appview.dinakernel.com/xrpc/com.dinakernel.service.search?capability=price_check" 2>/dev/null)
  n=$(printf '%s' "$body" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('services',[])))" 2>/dev/null)
  if [ -n "$n" ] && [ "$n" != "0" ]; then
    echo "  discovery returns $n provider(s) at attempt $i:"
    printf '%s' "$body" | python3 -c "import sys,json;[print('   -',s.get('name'),s.get('capabilities')) for s in json.load(sys.stdin).get('services',[])]" 2>/dev/null
    FOUND=1; break
  fi
  sleep 5
done
[ "$FOUND" = 0 ] && { echo "  FATAL: discovery still empty after polling — cannot drive card"; exit 2; }

echo
echo "### STEP D: drive the banana query"
idb ui tap --udid "$SIM" 70 756 >/dev/null 2>&1; sleep 1.3
idb ui text --udid "$SIM" "$Q" >/dev/null 2>&1; sleep 1.0
idb ui tap --udid "$SIM" 366 755 >/dev/null 2>&1
echo "  sent: $Q"
for s in $(seq 5 5 70); do sleep 5; done
echo "  waited 70s"

echo
echo "### STEP E: screenshot + isolate NEWEST banana card from a11y tree"
xcrun simctl io "$SIM" screenshot /tmp/sim_price_corrected.png >/dev/null 2>&1
cp /tmp/sim_price_corrected.png ../docs/assets/price_check_card_fixed.png 2>/dev/null || true
idb ui describe-all --udid "$SIM" --json > /tmp/ui_rvd.json 2>/dev/null
python3 - <<'PY'
import json, re
els = json.load(open('/tmp/ui_rvd.json'))
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
titles=[(y,l) for (y,l) in rows if l.lower()=='organic bananas']
if not titles:
    print("RESULT: no 'organic bananas' card title visible — newest answer was likely a TEXT reply, not a card.")
    print("Visible DINA text answers:")
    for y,l in rows:
        if (0<=y<=820) and (l.startswith("I couldn't") or l.startswith("I don't") or 'no live' in l.lower()):
            print("  ", l[:120])
else:
    ty=titles[-1][0]
    card=[(y,l) for (y,l) in rows if ty-12 <= y <= ty+250]
    print(f"=== NEWEST BANANA CARD (title y={int(ty)}) ===")
    for y,l in card: print(f"  y={int(y):5d}  {l}")
    blob=" || ".join(l for _,l in card)
    money=re.search(r'[$€£¥₹]\s?\d', blob)
    print("\n=== ASSERTIONS ===")
    print("currency-formatted price ($X):", bool(money), (money.group(0) if money else ''))
    print("bad 'to Corner Market' caption:", 'to Corner Market' in blob, "(must be False)")
    print("separate Currency row         :", any(l.strip().lower()=='currency' for _,l in card), "(should be False — folded in)")
    print("Store row present             :", any('store' in l.lower() and 'example' not in l.lower() for _,l in card))
PY
echo "### DONE"
