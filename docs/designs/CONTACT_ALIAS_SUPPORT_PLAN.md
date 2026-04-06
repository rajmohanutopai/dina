# Contact Alias Support Plan

## Purpose

This document defines the implementation plan for explicit contact alias
support in Dina.

Examples:

- Contact name: `Emma`
- Aliases: `my daughter`, `my kid`

Expected outcomes:

- routing treats `Emma` and `my daughter` as the same contact
- `/ask What does Emma like?` can recall notes stored as `my daughter ...`
- `/ask What does my daughter like?` can recall notes stored as `Emma ...`

This plan is deliberately about **explicit alias support**, not automatic
entity inference. Automatic person/entity linking is covered separately in
`PERSON_ENTITY_LINKING_PLAN.md`.

## Why This Matters

Without explicit alias support, Dina's memory is fragile whenever the user
switches between:

- proper names
- family-role phrases
- nicknames
- short forms

For a personal AI, that is not edge-case behavior. It is the normal case.

## Current State

### What exists today

| Area | Current state |
|---|---|
| Contact model | `domain.Contact` includes a single `Alias string` field |
| OpenAPI / generated types | `alias` exists in schema and generated types |
| Routing matcher | `ContactMatcher` is name-only |
| SubjectAttributor | Handles kinship phrases (`my daughter`) as `household_implicit` bucket |
| `/ask` retrieval | Agentic search exists, but no alias-aware query expansion |
| UI commands | No alias set/remove command |
| Storage | SQLite does not persist alias — field exists in domain but is never written/read |

### What is missing

| Gap | Why it matters |
|---|---|
| Alias persistence in Core | No durable alias memory |
| Alias CRUD in API | Brain and UI cannot manage aliases |
| Alias-aware routing | Sensitive facts written via role phrase do not bind to contact |
| Alias-aware recall | Querying by name cannot reliably find alias-stored notes |
| Alias conflict handling | Same alias could collide with contact names or other aliases |

## Design Decisions

### 1. Separate ContactAliasStore interface

Aliases are a separate persistence concern with their own table and lifecycle.
Do NOT extend `ContactDirectory` with alias methods.

New interface:

```go
type ContactAliasStore interface {
    AddAlias(ctx context.Context, did, alias string) error
    RemoveAlias(ctx context.Context, did, alias string) error
    ListAliases(ctx context.Context, did string) ([]string, error)
    ResolveAlias(ctx context.Context, alias string) (string, error) // alias → DID
    ListAllAliases(ctx context.Context) (map[string][]string, error) // DID → aliases
    DeleteAllForContact(ctx context.Context, did string) error
}
```

Rationale: avoids inflating ContactDirectory again (3 implementations to update).
AliasStore is implemented once in SQLite. In-memory and test mock get simple
map-based implementations.

### 2. Multi-alias as the real model

Internal canonical shape: `Aliases []string` (or queried from alias store).

The existing single `Alias string` field on `domain.Contact` becomes a
**compatibility-only API projection** (`aliases[0]`), not a competing internal
truth. It is populated at the serialization boundary only.

Internal code never reads `Contact.Alias` — it reads from the alias store or
the `Aliases` field populated by the list path.

### 3. Explicit delete — no FK pragma trust

Contact deletion must explicitly delete aliases in the same transaction.

Do NOT rely on `PRAGMA foreign_keys = ON` from the schema file. Current
`pool.go` opens connections via `sql.DB` which can use multiple connections,
and the pragma is per-connection. The schema file sets it but enforcement
is not guaranteed across the pool.

Implementation: the SQLite alias store and contact directory share the same
`identity.sqlite` database via the Pool. `DeleteContactWithAliases` is a
single method on the SQLite adapter that wraps both deletes in one
`BEGIN/COMMIT` transaction. If either fails, the transaction rolls back and
the contact + aliases remain consistent. The handler calls this single
transactional method, not two separate calls.

For the in-memory adapter: both maps are updated under the same mutex lock.

### 4. Global normalized uniqueness across names and aliases

Uniqueness must span both `contacts.display_name` and
`contact_aliases.normalized_alias`.

**AddAlias** must reject if:
- normalized form matches any contact's `display_name` (case-insensitive)
- normalized form matches any other contact's active alias
- normalized form matches the contact's own `display_name` (redundant)

