#!/usr/bin/env bash
# Unified OpenClaw container entrypoint — role-aware, env-driven.
#
# Transport — one of:
#   (a) Direct HTTP — only when Core is reachable on the same Docker network / LAN.
#       Set DINA_CORE_URL and leave DINA_MSGBOX_URL empty.
#   (b) MsgBox relay — required for NAT'd Home Nodes (mobile, cloud → home).
#       Set DINA_MSGBOX_URL + DINA_HOMENODE_DID.
#   (c) Auto — tries direct first, falls back to MsgBox. Pass all three.
#
# Required env:
#   DINA_CORE_URL           e.g. http://host.docker.internal:8100 (LAN/Docker)
#                           or unset/empty when using MsgBox only.
#   DINA_PAIRING_CODE       pairing code printed by `dina-admin device pair`
#   GOOGLE_API_KEY          Gemini API key for OpenClaw itself
#
# MsgBox env (required for NAT'd deployments):
#   DINA_MSGBOX_URL         wss://mailbox.example.com/ws
#   DINA_HOMENODE_DID       did:plc:... of the paired Home Node
#   DINA_TRANSPORT          direct | msgbox | auto (default: auto)
#
# Optional env:
#   OPENCLAW_ROLE           provider | user (default: user)
#   OPENCLAW_TOKEN          gateway auth token (default: <role>-oc-token-<ts>)
#   OPENCLAW_DEVICE_NAME    dina-agent device name (default: openclaw-<role>)
#   OPENCLAW_POLL_INTERVAL  seconds (default: 10)
#   OPENCLAW_LEASE_DURATION seconds (default: 300)
#   DINA_HOOK_CALLBACK_TOKEN Bearer token for Core callback (default: dina-callback-<role>-token)
#
# Provider-only env (read when OPENCLAW_ROLE=provider):
#   OPENCLAW_MCP_NAME        MCP server name (e.g. "transit")
#   OPENCLAW_MCP_COMMAND     executable (e.g. "python3")
#   OPENCLAW_MCP_ARGS        JSON array (e.g. '["-m","demo.transit"]')
#   OPENCLAW_MCP_PYTHONPATH  optional PYTHONPATH override (e.g. "/app")
#
# User-only env (read when OPENCLAW_ROLE=user):
#   GOG_KEYRING_PASSWORD    decrypt gog-auth secrets (mount /root/.config/gogcli separately)

set -euo pipefail

ROLE="${OPENCLAW_ROLE:-user}"
CONFIG_DIR="$HOME/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"
OC_TOKEN="${OPENCLAW_TOKEN:-${ROLE}-oc-token-$(date +%s)}"
DEVICE_NAME="${OPENCLAW_DEVICE_NAME:-openclaw-${ROLE}}"

mkdir -p "$CONFIG_DIR"

# Provider extra-MCP block (optional — omitted when unset)
extra_mcp=""
if [ "$ROLE" = "provider" ] && [ -n "${OPENCLAW_MCP_NAME:-}" ] && [ -n "${OPENCLAW_MCP_COMMAND:-}" ]; then
    # OPENCLAW_MCP_ARGS is a JSON array; splice verbatim.
    mcp_args="${OPENCLAW_MCP_ARGS:-[]}"
    mcp_env=""
    if [ -n "${OPENCLAW_MCP_PYTHONPATH:-}" ]; then
        mcp_env="        env: { PYTHONPATH: \"${OPENCLAW_MCP_PYTHONPATH}\" },"
    fi
    extra_mcp=$(cat <<MCP
      ${OPENCLAW_MCP_NAME}: {
        command: "${OPENCLAW_MCP_COMMAND}",
        args: ${mcp_args},
${mcp_env}
      },
MCP
)
fi

