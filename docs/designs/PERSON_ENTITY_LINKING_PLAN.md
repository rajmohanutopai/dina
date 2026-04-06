# Conservative Person and Entity Linking Plan

## Purpose

This document defines the implementation plan for automatic but conservative
person/entity linking in Dina.

Target scenario:

1. `/remember My daughter's name is Emma`
2. `/remember My daughter loves dinosaurs`
3. `/ask What does Emma like?`

Desired behavior:

- Dina learns that `Emma` and `my daughter` refer to the same person
- later recall is reliable
- false merges are avoided

This plan is intentionally broader than contact aliases:

- aliases are explicit, user-managed mappings
- entity links are learned or inferred mappings between different surface forms

## Why This Needs a Separate Layer

Alias support alone only works when:

- a contact already exists
- the user explicitly sets the alias

That is useful, but not enough for a personal AI.

Users naturally produce identity facts through notes such as:

- `My daughter's name is Emma`
- `Our son Arjun loves trains`
- `Emma is my daughter`

If Dina cannot learn from those, memory feels brittle and shallow.

At the same time, entity linking is dangerous because false merges corrupt
long-term memory.

So the correct design is:

- conservative extraction
- durable structured storage
- explicit review/confirmation path
- gradual rollout

## Current State

### What exists today

| Area | Current state |
|---|---|
| `/remember` storage | Notes are stored as vault items with metadata and summaries |
| `/ask` runtime | Agentic retrieval/search exists in `vault_context.py` |
| Contact model | Contacts exist with name, relationship, data_responsibility, aliases |
| Contact aliases | Explicit multi-alias per contact with global uniqueness |
| Sensitive routing | Deterministic subject attribution via `subject_attributor.py` |
| Contact matching | `ContactMatcher` matches names + aliases with word-boundary regex |
| Subject precedence | `SubjectAttributor` uses stored alias > kinship pattern > role phrase |
| Review infrastructure | Routing review surfaced in daily brief via KV-backed review items |

### What does not exist today

| Gap | Why it matters |
|---|---|
| Canonical person/entity records beyond contacts | Non-contact people have no durable identity object |
| Durable surface-form mapping | `Emma` and `my daughter` are not stored as linked surfaces |
| Confidence/status on learned links | No safe lifecycle for suggestions vs confirmed truth |
| Query-time person expansion | `/ask` cannot deterministically expand one surface into another |
| User confirmation loop for person links | No way to approve/reject learned identity links |
| Routing policy on learned identity | No defined boundary for when inferred links may affect sensitive routing |

## Core Design Principles

1. Learned identity is structured, not just embedded in note text.
2. Low-confidence links do not become durable truth automatically.
3. Unconfirmed links should help recall only when safe.
4. Sensitive routing should not depend on weak inferred identity.
5. User confirmation is part of the system, not an afterthought.
6. False merges are worse than missed links.

## Goals

1. Learn high-confidence identity links from notes.
2. Make recall reliable across name/role phrase variation.
3. Preserve provenance and confidence for every learned link.
4. Support user review, correction, and confirmation.
5. Avoid false merges.

## Non-Goals

1. Full knowledge-graph reasoning.
2. Broad LLM-only entity inference with no stored evidence.
3. Automatic use of weak links for sensitive routing.
4. Aggressive pronoun coreference across documents.

## Proposed Data Model

### New table: `people`

| Column | Type | Purpose |
|---|---|---|
| `person_id` | TEXT PK | Opaque identifier (UUID) |
| `canonical_name` | TEXT nullable | Best current proper name, if known |
| `contact_did` | TEXT nullable | Link to a contact when this person is also a contact |
| `relationship_hint` | TEXT nullable | `child`, `spouse`, `parent`, etc. when known |
| `status` | TEXT | `suggested`, `confirmed` |
| `created_from` | TEXT | `manual`, `llm`, `imported` |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |

