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

This starts Dina in **Online Mode** (the default):
- **dina-core** (Go) — your encrypted vault, keys, and DIDComm endpoint
- **dina-brain** (Python) — the guardian angel reasoning loop (uses Gemini Flash Lite + Deepgram)

Your reputation data (reviews, attestations) is pushed to the Dina Foundation PDS (`pds.dina.host`) — no extra container needed. If you're on a VPS and want to self-host your PDS, see [Advanced Setup](ADVANCED-SETUP.md).

## 2. Initialize your identity

```bash
curl -X POST http://localhost:8100/v1/identity/init
```

This generates your root DID and encryption keys. You'll get a 24-word recovery phrase — **write it down and store it safely**. This is the only way to recover your identity if you lose access.

## 3. Go online

```bash
sudo tailscale up && sudo tailscale funnel 8443
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
- **Run Offline Mode** — See [Advanced Setup](ADVANCED-SETUP.md) for local LLM + voice (Gemma 3n + Whisper, no cloud APIs)
- **Set up production networking** — See [Advanced Setup](ADVANCED-SETUP.md) for Cloudflare Tunnel (custom domain, DDoS protection) or Yggdrasil (censorship resistance)

## System Requirements (Online Mode)

| Resource | Minimum |
|----------|---------|
| RAM | 2 GB |
| CPU | 2 cores |
| Storage | 10 GB (grows with your data) |
| Network | Always-on internet connection |
| GPU | Not required |

> Want to run everything locally with no cloud APIs? See [Advanced Setup — Offline Mode](ADVANCED-SETUP.md) (requires 8GB+ RAM).
