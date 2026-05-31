# Quick Start

## Install

```bash
git clone https://github.com/rajmohanutopai/dina.git
cd dina
legacy/bin/install.sh # --quick to avoid repeating the backup phrases
```

The installer asks your name, picks a messaging channel (Telegram or Bluesky), and sets up your AI provider (Gemini, OpenAI, or Claude). Everything else is automatic — keys, containers, identity, PeerLens account.

## See Dina in Action

Seeing how Dina works will give a really good picture of what Dina is.

 [`📖 Read the Full Capabilities & Usage Guide`](./CAPABILITIES.md)

## Verify

```bash
legacy/bin/dina-admin status
```

## Talk to your Dina

**Telegram/Bluesky** — open your bot and chat:
```
/remember My daughter Emma turns 7 on March 15
/ask when is Emma's birthday?
/send Sancho: arriving in 10 minutes
/review Aeron Chair: fixed my back pain
/status
```

**Bluesky** — DM your Dina's Bluesky account which you have setup during install

**CLI** — from any machine (used for connecting to agents like openclaw):
```bash
pip install dina-agent
dina configure
dina ask "what kind of tea do I like?"
```

**Admin** — on the Home Node:
```bash
legacy/bin/dina-admin ask "what do I know about Sancho?"
legacy/bin/dina-admin inbox
legacy/bin/dina-admin trace <request_id>
```

## Manage

```bash
legacy/bin/run.sh --start     # start (rebuilds from latest code)
legacy/bin/run.sh --stop      # stop
legacy/bin/run.sh --status    # health check
legacy/bin/run.sh --logs      # tail logs
legacy/bin/dina-admin export  # decrypted backup
```

## Requirements

Docker & Docker Compose. 2 GB RAM, 2 cores, 10 GB storage. Runs on a VPS, Raspberry Pi, or any always-on machine.
