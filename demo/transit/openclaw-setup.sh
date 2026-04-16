#!/usr/bin/env bash
# OpenClaw setup for BusDriver transit provider.
# Extended from tests/sanity/openclaw-setup.sh with transit MCP tool.
set -euo pipefail

CONFIG_DIR="$HOME/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"
OC_TOKEN="${OPENCLAW_TOKEN:-busdriver-oc-token-$(date +%s)}"

echo "==> Writing OpenClaw config (with transit MCP tool)"
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
      transit: {
        command: "python3",
        args: ["-m", "demo.transit"],
        env: {
          PYTHONPATH: "/app",
        },
      },
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

echo "==> Configuring dina-agent"
if [ -n "${DINA_PAIRING_CODE:-}" ] && [ -n "${DINA_CORE_URL:-}" ]; then
    dina configure --headless \
        --core-url "${DINA_CORE_URL}" \
        --pairing-code "${DINA_PAIRING_CODE}" \
        --device-name "busdriver-openclaw" \
        --config-dir /root \
        --role agent
    export DINA_CONFIG_DIR=/root/.dina/cli
    echo "==> dina-agent paired with BusDriver Core"
else
    echo "==> Skipping dina pairing (no DINA_PAIRING_CODE)"
fi

echo "==> Setting up callback hook env"
export DINA_CORE_CALLBACK_URL="${DINA_CORE_URL}"
export DINA_HOOK_CALLBACK_TOKEN="${DINA_HOOK_CALLBACK_TOKEN:-dina-callback-busdriver-token}"

echo "==> Starting dina agent-daemon (background)"
export DINA_CONFIG_DIR=/root/.dina/cli
export DINA_OPENCLAW_URL="http://localhost:3000"
export DINA_OPENCLAW_HOOK_TOKEN="dina-hooks-token-${OC_TOKEN}"
dina agent-daemon --poll-interval 5 --lease-duration 120 > /tmp/agent-daemon.log 2>&1 &
DAEMON_PID=$!
echo "  agent-daemon PID: ${DAEMON_PID}"

echo "==> Starting OpenClaw gateway (port 3000)"
exec openclaw gateway
