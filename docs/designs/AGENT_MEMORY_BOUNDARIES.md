# Agent vs Memory Boundaries

## Purpose

This document separates three concerns that are easy to conflate:

1. Deterministic product memory and state
2. Agent-inferred behavior
3. User-confirmed learning

The immediate motivation is the next set of memory features:

- Contact alias support
- Automatic person/entity linking

The broader question behind both is architectural:

> If Dina already has a strong LLM and an agentic runtime, why do alias and
> entity-link features still need explicit code and storage?

Short answer:

- An agent can often infer identity in one conversation.
- A personal AI product needs identity to be durable, testable, policy-aware,
  and available even when the model is wrong, unavailable, or swapped out.

That requires explicit product state.

## Executive Summary

Dina today already has meaningful deterministic infrastructure:

- explicit contact records in Core
- explicit relationship and responsibility fields
- deterministic sensitive-signal detection
- deterministic subject attribution for sensitive facts
- responsibility-aware routing
- an agentic `/ask` flow that can choose vaults and search queries

Dina does **not** yet have the two identity features required for reliable
cross-reference memory:

- durable alias support end-to-end
- durable person/entity linking across notes

This is why a scenario like:

1. `/remember My daughter's name is Emma`
2. `/remember My daughter loves dinosaurs`
3. `/ask What does Emma like?`

is still opportunistic today rather than guaranteed.

The current agent may answer correctly if retrieval and reasoning line up, but
the system does not yet maintain a canonical durable link from `Emma` to
`my daughter`.

## Current Architecture in This Repo

### What Dina already has

#### Contact and policy model

Core contact records now carry relationship-aware routing fields in
`core/internal/domain/contact.go`:

- `relationship`
- `data_responsibility`
- `responsibility_explicit`

These are persistent product-state fields. They are not agent-only concepts.

#### Deterministic routing for sensitive facts

The sensitive-fact routing path is now largely deterministic:

- canonical sensitive-domain detection in
  `brain/src/service/sensitive_signals.py`
- known-contact matching in
  `brain/src/service/contact_matcher.py`
- per-fact subject attribution in
  `brain/src/service/subject_attributor.py`
- responsibility-aware aggregation and staging override in
  `brain/src/service/staging_processor.py`
- optional LLM correction by stable attribution ID in
  `brain/src/service/persona_selector.py`

This is the correct shape for policy-sensitive routing because:

- it works when the LLM is unavailable
- it is testable
- it makes privacy/routing behavior explicit

#### Agentic `/ask` flow

The recall path is agentic, not rigidly hardcoded. The runtime in
`brain/src/service/vault_context.py` lets the LLM:

- list personas
- browse vaults
- search vaults
- fetch full content
- iterate via tool calls

This is a real agent loop. It is not a simple keyword router.

#### Multi-provider model routing

`brain/src/service/llm_router.py` already provides provider selection and policy
gates, including local-vs-cloud routing and cloud consent handling.

### What Dina is not using today

Although the repo documentation mentions ADK-oriented architecture in places,
the current runtime in this codebase is not an active `google.adk`-managed
memory/agent system.

What exists:

- `google.genai` provider usage
- custom agentic orchestration in `vault_context.py`
- custom model routing in `llm_router.py`

What is not present as the active runtime:

- an imported and integrated `google.adk` application layer that owns entity
  memory, alias memory, or identity linking

This matters because there is no hidden framework layer currently solving alias
or entity resolution on Dina's behalf.

## Why Agent Frameworks Do Not Replace Product Memory

Agent frameworks such as Claude Code or Google ADK help with:

- tool orchestration
- multi-step planning
- session/state at the runtime layer
- retries and execution loops
- subagents, skills, or MCP integration

They do **not** automatically provide:

- a canonical person record
- durable alias mappings
- durable entity-link records
- privacy/routing policy invariants
- retrieval expansion rules
- auditability
- migration-backed persistence

That work still belongs to the product.

### Framework capability vs product responsibility

| Area | What an agent framework can help with | What the Dina product still must own |
|---|---|---|
| Tool use | Decide which search/retrieval tools to call | Define the tools and what structured data they operate on |
| Conversation memory | Keep session context for the current run | Persist cross-session identity and memory links |
| Inference | Infer that `Emma` may be `my daughter` in-context | Store whether `Emma == my daughter` as a durable truth |
| Clarification | Ask `Do you mean Emma, your daughter?` | Record the answer as canonical state |
| Search | Generate multiple natural-language queries | Expand queries with known aliases/entity links deterministically |
| Safety | Follow prompt instructions | Enforce hard routing/policy invariants in code |
| Portability | Work with multiple providers | Keep identity semantics stable across provider/model changes |

