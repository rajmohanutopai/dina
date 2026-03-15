# Dina Architecture Review

Date: 2026-03-09
Scope: Review of `README.md` and `ARCHITECTURE.md`
Purpose: Decision memo before any architecture-document rewrite or implementation changes
Status: Review only. No implementation or spec changes are proposed in this file.

---

## Executive Summary

The architecture is fundamentally good.

Its core shape is strong:

- user-owned Home Node
- encrypted local vault
- thin sovereign kernel
- external agents via MCP
- strong containment and prompt-injection defense
- public trust data separated from private life data

Those are the right foundations for Dina.

The problems are not primarily "bad technology choices." The problems are:

1. `ARCHITECTURE.md` translates the security thesis of the README much better than the product thesis.
2. The document mixes current architecture, future protocol design, and long-horizon speculative systems into one "active implementation" narrative.
3. A few core identity/auth concepts are internally contradictory, which is dangerous because those are foundational, not peripheral.

The architecture does match the README on sovereignty, identity, privacy, thinness, trust, and quiet-first behavior.

It does not yet match the README strongly enough on:

- loyalty as a system invariant
- human connection / anti-Her as a system invariant
- the pull economy / intent economy
- creator value return / discovery engine defaults
- explicit architectural expression of "works for you and nobody else"

My conclusion:

- Keep the architecture.
- Tighten the specification.
- Separate "implemented/current" from "future protocol."
- Add missing cross-cutting invariants for loyalty, human connection, and pull economy behavior.

---

## The Three Questions

This review is structured around:

1. Does the architecture match the vision document?
2. Is it the simplest it can be?
3. Is it a good architecture: maintainable and future-proof?

---

## 1. Vision Alignment Review

### Overall Judgment

The architecture matches the README well on the mechanical parts of Dina and less well on the philosophical parts that make Dina distinct.

That distinction matters.

Many systems can claim:

- encrypted storage
- agent orchestration
- external connectors
- trust scoring
- cryptographic identity

What makes Dina special in the README is not just the security architecture. It is the combination of:

- loyalty
- quiet-first attention behavior
- human-relationship orientation
- intent-driven discovery
- pull economy instead of push economy
- value return to creators and experts

Those ideas are present in `ARCHITECTURE.md`, but not yet treated as first-class architectural constraints.

### Vision Coverage Matrix

| README Promise | Coverage in Architecture | Judgment |
|---|---|---|
| Sovereign identity | Strong | Well handled |
| Home Node / user-owned deployment | Strong | Well handled |
| Thin kernel / no plugins | Strong | Well handled |
| Persona compartments | Strong | Well handled |
| PII scrubbing | Strong | Well handled |
| Prompt-injection containment | Strong | Well handled |
| Quiet-first / fiduciary interruption | Strong | Well handled |
| Dina-to-Dina messaging | Strong | Well handled |
| Cart handover / Dina never touches money | Strong | Well handled |
| Trust Network and trust rings | Strong | Well handled |
| Bot trust and routing | Medium-strong | Present, but more protocol than operating policy |
| Loyalty framework | Weak-medium | Implied, not architecturally explicit |
| Human connection | Weak | Mostly future-note level |
| Anti-Her | Weak | Present as a future note, not a current invariant |
| Pull economy / intent economy | Weak | Implied through trust and deep links, not explicitly designed |
| Creator value return | Medium | Deep-link rule exists, but system-level framing is thin |
| Merit economy | Medium | Trust network supports it, but architecture does not present it as a formal design outcome |
| Open economy | Medium | Present as future commerce path, but correctly deferred |

### Strong Alignment Areas

These are the best-translated parts of the README into the architecture:

#### 1. Dina is a kernel, not a platform

This is the most successful translation from the vision document into engineering form.

The README says Dina should be thin, should have no plugins, and should use external agents while keeping keys and vault local.

The architecture reflects that clearly:

- Go core owns keys, vault, messaging, and enforcement.
- Python brain owns orchestration and reasoning.
- external agents remain outside the trust boundary.

This is one of the strongest parts of the entire spec.

#### 2. Sovereign identity and persona isolation

The architecture strongly captures the README claim that Dina is "you" and that personas are cryptographic compartments rather than app-level preferences.

Per-persona databases, per-persona DEKs, selective unlock, and gatekeeper enforcement are coherent and aligned with the vision.

