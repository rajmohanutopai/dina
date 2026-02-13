# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Dina** — The Architecture of Agency. Inspired by the novel *UTOPAI*.

Dina is the user's personal agent — a digital extension of *their* will, interests, and values. She serves one master: the human who created her. Not advertisers, not platforms, not corporations. This singular loyalty naturally produces a "Pull Economy" where the agent fetches verified truth on demand instead of being fed ads. Three laws govern every design decision: Silence First (never push), Verified Truth (reputation over marketing), Absolute Loyalty (user holds the keys).

### The Full Vision (Phases)

| Phase | Name | What it does |
|-------|------|-------------|
| v0.1 | **The Eyes** | Extract expert verdicts from YouTube reviews via local LLM |
| v0.2 | **The Voice** (now) | Local-first conversational interface with persistent vector memory |
| v0.3 | **The Identity** | W3C DID-based agent identity — cryptographic passport |
| v0.4 | **The Memory** | Decentralized Personal Data Vault (Ceramic Network) |
| v0.5 | **The Hand** | Autonomous purchasing via crypto (USDC), zero ads |

### The Freedom Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Brain | Gemma 3 / Ollama (local) | On-device LLM — no data leaves the machine |
| Schema | PydanticAI | Type-safe structured output, no hallucination |
| Memory | ChromaDB + nomic-embed-text | Local vector store for verdict recall |
| Identity | W3C DIDs (`did:dht`, `did:key`) | Self-sovereign identity |
| Memory (future) | Ceramic Network | Decentralized user-owned data streams |
| Trust | Base / Polygon (L2) | On-chain reputation ledger |
| Privacy | ZK-SNARKs (Mina / Aztec) | Prove facts without revealing raw data |

## Current State: v0.2 (The Voice)

- **Python:** 3.10+
- **LLM:** Gemma 3 via Ollama (`localhost:11434`)
- **Embeddings:** nomic-embed-text via Ollama
- **Vector Store:** ChromaDB (persists to `~/.dina/memory/`)
- **Framework:** PydanticAI (strict schema validation)
- **License:** MIT

## Build & Development Commands

```bash
# Install dependencies (editable mode)
pip install -e .

# Prerequisites: Ollama must be running with both models pulled
ollama pull gemma3
ollama pull nomic-embed-text
ollama serve   # if not already running

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

### v0.2: Voice + Memory (interactive REPL)

```
dina/
  models.py          "Truth Schema" — ProductVerdict Pydantic model (the atomic unit of truth)
  tools.py           "Eyes" — YouTube transcript fetching + smart truncation + URL detection
  agent.py           "Brain" — verdict_agent (structured) + chat_agent (conversational RAG)
  memory.py          "Memory" — ChromaDB vector store for persistent verdict recall
  chat.py            "Voice" — Terminal REPL with URL detection, RAG queries, commands
  __main__.py        Enables `python -m dina`
```

**Data flow (URL analysis):** URL → `fetch_youtube_transcript()` → transcript → `verdict_agent.run_sync()` → `ProductVerdict` → `memory.store()`

**Data flow (RAG query):** question → `memory.search()` → context → `chat_agent.run_sync()` → natural language response

**REPL commands:** `/quit`, `/history`, `/search <query>`

### Key design decisions

- **Local-first:** All inference and embeddings run on the user's machine via Ollama. No data leaves the device.
- **Schema-enforced output:** PydanticAI forces the LLM to produce a valid `ProductVerdict` — no freeform text.
- **Smart truncation:** Transcripts over ~8 000 tokens are truncated from the middle, keeping intro (context) and outro (verdict) intact.
- **Persistent memory:** ChromaDB vector store at `~/.dina/memory/` survives across sessions and `git clean`.
- **Idempotent storage:** Verdicts are upserted by YouTube video ID — re-analysing the same video overwrites, no duplicates.

## Rules

- **No git commands.** Do not run any git commands (commit, push, checkout, etc.) unless the user explicitly asks.
- **Stay inside the project.** Never read, write, or modify files outside the `/Users/rajmohan/OpenSource/dina/` directory.
