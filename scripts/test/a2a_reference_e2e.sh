#!/usr/bin/env bash
# A2A Lane 1 end-to-end run against the official a2a-sdk (Python) reference
# agent (docs/A2A_GATEWAY_ARCHITECTURE.md §12 M1a), and card signatures checked
# both ways with the SDK's own signer and verifier (§6.6). Creates the agent's
# virtualenv inside the project on first use, then runs the e2e suites.
#
#   scripts/test/a2a_reference_e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REF="$ROOT/apps/home-node-lite/core-server/__tests__/a2a/reference"

if [ ! -x "$REF/.venv/bin/python" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv "$REF/.venv" --python 3.11
    uv pip install --python "$REF/.venv/bin/python" -r "$REF/requirements.txt"
  else
    python3 -m venv "$REF/.venv"
    "$REF/.venv/bin/pip" install -r "$REF/requirements.txt"
  fi
fi

cd "$ROOT/apps/home-node-lite/core-server"
# The interpreter exists now: a skip would hide a broken setup, so require it.
DINA_A2A_REFERENCE_REQUIRED=1 npx jest __tests__/a2a/reference_agent.e2e.test.ts __tests__/a2a/sdk_card_signatures.e2e.test.ts __tests__/a2a/host_transport.test.ts --runInBand
