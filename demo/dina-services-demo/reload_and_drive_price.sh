#!/usr/bin/env bash
# Reload the mobile app (force Metro to re-transform the edited @dina/brain
# source — there is no dist/, Metro bundles TS source on demand) then re-drive
# the price query and screenshot the corrected card. One round-trip; read the
# log + /tmp/sim_price_fixed.png after.
set -uo pipefail
cd "$(dirname "$0")"
SIM=6D57099D-48DA-430D-B4BB-1A2BF1EBACB7
BUNDLE=com.dinakernel.mobile

echo "### metro source-resolution sanity"
grep -nE "watchFolders|nodeModulesPaths|@dina|disableHierarchical|enablePackageExports|extraNodeModules" \
  ../../apps/mobile/metro.config.js 2>/dev/null | head -20 || echo "  (no matches / no metro.config.js)"
echo

echo "### STEP 1: terminate + relaunch app (fresh bundle from Metro)"
xcrun simctl terminate "$SIM" "$BUNDLE" 2>/dev/null && echo "  terminated" || echo "  (was not running)"
sleep 2
xcrun simctl launch "$SIM" "$BUNDLE" 2>&1 | sed 's/^/  /'
echo "  waiting for JS bundle to build + app to mount..."
sleep 18

echo
echo "### STEP 2: wait for the composer 'Ask' chip to appear"
for i in $(seq 1 12); do
  if idb ui describe-all --udid "$SIM" --json 2>/dev/null | grep -q '"Ask"'; then
    echo "  Ask chip present (attempt $i)"
    break
  fi
  echo "  ...not ready ($i)"
  sleep 4
done

echo
echo "### STEP 3: drive the price query (real discovery path, no bypass)"
python3 drive_price_query.py 2>&1 | sed 's/^/  /'

echo
echo "### STEP 4: final screenshot copy"
cp /tmp/sim_price_result.png /tmp/sim_price_fixed.png 2>/dev/null && echo "  -> /tmp/sim_price_fixed.png" || echo "  copy failed"

echo
echo "### STEP 5: daemon claim sanity (distinct task ids + error count)"
sed 's/\x1b\[[0-9;]*m//g' /tmp/price_daemon.log 2>/dev/null | grep -oE "svc-exec-[a-f0-9]+" | sort -u | sed 's/^/  claimed /'
echo "  decrypt/claim errors: $(grep -ciE 'decrypt|claim error' /tmp/price_daemon.log 2>/dev/null)"
echo "### DONE"
