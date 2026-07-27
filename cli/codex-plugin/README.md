# Dina Codex Plugin

This directory is a repo marketplace for the Dina Codex plugin.

## Local Installation

From the Dina repository, the one-command developer preview builds and installs
an isolated test Home Node through the same plugin-owned setup path users
receive, installs the local plugin, verifies both services, selects Codex as
the foreground Brain, and launches Codex:

```bash
npm run dina:codex
```

Open `/hooks`, review the plugin hook, and explicitly trust it. This human
decision is deliberately not automated.

For a local marketplace installation:

```bash
codex plugin marketplace add /absolute/path/to/dina/cli/codex-plugin
codex plugin add dina@dina
```

Then invoke `$dina-setup` or tell Codex **Set up Dina**. The plugin installs a
compatible `dina-agent>=0.20.0,<0.21.0` and Home Node Lite itself. Read
`plugins/dina/README.md` before enabling it because the local tool gate
intentionally fails closed.