#### 3. Quiet-first behavior

The Silence Protocol is one of the best behavioral translations in the document.

The README's three-tier logic:

- interrupt when silence causes harm
- notify when explicitly requested
- stay silent otherwise

is captured cleanly in the interrupt classification model.

#### 4. Trust Network architecture

The README's trust thesis translates well into:

- signed public records
- trust rings
- outcome data
- AppView aggregation
- bot trust scoring
- tombstones

This part is conceptually consistent.

#### 5. Cart handover and no direct money handling

The architecture carries the README principle faithfully: Dina can prepare, evaluate, and hand off, but not execute payment custody.

That is a good boundary.

---

## 1A. Vision Areas That Are Missing or Under-Specified

These are not "nice to have." These are part of what makes Dina different from OpenClaw, Claude Cowork, Perplexity Computer, or generic assistant stacks.

### A. Loyalty Is Not Yet an Architectural Invariant

The README makes loyalty central:

- Dina should work for the user and nobody else
- Dina should be the missing identity-and-protocol layer that makes other agents loyal
- recommendations should not be distorted by platform incentives

The current architecture supports loyalty indirectly through:

- local vault ownership
- PII protection
- trust network
- action gating

That is necessary, but not sufficient.

What is missing is an explicit section defining `Loyalty Invariants`.

The architecture should explicitly state something like:

1. external agents never receive user data beyond task-minimal context
2. recommendation ranking must be attributable and explainable
3. sponsorship, paid placement, and opaque ranking must be tagged or excluded
4. user policy overrides platform defaults
5. Dina defaults to evidence-ranked pull, not vendor-ranked push

Without this, the security architecture is clear, but the loyalty architecture is still mostly philosophical.

### B. Human Connection Is Not Yet Designed as a First-Class Outcome

The README says Dina should provide:

- Trust
- Memory
- Agency
- Human Connection

The architecture strongly covers trust, memory, and agency.
It does not strongly cover human connection.

The anti-Her note exists, but only as a future feature.
That is too weak relative to the README.

What is missing is a small but explicit `Human Connection Invariants` section describing:

1. Dina should strengthen human-human relationships rather than substitute for them
2. relational nudges are a core product behavior, not a cosmetic feature
3. if the system detects companionship-seeking patterns, the preferred response is human redirection
4. emotionally loaded interactions should not optimize for attachment
5. conversation UX should not be optimized toward dependence loops

This does not need a giant ML system.
It does need architectural status.

### C. Pull Economy / Intent Economy Is Not Explicitly Architected

The README's most original economic idea is the inversion from push to pull:

- no distraction-first discovery
- no feed-first economic system
- user intent drives retrieval
- trust drives ranking
- creators get linked back to

The architecture contains ingredients of this:

- deep-link attribution
- quiet-first behavior
- trust-based recommendations
- no marketplace middleman requirement

But it never explicitly states the core design rule:

`Dina is an intent router, not an engagement maximizer.`

This should become a short cross-cutting section.

Otherwise the architecture reads like a trust-and-security architecture with economic implications, rather than an architecture for a pull economy.

### D. Creator Value Return Is Present, But Too Localized

The deep-link rule in bot responses is good.
It is one of the most important parts of the architecture because it directly operationalizes the "discovery engine, not extraction engine" idea.

But it is currently isolated in the bot protocol section.

This should be promoted to a system default:

- attribution required
- deep links preferred
- source credit preserved through summaries
- bots that strip attribution are penalized
- "answer plus route back to source" is the default user-facing pattern

### E. The Merit Economy Is Supported, But Not Presented as a Deliberate System Behavior

The trust architecture enables the merit economy.
It does not yet describe the merit economy as a deliberate protocol outcome.

What should be clearer:

- rankings should emerge from outcomes, attestations, and trust, not from paid placement
- AppView and query APIs should preserve evidence traceability
- economic value should be downstream of quality and trust, not upstream of visibility

### F. "Works for You and Nobody Else" Needs Architectural Language

This is the most important user-facing sentence in the README.

The architecture should probably have one explicit section titled either:

- `User Sovereignty Invariants`
- `Loyalty Invariants`

That section should unify:

- vault control
- action gating
- recommendation integrity
- attribution defaults
- policy ownership
- default-deny sharing

Right now those pieces exist, but they are scattered.

---

## 1B. Internal Contradictions That Need Resolution

