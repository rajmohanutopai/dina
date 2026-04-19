# Standalone OpenClaw containers

Two minimal Docker images for the OpenClaw execution plane — a **provider**
(lightweight, runs one MCP server alongside the Dina MCP) and a **user**
(full browsing + Gmail + Hermes runner). Shared base layer.

Designed to run against an existing Dina Core — either on the host
(`host.docker.internal:8100`) or in another compose stack. This directory
copies cleanly into `dina-mobile`; the Dockerfiles expect the repo root as
build context.

## Images

| Image | Role | Size | Adds over base |
|-------|------|------|----------------|
| `dina-openclaw-base` | shared layer | 2.2 GB | Node, Python, OpenClaw, `dina` CLI, `fastmcp`, callback hook, skill |
| `dina-openclaw-provider` | service tenants (BusDriver, Dr Carl, …) | 2.2 GB | _nothing — role label only_ |
| `dina-openclaw-user` | personal tenants (Alonso, …) | 3.1 GB | Chromium, `gog` (Gmail), Hermes runner |

The provider image comes out ~1.25 GB smaller than the current shared
`dina-test-*-openclaw` image (3.48 GB) because it skips Chromium, `gog`,
and Hermes — the three things a service tenant never needs.

## Build

```bash
# From repo root
./docker/openclaw/build.sh
```

The script builds base → provider → user in order (provider and user both
`FROM dina-openclaw-base:latest`, so base must exist first). Re-running is
fast: Docker caches every layer whose inputs haven't changed.

## Configure

```bash
cp docker/openclaw/.env.example docker/openclaw/.env
# Fill in: GOOGLE_API_KEY, PROVIDER_PAIRING_CODE, USER_PAIRING_CODE, etc.
```

Get pairing codes from the Dina Core you're pointing at:

```bash
# On the provider's Core:
curl -s -X POST http://<core-host>:8100/v1/pair/initiate \
     -H "Authorization: Bearer <client_token>" \
     -d '{"device_name":"openclaw-provider","role":"agent"}' \
   | jq -r .pairing_code
```

## Run

```bash
docker compose -f docker/openclaw/docker-compose.yml up provider
# or
docker compose -f docker/openclaw/docker-compose.yml up          # both
```

Gateways land on host ports `13000` (provider) and `13001` (user) by default.

## Swapping the provider MCP

The provider image intentionally does **not** bake a specific MCP in. Point
`PROVIDER_MCP_*` and `PROVIDER_MCP_PATH` at your own module — the compose file
bind-mounts it at `/app/…` and the entrypoint splices a `mcp.servers.<name>`
entry into `openclaw.json` at startup.

Example (Dr Carl appointment demo):

```env
PROVIDER_MCP_NAME=appointment
PROVIDER_MCP_ARGS=["-m","demo.appointment"]
PROVIDER_MCP_PATH=../../demo/appointment
PROVIDER_MCP_MODULE=demo/appointment
```

## Running just one container

Nothing in this stack cares whether the sibling is up — start only what you
need:

```bash
docker compose -f docker/openclaw/docker-compose.yml up openclaw-user
```

## Using with dina-mobile

Copy this directory into the `dina-mobile` repo. On mobile, the Dina Core runs
as the mobile app's own Home Node, so only one OpenClaw container is typically
needed at a time — start just `openclaw-user` (or just `openclaw-provider` for
a mobile-hosted service node) and point `DINA_CORE_URL` at the mobile's Core.
