# Quick Start

Get Dina running in under 5 minutes.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- [Tailscale](https://tailscale.com/download) (free account, for networking)

## 1. Install Dina (Home Node)

```bash
git clone https://github.com/rajmohanutopai/dina.git
cd dina
./install.sh
```

`install.sh` handles everything:
1. Checks prerequisites (Docker, Docker Compose, curl)
2. Generates secrets (brain token, identity seed, PDS JWT/rotation keys)
3. Asks which LLM provider to use (Gemini, OpenAI, Claude, OpenRouter, Ollama)
4. Creates `.env` with your API key and secrets
5. Builds and starts Docker containers
6. Waits for health checks
7. Displays your DID and 24-word recovery phrase

> **Idempotent** — safe to re-run. Existing secrets and seeds are preserved. Use `--skip-build` to skip Docker image builds on re-runs.

This starts Dina in the **Cloud LLM profile** (the default) — 3 containers:
- **dina-core** (Go) — your encrypted vault, keys, and messaging endpoint (port 443 external, port 8100 internal)
- **dina-brain** (Python) — the guardian angel reasoning loop (uses Gemini Flash Lite + Deepgram)
- **dina-pds** — AT Protocol Personal Data Server for your reputation data (port 2583)

Want a local LLM too? `docker compose --profile local-llm up -d` adds a 4th container (llama with Gemma 3n). See [Advanced Setup](ADVANCED-SETUP.md).

## 2. Save your recovery phrase

The install script displays a 24-word recovery phrase. **Write it down on paper and store it safely.** This is the only way to recover your identity if you lose access.

## 3. Go online

```bash
sudo tailscale up && sudo tailscale funnel 443
```

Your Dina is now reachable at `https://<machine-name>.<tailnet>.ts.net/`. Other Dinas can find you and send encrypted messages.

Register your public endpoint so other Dinas can find you:

```bash
dina network set-endpoint "https://<machine-name>.<tailnet>.ts.net/"
```

## 4. Install the CLI

On your local machine (laptop, desktop — not the server):

```bash
pip install dina-cli
dina configure --url https://<machine-name>.<tailnet>.ts.net
```

`dina configure` will:
- Prompt for a pairing code (generate one from the admin dashboard or `curl -X POST http://localhost:8100/v1/pair/initiate`)
- Generate an Ed25519 device keypair for signed requests
- Register the device with your Home Node
- Save config to `~/.dina/cli/config.json`

Quick test:

```bash
dina recall "test"          # search the vault (empty on first run)
dina remember "I like tea"  # store a fact in encrypted vault
dina recall "tea"           # should return the fact you just stored
```

## 5. Install the Reputation AppView (optional)

The AppView is the public Reputation Graph indexer — it consumes AT Protocol records from the Jetstream firehose, scores them, and serves XRPC query endpoints.

```bash
cd appview
./install_appview.sh
```

`install_appview.sh` handles:
1. Installs Node.js dependencies
2. Starts PostgreSQL 17 + Jetstream via Docker Compose
3. Pushes the 27-table schema (97 indexes) via Drizzle
4. Starts the ingester, scorer, and web containers

This adds 5 containers:
- **postgres** — PostgreSQL 17 for reputation data (port 5432)
- **jetstream** — AT Protocol firehose filtered to `com.dina.reputation.*` (port 6008)
- **ingester** — 19 record handlers with Zod validation, trust edges, dirty flags
- **scorer** — 9 cron jobs (trust-score, reviewer-quality, sentiment, anomaly, coordination, sybil, tombstones, decay, cleanup)
- **web** — XRPC API endpoints: resolve, search, get-profile, get-attestations, get-graph (port 3000)

> The Home Node and AppView are independent. The Home Node is your private sovereign agent. The AppView is the public reputation indexer anyone can run.

## 6. Use as an OpenClaw Skill

Dina works as an [OpenClaw](https://openclaw.org) skill — any AI agent (Claude, GPT, Gemini, OpenClaw) can use your Dina for encrypted memory, PII scrubbing, and action gating.

The skill manifest is at [`dina-openclaw-skill.md`](dina-openclaw-skill.md). Point your agent to it, or use the CLI commands directly:

```
dina remember <text>              Store a fact in encrypted vault
dina recall <query>               Search the vault (persists across sessions)
dina scrub <text>                 Remove PII before sending to external APIs
dina rehydrate <text> --session   Restore PII on the response
dina validate <action> <desc>     Check if a destructive action is approved
dina sign <content>               Cryptographic signature with your DID key
```

**Example: AI agent with PII-safe external API calls**

```bash
# Agent scrubs PII before calling an external API
dina scrub "Patient Raj Kumar, Aadhaar 9876-5432-1012, diagnosis: Type 2 diabetes"
# → {"scrubbed": "[PERSON_1], [AADHAAR_1], diagnosis: Type 2 diabetes", "session": "sess_k9m2"}

# Agent sends scrubbed text to external API, then restores PII on the response
dina rehydrate "<api response with placeholders>" --session sess_k9m2
```

**Example: AI agent with persistent memory**

```bash
# Session 1: agent stores a fact
dina remember "Daughter turns 7 on March 15, loves dinosaurs" --category relationship

# Session 47: different agent session, same vault
dina recall "daughter birthday"
# → instant recall from encrypted vault
```

## That's it

Your Dina is running, has a cryptographic identity, is reachable by other Dinas, and your CLI is paired. What's next:

- **Use as OpenClaw skill** — Give any AI agent encrypted memory and PII scrubbing via the [Dina skill](dina-openclaw-skill.md)
- **Connect Gmail** — `dina connector add gmail` (read-only, OAuth)
- **Connect Calendar** — `dina connector add calendar` (CalDAV)
- **Add a friend's Dina** — Scan their QR code or exchange DIDs
- **CLI reference** — See [`dina-openclaw-skill.md`](dina-openclaw-skill.md) for full command reference and default policies
- **Run with Local LLM** — See [Advanced Setup](ADVANCED-SETUP.md) for local LLM (Gemma 3n, no cloud APIs for inference)
- **Set up production networking** — See [Advanced Setup](ADVANCED-SETUP.md) for Cloudflare Tunnel (custom domain, DDoS protection) or Yggdrasil (censorship resistance)

## System Requirements

**Home Node (Cloud LLM Profile)**

| Resource | Minimum |
|----------|---------|
| RAM | 2 GB |
| CPU | 2 cores |
| Storage | 10 GB (grows with your data) |
| Network | Always-on internet connection |
| GPU | Not required |

**AppView (additional, optional)**

| Resource | Minimum |
|----------|---------|
| RAM | 1 GB (PostgreSQL) |
| CPU | 2 cores |
| Storage | 5 GB (grows with reputation data) |

> Want to run everything locally with no cloud APIs? See [Advanced Setup — Local LLM Profile](ADVANCED-SETUP.md) (requires 8GB+ RAM).
