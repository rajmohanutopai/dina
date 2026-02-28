> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## System Overview

Dina has eight layers. Each is independent and can be built, tested, and replaced separately.

### Core Philosophy: Dina is a Kernel, Not a Platform

**No internal plugins. No untrusted third-party code inside Dina's process. Ever.**

Dina is an orchestrator — she decides *what* needs to be done, but delegates *doing* it to specialized child agents. This is the "CEO vs. Contractor" model:

| | Dina (The CEO) | Child Agents (The Contractors) |
|---|---|---|
| **Role** | Holds intent, memory, identity, trust | Specialized workers (browser, coding, travel, legal) |
| **Code** | Clean, minimal, high-security Go + Python | Whatever works — can crash without affecting Dina |
| **Security** | No third-party code in-process | Run in separate containers or servers |
| **Protocol** | Issues tasks, verifies results | Executes and reports back |

**Two external protocols, no plugin API:**

- **Dina-to-Dina** (peer communication): NaCl `crypto_box_seal` over HTTPS
- **Dina-to-Agent** (task delegation to OpenClaw etc.): MCP (Model Context Protocol)

Both talk to external processes. Neither runs code inside Dina. Child agents cannot touch Dina's vault, keys, or personas — they receive task messages via MCP and return results. If a child agent gets compromised, it's just a misbehaving external process that Dina can disconnect.

**Why this matters for security:** The biggest attack surface in any system is third-party code. Plugins running inside your process can crash your vault, read across persona boundaries, or exfiltrate data. By refusing to run external code inside the process, entire categories of vulnerabilities are eliminated. A compromised child agent is contained — it can only respond to MCP calls, never initiate access to Dina's internals.

**Why this matters for architecture:** No plugin store to maintain, no plugin review process, no sandboxing, no scoped tokens, no plugin API versioning. The two-tier auth model (`BRAIN_TOKEN` + `CLIENT_TOKEN`) is the permanent design, not a stepping stone. NaCl (for peers) and MCP (for agents) are the only extension points.

### Deployment Model: Home Node + Client Devices

**Dina is not an app on your phone. Dina is a service that runs on infrastructure you control.**

An agent that goes offline when your phone battery dies isn't an agent — it's an app. Dina needs to be always-available: other Dinas need to reach it, brain needs to schedule sync cycles via OpenClaw at 3am, glasses and watches need a brain to talk to.

Dina runs on a **Home Node** — a small, always-on server. Your phone, laptop, glasses, and watch are **client devices** that connect to it. Think of it like email: your mail server is always running, and your phone is just a window into it.

```
┌──────────────────────────────────────────────────────┐
│                  DINA HOME NODE                       │
│      (VPS / Raspberry Pi / NAS / home server)        │
│                                                       │
│  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ Encrypted    │  │ Go Core (dina-core)           │  │
│  │ Vault        │  │ - Connector scheduler         │  │
│  │ (SQLite +    │  │ - PII scrubber                │  │
│  │  FTS5 +      │  │ - DIDComm endpoint            │  │
│  │  sqlite-vec) │  │ - WebSocket server            │  │
│  └──────────────┘  │ - Key management              │  │
│                     └──────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ Local LLM    │  │ Python Brain (dina-brain)     │  │
│  │ (llama.cpp   │  │ - Guardian angel loop (ADK)   │  │
│  │  + Gemma 3n) │  │ - Silence classification      │  │
│  └──────────────┘  │ - Nudge assembly             │  │
│                     │ - Agent orchestration          │  │
│                     └──────────────────────────────┘  │
└──────────┬──────────────┬──────────────┬─────────────┘
           │              │              │
     ┌─────┴────┐   ┌────┴─────┐  ┌─────┴──────┐
     │ Phone    │   │ Laptop   │  │ Glasses /  │
     │ (rich    │   │ (rich    │  │ Watch /    │
     │  client, │   │  client, │  │ Browser    │
     │  local   │   │  local   │  │ (thin      │
     │  cache,  │   │  cache,  │  │  client)   │
     │  on-device│  │  on-device│ │            │
     │  LLM)   │   │  LLM)    │  │            │
     └─────────┘   └──────────┘  └────────────┘
```

**Client devices:**

| Mode | Examples | Capabilities |
|------|----------|-------------|
| **Rich client** | Phone, Laptop | Local vault cache, on-device LLM, works offline (limited), syncs when connected |
| **Thin client** | Glasses, Watch, Browser, Car display | Authenticated WebSocket to Home Node only, no local storage |

**Privacy model:** All vault data encrypted at rest with user's keys. Home Node decrypts in-memory only during processing, then discards plaintext. Binary is open source and auditable. Hosting provider sees only encrypted blobs. Long-term: Confidential Computing (AMD SEV-SNP / Intel TDX / AWS Nitro Enclaves) makes even RAM inspection impossible.

### Hosting Levels

Same containers, same SQLite vault, same Docker image at every level. Migration between levels = `dina export` on old machine, `dina import` on new machine (see "Portability & Migration" below).

| Level | Host | Trust Model |
|-------|------|------------|
| **Managed (default)** | Foundation or certified hosting partner | Operator trust + open-source audits + Confidential Computing (Phase 2+) |
| **Self-hosted VPS** | User's own VPS (Hetzner, Oracle free tier, DigitalOcean) | User's operational security. Single-user server = not a honeypot. |
| **Sovereign box** | Raspberry Pi / NAS / home server | Physical control. Attack surface is one machine, one user. |

**The honeypot problem:** For Dina to be a 24/7 agent, the Home Node must decrypt and process the vault. During processing, keys exist in RAM. On a managed multi-user server, a root attacker could theoretically extract keys. Mitigation: per-user SQLite isolation (no shared database), open-source audits, and Confidential Computing enclaves (Phase 2+) where hardware enforces memory encryption — even root cannot read enclave memory.

