#!/usr/bin/env bash
# Re-pair the Corner Market (drcarl) price agent against drcarl lite Core (:18299),
# then (re)start the price daemon. Self-contained so it survives a flaky tool
# channel: ALL output goes to stdout (redirect to a log and Read it).
#
# Why: the device's ed25519_private.pem was regenerated out-of-band, so it no
# longer matches the pubkey drcarl Core has registered → MsgBox responses are
# sealed to the stale key → "Response decryption failed". A clean re-pair makes
# the local keypair and Core's device registry consistent again.
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
CORE=http://127.0.0.1:18299
HOMENODE_DID=did:plc:uib44xwkcqkosr2hli6exsww
MSGBOX=wss://test-mailbox.dinakernel.com/ws
CFGBASE="$ROOT/price-agent"          # clean base, no pre-existing doubling
DINA="$ROOT/venv/bin/dina"

echo "### STEP 0: kill any running price daemon"
pkill -f run_daemon_price.py 2>/dev/null && echo "  killed old daemon" || echo "  none running"
rm -rf "$CFGBASE"
echo

echo "### STEP 1: mint a fresh pairing code on drcarl Core"
PAIR_OUT=$(DINA_CORE_URL=$CORE npx tsx pair_initiate_drcarl.ts 2>&1)
echo "$PAIR_OUT"
CODE=$(printf '%s\n' "$PAIR_OUT" | grep -oE '"pairing_code"[^,}]*' | grep -oE '[A-Z0-9]{6,}' | head -1)
if [ -z "$CODE" ]; then
  CODE=$(printf '%s\n' "$PAIR_OUT" | grep -oE '[A-Z0-9]{6}-?[A-Z0-9]{0,6}' | head -1)
fi
echo "  PARSED CODE: '${CODE:-<none>}'"
[ -z "$CODE" ] && { echo "FATAL: no pairing code parsed"; exit 1; }
echo

echo "### STEP 2: dina configure --headless (generates keypair + completes pairing)"
"$DINA" configure --headless \
  --core-url "$CORE" \
  --pairing-code "$CODE" \
  --device-name price-agent \
  --role agent \
  --transport msgbox \
  --msgbox-url "$MSGBOX" \
  --homenode-did "$HOMENODE_DID" \
  --config-dir "$CFGBASE" 2>&1
echo "  configure exit=$?"
echo

echo "### STEP 3: locate the written config.json"
CFGJSON=$(find "$CFGBASE" -name config.json 2>/dev/null | head -1)
echo "  config.json at: ${CFGJSON:-<NOT FOUND>}"
[ -z "$CFGJSON" ] && { echo "FATAL: configure wrote no config.json"; exit 1; }
CFGDIR=$(dirname "$CFGJSON")
echo "  => DINA_CONFIG_DIR=$CFGDIR"
ls -la "$CFGDIR" "$CFGDIR/identity" 2>&1
echo

echo "### STEP 4: start the price daemon pointed at the real config dir"
DINA_CONFIG_DIR="$CFGDIR" nohup "$ROOT/venv/bin/python" run_daemon_price.py > /tmp/price_daemon.log 2>&1 &
echo "  daemon pid=$!"
echo "  CONFIG_DIR_FOR_DAEMON=$CFGDIR" > /tmp/price_daemon_cfgdir.txt
sleep 8
echo

echo "### STEP 5: daemon log (look for Claim error vs clean poll)"
sed 's/\x1b\[[0-9;]*m//g' /tmp/price_daemon.log | head -30
echo "### DONE"
