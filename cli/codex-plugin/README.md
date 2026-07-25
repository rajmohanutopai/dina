# Dina Codex Plugin

This directory is a repo marketplace for the Dina Codex plugin.

## Local Installation

1. Install the marketplace root:

   ```bash
   codex plugin marketplace add /absolute/path/to/dina/cli/codex-plugin/.agents/plugins
   ```

2. Open `/plugins`, install **Dina**, and start a new conversation.
3. Open `/hooks`, review the plugin hook, and explicitly trust it.

The plugin requires `dina-agent>=0.20.0` and a healthy Home Node Lite
installation. Read
`plugins/dina/README.md` under the marketplace root before enabling it because
the local tool gate intentionally fails closed.