These contradictions are more serious than missing future features because they create ambiguity in the foundation.

### 1. Root Identity Custody Contradiction

There are at least two incompatible stories in the document:

- root identity generated and held on client hardware
- root identity generated by Home Node and never held by devices

These cannot both be true.

Recommended canonical decision:

`The Home Node is the root identity holder.`

Reason:

- Dina is fundamentally a Home Node architecture
- the node must sign DID operations and Dina-to-Dina interactions
- device revocation and pairing are cleaner if devices are delegated clients
- this aligns better with the implemented and operational shape of the project

Then clarify:

- devices hold device keys only
- root identity never leaves the Home Node
- recovery is about restoring the Home Node's seed, not restoring a phone-held root key

### 2. Client Authentication Contradiction

There are also two incompatible stories:

- all clients use Ed25519 device keys
- browser admin uses a separate session-backed path

Recommended canonical decision:

`All non-browser clients use Ed25519 device keys.`

`Browser admin should authenticate to a dedicated admin backend with a session cookie.`

`That admin backend should authenticate to core with Ed25519.`

Reason:

- simpler trust model
- fewer authentication classes
- cleaner revocation semantics
- better long-term consistency with "pair a device key"

If some legacy client must use a token, that should be documented as an exception, not the primary model.

### 3. Core Scheduler Contradiction

The system overview suggests connector scheduling in core.
The ingestion layer says scheduling belongs to brain and core has no connector code.

Recommended canonical decision:

`Scheduling for ingestion belongs to brain.`

`Core may only run its own small internal loops for kernel duties.`

This aligns with the "core is pure sovereign kernel" principle.

### 4. "Active Implementation" vs "Future Architecture" Contradiction

The document says the architecture above is the active implementation, while containing a large number of future/deferred/phase-specific sections.

This is not just editorial.
It creates false certainty.

Recommended canonical decision:

Every major section should be clearly labeled as one of:

- `Implemented`
- `Phase 1 Current Target`
- `Deferred`
- `Long-Horizon Future`

---

## 2. Simplicity Review

### Overall Judgment

The architecture is simpler than it looks.
The document is more complicated than the architecture needs to be.

The actual core system is fairly clean:

- one Home Node
- one encrypted vault layer
- one sovereign kernel
- one intelligence sidecar
- one agent-delegation protocol
- one optional trust-publication layer

That is not over-engineered.

What makes the document feel heavy is that it carries too much future protocol surface inside the current narrative.

### What Is Already Simple and Correct

These are simplifications worth defending, not revisiting:

#### 1. SQLite + SQLCipher for private state

Correct choice.
This is aligned with:

- portability
- low ops burden
- user ownership
- single-user topology
- simple backup and restore

Do not replace this with a server database unless the product model changes drastically.

#### 2. Go core + Python brain

Good tradeoff.
The split is justified by:

- strong kernel boundary
- Python ecosystem for orchestration
- ability to evolve or replace brain independently

This is less risky than a giant monolith pretending to be simple.

#### 3. Home Node as source of truth

Correct.
This avoids unnecessary CRDT/event-log complexity.

#### 4. No plugin architecture

Very good.
This is one of the most important anti-complexity decisions in the system.

#### 5. MCP delegation for external work

Good fit for Phase 1.
It avoids rebuilding connector/auth ecosystems inside core.

#### 6. Cart handover and draft-don't-send

Good product simplifications.
They reduce risk while preserving value.

### Where the Document Is More Complex Than Necessary

#### A. The Home Node Default Shape Is Too Wide for the Real Phase 1 Story

The document correctly says:

- Phase 1 value must not depend on the trust network

But it still mentally centers:

- bundled PDS
- three ingress tiers
- public trust topology choices

That is not wrong, but it is not the smallest useful mental model.

The simplest Phase 1 mental model should be:

1. Home Node private core:
   - `dina-core`
   - `dina-brain`
2. optional public trust stack:
   - `dina-pds`
   - `appview`
3. optional local inference:
   - `llama`

This framing would make the architecture feel much cleaner.

#### B. Too Many Future Protocol Details in the Mainline Doc

The following are valid ideas, but should not dominate the primary architecture narrative:

- multiple ingress tiers
- Noise migration
- full DIDComm compatibility phases
- sharded AppView cluster
- Merkle anchoring on L2
- Shamir-based estate flow
- Phase 3 commerce protocols
- future mobile platform details

