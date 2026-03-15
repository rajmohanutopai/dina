# Architecture Rewrite Decisions

Date: 2026-03-09
Purpose: Decision memo for choices that should be locked before rewriting `ARCHITECTURE.md`
Scope: Specification decisions only
Status: Review document only. No implementation changes are implied by this file.

Companion documents:

- `ARCHITECTURE_REVIEW.md` — broad review and analysis
- `ARCHITECTURE.md` — current architecture document

---

## What This Document Is For

This document is narrower than `ARCHITECTURE_REVIEW.md`.

It answers:

- Which architecture/spec decisions should be made before rewriting the architecture document?
- Which choices should be treated as canonical defaults?
- Which choices should remain explicitly deferred?

The goal is to prevent a rewrite of `ARCHITECTURE.md` from becoming stylistic cleanup while leaving foundational ambiguity in place.

---

## Decision Levels

This document uses three levels:

- `Must Lock Now` — rewriting without deciding this will preserve ambiguity
- `Should Lock Now` — not strictly blocking, but important for clarity
- `Can Defer` — should be marked as intentionally unresolved

---

## Executive Decision Summary

These are the decisions I recommend locking before any rewrite:

### Must Lock Now

1. Root identity lives on the Home Node, not on client devices.
2. All non-browser clients use Ed25519 device keys.
3. Browser admin uses a session cookie to `dina-admin`, and `dina-admin` authenticates to core with Ed25519.
4. Ingestion scheduling belongs to brain, not core.
5. The canonical Phase 1 value proposition is private memory + quiet-first nudges + safe delegation.
6. The trust network is strategically important but not required for initial product coherence.
7. `ARCHITECTURE.md` must distinguish current architecture from future protocol work.

### Should Lock Now

1. Public trust stack should be described as a separate subsystem from the private Home Node.
2. The document should have explicit `Loyalty Invariants`.
3. The document should have explicit `Human Connection Invariants`.
4. The document should have explicit `Intent Economy / Pull Economy Invariants`.
5. The document should define one canonical deployment path before listing variants.

### Can Defer

1. Exact long-term DID migration strategy
2. Exact future commerce protocol
3. Exact AppView scaling path
4. Exact future mesh networking path
5. Exact estate execution mechanics
6. Exact blockchain anchoring mechanics

---

## Must Lock Now

## 1. Root Identity Ownership

| Field | Decision |
|---|---|
| Topic | Where the root identity and master seed live |
| Priority | Must Lock Now |
| Recommended choice | The Home Node owns the root identity and master seed |
| Do not choose | Client devices holding the root identity |

### Why this should be locked

This is the single most important architectural truth in the system.

It affects:

- onboarding
- recovery
- pairing
- threat model
- export/import
- device revocation
- messaging
- DID operations

### Why the Home Node should own it

- Dina is fundamentally a Home Node architecture.
- The node is the always-on sovereign endpoint.
- The node is the natural holder of vault, identity, and messaging authority.
- Device revocation is cleaner if devices are delegated clients rather than identity roots.
- This fits the actual kernel model better than a phone-first identity model.

### What this decision implies

- Devices hold device keys, not the root key.
- Recovery restores the Home Node seed.
- DID operations are signed by the Home Node.
- Browser and device auth are access paths into the node, not holders of sovereign identity.

### What the rewritten architecture should say

`The Home Node is the sovereign holder of the user's root identity and master seed.`

`Client devices pair as delegated devices with their own device keys.`

---

## 2. Client Authentication Model

| Field | Decision |
|---|---|
| Topic | How clients authenticate to the Home Node |
| Priority | Must Lock Now |
| Recommended choice | All non-browser clients authenticate with Ed25519 device keys |
| Do not choose | Split model where some normal clients primarily use bearer tokens |

### Why this should be locked

The current architecture text drifts between:

- all clients use Ed25519
- non-CLI clients use `CLIENT_TOKEN`
- `CLIENT_TOKEN` is admin-only

This needs one answer.

### Why Ed25519 device auth is the best canonical model

- consistent mental model across clients
- cleaner revocation semantics
- better long-term security posture
- better fit with "pair a device" rather than "issue a shared secret"
- aligns with the identity-first design of Dina

### What this decision implies

- phones, laptops, desktop clients, and CLI all use device keypairs
- browser auth remains a separate path because browsers are special
- device pairing becomes "register public key" everywhere
- revocation is "disable device key"