### New table: `person_surfaces`

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Row identifier (autoincrement) |
| `person_id` | TEXT NOT NULL | FK to `people.person_id` |
| `surface` | TEXT NOT NULL | Surface form such as `Emma` or `my daughter` |
| `normalized_surface` | TEXT NOT NULL | Lowercased/trimmed lookup form |
| `surface_type` | TEXT | `name`, `role_phrase`, `nickname`, `alias` |
| `status` | TEXT | `suggested`, `confirmed`, `rejected` |
| `confidence` | TEXT | `high`, `medium`, or `low` |
| `source_item_id` | TEXT nullable | Provenance to the vault item that caused extraction |
| `source_excerpt` | TEXT nullable | Short evidence span (cleared on source deletion) |
| `extractor_version` | TEXT | Version of the extractor that created this record |
| `created_from` | TEXT | `llm`, `manual`, `imported` |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |

Indexes:

- `CREATE INDEX idx_person_surface_normalized ON person_surfaces(normalized_surface)`
- `CREATE INDEX idx_person_surface_person ON person_surfaces(person_id, normalized_surface)`
- `CREATE INDEX idx_person_surface_source ON person_surfaces(source_item_id)`

### Surface uniqueness rules

Person surfaces are **NOT globally unique**. Multiple people named `Emma` are
valid. Even role phrases like `my daughter` may be ambiguous in real families.

The resolver must handle ambiguity explicitly:
- If a surface resolves to exactly one person → unambiguous match
- If a surface resolves to multiple persons → return all candidates with
  confidence, let the caller handle disambiguation
- If a surface matches both a contact alias AND a person surface → contact
  alias takes priority (contact is authoritative)

### Why not just use contacts?

| Concept | Contact | Person entity |
|---|---|---|
| Explicit DID-backed directory entry | Yes | Optional |
| May exist without contact details | No | Yes |
| Has routing responsibility | Yes | Not directly |
| Can be learned from notes | Not safely | Yes |
| Canonical identity across role phrase and name | Partial (aliases) | Yes |
| Globally unique surfaces | Yes (aliases) | No |

## API Contract

### Core write contract: atomic extraction results

The extractor will often discover multiple surfaces from one source item.
Individual row-level CRUD is the wrong abstraction for extraction results.

**Primary write endpoint:**

```
POST /v1/people/apply-extraction
```

Request:
```json
{
  "source_item_id": "vault-item-123",
  "extractor_version": "llm-v1",
  "results": [
    {
      "canonical_name": "Emma",
      "relationship_hint": "child",
      "surfaces": [
        {"surface": "Emma", "surface_type": "name", "confidence": "high"},
        {"surface": "my daughter", "surface_type": "role_phrase", "confidence": "high"}
      ],
      "source_excerpt": "My daughter's name is Emma"
    }
  ]
}
```

Semantics:
- **Idempotent** per `(source_item_id, extractor_version)`. Re-applying the
  same extraction result is a no-op.
- **Atomic**: all surfaces for one extraction result are created in one transaction.
- **Dedup**: if a surface already belongs to the same person → update confidence.
- **Name surfaces** (type=`name`) like `Emma` are allowed on multiple people.
  Multiple people named Emma is valid. No conflict returned.
- **Role phrase surfaces** (type=`role_phrase`) like `my daughter` trigger
  conflict review if already confirmed on a different person. This prevents
  silent contradictions on identity-anchoring phrases.
- **Contradictory (role_phrase + canonical_name) claims** on the same person
  also trigger conflict review (see Contradiction Handling).

Idempotency key: `(source_item_id, extractor_version, normalized extraction fingerprint)`.
The fingerprint is a hash of the sorted normalized surfaces. If the extractor
is re-run on the same item and produces the same output, no new records are created.

### Additional Core endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/people` | List all people (with surfaces) |
| GET | `/v1/people/{person_id}` | Get one person with surfaces |
| PUT | `/v1/people/{person_id}/confirm` | Confirm a suggested person |
| PUT | `/v1/people/{person_id}/reject` | Reject a suggested person |
| PUT | `/v1/people/{person_id}/surfaces/{id}/confirm` | Confirm a surface |
| PUT | `/v1/people/{person_id}/surfaces/{id}/reject` | Reject a surface |
| DELETE | `/v1/people/{person_id}/surfaces/{id}` | Detach surface from person |
| POST | `/v1/people/merge` | Merge two people into one |
| DELETE | `/v1/people/{person_id}` | Tombstone/delete person |
| POST | `/v1/people/{person_id}/link-contact` | Link person to a contact DID |

