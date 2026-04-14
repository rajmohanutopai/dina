# Dina Agent Architecture — Overview and Reading Guide

**Status:** Specification (overview) · **Audience:** Dina Mobile team, Basic Dina team, OpenClaw team, future contributors and integrators · **Purpose:** the map. Explains how the four architecture documents compose, what each owns, how they interact, and the reading order for different roles.

## The Four Documents

| Document | Scope | Length | Read when |
|----------|-------|--------|-----------|
| **DINA_ARCHITECTURE_OVERVIEW.md** (this) | Map and reading guide | short | first |
| **[DINA_AGENT_KERNEL.md](./DINA_AGENT_KERNEL.md)** | Synchronous turn loop: streaming, tools, permissions, compaction, cancellation, budgets, sanitization | long | implementing agent runtime |
| **[DINA_WORKFLOW_CONTROL_PLANE.md](./DINA_WORKFLOW_CONTROL_PLANE.md)** | Durable state: tasks, timers, approvals, watches, delegations, obligations, ingestion | medium-long | implementing state-outlives-turn behavior |
| **[DINA_DELEGATION_CONTRACT.md](./DINA_DELEGATION_CONTRACT.md)** | Wire protocol for external execution planes (OpenClaw, MCP) | medium | implementing Dina-compatible delegation endpoints |

Together they specify the full Dina agent architecture across the synchronous and asynchronous layers.

## Why Three Specs, Not One

A single "Dina Agent Architecture" document tried to be everything and was both too detailed in places and too vague in others. Three documents with clear scopes let each go deep in its domain:

- **Kernel** is a *how-do-turns-work* spec. Mostly behavioral. Implementers write code that makes turns feel like Claude Code.
- **Control plane** is a *state-and-lifecycle* spec. Mostly data model + protocols. Implementers write the durable machinery that makes long-running agent behavior possible.
- **Delegation contract** is a *wire-protocol* spec. Mostly message shapes + verification. Implementers on either side (Dina or external plane) write compatible endpoints.

The split also aligns with team boundaries. The mobile app and server may share the kernel and control plane, but each may integrate with different external planes via the delegation contract.

## Mental Model — How the Layers Compose

```
        ┌─────────────────────────────────────────────────────┐
        │                     User                            │
        └───────────────┬────────────────────▲────────────────┘
                        │ input              │ responses
                        ▼                    │
        ┌─────────────────────────────────────────────────────┐
        │               Dina Agent Kernel                     │
        │                                                     │
        │  - turn loop   - streaming     - tools              │
        │  - permissions - sanitization  - compaction         │
        │  - budgets     - cancellation  - action lifecycle   │
        │  - session with structured state (read-through)     │
        └──────┬──────────────────────┬────────────▲──────────┘
               │ reads state          │ calls       │ invoked by
               │ creates tasks        │ tools       │ (user input OR
               ▼                      │             │  WakeReason)
        ┌──────────────────────────────────────────────────────┐
        │           Dina Workflow Control Plane                │
        │                                                      │
        │  - tasks (pending, running, awaiting, etc.)          │
        │  - timers / scheduler                                │
        │  - approvals (sync and async)                        │
        │  - delegations (lifecycle)                           │
        │  - watches / subscriptions                           │
        │  - obligations                                       │
        │  - result ingestion router                           │
        │  - durable state (SQLite)                            │
        └──────┬───────────────────────────────▲───────────────┘
               │ outbound packets               │ callbacks
               │ (per delegation contract)      │ (per contract)
               ▼                                │
        ┌──────────────────────────────────────────────────────┐
        │        External Execution Planes                     │
        │    OpenClaw   MCP servers   Webhooks   etc.          │
        └──────────────────────────────────────────────────────┘
```

**Flow of control in practice.**