### What the rewritten architecture should say

`All paired client devices authenticate using device-specific Ed25519 keypairs.`

`The browser admin path is separate and terminates at dina-admin, which authenticates to core with its own Ed25519 service identity.`

---

## 3. Browser Admin Authentication

| Field | Decision |
|---|---|
| Topic | How browser-admin authentication should work |
| Priority | Must Lock Now |
| Recommended choice | Browser session cookie at `dina-admin`; `dina-admin` talks to core with Ed25519 |
| Do not choose | Browser secrets passed directly to core, or `CLIENT_TOKEN` as a permanent browser/admin credential |

### Why this should be locked

The browser is the one Dina client that cannot realistically participate in the normal Ed25519 service/device model.

That does not justify a permanent shared-secret exception between browser/admin code and core.

The cleaner rule is:

- browser authenticates to an admin backend with an HTTP session
- admin backend authenticates to core with Ed25519
- all non-browser hops into core use the same cryptographic model

### Recommended canonical statement

`Browser users authenticate to dina-admin with a session cookie.`

`dina-admin authenticates to core with its own Ed25519 service keypair.`

`CLIENT_TOKEN` is not part of the canonical long-term auth model.`

### What this decision implies

- browser sessions live in `dina-admin`, not in the core↔brain transport layer
- normal clients do not depend on bearer-token handling
- internal services (`dina-brain`, `dina-admin`, connectors) all follow the same Ed25519 service-auth pattern
- admin flows become easier to explain because the browser/backend split is explicit

---

## 4. Core vs Brain Responsibility Split

| Field | Decision |
|---|---|
| Topic | Which service owns orchestration and scheduling |
| Priority | Must Lock Now |
| Recommended choice | Brain owns ingestion scheduling and orchestration; core owns kernel-local enforcement and storage |
| Do not choose | Mixed scheduling story where connector scheduling appears in both layers |

### Why this should be locked

This is the second most important boundary after identity.

The architecture is strongest when:

- core is a sovereign kernel
- brain is a guest/orchestrator

### Recommended model

Core owns:

- vault access
- key management
- gatekeeper
- egress enforcement
- messaging
- device trust
- kernel-local loops such as reminders, cleanup, watchdogs

Brain owns:

- ingestion scheduling
- sync orchestration
- classification
- nudges
- external-agent delegation
- reasoning

### What the rewritten architecture should say

`Core never owns external integration workflows.`

`Brain decides when to fetch, reason, classify, and delegate.`

`Core stores, enforces, signs, and gates.`

---

## 5. Canonical Phase 1 Product Core

| Field | Decision |
|---|---|
| Topic | What Dina's minimum coherent product is in Phase 1 |
| Priority | Must Lock Now |
| Recommended choice | Private memory + quiet-first nudges + safe delegation |
| Do not choose | Trust-network-first framing |

### Why this should be locked

The architecture document should not make Dina feel dependent on ecosystem-scale trust adoption before it is useful.

The cleanest Phase 1 story is:

- user-owned memory
- contextual nudges
- private search and recall
- safe external-agent mediation

That is already enough for a coherent product.

### What this decision implies

- trust network is important but not required for first-order value
- PDS/AppView should not dominate the opening architecture narrative
- "tool first, network second" becomes the explicit product architecture principle

### Recommended canonical statement

`Phase 1 Dina is valuable as a sovereign memory-and-guardian layer even without network-scale trust data.`

---

## 6. Trust Network Positioning

| Field | Decision |
|---|---|
| Topic | How central the trust network is to the current system description |
| Priority | Must Lock Now |
| Recommended choice | The trust network is a major subsystem, but not the minimum private core of Dina |
| Do not choose | Describing Dina as inseparable from the full trust public stack in the opening architecture story |

### Why this should be locked

Right now the architecture is strategically correct but rhetorically too wide.

The private Home Node and the public trust stack are both important, but they are not the same thing.

### Recommended framing

Private core:

- identity
- vault
- nudges
- delegation
- messaging

Public extension:

- PDS
- AppView
- public trust records
- trust query federation

### What this decision implies

- the document should explain the Home Node first
- the trust network should appear as the public layer
- the two systems should be shown as interoperating, not merged conceptually

---

## 7. Spec Status Model

| Field | Decision |
|---|---|
| Topic | How `ARCHITECTURE.md` distinguishes current vs future work |
| Priority | Must Lock Now |
| Recommended choice | Add explicit status labeling to every major section |
| Do not choose | One undifferentiated narrative that calls the whole document "active implementation" |

### Recommended status labels

- `Implemented`
- `Current Phase 1 Target`
- `Deferred`
- `Future Protocol`

### Why this should be locked

Without this, a rewrite will improve prose but preserve ambiguity.

### What this decision implies

- the document becomes maintainable
- readers can tell which ideas are commitments vs direction
- review discussions become more precise

---

## Should Lock Now

## 8. Public vs Private Subsystem Framing

| Field | Decision |
|---|---|
| Topic | Top-level architecture shape |
| Priority | Should Lock Now |
| Recommended choice | Explicitly describe Dina as private Home Node core plus optional public trust subsystem |

### Why this matters

This makes the system much easier to understand quickly.

### Recommended top-level framing

Private subsystem:

- core
- brain
- vault
- device pairing
- PII
- messaging

Public subsystem:

- PDS
- AppView
- trust records

Optional subsystem:

- local LLM

---

## 9. Loyalty Invariants

| Field | Decision |
|---|---|
| Topic | How the spec captures "works for you and nobody else" |
| Priority | Should Lock Now |
| Recommended choice | Add a dedicated cross-cutting invariants section |

### Recommended invariants

1. Dina must optimize for user interest, not engagement.
2. External agents receive only task-minimal context.
3. Recommendation outputs must preserve attribution and evidence.
4. User policy must override platform defaults.
5. Opaque vendor influence must be visible, penalized, or excluded.

### Why this matters

Without this section, the architecture reads as secure but not yet explicitly loyal.

---

## 10. Human Connection Invariants

| Field | Decision |
|---|---|
| Topic | How the spec captures the README's "Human Connection" promise |
| Priority | Should Lock Now |
| Recommended choice | Add a dedicated cross-cutting invariants section |

### Recommended invariants

1. Dina should strengthen human-human relationships.
2. Dina should not optimize for emotional dependency on Dina.
3. Relational nudges are a core feature, not a cosmetic extra.
4. Companionship-seeking patterns should trigger human redirection where feasible.
5. Conversation design should avoid attachment-maximizing loops.

### Why this matters

This is one of the most distinctive product claims in the README.

If it remains only a future note, it will keep reading as philosophy rather than architecture.

---

## 11. Pull Economy / Intent Economy Invariants

| Field | Decision |
|---|---|
| Topic | How the spec captures the economic/product philosophy |
| Priority | Should Lock Now |
| Recommended choice | Add a dedicated cross-cutting invariants section |

### Recommended invariants

1. Dina is an intent router, not an engagement system.
2. Dina defaults to pull, not push.
3. Silence is the default when there is no harm.
4. Discovery should be trust-ranked and attributable.
5. Creator value return is the default, not an optional courtesy.

### Why this matters

This is where the README is most original.

The architecture already has ingredients for this, but they should be explicitly connected.

---

## 12. Canonical Default Deployment Path

| Field | Decision |
|---|---|
| Topic | Which deployment path should be mentally primary |
| Priority | Should Lock Now |
| Recommended choice | One canonical default path first, variants second |

### Recommended canonical default

Default mental model:

- one Home Node
- core + brain
- cloud LLM allowed
- local encrypted vault
- external agents via MCP
- optional PDS/public trust path

### Why this matters

The current document often presents multiple valid worlds at once.

That is complete, but not clear.

### Recommended rule for rewrite

For each layer:

1. state the canonical default
2. then list optional variants

---

## 13. Canonical Phase 1 Architecture Section

| Field | Decision |
|---|---|
| Topic | Whether the rewritten doc should open with a minimal architecture section |
| Priority | Should Lock Now |
| Recommended choice | Yes |

### Recommended contents

- what Dina is today
- what is mandatory
- what is optional
- what is deferred
- what Phase 1 does not depend on

### Why this matters

This gives the reader a correct mental model before they enter the long-form spec.

---

## Can Defer

These should remain deliberately deferred.
The point is not to decide everything before rewriting.
The point is to avoid pretending that future protocol details are already canonical.

## 14. Exact DID Escape Strategy

| Field | Decision |
|---|---|
| Topic | Exact long-term `did:plc` to `did:web` migration mechanics |
| Priority | Can Defer |
| Recommendation | Keep high-level design only |

### Why defer

The important part is the sovereignty escape principle, not the precise long-horizon migration mechanics.

---

## 15. Exact Future Commerce Protocol

| Field | Decision |
|---|---|
| Topic | ONDC/UPI/crypto negotiation details |
| Priority | Can Defer |
| Recommendation | Keep as future protocol, not current architecture commitment |

### Why defer

The current architecture only needs to lock:

- Dina does not custody payment credentials
- Dina can prepare and hand over
- trust and attribution should inform commerce

Exact commerce protocol details can wait.

---

## 16. Exact AppView Scaling Path

| Field | Decision |
|---|---|
| Topic | Future sharding, Kafka, Scylla, cluster details |
| Priority | Can Defer |
| Recommendation | Keep as optional future scaling note |

### Why defer

These are valid ideas but not necessary to lock for the spec rewrite.

The important current truth is:

- AppView is a read-only commodity indexer
- private data does not depend on it

---

## 17. Exact Mesh Networking Path

| Field | Decision |
|---|---|
| Topic | Tailscale vs Cloudflare vs Yggdrasil vs relay specifics |
| Priority | Can Defer |
| Recommendation | Keep one canonical default and mark alternatives as variants |

### Why defer

The architecture only needs one clear default story.
The exact long-term networking ecosystem does not need to be settled before rewrite.

---

## 18. Exact Estate Mechanics

| Field | Decision |
|---|---|
| Topic | Detailed post-death release workflows |
| Priority | Can Defer |
| Recommendation | Keep as future protocol with high-level principles only |

### Why defer

The key architectural truth is reuse of trust/recovery infrastructure.

The exact operational flow can remain unresolved.

---

## 19. Exact Blockchain Anchoring Mechanics

| Field | Decision |
|---|---|
| Topic | Chain choice, cadence, proof format |
| Priority | Can Defer |
| Recommendation | Keep as future protocol note only |

### Why defer

The only important current decision is:

`blockchain is not for private data storage; timestamp anchoring is the only plausible use case`

That principle is already enough.

---

## Rewrite Guardrails

These are the guardrails I would use while rewriting `ARCHITECTURE.md`.

### Guardrail 1

Do not rewrite around prose only.
Resolve identity/auth contradictions first.

### Guardrail 2

Do not let future protocol detail dominate the opening sections.

### Guardrail 3

Do not describe optional variants before the canonical default path.

### Guardrail 4

Do not leave loyalty, human connection, and pull economy as implicit side effects.

### Guardrail 5

Do not blur private Home Node architecture with public trust infrastructure.

### Guardrail 6

Do not mark future protocol sections as "active implementation."

---

## Recommended Rewrite Sequence

This is the order I would use for the actual document rewrite later.

1. Write the canonical Phase 1 architecture section.
2. Write the core invariants section.
3. Write the identity/auth matrix.
4. Rewrite the current Home Node architecture around those decisions.
5. Move trust-network content into its own clearly bounded public-layer section.
6. Move all long-horizon protocol details into a deferred/future section.
7. Add status labels throughout the document.

---

## Decision Record Template

When you review these decisions, I recommend treating each one in this format:

| Topic | Decision | Accept / Reject / Modify | Notes |
|---|---|---|---|
| Root identity ownership | Home Node owns root identity |  |  |
| Non-browser client auth | Ed25519 device keys |  |  |
| Browser admin auth | Browser session → `dina-admin` → Ed25519 → core |  |  |
| Ingestion scheduling | Brain-owned |  |  |
| Phase 1 product core | Memory + nudges + safe delegation |  |  |
| Trust-network framing | Public subsystem, not minimum private core |  |  |
| Status model | Implemented / Current Target / Deferred / Future |  |  |
| Loyalty invariants | Add explicit section |  |  |
| Human connection invariants | Add explicit section |  |  |
| Pull economy invariants | Add explicit section |  |  |

This will make your rewrite review much easier.

---

## Final Recommendation

If you want the architecture rewrite to materially improve the project, lock the following before editing the spec:

- root identity ownership
- client authentication model
- browser admin authentication model
- core vs brain responsibility split
- canonical Phase 1 product core
- trust network positioning
- status labeling model

Then use the rewrite to make Dina's most original claims explicit as architecture:

- loyalty
- human connection
- pull economy

That is the highest-leverage path.