## Precedence and Authority

### Explicit precedence chain (4 layers)

For **recall** (query expansion in `/ask`):
1. Contact aliases (explicit, user-managed) → deterministic expansion
2. Confirmed person surfaces → deterministic expansion
3. Suggested person surfaces → **NOT used for expansion**; may appear as
   ranking hints in review UI, never in search queries

For **sensitive routing** (persona classification):
1. Contact alias match → `known_contact` (stored `data_responsibility`)
2. Contact name match → `known_contact` (stored `data_responsibility`)
3. Person surface match → **ignored for routing** (unless contact-backed)
4. Kinship/role pattern → `household_implicit` / `unknown_third_party`

Person links enter sensitive routing ONLY when the person is linked to a
contact. The contact's resolved `data_responsibility` is used (whether
auto-defaulted from relationship or explicitly overridden).
`responsibility_explicit` is metadata for the recompute-on-relationship-change
rule, not a routing gate.

### Contact alias vs person surface shadowing

When a person IS linked to a contact, contact aliases shadow identical person
surfaces for routing purposes:
- Contact alias `my daughter` → routes via contact `data_responsibility`
- Person surface `my daughter` → retained for provenance/recall history
- Runtime resolution: contact alias wins, person surface is not double-counted

When a person is NOT linked to a contact:
- Person surfaces are used for recall expansion only
- They never enter the routing pipeline

## Shared Infrastructure

### Surface matching layer

Do NOT duplicate ContactMatcher's normalization and word-boundary logic.

Extract a shared `SurfaceMatcher` / normalization utility that both
`ContactMatcher` and `PersonResolver` use:

- Word-boundary regex construction
- Longest-match-first ordering
- Case-insensitive normalization (`NormalizeAlias` already exists in domain)
- Minimum length filtering

`ContactMatcher` wraps this for contacts + aliases.
`PersonResolver` wraps this for person surfaces.

### Regex scope rule

**No regex for semantic extraction from free-form user text.** The LLM handles
all natural-language understanding: identity extraction, copular detection,
appositive parsing, multi-word names, exclusion of non-identity references.

**Exact matching of already-known surfaces IS allowed via regex.** Word-boundary
regex (`\b{surface}\b`) is used to find occurrences of stored contact names,
aliases, and confirmed person surfaces in text. This is lookup, not extraction.

## Extraction Strategy

### LLM-first extraction (not regex)

Identity extraction uses the **LLM**, not regex patterns.

Why:
- The LLM already understands copulars, appositives, parentheticals,
  multi-word names, punctuation variants, and exclusion cases natively
- Regex pattern families for all these forms are fragile, hard to maintain,
  and will always miss edge cases
- Extraction is **async and post-store** — LLM failure means "nothing learned
  this time," not "wrong vault" or "privacy leak"
- The LLM is already in the pipeline (persona classification) — this is a
  natural extension

The deterministic layer is limited to:
- **Validation**: check that extracted names/roles make sense
- **Conflict detection**: flag contradictions with existing person records
- **Dedup**: match extracted surfaces against existing contacts/people

### Extraction prompt

A dedicated prompt (added to `brain/src/prompts.py`) asks the LLM to extract
identity links from a stored note:

