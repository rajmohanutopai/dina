# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important:** Always consult `README.md` for the full product vision, design philosophy, and long-term direction. Every technical decision should align with the principles described there.

## Project Overview

**Dina** — The Architecture of Agency. Inspired by the novel *[UTOPAI](https://github.com/rajmohanutopai/utopai/blob/main/UTOPAI_2017_full.pdf)* (2012–2017).

Dina is a **sovereign personal AI** and the **safety layer for autonomous agents**. She is a digital extension of *your* will, interests, and values. She serves one master: the human who created her. Not advertisers, not platforms, not corporations. This singular loyalty naturally produces a "Pull Economy" where the agent fetches verified truth on demand instead of being fed ads.

Dina also solves a critical safety gap: autonomous agents today operate without oversight — leaking credentials, accepting commands from anyone, acting without guardrails. Any agent supporting the Dina protocol submits its **intent** to Dina before acting. Dina checks: does this violate your privacy rules? Is this vendor trusted? Are you in the right state to make this decision? Safe tasks pass through silently. Risky actions (sending email, moving money, sharing data) are flagged for your review. The agent never holds your keys, never sees your full history, and never acts without oversight. Regardless of which autonomous agent does the work, the safety layer stays the same.

### The Three Laws

Every design decision must honour these:

1. **Silence First** — Default state is quiet. Only break silence when silence causes harm. Three tiers: Fiduciary (interrupt — silence causes harm), Requested (notify — user asked), Engagement (save for briefing — silence merely misses an opportunity).
2. **Verified Truth** — Reputation earned, never bought. The Reputation Graph replaces marketing.
3. **Absolute Loyalty** — User holds the keys. No advertiser, no platform, no corporation in the loop. Dina is open source, trustworthy, and incorruptible.

### Core Principles

- **Anti-Her:** Dina must never become an emotional crutch. She connects you to humans, never replaces them. If she senses loneliness, she nudges toward friends, not deeper engagement.
- **Thin Agent:** Dina is an orchestrator, not an omniscient brain. She delegates to specialist bots (review, legal, recipe) and routes based on Reputation Graph scores. Raw data never leaves the Home Node — external bots get questions only.
- **Sovereign Identity:** One root identity (user holds the keys), multiple **personas** as separate cryptographic compartments. A seller sees "verified buyer, wants a chair." The government sees full legal identity. No external system can cross compartments.
- **Trust Rings:** Unverified → Verified (ZKP, no real name needed) → Verified + Actioned (transactions, time, peer attestation). Trust is a composite function: `f(identity anchors, transaction history, outcome data, peer attestations, time)`.
- **Deep Link Default:** Dina credits sources — "MKBHD says the battery is bad, here's the timestamp" — not just extracts. Creators get traffic, users get truth. Configurable, but the default is fair.
- **Cart Handover:** Dina advises on purchases but never touches money. She hands control back to you for the final decision.
- **Agent Safety Layer:** Dina is the oversight protocol for all autonomous agents. Any agent acting on your behalf submits intent to Dina first. Safe tasks pass silently; risky actions (email, money, data sharing) require approval. The agent never holds your keys or sees your full history.

### Target Architecture (see README.md)

The long-term architecture is a **Home Node** (always-on, encrypted, sovereign):

- **Rust Core** (Axum) — identity, storage, crypto, API
- **Python Brain** (sidecar) — LLM reasoning, agent logic
- **SQLite** — local structured storage
- **Dina-to-Dina protocol** — P2P communication between sovereign agents
- **Reputation Graph** — expert knowledge + passive outcome data from millions of Dinas
- **PII Scrubber** — raw data never leaves the Home Node

### The Full Vision (Phases)

| Phase | Name | What it does |
|-------|------|-------------|
| v0.1 | **The Eyes** | Extract expert verdicts from YouTube reviews via local LLM |
| v0.2 | **The Voice** | Local-first conversational interface with persistent vector memory |
| v0.3 | **The Identity** | W3C DID-based agent identity — cryptographic passport |
| v0.4 | **The Memory** (now) | Decentralized Personal Data Vault (Ceramic Network) |
| v0.5 | **The Hand** | Autonomous purchasing via crypto (USDC), zero ads |

### The Freedom Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Brain | Multi-provider: light model (chat) + heavy model (video analysis) | LLM — local-first with cloud option |
| Schema | PydanticAI | Type-safe structured output, no hallucination |
| Memory | ChromaDB + nomic-embed-text / text-embedding-004 | Vector store for verdict recall |
| Identity | W3C DIDs (`did:dht`, `did:key`) | Self-sovereign identity |
| Vault | Ceramic Network | Decentralized user-owned data streams |
| Trust | Base / Polygon (L2) | On-chain reputation ledger |
| Privacy | ZK-SNARKs (Mina / Aztec) | Prove facts without revealing raw data |

## Current State: v0.4 (The Memory)

- **Python:** 3.10+
- **LLM:** Multi-provider — light model for chat/RAG, heavy model for video analysis. Configured via `DINA_LIGHT` and `DINA_HEAVY` in `.env` using `provider/model` format (e.g. `ollama/gemma3`, `gemini/gemini-2.5-flash`). At least one must be set.
- **Video Analysis:** If heavy model is Gemini, uses native `VideoUrl` (no transcript fetching). Otherwise falls back to transcript extraction.
- **Embeddings:** Configurable via `DINA_EMBED` (e.g. `ollama/nomic-embed-text`). Inferred from light provider if omitted.
- **Vector Store:** ChromaDB (persists to `~/.dina/memory/`)
- **Vault:** Ceramic Network (optional, configurable via `DINA_CERAMIC_URL`). Dual-writes signed verdicts for decentralized portability. Graceful degradation when disabled or unreachable.
- **Identity:** Ed25519 keypair (`did:key`) persisted at `~/.dina/identity/`; optional `did:dht` via Rust crate
- **Framework:** PydanticAI (strict schema validation)
- **Config:** `.env` file (see `.env.example`); multi-provider `provider/model` format
- **License:** MIT

## Build & Development Commands

```bash
# Install dependencies (editable mode)
pip install -e .

# Copy the example env and configure
cp .env.example .env
# Edit .env — set DINA_LIGHT and/or DINA_HEAVY (provider/model format)

# --- Option A: Ollama only (local, private) ---
# DINA_LIGHT=ollama/gemma3
ollama pull gemma3
ollama pull nomic-embed-text
ollama serve   # if not already running

# --- Option B: Gemini only (cloud) ---
# DINA_HEAVY=gemini/gemini-2.5-flash
# GOOGLE_API_KEY=your-key-here

# --- Option C: Both (recommended) ---
# DINA_LIGHT=ollama/gemma3        # chat uses local model
# DINA_HEAVY=gemini/gemini-2.5-flash  # video analysis uses Gemini + native VideoUrl

# v0.1 one-shot mode — analyse a single YouTube URL
python run_dina.py "https://www.youtube.com/watch?v=VIDEO_ID"

# v0.2 interactive REPL
python -m dina
# or
dina-chat
```

## Architecture

### v0.1: Eyes → Brain → Verdict (one-shot)

```
run_dina.py          CLI entry point — parses URL arg, orchestrates the pipeline
```

### v0.2–v0.4: Voice + Memory + Identity + Vault (interactive REPL)

```
dina/
  providers.py       "Registry" — multi-provider config, model routing, embedding factory
  models.py          "Truth Schema" — ProductVerdict Pydantic model (the atomic unit of truth)
  tools.py           "Eyes" — YouTube transcript fetching + smart truncation + URL detection
  agent.py           "Brain" — verdict_agent (structured) + chat_agent (conversational RAG), no default model
  memory.py          "Memory" — ChromaDB vector store, embedding from providers
  chat.py            "Voice" — Terminal REPL with smart routing (VideoUrl for Gemini, transcript fallback)
  __main__.py        Enables `python -m dina`
  did_models.py      DID Document Pydantic models (W3C-compliant)
  identity.py        Ed25519 keypair generation / persistence at ~/.dina/identity/
  did_key.py         did:key method — derive DID from Ed25519 public key
  signing.py         Verdict signing and verification (Ed25519 over canonical JSON)
  vault.py           "Vault" — CeramicVault: decentralized verdict storage via Ceramic Network
```

```
dina-dht/            (optional Rust crate — did:dht via pkarr + PyO3)
  src/lib.rs         PyO3 bindings: create_did_dht, publish_did_dht, resolve_did_dht
  src/did_dht.rs     Core did:dht logic wrapping pkarr
  src/dns_encoding.rs  DID Document ↔ DNS TXT record encoding
```

**Data flow (URL analysis — Gemini heavy):** URL → `VideoUrl` → `verdict_agent.run_sync(model=providers.verdict_model)` → `ProductVerdict` → `sign_verdict()` → `memory.store()` → `vault.publish()` → `memory.update_stream_id()`

**Data flow (URL analysis — transcript fallback):** URL → `fetch_youtube_transcript()` → `verdict_agent.run_sync(model=providers.verdict_model)` → `ProductVerdict` → `sign_verdict()` → `memory.store()` → `vault.publish()` → `memory.update_stream_id()`

**Data flow (RAG query):** question → `memory.search()` → context → `chat_agent.run_sync(model=providers.chat_model)` → natural language response

**REPL commands:** `/quit`, `/history`, `/search <query>`, `/identity`, `/verify <video_id>`, `/vault`

### Key design decisions

- **Multi-provider architecture:** Configure `DINA_LIGHT` (chat/RAG) and `DINA_HEAVY` (video analysis) independently. Auto-routes by task type. Graceful degradation — works with just one model configured.
- **Native video analysis:** When heavy model is Gemini, uses PydanticAI `VideoUrl` for native YouTube processing (no transcript fetching needed). Falls back to transcript extraction for non-Gemini models.
- **Schema-enforced output:** PydanticAI forces the LLM to produce a valid `ProductVerdict` — no freeform text.
- **Smart truncation:** Transcripts over ~8 000 tokens are truncated from the middle, keeping intro (context) and outro (verdict) intact.
- **Persistent memory:** ChromaDB vector store at `~/.dina/memory/` survives across sessions and `git clean`.
- **Idempotent storage:** Verdicts are upserted by YouTube video ID — re-analysing the same video overwrites, no duplicates.
- **Self-sovereign identity:** Ed25519 keypair generated on first run, persisted at `~/.dina/identity/`. Every verdict is signed. `did:key` is pure Python; `did:dht` requires the optional Rust crate.
- **Signature chain:** Canonical JSON (deterministic `json.dumps` with `sort_keys`, excluding signature fields) → Ed25519 sign → hex-encoded signature stored alongside verdict in ChromaDB metadata.
- **Dual-write vault:** When `DINA_CERAMIC_URL` is set, verdicts are published to Ceramic after ChromaDB. Stream IDs are cross-referenced in ChromaDB metadata. Vault gracefully degrades — disabled when URL unset, warns and continues when node unreachable.
- **Local stream index:** `~/.dina/vault/stream_index.json` maps `video_id → stream_id` for fast lookups without network calls. Written atomically.

## Rules

- **No git commands.** Do not run any git commands (commit, push, checkout, etc.) unless the user explicitly asks.
- **Stay inside the project.** Never read, write, or modify files outside the `/Users/rajmohan/OpenSource/dina/` directory.