These should live in either:

- a dedicated `future protocol` document
- or clearly demarcated deferred appendices

#### C. Too Many "Possible Worlds" Are Presented Side-by-Side

The document often presents multiple topologies at once:

- external PDS vs bundled PDS
- Tailscale vs Cloudflare vs Yggdrasil
- cloud vs local vs hybrid inference
- single-persona vs multi-persona evolution
- browser vs device-token vs key-based auth

That is useful for completeness.
It is not ideal for clarity.

Recommended principle:

`Every layer should have one canonical default path, then optional variants.`

#### D. Some Future Systems Are Architecturally Valid but Prematurely Concrete

Examples:

- estate executor flows
- multi-AppView anti-censorship verification
- blockchain timestamp anchoring
- emotional state gating
- open-economy negotiation

These are not bad ideas.
They are just too concretely specified relative to what needs to be true today.

That makes the architecture feel more complex than the shipped system really is.

### The Simplest Canonical Phase 1 Architecture

If I had to compress the current architecture to the simplest faithful version, it would be:

`Dina is a Home Node with a Go security kernel and a Python reasoning sidecar.`

The kernel owns:

- encrypted vault
- identity
- device auth
- persona access
- egress control
- messaging

The brain owns:

- ingestion orchestration
- silence classification
- nudges
- external-agent delegation

External agents do outside work.
They never get direct vault or key access.

Public trust is an optional but compatible extension.

That is the architecture's clean center.
The spec should make that center impossible to miss.

---

## 3. Architecture Quality, Maintainability, and Future-Proofing

### Overall Judgment

This is a good architecture.

It is maintainable and future-proof if a few spec-hygiene issues are fixed early.

### Why It Is Good

#### 1. Strong boundaries

Good architecture is mostly about boundaries.

This architecture has strong ones:

- private vs public data
- kernel vs intelligence
- local vault vs external agents
- open vs restricted vs locked personas
- action proposal vs action execution

That is a major strength.

#### 2. Correct trust model

The document does not assume:

- LLMs are trustworthy
- external agents are safe
- relays are benevolent
- users want perfect automation

That realism is a strength.

#### 3. Good portability model

The file-based encrypted vault model is aligned with the product promise that users should be able to move their Dina.

This is much better than accidental dependence on an opaque managed backend.

#### 4. Good cold-start strategy

The architecture correctly avoids making initial value depend on network-scale trust data.

That is strategically sound.

#### 5. Good future seams

The architecture has durable seams for future evolution:

- internal core/brain API
- MCP boundary
- AppView as replaceable commodity
- PDS split sovereignty model
- local vs cloud inference profiles

These are good abstractions.

### Maintainability Risks

#### A. Spec sprawl

The biggest maintainability problem is the document itself.

When one file simultaneously acts as:

- current architecture spec
- future roadmap
- protocol design notebook
- tradeoff essay
- implementation status snapshot

it becomes harder to keep accurate.

This is already starting to happen.

#### B. Foundational contradictions

Identity and auth contradictions are dangerous because they spread into:

- onboarding
- pairing
- export/import
- threat model
- UI and recovery flows
- actual code paths

These need canonical resolution before more implementation grows around them.

#### C. Cross-cutting invariants are scattered

Right now:

- sharing rules live in one place
- PII policy in another
- deep-link behavior in another
- anti-Her in another
- trust behavior in another
- action gating elsewhere

The system needs a few short "cross-cutting rule" sections that unify behavior.

#### D. Future-first specificity can harden the wrong things

When future systems are specified too concretely too early, teams tend to preserve accidental interfaces just because they were written down.

That can slow iteration.

The right move is not to remove future sections.
The right move is to separate them from current commitments.

#### E. Dependency concentration in OpenClaw for ingestion

For Phase 1, this is pragmatic and fine.

Longer term, it creates a strategic risk:

- Dina's memory pipeline depends on another agent system's connector surface
- if that surface changes, Dina's ingestion quality degrades
- "loyalty layer for all agents" becomes partially dependent on one agent stack

This is not a flaw in the architecture.
It is a dependency to monitor and keep intentionally replaceable.

### Future-Proofing Judgment

The architecture is future-proof in the right way:

- replaceable brain
- replaceable AppView
- optional public trust topology
- optional local inference
- portable storage

It is not future-proof in the wrong way:

