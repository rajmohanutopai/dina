#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
CHECK="$ROOT/apps/mobile/maestro/harness/log_hygiene_check.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/clean.log" <<'EOF'
Task <E892BD84-2BFA-410A-9972-37650C1200F0>.<1> finished
loaded: an empty base plist and no additional changes from the base plist
EOF
"$CHECK" "$tmp/clean.log" >/dev/null

printf '%s\n' 'PDS password abcd-1234-efgh-5678 leaked' > "$tmp/password.log"
if "$CHECK" "$tmp/password.log" >/dev/null 2>&1; then
  echo 'expected an exact four-part app password to fail the gate' >&2
  exit 1
fi

# Public BIP-39 test vector, never a Dina user phrase.
printf '%s\n' 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' > "$tmp/mnemonic.log"
if "$CHECK" "$tmp/mnemonic.log" >/dev/null 2>&1; then
  echo 'expected a valid BIP-39 phrase to fail the gate' >&2
  exit 1
fi

owner='did:plc:owneronly'
printf '%s\n' "boot identity $owner" > "$tmp/owner.log"
OWNER_DID="$owner" "$CHECK" "$tmp/owner.log" >/dev/null

# The owner allowlist is per extracted DID, not per line. A contact DID on the
# same diagnostic line must not hitchhike on the owner's exception.
printf '%s\n' "from $owner to did:key:z6MkContactLeak" > "$tmp/mixed-dids.log"
if OWNER_DID="$owner" "$CHECK" "$tmp/mixed-dids.log" >/dev/null 2>&1; then
  echo 'expected a contact DID beside the owner DID to fail the gate' >&2
  exit 1
fi

# iOS emits full request URLs in privileged CFNetwork debug telemetry. Dina
# cannot redact those OS-owned lines; the gate excludes them only for DID
# matching while continuing to scan them for vault content and secrets.
printf '%s\n' \
  'Df Dina[123] [com.apple.network:connection] url: https://plc.directory/did:plc:PublicContact' \
  > "$tmp/apple-network.log"
OWNER_DID="$owner" "$CHECK" "$tmp/apple-network.log" >/dev/null

printf '%s\n' \
  "I Dina[123] [com.facebook.react.log:javascript] contact did:plc:PublicContact" \
  > "$tmp/application-contact.log"
if OWNER_DID="$owner" "$CHECK" "$tmp/application-contact.log" >/dev/null 2>&1; then
  echo 'expected an application-owned contact DID log to fail the gate' >&2
  exit 1
fi

echo 'log_hygiene_check tests passed'