## The Three Layers Dina Needs

## 1. Deterministic Schema and State

This is the layer that must be true even if:

- the model is wrong
- the model is unavailable
- the provider changes
- the conversation is long gone

Examples for Dina:

- contact record
- DID
- name
- alias list or alias field
- relationship
- data responsibility
- responsibility explicitness
- canonical person/entity ID
- confirmed entity links
- confidence/provenance for learned links
- review status for unresolved links
- retrieval expansion map

This layer should be persisted, migrated, and queryable.

### What belongs here

| Capability | Should be deterministic? | Why |
|---|---|---|
| Contact name | Yes | Canonical lookup key |
| Contact alias | Yes | Needed for reliable routing and recall |
| Relationship | Yes | User-owned descriptive metadata |
| Data responsibility | Yes | Hard routing policy input |
| `Emma == my daughter` after confirmation | Yes | Durable identity fact |
| `Mom == contact DID xyz` | Yes | Needed across sessions and models |
| Query expansion from name to alias | Yes | Retrieval should not depend on LLM luck |
| Sensitive routing decision | Yes, with optional LLM refinement | Privacy policy requires deterministic floor |

## 2. Agent-Inferred Behavior

This is where the LLM should help because language is ambiguous and variable.

Examples:

- propose candidate aliases
- infer likely links from natural sentences
- generate search variants
- resolve ambiguous references in current context
- choose which vaults to search
- decide whether to ask the user a clarifying question

This layer should be treated as:

- helpful
- probabilistic
- revisable
- never the only source of truth for durable identity

### What belongs here

| Capability | Should be agent-inferred? | Why |
|---|---|---|
| `Emma is probably your daughter` from a note | Yes | Good inference candidate, not yet durable truth |
| Choosing search phrasings for `/ask` | Yes | Natural-language flexibility is useful here |
| Deciding which vaults to inspect first | Yes | Good agent-planning task |
| Interpreting `her` in one sentence | Yes, with deterministic backstop where needed | Contextual language resolution is model-friendly |
| Proposing that `my kid` and `my daughter` may be the same person | Yes | Suggestion first, then confirm/store |

## 3. User-Confirmed Learning

This layer turns uncertain inferences into durable product state.

The user is the authority when identity matters.

Examples:

- confirm that `Emma` is `my daughter`
- confirm that `Mom` is a contact alias
- reject a mistaken merge
- split two people the system conflated
- promote a suggested relationship to a stored contact field

### What belongs here

| Capability | Should require user confirmation? | Why |
|---|---|---|
| Creating a durable alias from a weak inference | Usually yes | Avoid false merges |
| Linking a proper name to a family-role phrase | Yes unless extracted from high-confidence pattern | Personal identity errors are costly |
| Changing responsibility from `external` to `care` | Yes | This affects sensitive routing policy |
| Merging two possible people records | Yes | Wrong merges corrupt long-term memory |

## What Exists Today vs What Does Not

### Dina memory and routing inventory

| Area | What exists today | What does not exist today |
|---|---|---|
| Contact persistence | Contact model with name, alias field in schema/model, relationship, responsibility, explicitness | End-to-end alias lifecycle that is actively used by routing and recall |
| Sensitive routing | Deterministic sensitive signal detection and subject attribution | Alias-aware subject attribution |
| LLM correction | Stable-ID correction over deterministic attributions | Durable identity memory from those corrections |
| `/ask` recall runtime | Agentic search/browse/fetch tool loop in `vault_context.py` | Alias-aware query expansion and person-link retrieval |
| Person identity model | Contacts exist | Canonical entity graph linking names, aliases, and role phrases over time |
| Role-phrase linking | Heuristics for routing-sensitive ownership buckets | Durable learning that `my daughter == Emma` |
| User control | Relationship/responsibility commands exist | Alias management commands and entity-link review flows |
| Review path | Unresolved ownership can be surfaced for review | Structured review queue for identity-link suggestions |
| Storage for learned links | None beyond current contact fields | Dedicated person-link store or equivalent confirmed mapping model |
| Framework support | Custom agentic loop and model router | Framework-owned memory layer that replaces product modeling |

### Alias support specifically

