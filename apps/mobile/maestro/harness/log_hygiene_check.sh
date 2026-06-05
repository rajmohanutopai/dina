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
  '[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}'  # app-password shape (e.g. PDS app password)
  '\b([a-z]+ ){11,}[a-z]+\b'              # 12-/24-word mnemonic run (rough)
)

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
  # did:plc / did:key in plaintext other than the owner's own DID. Pass the
  # owner DID via OWNER_DID to allowlist it.
  owner="${OWNER_DID:-}"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ -n "$owner" ] && echo "$line" | grep -qF "$owner"; then continue; fi
    hit "contact DID in plaintext" "$line"
  done < <(grep -noE 'did:(plc|key):[A-Za-z0-9]+' "$f" 2>/dev/null | grep -vF "${owner:-__none__}" | head -3)
done

if [ "$fail" -ne 0 ]; then
  echo "MRS-14 FAIL — forbidden content found in logs"
  exit 1
fi
echo "MRS-14 PASS — no vault content / secrets / contact DIDs in logs"
