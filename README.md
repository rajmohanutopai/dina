# Dina — The Architecture of Agency

### Your Agent. Your Interests. Nothing Else.

[](https://opensource.org/licenses/MIT)

> *"In the novel UTOPAI, Dina was the agent who protected human intent from machine manipulation. This repository is the attempt to build her."*

---

## What is Dina?

**Dina is you.** She is your personal agent — a digital extension of *your* will, *your* interests, *your* values. She does not serve advertisers, platforms, or corporations. She serves one master: the human who created her.

Every app on your phone today works for someone else. Your search engine works for advertisers. Your social feed works for engagement metrics. Your shopping app works for the marketplace.

Dina works for **you**. Only you. That is the entire point.

## The Problem

The internet runs on a **Push Economy**. Corporations surveil users to push ads, manipulate attention, and profit from distraction. The user is the product, not the customer.

- A 12th grader researching biology gets bombarded with beauty ads.
- An elderly parent clicks a "dark pattern" and buys something they never needed.
- A brilliant chair-maker in Bangalore loses to a mediocre brand with a bigger ad budget.

Truth is buried under marketing. Attention is stolen, not earned.

## The Vision

Because Dina's only allegiance is to her human, a natural consequence emerges: a **Pull Economy**. Instead of corporations pushing noise at you, your agent **pulls** verified truth on demand.

- **No ads.** Dina only speaks when spoken to.
- **No surveillance.** All reasoning happens locally on your device.
- **No gatekeepers.** A small honest manufacturer wins on quality, not ad spend.

Dina doesn't care about corporate interests. She cares about *your* interests.

## The Three Laws of Agency

Every agent built on the Dina Protocol must obey:

1. **Silence First.** The agent never pushes content. It only pulls what the human explicitly requests.
2. **Verified Truth.** The agent values Proof of Reputation over Proof of Marketing Budget.
3. **Absolute Loyalty.** The agent's data vault is encrypted with keys only the human holds. It cannot be bribed by advertisers.

## How It Works

### The Expert Bridge

Buying decisions today are driven by ads. In Dina, they are driven by **Wisdom**.

Trusted experts (MKBHD, Linus Tech Tips, rtings.com, Reddit communities) produce real knowledge — but it's trapped in videos and threads. Dina extracts that wisdom into structured, verifiable data.

```
Expert uploads review → Dina Oracle extracts verdict → Signed attestation stored
                                                              ↓
                        User asks agent → Agent checks Expert Graph → Informed decision
```

> *You want a laptop. Your agent checks the Dina Graph. Trusted reviewers flagged the battery on Model X. Your agent warns you — even if the ad says "Best Battery Ever."*

### The Reputation System

No universal score that can be gamed. Instead, a **composite trust model**:

- **Transaction Score** — Proof-of-purchase history. If you pay, you play. No gates.
- **Identity Anchors** — Optional verified badges (LinkedIn, GitHub) via zero-knowledge proofs. Prove you're real without revealing who you are.
- **Expert Weight** — Does the Expert Graph support this product?

### The Privacy Architecture

- **Local-First AI.** Analysis of your preferences happens on your device. Only the *result* (a preference vector) ever leaves, and only with explicit permission.
- **Encrypted Vault.** Chat logs and review history live in a decentralized Personal Data Vault. The hash goes on-chain for tamper-proofing; the data stays yours.
- **Selective Disclosure.** Grant a vendor read-only access to "Coffee Preferences" without exposing your entire history.

## The Freedom Stack

Built to resist corporate capture:

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Brain** | Gemma 3 / Ollama (local) | On-device LLM reasoning — no cloud dependency |
| **Schema** | PydanticAI | Type-safe, hallucination-resistant structured output |
| **Identity** | W3C DIDs (`did:dht`, `did:key`) | Self-sovereign identity — no "Log in with Google" |
| **Memory** | Ceramic Network | Decentralized, user-owned, mutable data streams |
| **Trust** | Base / Polygon (L2) | Low-cost on-chain reputation ledger |
| **Privacy** | ZK-SNARKs (Mina / Aztec) | Prove facts without revealing raw data |

## Getting Started (v0.1 — The Truth Oracle)

The first working piece: turn a YouTube review into a structured verdict.

**Prerequisites:**
- Python 3.10+
- [Ollama](https://ollama.com) with `gemma3` pulled

```bash
# Install
pip install -e .

# Pull the local LLM
ollama pull gemma3

# Run against a YouTube review
python run_dina.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

**Output:** A strict JSON verdict — BUY, WAIT, or AVOID — with pros, cons, hidden warnings, and confidence score. No freeform hallucination allowed.

## Roadmap

### Phase 1: The Eyes of Dina (v0.1 — Now)
The sensory layer. Extract expert wisdom from YouTube reviews into structured, verifiable verdicts.

### Phase 2: The Voice of Dina (v0.2)
A local-first conversational interface. Talk to your agent. It remembers your preferences in an encrypted local vault.

### Phase 3: The Identity of Dina (v0.3)
DID-based agent identity. Your agent gets a cryptographic passport — provable, revocable, sovereign.

### Phase 4: The Memory of Dina (v0.4)
Decentralized Personal Data Vault on Ceramic. Your history, your keys, your rules.

### Phase 5: The Hand of Dina (v0.5)
Autonomous purchasing. The agent negotiates and buys on your behalf using crypto (USDC). Zero ads served.

## The Origin: UTOPAI

This project is inspired by the novel *UTOPAI*, which imagined a world where AI agents act as guardians of human intent rather than tools of corporate extraction.

Dina is the protagonist of that story. This code is the attempt to bring her to life.

## Join the Story

This is more than code. It is public infrastructure for truth.

- **Contribute:** Pull requests welcome.
- **Discuss:** Open an issue to propose ideas.
- **Read:** The novel *UTOPAI* (coming soon).

> *"The future is not what happens to us. It is what we build."*

---

**License:** MIT