**Add contact / UpdateName** must also reject if:
- normalized new name matches any existing alias in `contact_aliases`

This is bidirectional: aliases cannot collide with names, AND names cannot
collide with aliases. Without both directions, the global uniqueness
invariant is not real.

Implementation: `ContactDirectory.Add` and `UpdateName` call
`AliasStore.ResolveAlias(normalizedName)` before writing. If it returns a
DID, reject with a conflict error. This requires the handler (or a
coordinating service) to have access to both stores.

### 5. Alias wins over kinship in routing

Explicit precedence rule for `SubjectAttributor`:

1. **Stored contact alias match → `known_contact`** with stored `data_responsibility`
2. **Generic kinship regex → `household_implicit`** only when no stored alias/contact matches

So if "my daughter" is a stored alias for Emma (child/household):
- `SubjectAttributor` matches it as `known_contact` (Emma, household)
- NOT as `household_implicit` (generic kinship)

This means stored responsibility always wins over inferred responsibility.

Implementation: `ContactMatcher` builds patterns for both names AND aliases.
`SubjectAttributor._find_all_subject_refs()` checks ContactMatcher BEFORE
kinship patterns. If a span is already claimed by a contact match, the kinship
pattern skips it.

### 6. Recall: prompt hinting first, bounded fan-out second

Phase A (this plan):
- Pass alias mappings into `/ask` agent context via system prompt
- Agent sees: `Emma (aliases: "my daughter", "my kid")`
- Agent uses these when formulating search queries

Phase B (future):
- Bounded fan-out: search canonical name first, if weak/no results, search
  1–2 aliases individually
- Merge/rerank results
- NOT a single giant OR-expanded FTS query

## Data Model

### New table: `contact_aliases`

| Column | Type | Purpose |
|---|---|---|
| `contact_did` | TEXT NOT NULL | FK to `contacts.did` |
| `alias` | TEXT NOT NULL | Original user-facing alias text |
| `normalized_alias` | TEXT NOT NULL | Lowercased, trimmed lookup form |
| `source` | TEXT NOT NULL DEFAULT 'manual' | `manual`, `imported`, later `learned` |
| `created_at` | INTEGER NOT NULL | Unix timestamp |
| PRIMARY KEY | `(contact_did, normalized_alias)` | Composite, WITHOUT ROWID |

Indexes:
- `CREATE UNIQUE INDEX idx_alias_normalized ON contact_aliases(normalized_alias)`
  — enforces global uniqueness

The global uniqueness across names is enforced at the application layer
(AddAlias checks `contacts.display_name` before inserting).

### Alias validation rules

Reject aliases that are:
- empty or whitespace-only
- shorter than 2 characters
- pronouns: he, she, they, him, her, them, his, hers, their, theirs
- identical (normalized) to the contact's own display_name
- already claimed by another contact (name or alias)

### Domain model changes

```go
type Contact struct {
    // ... existing fields ...
    Aliases []string `json:"aliases,omitempty"` // populated from alias store
}
```

The existing `Alias string` field remains for backward-compatible API output.
It is populated from `Aliases[0]` at serialization time in the handler, never
read internally.

## API Design

### Contact list response

`GET /v1/contacts` returns contacts with `aliases: []` populated from the
alias store join.

### New endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/contacts/{did}/aliases` | Add alias |
| DELETE | `/v1/contacts/{did}/aliases/{alias}` | Remove alias |
| GET | `/v1/contacts/{did}/aliases` | List aliases for contact |

Request shape for add:
```json
{"alias": "my daughter"}
```

Error responses:
- 409 Conflict: alias already belongs to another contact
- 400 Bad Request: alias too short, pronoun, or matches own name

### OpenAPI schema

Add to `schemas.yaml`:
- `aliases: string[]` on Contact
- Alias endpoint schemas

Regenerate via `make generate`.

## Implementation

### Phase 1: Core — Storage + API

**1A. Port interface** — `core/internal/port/identity.go`
- New `ContactAliasStore` interface (6 methods)

**1B. Migration v9** — `core/internal/adapter/sqlite/pool.go`
- CREATE TABLE IF NOT EXISTS contact_aliases
- CREATE UNIQUE INDEX idx_alias_normalized