```
Given this note stored by a personal AI user, extract any identity links —
statements that define who someone is in relation to the user.

Return a JSON object:
{
  "identity_links": [
    {
      "name": "the person's proper name",
      "role_phrase": "the relationship phrase (e.g. 'my daughter')",
      "relationship": "child|spouse|parent|sibling|friend|colleague|other",
      "confidence": "high|medium|low",
      "evidence": "the exact sentence or phrase that establishes this"
    }
  ]
}

Rules:
- Only extract IDENTITY statements: "X is my Y", "my Y's name is X",
  "my Y X loves...", "X, my Y, ..."
- Do NOT extract social references: "X met my Y", "X knows my Y",
  "I told X about my Y" — these mention people but do not define identity
- For each link, state your confidence as "high", "medium", or "low":
  - high: the text clearly and unambiguously defines this identity
  - medium: the text probably defines this identity but could be read differently
  - low: this is a guess based on context, not a clear statement
- If no identity links exist in the text, return {"identity_links": []}
```

This single prompt handles all the cases that would require dozens of regex
patterns: copulars, appositives, parentheticals, dash-delimited, multi-word
names, inverse forms, and exclusion patterns. The LLM understands the
difference between "My daughter's name is Emma" and "My daughter's teacher
is Emma" without explicit exclusion rules.

### Confidence mapping to status

| LLM confidence | Initial status | User review? |
|---|---|---|
| `high` | `confirmed` | No (auto-confirmed) |
| `medium` | `suggested` | Yes (surfaced in daily brief) |
| `low` | `suggested` | Yes (surfaced in daily brief) |

No numeric confidence scores. The LLM is not calibrated for numbers, but
it reliably distinguishes "I'm certain" from "I'm guessing." Both medium
and low go to the user — the worst case is an extra review item, never a
silent false merge. This also works across languages without grammar-specific
validation rules.

### Timing: synchronous enqueue + fast async worker

The extraction step is NOT in the hot `/remember` path, but must be fast
enough that `/ask` within a few seconds reliably finds the link.

**Design:**
1. After staging processor stores the item, enqueue the item ID for extraction
   (lightweight — just push to an in-memory queue or KV marker).
2. A fast background worker picks up the queue and runs the LLM extraction.
3. Worker processes within seconds, not minutes.

**Fallback for immediate `/ask`:**
If a user `/remember`s and immediately `/ask`s, and extraction hasn't run yet,
the `/ask` agent has contact alias hints (already implemented). The person link
enriches this over time — it is eventually consistent by design.

This must be explicitly documented in user-facing docs: "Dina learns identity
links from your notes within a few seconds."

### LLM failure behavior

If the LLM is unavailable or returns invalid JSON:
- Nothing is learned. No person records created.
- The item is re-queued for retry (up to 3 attempts with backoff).
- After retries exhausted, the item is skipped. The note is still stored
  in the vault — only the identity extraction is missed.
- This is safe because extraction is additive, not destructive. Missing a
  link just means recall is less rich, not that data is misrouted.

### Where extraction runs

In the Brain process, as a post-publish hook in `staging_processor.py`.
After successful vault publication:
1. Check if the item is note-like (type=note, source=telegram/cli)
2. Enqueue for extraction
3. Worker calls `PersonLinkExtractor.extract(item_text, item_id)`
4. Extractor sends text to LLM with the identity extraction prompt
5. Worker POSTs result to Core via `POST /v1/people/apply-extraction`

### Extractor versioning

All learned data depends on the extraction prompt and LLM model version.
The extractor version is stored on every surface record:
- `extractor_version: "llm-v1"` (prompt version + model family)
- When the prompt improves, the new version can re-process old items
- Old surfaces from superseded versions can be flagged for re-review
- Core can filter/query by extractor version

## Contradiction Handling

Later notes may contradict earlier identity links.

Example:
- First: "My daughter's name is Emma"
- Later: "My daughter's name is Lily"

This must NOT silently overwrite or merge.

Behavior:
1. Detect that `my daughter` already links to person "Emma"
2. The new extraction produces a conflicting link to "Lily"
3. Create the new person "Lily" as `suggested` (not confirmed)
4. Create a review item with kind `person_link_conflict`:
   ```json
   {
     "kind": "person_link_conflict",
     "existing_person": "Emma",
     "new_candidate": "Lily",
     "shared_surface": "my daughter",
     "source_excerpt": "My daughter's name is Lily",
     "suggested_action": "review_and_resolve"
   }
   ```
