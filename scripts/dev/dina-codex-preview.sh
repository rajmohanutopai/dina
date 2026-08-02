#!/usr/bin/env bash
# Install the local Codex plugin, then exercise its one-command native setup
# path against an isolated test identity. No container runtime is used.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREPARE_ONLY=0

if [[ "${1:-}" == "--prepare-only" ]]; then
  PREPARE_ONLY=1
  shift
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command codex
require_command node
require_command python3

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  echo "Dina Home Node requires Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

export DINA_HOME_NODE_DIR="${DINA_HOME_NODE_DIR:-$HOME/.dina/home-node-codex-preview}"
export DINA_CONFIG_DIR="${DINA_CONFIG_DIR:-$HOME/.dina/cli-codex-preview}"
export DINA_AGENT_HOST_CONFIG_DIR="$DINA_CONFIG_DIR"
export DINA_SETUP_RUNTIME_DIR="${DINA_SETUP_RUNTIME_DIR:-$HOME/.dina/runtime/agent-plugin-codex-preview}"
export DINA_PLUGIN_DEV_MODE=1
if [[ -n "${CODEX_HOME:-}" ]]; then
  mkdir -p "$CODEX_HOME"
fi

VERSION="dev-$(git -C "$ROOT" rev-parse --short HEAD)"
OUT_DIR="$ROOT/dist/home-node-native"
MARKETPLACE_ROOT="$ROOT/cli/codex-plugin"
PLUGIN_ROOT="$MARKETPLACE_ROOT/plugins/dina"

echo "[1/5] Building Dina Home Node $VERSION"
BUILD_OUTPUT="$(
  python3 "$ROOT/scripts/release/build_home_node_native.py" \
    --version "$VERSION" \
    --out-dir "$OUT_DIR"
)"
printf '%s\n' "$BUILD_OUTPUT"
BUNDLE="$(
  printf '%s\n' "$BUILD_OUTPUT" |
    awk '/dina-home-node-lite-.*\.tar\.gz$/ { print; exit }'
)"
if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "The Home Node build did not produce a native release archive." >&2
  exit 1
fi

echo "[2/5] Installing the local Codex marketplace and Dina plugin"
codex plugin marketplace add "$MARKETPLACE_ROOT" --json >/dev/null
if ! codex plugin add dina@dina --json >/dev/null 2>&1; then
  if ! codex plugin list --json |
    python3 -c 'import json,sys; raise SystemExit(0 if any(p.get("pluginId") == "dina@dina" for p in json.load(sys.stdin).get("installed", [])) else 1)'; then
    echo "Codex could not install the Dina plugin." >&2
    exit 1
  fi
fi

echo "[3/5] Running the Codex plugin setup path"
export DINA_SETUP_CLI_SPEC="$ROOT/cli"
export DINA_SETUP_HOME_NODE_BUNDLE="$BUNDLE"
export DINA_SETUP_HOME_NODE_RELEASE="$VERSION"
export DINA_SETUP_ENDPOINT_MODE="test"
export DINA_SETUP_CORE_PORT="${DINA_PREVIEW_CORE_PORT:-18100}"
export DINA_SETUP_BRAIN_PORT="${DINA_PREVIEW_BRAIN_PORT:-18200}"

set +e
SETUP_RESULT="$("$PLUGIN_ROOT/bin/dina-setup" --ensure --json)"
SETUP_RC=$?
set -e
if (( SETUP_RC != 0 )); then
  SETUP_CODE="$(
    printf '%s' "$SETUP_RESULT" |
      python3 -c 'import json,sys; print(json.load(sys.stdin).get("code", ""))'
  )"
  if [[ "$SETUP_CODE" != "identity_choice_required" ]]; then
    printf '%s\n' "$SETUP_RESULT" >&2
    exit "$SETUP_RC"
  fi
  if [[ "${DINA_PREVIEW_LOCAL_ONLY:-0}" == "1" ]]; then
    SETUP_RESULT="$("$PLUGIN_ROOT/bin/dina-setup" --local-only --json)"
  else
    TEST_PREFIX="$(
      python3 -c 'import secrets,string; alphabet=string.ascii_lowercase+string.digits; print("".join(secrets.choice(alphabet) for _ in range(6)))'
    )"
    TEST_HANDLE="${DINA_PREVIEW_PDS_HANDLE:-$TEST_PREFIX.test-pds.dinakernel.com}"
    SETUP_RESULT="$(
      "$PLUGIN_ROOT/bin/dina-setup" \
        --pds-handle "$TEST_HANDLE" \
        --json
    )"
  fi
fi

echo "[4/5] Verifying Home Node, coding identity, and foreground Brain"
printf '%s' "$SETUP_RESULT" | python3 -c '
import json,sys
s=json.load(sys.stdin)
home=s.get("home_node") or {}
agent=s.get("agent") or {}
brain=s.get("connected_brain") or {}
if not s.get("ready"):
    raise SystemExit("Plugin setup did not report ready")
if not (agent.get("paired") and agent.get("authenticated") and agent.get("core_reachable")):
    raise SystemExit("Coding agent is not connected")
if not brain.get("selected"):
    raise SystemExit("Codex was not selected as foreground Brain")
print("  Core:  {}".format(home.get("core_url")))
print("  Brain: {}".format(home.get("brain_url")))
print("  Owner: {}".format(home.get("owner_url")))
print("  Agent: {}".format(agent.get("did")))
print("  Bound: {}".format(brain.get("backend_id")))
'

echo "[5/5] Dina is ready"
echo
echo "In Codex, open /hooks once and trust the Dina hook."
echo "For phone approvals, pair the Dina app under Approval phone at the Owner URL above."
echo "Show the local owner key privately with:"
echo "  $PLUGIN_ROOT/bin/dina-cli home-node show-owner-capability"
echo "Show the recovery phrase privately with:"
echo "  $PLUGIN_ROOT/bin/dina-cli home-node show-recovery-phrase"
echo

if (( PREPARE_ONLY )); then
  printf 'Preparation complete. Launch Codex with:\n'
  printf 'DINA_HOME_NODE_DIR=%q DINA_CONFIG_DIR=%q DINA_AGENT_HOST_CONFIG_DIR=%q DINA_SETUP_RUNTIME_DIR=%q codex\n' \
    "$DINA_HOME_NODE_DIR" "$DINA_CONFIG_DIR" "$DINA_AGENT_HOST_CONFIG_DIR" "$DINA_SETUP_RUNTIME_DIR"
  exit 0
fi

exec codex "$@"