echo "==> Writing OpenClaw config (role=${ROLE})"
cat > "$CONFIG_FILE" <<CONF
{
  agents: {
    defaults: {
      model: {
        primary: "google/gemini-2.5-flash",
      },
    },
  },

  gateway: {
    mode: "local",
    port: 3000,
    auth: {
      mode: "token",
      token: "${OC_TOKEN}",
    },
    http: {
      endpoints: {
        chatCompletions: {
          enabled: true,
        },
      },
    },
  },

  mcp: {
    servers: {
      dina: {
        command: "dina",
        args: ["mcp-server"],
        env: {
          DINA_CONFIG_DIR: "/root/.dina/cli",
          OPENCLAW_TOKEN: "${OC_TOKEN}",
          DINA_OPENCLAW_URL: "http://localhost:3000",
        },
      },
${extra_mcp}
    },
  },

  hooks: {
    enabled: true,
    token: "dina-hooks-token-${OC_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"],
  },

  browser: {
    noSandbox: true,
    headless: true,
  },

  logging: {
    level: "info",
  },
}
CONF

chmod 700 "$CONFIG_DIR"
chmod 600 "$CONFIG_FILE"

if [ -n "${GOOGLE_API_KEY:-}" ]; then
    openclaw config set env.GOOGLE_API_KEY "${GOOGLE_API_KEY}" 2>/dev/null || true
fi

TRANSPORT_MODE="${DINA_TRANSPORT:-auto}"

echo "==> Configuring dina-agent (transport=${TRANSPORT_MODE})"
if [ -n "${DINA_PAIRING_CODE:-}" ]; then
    if [ -z "${DINA_CORE_URL:-}" ] && [ -z "${DINA_MSGBOX_URL:-}" ]; then
        echo "==> WARNING: Neither DINA_CORE_URL nor DINA_MSGBOX_URL set — cannot pair"
    else
        # MsgBox flags are optional at the CLI level; populate only when set
        # so --transport=auto can still fall back to direct in Docker stacks.
        msgbox_flags=()
        if [ -n "${DINA_MSGBOX_URL:-}" ]; then
            msgbox_flags+=(--msgbox-url "${DINA_MSGBOX_URL}")
        fi
        if [ -n "${DINA_HOMENODE_DID:-}" ]; then
            msgbox_flags+=(--homenode-did "${DINA_HOMENODE_DID}")
        fi
        dina configure --headless \
            --core-url "${DINA_CORE_URL:-http://localhost:8100}" \
            --transport "${TRANSPORT_MODE}" \
            "${msgbox_flags[@]}" \
            --pairing-code "${DINA_PAIRING_CODE}" \
            --device-name "${DEVICE_NAME}" \
            --config-dir /root \
            --role agent
        export DINA_CONFIG_DIR=/root/.dina/cli
        echo "==> dina-agent paired as ${DEVICE_NAME}"
    fi
else
    echo "==> Skipping dina pairing (DINA_PAIRING_CODE missing)"
fi

# User role: optionally check gog (Gmail CLI) auth
if [ "$ROLE" = "user" ] && command -v gog >/dev/null 2>&1; then
    export GOG_KEYRING_PASSWORD="${GOG_KEYRING_PASSWORD:-}"
    if [ -n "${GOG_KEYRING_PASSWORD}" ]; then
        if gog gmail search "is:unread" --limit 1 >/dev/null 2>&1; then
            echo "==> gog: Gmail authenticated"
        else
            echo "==> gog: auth check failed (token may need refresh)"
        fi
    fi
fi

export DINA_CORE_CALLBACK_URL="${DINA_CORE_URL:-}"
export DINA_HOOK_CALLBACK_TOKEN="${DINA_HOOK_CALLBACK_TOKEN:-dina-callback-${ROLE}-token}"

echo "==> Starting dina agent-daemon (background)"
export DINA_CONFIG_DIR=/root/.dina/cli
export DINA_OPENCLAW_URL="http://localhost:3000"
export DINA_OPENCLAW_HOOK_TOKEN="dina-hooks-token-${OC_TOKEN}"
dina agent-daemon \
    --poll-interval "${OPENCLAW_POLL_INTERVAL:-10}" \
    --lease-duration "${OPENCLAW_LEASE_DURATION:-300}" \
    > /tmp/agent-daemon.log 2>&1 &
echo "  agent-daemon PID: $!"

echo "==> Starting OpenClaw gateway (role=${ROLE}, port=3000)"
exec openclaw gateway