5. User resolves via confirmation: either the old link was wrong, or there
   are two daughters

## Deletion and Privacy Semantics

### Source item deletion

When a vault item (the source note) is deleted by the user:

1. **Learned person/surface records survive** — they represent learned identity,
   not the note content. Deleting "My daughter's name is Emma" should not make
   Dina forget that Emma is the user's daughter.

2. **`source_excerpt` is cleared** — verbatim evidence text is removed to ensure
   semantic completeness of deletion. The `source_item_id` is retained as a
   tombstone reference (for audit) but the text is gone.

3. **If the person has no remaining confirmed surfaces after excerpt cleanup,
   and no other provenance, downgrade to `suggested`** — it may need re-confirmation.

### Person record deletion

`DELETE /v1/people/{person_id}`:
- Tombstones the person record (soft delete)
- All surfaces become `rejected`
- Rejected surfaces are excluded from future auto-linking
- Audit trail preserved

### Garbage collection for stale suggestions

Suggested-but-never-confirmed people accumulate over time.

Policy:
- Suggested people with no confirmed surfaces and older than 90 days → archive
- Archived people are excluded from resolution but retained for audit
- User can manually review and confirm/delete archived records

## Merge and Split Operations

### Merge: two persons are the same

`POST /v1/people/merge`:
```json
{
  "keep_person_id": "p_123",
  "merge_person_id": "p_456"
}
```

Behavior:
- All surfaces from `p_456` are moved to `p_123`
- `p_456` is tombstoned with a redirect to `p_123`
- If both have `contact_did`, conflict → reject merge unless one is null
- Audit trail records the merge

### Split: detach surface from person

`DELETE /v1/people/{person_id}/surfaces/{id}`:
- Surface is detached and can be re-linked manually
- Or create a new person from the detached surface

### Reject: block future auto-linking

`PUT /v1/people/{person_id}/surfaces/{id}/reject`:
- Surface status → `rejected`
- Future extractors skip this surface for this person
- Prevents re-learning a known-wrong link

## Learning Lifecycle

### States

| Status | Meaning |
|---|---|
| `suggested` | Candidate link, helps recall conservatively, never affects routing |
| `confirmed` | Safe for deterministic recall expansion |
| `rejected` | Blocked from future auto-linking |

### Confidence sources