- **User types a message** → kernel starts a turn. Turn reads current structured state (from control plane's read-through cache). Turn runs, maybe proposes a send_email (action lifecycle). Proposal becomes a pending approval task (control plane). Turn ends.
- **User approves the proposal** → control plane resolves the approval and triggers a new kernel turn with `WakeReason: approval_resolved`. Turn executes the send_email, verifies, records. Ends.
- **Timer fires** → control plane scheduler triggers a new kernel turn with `WakeReason: timer_fired`. Turn acts on the reminder. Ends.
- **Model decides to delegate research to OpenClaw** → agent calls a tool that creates a delegation task. Control plane sends packet outbound per delegation contract. Turn returns synthetic "delegation submitted, pending" result and ends.
- **OpenClaw returns result 40 minutes later** → control plane's ingest router validates the signed result packet and triggers a new kernel turn with `WakeReason: delegation_returned`. Turn continues the user's original intent.
- **A watch fires for a subscribed event** → control plane triggers a kernel turn with `WakeReason: watch_event`. Turn decides whether to notify the user or handle silently.

The kernel is the **brain**; the control plane is the **spine**; the delegation contract is the **nervous system** reaching out to the world.

## Reading Order by Role

**Implementer building Dina Mobile or Basic Dina from scratch.**
1. This document (overview) — 15 min
2. Kernel document — read fully. Implement Phase 1 (Foundation) before reading further.
3. Control plane document — read fully after kernel Phase 1 is passing golden tests.
4. Delegation contract — read when you start integrating OpenClaw or MCP.

**Implementer on OpenClaw or an external execution plane.**
1. This document — 15 min
2. Delegation contract — read fully. This is the only doc you *must* implement against.
3. Kernel document — read sections on tools and action lifecycle for context.
4. Control plane document — read sections on delegations for lifecycle context.

**Reviewer or architect doing design review.**
1. This document
2. Kernel document's preface, invariants, tier table, "What this doesn't handle"
3. Control plane document's preface, principles, component map, "What this doesn't handle"
4. Delegation contract's preface, principles, wire shapes
5. Deep-dive into specific patterns as needed

**Product / user researcher trying to understand agent behavior.**
1. This document
2. Kernel: preface, invariant #9 (structured state), pattern 11 (reminders + state summary), pattern 22a (action lifecycle)
3. Control plane: patterns 4 (approvals), 6 (watches), 7 (obligations)
4. Skip wire-level details

## Ownership and Boundaries

### What the kernel owns

- How a single turn runs from input to committed messages
- Streaming semantics with every provider
- Tool execution with per-tool timeouts and mandatory sanitization
- Permission checks including the four-layer authorization
- Compaction (deterministic default, LLM-assisted upgrade)
- Structured system prompt construction with versioned boundary
- Session append-only persistence (messages + state deltas)
- Per-turn budgets and cancellation

### What the kernel does NOT own

- Durability of structured state (owned by control plane)
- Scheduling (control plane)
- Sync between devices (control plane)
- External delegation wire format (delegation contract)
- Retries that span across turn boundaries (control plane)

### What the control plane owns

- Durable task model and state machines
- Scheduler and timer delivery
- Approval flow (sync coordination + async state)
- Delegation lifecycle
- Watches and subscriptions
- Obligation inference and tracking
- Ingest routing with correlation and auth
- Cross-task retry and circuit breakers
- Backup/export/restore of control-plane state

### What the control plane does NOT own

- Running individual LLM turns (kernel)
- Tool execution semantics (kernel)
- Wire format with externals (delegation contract)
- UI (that's the app)

### What the delegation contract owns

- Packet shape (outbound and result)
- Signature and correlation proofs
- Capability catalog
- Error taxonomy at the wire level
- Audit requirements at the wire level

### What the delegation contract does NOT own

- What external planes do internally
- How Dina decides when to delegate (control plane)
- How results are applied to sessions (kernel + control plane)

## Key Cross-Cutting Concepts

### Structured state (kernel invariant #9)

Sessions carry more than messages. They carry plan steps, open tasks, pending approvals, pending delegations, watches, obligations. The model sees a summary of this state in every turn. The full state is durable in the control plane; the kernel holds a read-through cache. This is the single biggest reason Dina can maintain coherence across long sessions and resumed work.

### Wake reasons (control plane pattern 2)

When a turn is triggered by something other than user input, the reason is explicit and first-class. The model sees *why* this turn is happening and acts appropriately. Without this, timer-triggered turns feel like the agent suddenly wandered into the conversation.

### Action lifecycle (kernel pattern 22a)

High-impact tool calls (sends, purchases, deletions) follow an explicit observe → plan → propose → approve → execute → verify → record flow. Separating these stages makes it impossible for the model to "just do" something risky and creates a clean intervention point for the user.

### Mandatory runtime sanitization (kernel invariant #8)

Untrusted text (tool outputs, vault reads, attestations, delegation results) passes through a non-removable sanitization stage. This is not a hook — it's plumbing that cannot be disabled or bypassed. Hooks add policy; sanitization enforces the security boundary.

### Deterministic compaction default (kernel pattern 13)

Session compaction defaults to deterministic local summarization. LLM-assisted enhancement is an opt-in upgrade path, never the only option. This makes compaction auditable, deterministic, and aligned with Dina's privacy-first values.

### Correlation IDs end-to-end

Every user intent can be traced from user request → agent proposal → task creation → delegation packet → external work → result callback → kernel turn → user response. The correlation ID is the thread that ties it all together. Signed cryptographically in delegation contracts to prevent replay.

## Implementation Sequencing Across Docs

A joint roadmap across the three specs:

### Milestone 1 — Walking skeleton (kernel + minimal control plane)

- Kernel Phase 1: Foundation (turn loop, tools, sanitization)
- Kernel Phase 2: Safety & lifecycle (permissions, action lifecycle)
- Control plane Phase 1: MVP (task model, approvals, timers, wake reasons, state visibility)

After this milestone: Dina can have coherent multi-turn conversations with safe tool use and basic scheduled reminders.

### Milestone 2 — Resilience (kernel + control plane hardening)

- Kernel Phase 3: Cancellation, budgets, oversized handling, stream recovery
- Control plane Phase 2: Delegations (infrastructure, without external integrations yet)
- Control plane Phase 5: Restart recovery, cancellation cascade

After this milestone: Dina handles real-world chaos — dropped connections, cancelled tools, app backgrounding, long-running work.

### Milestone 3 — Context and long sessions (kernel)

- Kernel Phase 4: Layered prompts, compaction, structured state summary
- Kernel Phase 5: SSE robustness, persistence with state deltas, concurrency

After this milestone: Sessions can run all day and stay coherent.

### Milestone 4 — External execution (delegation contract + control plane)

- Delegation contract implementation on Dina side (outbound + ingest)
- One concrete external plane integration (OpenClaw most likely)
- Control plane Phase 3: Watches (depends on external source integration)

After this milestone: Dina can delegate complex work to OpenClaw and subscribe to external events.

### Milestone 5 — Ambient intelligence (control plane + kernel polish)

- Control plane Phase 4: Obligations
- Kernel Phase 6: Observability (fork, output bounds, cache telemetry, corruption recovery)
- Control plane Phase 6: Observability (dev UI, support export)

After this milestone: Dina feels ambient — it tracks your commitments, resurfaces them at the right moment, and surfaces its own state for debugging.

## What This Suite Does NOT Cover

Explicitly out of scope across all four documents. Handle separately or accept as limitations:

1. **UI / UX design** — how approvals surface, how notifications are styled, how persona unlock is confirmed
2. **Vault schema and cryptography** — covered elsewhere in Dina core docs
3. **Onboarding and identity setup** — covered in core onboarding spec
4. **Trust network construction and attestation authoring** — covered in trust network docs
5. **Multi-user collaboration** — Dina is single-user
6. **Federation between Dina instances** — speculative, not yet speced
7. **Payment integration specifics** — referenced abstractly (`make_purchase` as action class), details elsewhere
8. **Model fine-tuning or prompt-engineering beyond the scaffolding** — the kernel defines the scaffolding; per-model prompt tuning is ongoing work

## Labeling Convention

All three deep documents use consistent labels on patterns:

- **[Reference-derived]** — adapted from Claude Code's claw-code reference
- **[Dina addition]** — not in the reference; Dina needs it for its own invariants
- **[Dina divergence]** — reference does it one way; Dina chose differently (usually for privacy, security, or mobile constraints)

This makes review honest and future reassessment easier. If you disagree with a divergence, you can target it directly; reference-derived patterns are less likely to need revisiting.

## Versioning

Each document has its own version. Changes to contracts (invariants, wire shapes, tier assignments) bump major. Pattern additions bump minor. Editorial changes bump patch.

Current versions (April 2026):
- Overview: 1.0
- Kernel: 4.0
- Control plane: 1.0
- Delegation contract: 1.0

A cross-document release tag (e.g., `dina-arch-2026.04`) captures the set that was reviewed together.

## Review Process

Substantial changes to any of these documents go through:

1. Author drafts in a branch
2. Review by Dina Mobile lead, Basic Dina lead, and (for delegation contract) OpenClaw lead
3. Integration test plan: every load-bearing change must have golden tests added or updated
4. Merge after all reviewers approve

Quick-fix editorial changes (typos, clarifications, updated references) can merge without full review.

---

**Document version:** 1.0 · **Last updated:** 2026-04-14 · **Purpose:** single entry point for the Dina Agent Architecture suite.
