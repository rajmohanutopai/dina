#!/usr/bin/env bash
#
# MRS-14 — Safety invariant: the log gate. Dina's Four Laws + PII rule mean
# vault content, the recovery phrase, API keys, the PDS password, raw seed
# blobs, D2D plaintext, and tool args/results must NEVER hit a device log.
# This greps captured iOS + Android logs for forbidden tokens and FAILS on
# any hit. Run it over logs captured DURING a suite run.
#
# Usage:
#   log_hygiene_check.sh <logfile> [<logfile> ...]
#   # or capture fresh from a running sim:
#   xcrun simctl spawn <udid> log stream --level debug \
#       --predicate 'process == "Dina"' > ios.log &   # then run a scenario
#
# The owner's own identity DID is allowed (printed at boot, not a secret).
# Contact DIDs in plaintext are NOT (they leak the social graph).
set -uo pipefail

[ "$#" -ge 1 ] || { echo "usage: $0 <logfile> [<logfile> ...]"; exit 2; }

# Seeded vault content used across the MRS scenarios — none may appear.
VAULT_TOKENS=(
  'HbA1c' 'blood pressure' 'Barclays'      # health / finance probes
  'cold brew'                              # MRS-04 Talk enrichment payload
  'Neptune'                                # MRS-13 durability seed
  'dinosaur'                               # remember persona-routing seed
)
# Secret-shaped patterns — extended-regex.
SECRET_RES=(
  'AIza[0-9A-Za-z_-]{20,}'                 # Google / Gemini API key
  'sk-[A-Za-z0-9]{20,}'                    # OpenAI-style key
  '(^|[^[:alnum:]-])([[:lower:][:digit:]]{4}-){3}[[:lower:][:digit:]]{4}([^[:alnum:]-]|$)'  # exact PDS app-password shape, not a UUID prefix
)

MNEMONIC_SCANNER="$(dirname "$0")/log_hygiene_mnemonic_scan.mjs"

# Ban the EXACT PDS app password too, loaded at RUNTIME from the gitignored
# sanity env if present — so the literal secret never lives in this script.
if [ -f tests/sanity/.env.sanity ]; then
  _pw="$(grep -aoE '\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b' tests/sanity/.env.sanity | head -1 || true)"
  [ -n "$_pw" ] && SECRET_RES+=("$(printf '%s' "$_pw" | sed 's/[][\.*^$/]/\\&/g')")
fi

fail=0
hit() { echo "  ✗ FORBIDDEN: $1"; echo "    $2"; fail=1; }

for f in "$@"; do
  [ -f "$f" ] || { echo "skip (missing): $f"; continue; }
  echo "== $f =="
  for tok in "${VAULT_TOKENS[@]}"; do
    line="$(grep -inF "$tok" "$f" | head -1 || true)"
    [ -n "$line" ] && hit "vault content '$tok'" "$line"
  done
  for re in "${SECRET_RES[@]}"; do
    line="$(grep -nE "$re" "$f" | head -1 || true)"
    [ -n "$line" ] && hit "secret pattern /$re/" "$line"
  done
  # A word-count regex flags ordinary log prose. Check BIP-39 vocabulary and
  # checksum instead, and report only the line number so the phrase itself is
  # never copied from the device log into CI output.
  mnemonic_lines="$(node "$MNEMONIC_SCANNER" "$f" 2>/dev/null)"
  mnemonic_status=$?
  if [ "$mnemonic_status" -ne 0 ]; then
    hit "mnemonic scanner failed closed" "scanner exit $mnemonic_status"
  elif [ -n "$mnemonic_lines" ]; then
    hit "valid BIP-39 recovery phrase" "line(s): $(echo "$mnemonic_lines" | paste -sd, -)"
  fi
  # did:plc / did:key in Dina-owned logs other than the owner's own DID. Pass
  # the owner DID via OWNER_DID to allowlist it. Apple's privileged networking
  # debug stream prints request URLs (for example plc.directory/<contact-did>)
  # even when application logging is silent. That is OS transport telemetry,
  # not a log Dina can redact; exclude only those Apple subsystem lines from
  # this DID check. Vault content and secrets above still scan every line.
  owner="${OWNER_DID:-}"
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    did="${match#*:}"
    [ -n "$owner" ] && [ "$did" = "$owner" ] && continue
    hit "contact DID in plaintext" "$match"
  done < <(
    grep -vE '\[com\.apple\.(network|CFNetwork):' "$f" 2>/dev/null \
      | grep -noE 'did:(plc|key):[A-Za-z0-9]+' \
      | head -3
  )
done

if [ "$fail" -ne 0 ]; then
  echo "MRS-14 FAIL — forbidden content found in logs"
  exit 1
fi
echo "MRS-14 PASS — no vault content / secrets / contact DIDs in logs"
