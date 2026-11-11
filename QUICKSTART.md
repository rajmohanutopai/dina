# Quick Start

## On your phone

Dina for iOS is on the [App Store](https://apps.apple.com/app/id6781713799).
The whole Home Node runs on the phone: identity, vault, Core and Brain. Android
is in progress.

## On a server (Home Node Lite)

Needs Docker with Docker Compose, bash and curl.

```bash
git clone https://github.com/rajmohanutopai/dina.git
cd dina
./apps/home-node-lite/install-lite.sh            # install, or re-run safely
./apps/home-node-lite/install-lite.sh --web-ui   # also serve the web app from Core at /app/
./apps/home-node-lite/install-lite.sh --uninstall
```

The installer starts Core and Brain, creates your identity, and prints your DID
and recovery phrase. Write the phrase down; it is the only way to restore your
Dina.

To run from source without Docker, see
[`apps/home-node-lite/README.md`](./apps/home-node-lite/README.md).

## See Dina in action

[Capabilities and usage guide](./CAPABILITIES.md)

## Connect an agent

From any machine, pair the `dina-agent` CLI with your Home Node using a setup
code from the app (Settings → Agents):

```bash
pip install dina-agent
dina configure
dina ask "what kind of tea do I like?"
```

## For developers

```bash
npm install          # at the repo root, Node 22 or later
npm test             # Jest across every package and app
npm run typecheck
npm run lint
```