- it does not prematurely introduce distributed complexity into private storage
- it does not require Kubernetes for the core product
- it does not tie private state to public ledgers

That is good.

The main future-proofing improvement needed is spec clarity, not system redesign.

---

## Canonical Decisions Recommended Before Any Rewrite

These decisions should be made explicitly before editing `ARCHITECTURE.md`.

### 1. Root Identity Ownership

Recommended decision:

`The Home Node owns the root identity and master seed.`

Implications:

- devices pair as delegated clients
- device compromise does not compromise root identity
- recovery restores the Home Node identity
- device hardware stores device keys, not the root key

### 2. Client Authentication

Recommended decision:

`All non-browser clients authenticate with Ed25519 device keys.`

`Browser admin should use session cookie → dina-admin → Ed25519 → core.`

Implications:

- cleaner mental model
- cleaner pairing story
- simpler revocation
- fewer auth classes

### 3. Core vs Brain Responsibilities

Recommended decision:

`Core is the sovereign kernel. Brain is the orchestrator.`

Specifically:

- ingestion scheduling belongs to brain
- connector logic belongs outside core
- core may only run kernel-local loops and enforcement routines

### 4. Phase 1 Product Core

Recommended decision:

`Phase 1 core value is private memory + quiet-first nudges + safe delegation.`

Trust-network publishing should be framed as:

- compatible
- valuable
- important long-term

but not mentally required for initial product coherence.

### 5. Loyalty Invariants

Recommended decision:

Add a small cross-cutting invariant section defining:

- Dina must optimize for user interest, not engagement
- recommendations must remain attributable
- paid influence must be transparent or excluded
- external agents get only minimal context
- user policy overrides defaults

### 6. Human Connection Invariants

Recommended decision:

Add a section defining:

- Dina should strengthen human relationships
- Dina should not optimize for emotional dependency
- relationship nudges are core behavior
- human redirection is preferred over artificial companionship

### 7. Pull Economy / Intent Economy Invariants

Recommended decision:

Add a section defining:

- Dina is intent-driven, not feed-driven
- default retrieval is pull, not push
- interruption policy protects attention
- discovery should be trust-ranked and attributable
- creator value return is the default

---

## What the Architecture Spec Should Add

These are additions to the specification layer, not implementation changes.

### A. Add a Status Legend to the Document

Every major section or subsection should be marked as one of:

- `Implemented`
- `Current Phase 1 Target`
- `Deferred`
- `Future Protocol`

This single change would dramatically improve clarity.

### B. Add a "Canonical Phase 1 Architecture" Section Near the Top

This should be short and opinionated.

It should answer:

- what Dina minimally is today
- what containers are mandatory
- what is optional
- what is not required for value

### C. Add an "Identity and Authentication Matrix"

One compact table should cover:

- root identity
- master seed location
- device keys
- browser login
- CLI auth
- device pairing
- revocation
- export/import implications

This removes ambiguity faster than paragraphs spread across the document.

### D. Add "Loyalty Invariants"

This should be a short cross-cutting section.

Suggested contents:

1. Dina must not optimize for engagement
2. Dina must prefer attributable evidence over opaque recommendation
3. Dina must minimize external context exposure
4. Dina must preserve user override authority
5. Dina must treat vendor influence as policy-visible, not hidden

### E. Add "Human Connection Invariants"

Suggested contents:

1. Dina should strengthen human-human relationships
2. Dina should not present itself as a substitute relationship
3. Relational nudges are a core behavior
4. Emotional dependency signals should trigger human redirection
5. Long-term memory should support people, not replace them

### F. Add "Intent Economy / Pull Economy Invariants"

Suggested contents:

1. Dina is an intent router, not a feed
2. Dina defaults to silence when there is no harm
3. discovery is initiated by user need or fiduciary trigger
4. expert/value sources should receive attribution and traffic
5. ranking should be trust-based and evidence-based, not attention-based

### G. Add a "Current vs Future Trust Network" Clarifier

This should make explicit:

- what trust network capabilities are operationally required for Phase 1
- what are later ecosystem-level capabilities

This matters because right now the trust network section is good, but too easy to read as immediately central to everything.

### H. Add a "Public vs Private Subsystems" Clarifier

A simple diagram or table should state:

- private subsystem: core, brain, vault, pairing, PII, messaging
- public subsystem: PDS, AppView, trust records
- optional subsystem: local LLM