| Question | Current state |
|---|---|
| Does the data model mention alias? | Yes, the contact domain model includes an `Alias` field |
| Is alias a first-class user workflow today? | No |
| Does `ContactMatcher` use alias for routing? | No, it is name-only |
| Does `/ask` expand contact names into aliases during retrieval? | No explicit alias expansion path exists |
| Can current runtime reliably answer `What does Emma like?` from `My daughter loves dinosaurs`? | Not reliably; only if retrieval + reasoning happen to reconstruct the link |

### Automatic entity linking specifically

| Question | Current state |
|---|---|
| Does Dina persist confirmed links like `Emma == my daughter`? | No |
| Does Dina extract such links automatically from notes into structured state? | No |
| Can the LLM infer such links in-context? | Sometimes, if the right memories are retrieved |
| Is that inference durable across sessions/providers? | No |
| Is there a user confirmation flow for learned identity links? | No |

## Why the Example Scenario Is Not Guaranteed Today

Scenario:

1. `/remember My daughter's name is Emma`
2. `/remember My daughter loves dinosaurs`
3. `/ask What does Emma like?`

For this to be reliable, the system must do more than reasoning at answer time.

It must have a durable bridge between:

- `Emma`
- `my daughter`

Today, Dina may succeed if:

- both memories are retrieved
- the LLM infers the connection in-context

But that is not a product guarantee because there is no explicit durable
entity-link record behind it.

## What Alias Support Should Mean

Alias support is the simpler, explicit version of identity linking.

Example:

- Contact name: `Emma`
- Alias: `my daughter`

Expected system behavior:

- routing treats either phrase as the same contact
- `/ask What does Emma like?` can search using both `Emma` and `my daughter`
- `/ask What does my daughter like?` can also reach facts stored under `Emma`

### Why alias support is worth explicit implementation

- It is user-controlled.
- It is testable.
- It is deterministic.
- It reduces reliance on prompt luck.
- It improves both routing and recall immediately.

## What Automatic Person/Entity Linking Should Mean

Automatic entity linking is more powerful and more dangerous.

Example target behavior:

- `/remember My daughter's name is Emma`
- system proposes or records that `Emma` and `my daughter` are the same person

This should be implemented conservatively.

### Good high-confidence patterns

- `My daughter's name is Emma`
- `Emma is my daughter`
- `Our daughter Emma ...`
- `My son is called Arjun`

### Bad low-confidence patterns

- `Emma met my daughter`
- `My daughter's teacher is Emma`
- `Sancho knows Emma`

These should not create durable links automatically.

## Recommended Boundary for Future Work

### Deterministic layer should own

- contact aliases
- confirmed entity links
- canonical person IDs
- link provenance/confidence
- link review status
- deterministic query expansion
- deterministic routing inputs

### Agent layer should own

- proposing alias/entity candidates
- generating search variants
- asking clarifying questions
- using deterministic aliases/links during reasoning
- ranking likely matches when multiple people are possible

### User-confirmation layer should own

- approve/reject candidate links
- merge/split people
- set or edit aliases
- promote inferred links into durable state
- correct wrong identity assumptions

## Practical Answer to "Shouldn't Full Chat Handle This?"

Full back-and-forth chat helps, but it is not enough by itself.

Chat is good for:

- clarification
- ambiguity resolution
- one-shot reasoning
- proposing candidate interpretations

Chat is not sufficient for:

- durable identity truth
- cross-session consistency
- retrieval invariants
- privacy/routing policy
- auditable behavior

For a personal AI, those missing properties matter more than they do in a
stateless coding assistant.

## Recommended Sequencing

### Step 1: Explicit alias support

Add end-to-end support for:

- stored alias
- alias-aware routing
- alias-aware `/ask` query expansion
- alias management commands

This provides immediate value and is low-risk.

### Step 2: Conservative automatic entity linking

Add structured extraction for high-confidence patterns only.

Do not infer durable identity from loose co-occurrence.

### Step 3: User-confirmed learning loop

When the model proposes a likely link that is not high-confidence:

- store it as a suggestion
- surface it for confirmation
- promote it to durable state only after confirmation

## Final Position

The correct architecture for Dina is:

- deterministic product memory for identity and policy
- agentic reasoning on top of that memory
- user-confirmed learning to turn uncertain inferences into durable truth

This is not redundant with Claude Code-style or ADK-style agent frameworks.
Those frameworks make the agent more capable. They do not remove the need to
model personal identity, aliases, and routing policy explicitly inside the
product.
