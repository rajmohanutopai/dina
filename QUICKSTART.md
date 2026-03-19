# Quick Start

Get Dina running in under 5 minutes.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- [Tailscale](https://tailscale.com/download) (free account, for networking — optional for local-only setup)

## 1. Install Dina (Home Node)

```bash
git clone https://github.com/rajmohanutopai/dina.git
cd dina
./install.sh
```

`install.sh` handles everything:
1. Checks prerequisites (Docker, Docker Compose, curl)
2. Generates secrets (service keys, identity seed wrap files, PDS JWT/rotation keys)
3. Shows your 24-word recovery phrase (on a separate screen — write it down)
4. Asks which LLM provider to use (Gemini, OpenAI, Claude, OpenRouter, Ollama)
5. Asks to connect Telegram (recommended for approvals, optional)
6. Creates `.env` with your API key and secrets
7. Builds and starts Docker containers
8. Waits for health checks
9. Displays your DID

> **Idempotent** — safe to re-run. Existing secrets and seeds are preserved. Use `--skip-build` to skip Docker image builds on re-runs.

This starts Dina in the **Cloud LLM profile** (the default) — 3 containers:
- **dina-core** (Go) — your encrypted vault, keys, and messaging endpoint (port 443 external, port 8100 internal)
- **dina-brain** (Python) — the guardian angel reasoning loop (uses Gemini Flash Lite + Deepgram)
- **dina-pds** — AT Protocol Personal Data Server for your trust data (port 2583)

Want a local LLM too? `docker compose --profile local-llm up -d` adds a 4th container (llama with Gemma 3n). See [Advanced Setup](docs/ADVANCED-SETUP.md).

## 2. Verify the Home Node

```bash
./dina-admin status
```

Shows Core health, DID, LLM models (Lite/Primary/Heavy), and security mode.

```bash
./run.sh --status
```

Shows container health, DID, and LLM availability.

### Managing the Home Node

```bash
./run.sh --start     # start containers
./run.sh --stop      # stop containers
./run.sh --status    # check status
./run.sh --logs      # tail logs
```

## 3. Install the CLI (client machine)

On your local machine (laptop, desktop — can be the same machine or different):

```bash
pip install dina-agent
dina status
```

Should show `Paired: no` and `Dina: not connected`.

## 4. Pair the CLI with your Home Node

```bash
# On the Home Node:
./dina-admin device pair    # generates a pairing code

# On the client machine:
dina configure              # enter Core URL + pairing code
```

`dina configure` will:
- Generate an Ed25519 device keypair for signed requests
- Register the device with your Home Node using the pairing code
- Save config to `~/.dina/cli/config.json`

Verify pairing:

```bash
dina status
```

Should show `Paired: yes`, your device DID, and your Dina's DID.

## 5. Try it out

```bash
dina remember "I like strong cardamom tea"
dina ask "what kind of tea do I like?"

dina remember "Daughter turns 7 on March 15, loves dinosaurs"
dina ask "daughter birthday"

dina scrub "Call Rajmohan at 9876543210"
dina validate search "best office chair 2026"
```

## 6. Go online (optional)

```bash
sudo tailscale up && sudo tailscale funnel 443
```

Your Dina is now reachable at `https://<machine-name>.<tailnet>.ts.net/`. Other Dinas can find you and send encrypted messages.

## 7. Install the Trust AppView (optional)

The AppView is the public Trust Network indexer — it consumes AT Protocol records from the Jetstream firehose, scores them, and serves XRPC query endpoints.

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
- **postgres** — PostgreSQL 17 for trust data (port 5432)
- **jetstream** — AT Protocol firehose filtered to `com.dina.trust.*` (port 6008)
- **ingester** — 19 record handlers with Zod validation, trust edges, dirty flags
- **scorer** — 9 cron jobs (trust-score, reviewer-quality, sentiment, anomaly, coordination, sybil, tombstones, decay, cleanup)
- **web** — XRPC API endpoints: resolve, search, get-profile, get-attestations, get-graph (port 3000)

> The Home Node and AppView are independent. The Home Node is your private sovereign agent. The AppView is the public trust indexer anyone can run.

## 6. Use as an OpenClaw Skill

Dina works as an [OpenClaw](https://openclaw.org) skill — any AI agent (Claude, GPT, Gemini, OpenClaw) can use your Dina for encrypted memory, PII scrubbing, and action gating.

The skill manifest is at [`docs/dina-openclaw-skill.md`](docs/dina-openclaw-skill.md). Point your agent to it, or use the CLI commands directly:

```
dina remember <text>              Store a fact in encrypted vault
dina ask <query>                  Ask Dina (Brain-mediated reasoning across personas)
dina scrub <text>                 Remove PII before sending to external APIs
dina rehydrate <text> --session   Restore PII on the response
dina validate <action> <desc>     Check if a destructive action is approved
dina status                       Show pairing status and connectivity
dina unpair                       Revoke this device from the Home Node
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
dina ask "daughter birthday"
# → instant recall from encrypted vault
```

## That's it

Your Dina is running, has a cryptographic identity, and your CLI is paired. What's next:

- **Use as OpenClaw skill** — Give any AI agent encrypted memory and PII scrubbing via the [Dina skill](docs/dina-openclaw-skill.md)
- **Review approvals** — `dina-admin approvals` to list, approve, or deny pending requests
- **Connect Gmail** — `dina connector add gmail` (read-only, OAuth)
- **Connect Calendar** — `dina connector add calendar` (CalDAV)
- **Add a friend's Dina** — Scan their QR code or exchange DIDs
- **Manual testing** — See [`scripts/MANUAL_TEST_GUIDE.md`](scripts/MANUAL_TEST_GUIDE.md) for a full walkthrough
- **Run with Local LLM** — See [Advanced Setup](docs/ADVANCED-SETUP.md) for local LLM (Gemma 3n, no cloud APIs for inference)
- **Set up production networking** — See [Advanced Setup](docs/ADVANCED-SETUP.md) for Cloudflare Tunnel (custom domain, DDoS protection) or Yggdrasil (censorship resistance)

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
| Storage | 5 GB (grows with trust data) |

> Want to run everything locally with no cloud APIs? See [Advanced Setup — Local LLM Profile](ADVANCED-SETUP.md) (requires 8GB+ RAM).
