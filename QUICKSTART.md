# Quick Start

Get Dina running in under 5 minutes. Three commands.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- [Tailscale](https://tailscale.com/download) (free account)

## 1. Start Dina

```bash
git clone https://github.com/rajmohanutopai/dina.git
cd dina
docker compose up -d
```

This starts Dina in the **Cloud LLM profile** (the default) — 3 containers:
- **dina-core** (Go) — your encrypted vault, keys, and messaging endpoint (port 443 external, port 8100 internal)
- **dina-brain** (Python) — the guardian angel reasoning loop (uses Gemini Flash Lite + Deepgram)
- **dina-pds** — AT Protocol Personal Data Server for your reputation data (port 2583)

Want a local LLM too? `docker compose --profile local-llm up -d` adds a 4th container (llama with Gemma 3n). See [Advanced Setup](ADVANCED-SETUP.md).

## 2. Initialize your identity

```bash
curl -X POST http://localhost:8100/v1/identity/init
```

This generates your root DID and encryption keys. You'll get a 24-word recovery phrase — **write it down and store it safely**. This is the only way to recover your identity if you lose access.

## 3. Go online

```bash
sudo tailscale up && sudo tailscale funnel 443
```

Your Dina is now reachable at `https://<machine-name>.<tailnet>.ts.net/`. Other Dinas can find you and send encrypted messages.

Register your public endpoint so other Dinas can find you:

```bash
dina network set-endpoint "https://<machine-name>.<tailnet>.ts.net/"
```

## That's it

Your Dina is running, has a cryptographic identity, and is reachable by other Dinas. What's next:

- **Connect Gmail** — `dina connector add gmail` (read-only, OAuth)
- **Connect Calendar** — `dina connector add calendar` (CalDAV)
- **Add a friend's Dina** — Scan their QR code or exchange DIDs
- **Run with Local LLM** — See [Advanced Setup](ADVANCED-SETUP.md) for local LLM (Gemma 3n, no cloud APIs for inference)
- **Set up production networking** — See [Advanced Setup](ADVANCED-SETUP.md) for Cloudflare Tunnel (custom domain, DDoS protection) or Yggdrasil (censorship resistance)

## System Requirements (Cloud LLM Profile)

| Resource | Minimum |
|----------|---------|
| RAM | 2 GB |
| CPU | 2 cores |
| Storage | 10 GB (grows with your data) |
| Network | Always-on internet connection |
| GPU | Not required |

> Want to run everything locally with no cloud APIs? See [Advanced Setup — Local LLM Profile](ADVANCED-SETUP.md) (requires 8GB+ RAM).