**1C. SQLite alias store** — `core/internal/adapter/sqlite/contact_aliases.go` (new file)
- Implements `ContactAliasStore`
- AddAlias: validate, check name collision, INSERT
- RemoveAlias: DELETE by (did, normalized_alias)
- ListAliases: SELECT WHERE contact_did = ?
- ResolveAlias: SELECT contact_did WHERE normalized_alias = ?
- ListAllAliases: SELECT all, group by DID
- DeleteAllForContact: DELETE WHERE contact_did = ?

**1D. In-memory alias store** — `core/internal/adapter/identity/contact_aliases.go` (new file)
- Map-based implementation for CLI/tests

**1E. Handler** — `core/internal/handler/contact.go`
- New alias endpoints (add, remove, list)
- HandleAddContact: reject if name collides with existing alias (bidirectional uniqueness)
- HandleUpdateContact: reject name change if new name collides with existing alias
- HandleDeleteContact: call transactional delete (aliases + contact in one tx)
- HandleListContacts: populate Contact.Aliases from alias store

**1F. OpenAPI + codegen** — `api/components/schemas.yaml` → `make generate`

### Phase 2: Routing — ContactMatcher + SubjectAttributor

**2A. ContactMatcher** — `brain/src/service/contact_matcher.py`
- Build patterns from names AND aliases
- Both map to the same DID/contact record
- Longest-match-first across combined set
- Dedup: if name and alias match overlapping spans, emit one match

**2B. SubjectAttributor** — `brain/src/service/subject_attributor.py`
- ContactMatcher runs BEFORE kinship patterns
- Spans already claimed by a contact match are skipped by kinship regex
- Alias match → known_contact (with stored responsibility)
- Unmatched kinship phrase → household_implicit (fallback)

### Phase 3: Brain client + UI

**3A. Core HTTP adapter** — `brain/src/adapter/core_http.py`
- `add_alias(did, alias)`, `remove_alias(did, alias)`, `list_aliases(did)`

**3B. User commands** — `brain/src/service/user_commands.py`
- `add_alias(name, alias)` — resolves name→DID, calls Core
- `remove_alias(name, alias)`

**3C. Telegram** — `brain/src/service/telegram.py`
- `/contact alias Name: my daughter` — add alias (multi-word name + alias)
- `/contact unalias Name: my daughter` — remove alias
- `/contact list` — show aliases when present

**3D. Recall (Phase A)** — `brain/src/service/vault_context.py`
- Inject alias mappings into the agent system prompt context
- When contact is detected in query, include aliases in the search hints

### Phase 4: Tests

**4A. Core tests**
- Migration creates table + index
- Add/remove/list alias round-trips
- Conflict detection: alias already claimed by another contact
- Conflict detection: alias matches a contact display_name
- Conflict detection: new contact name matches an existing alias (bidirectional)
- Conflict detection: name update to a name that matches an existing alias
- Validation: reject pronouns, single-char, own-name
- Delete atomicity: deleting contact removes all aliases in one transaction
- Delete atomicity: if contact delete fails, aliases are not orphaned

**4B. ContactMatcher tests**
- Name match works
- Alias match works, maps to same DID
- Overlapping name/alias dedup
- Longest-match-first across combined set

**4C. SubjectAttributor tests**
- Alias match → known_contact (not household_implicit)
- Unmatched kinship → household_implicit (fallback)
- Mixed: alias "my daughter" → known_contact, "my colleague" → unknown_third_party

**4D. Telegram tests**
- Multi-word name + multi-word alias parsing
- Alias display in /contact list

## Verification

1. `cd core && go build -tags fts5 ./cmd/dina-core/` + `go test ./...`
2. `make generate` + `make check-generate`
3. `cd brain && pytest tests/`
4. Docker rebuild
5. `/contact add Emma: did:plc:...` → `/contact relationship Emma child`
6. `/contact alias Emma: my daughter`
7. `/contact alias Emma: my kid`
8. `/contact list` → shows Emma with aliases
9. `/remember My daughter has a peanut allergy` → health (alias → Emma → household)
10. `/remember My daughter loves dinosaurs` → general (no health signal)
11. `/ask What does Emma like?` → recalls dinosaur note (alias hint in context)
12. Conflict: `/contact alias Sancho: my daughter` → 409 (already Emma's alias)

## What This Does Not Solve

- Automatic linking from "My daughter's name is Emma"
- Automatic learning of new identities from notes
- Multi-surface canonical identity when no contact exists yet

That requires the separate person/entity-link layer.