This would greatly improve readability.

---

## Suggested Rewrite Plan for `ARCHITECTURE.md`

This is a proposed document-rewrite plan only.
No code or implementation implications are assumed.

### Rewrite Goal

Make the document do three things well:

1. explain the current architecture clearly
2. preserve the long-horizon protocol thinking
3. eliminate ambiguity about foundational decisions

### Recommended Document Shape

#### Section 1. What Dina Is Today

Keep this tight.

Suggested contents:

- one-paragraph system definition
- canonical Phase 1 topology
- mandatory components
- optional components
- short statement of what Dina is not

#### Section 2. Core Invariants

This should include:

- sovereign ownership invariant
- kernel/not-platform invariant
- loyalty invariants
- human connection invariants
- pull economy invariants
- default-deny sharing invariant

#### Section 3. Current Architecture

This should include only:

- core/brain split
- vault/storage model
- identity and device auth
- messaging
- ingestion
- silence protocol
- action gating
- sync

This is the heart of the current system.

#### Section 4. Public Trust Layer

This should include:

- trust network
- PDS/AppView shape
- what is current vs deferred
- current cold-start strategy

This keeps public architecture separate from the private Home Node architecture.

#### Section 5. Optional Profiles and Deployment Variants

This should include:

- managed vs self-hosted
- cloud LLM vs local LLM
- networking variants
- bundled vs external PDS

These are important, but secondary.

#### Section 6. Deferred Protocol Roadmap

Move long-horizon items here:

- Noise migration
- multi-AppView verification ecosystems
- Merkle timestamp anchoring
- Shamir social recovery activation
- estate flows
- open economy negotiation
- advanced mobile/platform features

This keeps them visible without pretending they are current commitments.

### Recommended Splits Into Additional Documents

If you want the main architecture doc to stay readable, these could become separate docs later:

- `docs/architecture/current-home-node.md`
- `docs/architecture/trust-network.md`
- `docs/architecture/auth-and-identity.md`
- `docs/architecture/future-protocol.md`

This is optional.
The key point is separation of current commitments from future design.

---

## Minimal Canonical Statements I Would Want Locked Before Rewriting

These are the "one-sentence truths" the architecture doc should make impossible to misunderstand.

### 1. What Dina is

`Dina is a user-owned Home Node with a sovereign security kernel that stores memory, enforces privacy and action boundaries, and delegates outside work to external agents.`

### 2. What Dina is not

`Dina is not a plugin platform, not a feed product, not a general marketplace, and not an emotional companion.`

### 3. What the kernel owns

`The kernel owns identity, vault access, device trust, sharing policy, egress control, and final action gates.`

### 4. What the brain does

`The brain reasons, classifies, assembles context, and orchestrates external work, but never owns vault or identity primitives.`

### 5. What external agents are

`External agents are tools and contractors, never trusted peers inside the kernel boundary.`

### 6. What trust data is

`Trust data is public, signed, and federated; private life data is local, encrypted, and portable.`

### 7. What the economy model is

`Dina serves an intent economy: it pulls what the user needs from trust-ranked sources instead of pushing engagement-maximizing distractions.`

### 8. What the relationship model is

`Dina should strengthen the user's human relationships and never optimize for emotional dependence on Dina itself.`

---

## Recommended Priority Order for Spec Cleanup

This is the order I would use before changing any implementation:

1. Resolve identity custody model
2. Resolve client authentication model
3. Add status labels: implemented/current/deferred/future
4. Write canonical Phase 1 architecture section
5. Add loyalty invariants
6. Add human connection invariants
7. Add pull economy invariants
8. Separate public trust architecture from private Home Node architecture more clearly
9. Move long-horizon protocol details into clearly deferred sections

---

## Final Judgment

This is not an overengineered architecture in the usual sense.

It is a strong architecture wrapped in an overgrown specification.

The architecture's center is clear and good:

- sovereign Home Node
- strong private/public boundary
- thin kernel
- delegated agents
- quiet-first behavior
- trust as infrastructure

What now needs work is not the system's bones.
It is:

- canonicalizing a few foundational choices
- turning the most original parts of the README into explicit invariants
- reducing ambiguity between current architecture and future protocol aspirations

If that cleanup is done, the architecture will read much more powerfully and much more credibly.

It will also become easier to maintain as the system grows.
