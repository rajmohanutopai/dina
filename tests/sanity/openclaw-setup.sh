#!/usr/bin/env bash
# Headless OpenClaw setup for sanity testing.
# Called as container CMD. Expects env vars:
#   GOOGLE_API_KEY     — Gemini API key
#   DINA_CORE_URL      — Core URL (e.g. http://host.docker.internal:18100)
#   DINA_PAIRING_CODE  — pairing code from dina-admin device pair
#   OPENCLAW_TOKEN     — gateway auth token (default: sanity-test-token)
set -euo pipefail

CONFIG_DIR="$HOME/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"
OC_TOKEN="${OPENCLAW_TOKEN:-sanity-test-token-$(date +%s)}"

echo "==> Writing OpenClaw config"
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

# Set Gemini API key via openclaw config
openclaw config set env.GOOGLE_API_KEY "${GOOGLE_API_KEY:-}" 2>/dev/null || true

chmod 700 "$CONFIG_DIR"

chmod 600 "$CONFIG_FILE"

echo "==> Configuring dina-agent (headless)"
if [ -n "${DINA_PAIRING_CODE:-}" ] && [ -n "${DINA_CORE_URL:-}" ]; then
    dina configure --headless \
        --core-url "${DINA_CORE_URL}" \
        --pairing-code "${DINA_PAIRING_CODE}" \
        --device-name "openclaw-sanity" \
        --config-dir /root \
        --role agent
    export DINA_CONFIG_DIR=/root/.dina/cli
    echo "==> dina-agent paired"
    dina status || true
else
    echo "==> Skipping dina pairing (no DINA_PAIRING_CODE)"
fi

echo "==> Checking gog (Gmail CLI)"
export GOG_KEYRING_PASSWORD="${GOG_KEYRING_PASSWORD:-rajmohan}"
if gog gmail search "is:unread" --limit 1 --account dinaworker85@gmail.com >/dev/null 2>&1; then
    echo "  gog: Gmail authenticated (dinaworker85@gmail.com)"
else
    echo "  gog: auth check failed (token may need refresh)"
fi

echo "==> Setting up callback hook env"
# For the OpenClaw agent_end hook → Dina Core callback
export DINA_CORE_CALLBACK_URL="${DINA_CORE_URL}"
export DINA_HOOK_CALLBACK_TOKEN="${DINA_HOOK_CALLBACK_TOKEN:-dina-callback-sanity-token}"

echo "==> Starting dina agent-daemon (background)"
export DINA_CONFIG_DIR=/root/.dina/cli
export DINA_OPENCLAW_URL="http://localhost:3000"
export DINA_OPENCLAW_HOOK_TOKEN="dina-hooks-token-${OC_TOKEN}"
dina agent-daemon --poll-interval 10 --lease-duration 300 > /tmp/agent-daemon.log 2>&1 &
DAEMON_PID=$!
echo "  agent-daemon PID: ${DAEMON_PID}"

echo "==> Starting OpenClaw gateway (port 3000, token: ${OC_TOKEN:0:8}...)"
exec openclaw gateway