| Source | Example | Typical initial status |
|---|---|---|
| LLM says `high` | `My daughter's name is Emma` | `confirmed` |
| LLM says `medium` | `Our daughter Emma` (could be a friend's daughter) | `suggested` + review |
| LLM says `low` | Weak contextual inference | `suggested` + review |
| Manual user action | `/person confirm Emma = my daughter` | `confirmed` |

### Promotion/demotion rules

1. LLM confidence `high` → auto `confirmed`
2. LLM confidence `medium` or `low` → `suggested` + review item
3. User confirmation → promotes to `confirmed`
4. User rejection → `rejected`
5. Conflicting later evidence → new `suggested` + conflict review item
6. Source deletion → clear excerpt, downgrade if no other provenance

## Routing Integration Boundary

**This is the most important safety rule in the plan.**

### Rule

Auto-learned person links should **not** affect sensitive routing until
the person is linked to a contact. The contact's resolved `data_responsibility`
(whether auto-defaulted from relationship or explicitly overridden) is used.

| Link state | Recall? | Sensitive routing? |
|---|---|---|
| Suggested, no contact | Conservative only | No |
| Confirmed, no contact | Yes | No |
| Confirmed, contact-backed | Yes | Yes (via contact's resolved `data_responsibility`) |

### Privacy constraint on query-time hints

Person-link resolution should use **local resolver + search expansion**,
not prompt injection of inferred relationships.

A learned mapping like `Emma → my daughter` reveals family relationship.
Unlike explicit contact aliases (user-declared), this relationship is
inferred. Injecting it into an LLM prompt creates a privacy leak risk,
especially for cloud-routed models.

Preferred approach:
1. `PersonResolver` resolves surfaces locally against confirmed person surfaces
2. Search expansion issues parallel vault queries for each confirmed surface
3. Never inject inferred relationship labels into cloud-routed prompts

### Query-time LLM disambiguation for unknown paraphrases

Local resolution works for known stored surfaces, but not for new paraphrases
that were never extracted — e.g. "my girl", "dtr", evolving shorthand.

When local resolution fails to match a person-like phrase in the query:
1. Gather a bounded candidate set: each candidate is a person name + their
   confirmed surface forms (e.g. "Emma: my daughter, my kid")
2. Send to the LLM: the unresolved phrase, the candidate list, and the
   recent 4-5 conversation turns for context
3. Ask the LLM: "which of these known people, if any, does this phrase refer to?"
4. Use the match for **recall expansion only** — NOT for durable truth creation

This is a recall-time disambiguation step. It does not create new person
surfaces or modify stored identity. It just helps the search find the right
vault items for this specific query.

**Exact disambiguation payload:**
```
- unresolved phrase: "my girl"
- candidates: ["Emma (also known as: my daughter, my kid)", "Sarah (also known as: my wife)"]
- recent turns: [last 4-5 user/assistant messages from the current conversation]
```

The recent turns are necessary — without them the LLM cannot resolve
shorthand like "dtr" or "my girl" that depends on conversational context.

**Privacy rules:**
- Disambiguation follows the same privacy/consent posture as extraction:
  it may use cloud LLM if the user has consented to cloud usage.
- Inferred relationship labels (child, spouse, etc.) are NOT included.
  Candidates are presented as name + surface forms only.
- The recent turns are already part of the conversation the LLM is
  processing, so they do not expand the privacy surface beyond what
  the `/ask` agent already sees.
- If cloud is not consented, disambiguation is skipped (local resolution
  only). This degrades recall but preserves privacy.

## Brain Components

### New service: `person_link_extractor.py`

Responsibilities:
- Send stored note content to LLM with identity extraction prompt
- Validate and normalize LLM response
- Detect conflicts with existing person records
- Write results to Core via `POST /v1/people/apply-extraction`
- Track extractor version (prompt version + model) for re-processing
- Handle LLM failure with retry + graceful skip

### New service: `person_resolver.py`

Responsibilities:
- Resolve query surfaces to `person_id` using confirmed person surfaces
- Return ambiguity when multiple persons match a surface
- Expand search terms using all confirmed surfaces for a person
- Respect contact-alias shadowing (contact wins for routing)

### Shared utility: `surface_matcher.py` (refactored from ContactMatcher)

Extract low-level matching from `ContactMatcher`:
- Word-boundary regex construction
- Longest-match-first ordering
- Case-insensitive normalization
- Both `ContactMatcher` and `PersonResolver` use this

## Suggested Phases

### Phase 1: Person memory schema

- `people` and `person_surfaces` tables in Core
- Core CRUD + `apply-extraction` endpoint
- OpenAPI schema + generated types
- No routing behavior change

### Phase 2: LLM-based extractor

- LLM extracts identity links from stored notes via dedicated prompt
- Post-publish hook in staging processor → enqueue for extraction
- Fast async worker processes queue with LLM call
- Note-like items only
- Categorical confidence mapping (high → confirmed, medium/low → suggested + review)
- Extractor version tracking
- LLM failure → retry + graceful skip

### Phase 3: Recall integration

- `PersonResolver` resolves surfaces for `/ask` queries
- Local search expansion using confirmed surfaces
- Contact-alias shadowing applied
- This makes the `Emma` / `my daughter` scenario reliable

### Phase 4: Suggestion and review workflow

- Suggestion surfacing via daily brief / review infrastructure
- Accept/reject path through Telegram or admin UI
- Contradiction detection and conflict review items
- Audit trail / provenance

### Phase 5: Contact promotion and routing integration

- Link confirmed person to a contact
- Promote person surfaces to contact aliases (with dedup)
- Only then does person identity influence responsibility-aware routing
- Contact state remains authoritative for `data_responsibility`

## Test Plan

### Positive extraction tests

- `My daughter's name is Emma` → person with surfaces [Emma, my daughter]
- `Emma is my daughter` → same person, same surfaces
- `Our daughter Emma loves dinosaurs` → same person, surface [Emma, our daughter]
- `My wife Sarah` → person with surfaces [Sarah, my wife]

### Negative extraction tests

- `Emma met my daughter` → no confirmed link
- `My daughter's teacher is Emma` → no confirmed link
- `Sancho knows Emma` → no confirmed link
- `I told Emma about my daughter` → no confirmed link

### Idempotency tests

- Run extraction twice on same note → same person, no duplicates
- Run extraction with same version → no new records
- Run extraction with new version → new records with new version tag

### Contradiction tests

- Store "My daughter's name is Emma", extract → confirmed
- Store "My daughter's name is Lily", extract → conflict review item created
- Original link not silently overwritten

### Recall tests

1. `/remember My daughter's name is Emma`
2. `/remember My daughter loves dinosaurs`
3. `/ask What does Emma like?`
4. Answer includes dinosaurs

### Safety tests

- Suggested links do not affect sensitive routing
- Confirmed non-contact links do not affect routing
- Contact-backed confirmed links affect routing only when `data_responsibility` is set
- Inferred relationships are NOT injected into cloud-routed LLM prompts

### Deletion tests

- Delete source note → `source_excerpt` cleared, person survives
- Delete person → tombstoned, surfaces rejected
- Garbage collection archives 90-day unconfirmed suggestions

### Merge/split tests

- Merge two persons → surfaces combined, tombstone redirect
- Reject surface → excluded from future auto-linking
- Detach surface → can be re-linked manually

## Risk Register

| Risk | Why it matters | Mitigation |
|---|---|---|
| False person merge | Corrupts long-term memory | High-confidence patterns only, conflict detection, review flow |
| LLM extraction failure | No links learned | Retry + graceful skip; extraction is additive, not destructive |
| LLM false positive | Wrong identity link | Only `high` confidence auto-confirms; `medium`/`low` → user review |
| Routing based on weak links | Privacy bug | Hard routing boundary: contact-backed only |
| Opaque storage in KV only | Hard to query/audit | Structured tables with provenance |
| Alias/entity duplication | Confusing identity model | Contact alias shadows person surface for routing |
| Privacy leak via prompt hints | Inferred relationships exposed | Local resolver, minimal prompt hints, no cloud injection |
| Contradictory evidence | Silent overwrite | Conflict detection + review items |
| Stale suggestions | Data accumulation | 90-day TTL, garbage collection |
| Extractor/prompt regression | New prompt version produces wrong links | Versioned extraction, re-processable, old versions queryable |

## Relationship to Contact Aliases

These two features coexist, not compete.

### Contact aliases

- Explicit, user-controlled
- Deterministic
- Globally unique (bidirectional with contact names)
- Ideal for routing and recall immediately
- Authoritative for sensitive routing

### Person/entity links

- Can be learned automatically
- May exist before contact creation
- NOT globally unique (multiple people can share a name)
- Improve recall first
- Influence routing ONLY after explicit confirmation AND contact linkage
- Contact alias shadows identical person surface for routing

### Promotion path

When a confirmed person is linked to a contact:
1. Person surfaces can be promoted to contact aliases (user action)
2. Promoted aliases follow contact alias uniqueness rules
3. Original person surfaces retained for provenance
4. Contact `data_responsibility` becomes authoritative for routing

## Final Recommendation

Implement person/entity linking as a **separate person-memory layer**.

Do not try to fake this with prompt-only reasoning or with a single alias
string on contacts.

For Dina, the right progression is:

1. explicit contact aliases (done)
2. LLM-based person-link extraction (high → auto-confirm, medium/low → user review)
3. user confirmation and promotion to durable truth
4. contact promotion for routing integration

The LLM handles the hard parsing (copulars, appositives, multi-word names,
exclusion of non-identity references) far more reliably than regex. The
deterministic layer handles validation, conflict detection, and dedup.
Extraction failure is safe: nothing learned, no harm done.
