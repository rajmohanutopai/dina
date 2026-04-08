# Knowledge Graph — Personal Knowledge Layer for Dina

## Problem

Dina stores memories as flat text blobs in encrypted vault files. Semantic search finds items by keyword/embedding similarity, but there's no structural understanding of what's inside them.

When a user stores:
```
/remember Kai recommended Clerk over Auth0 for auth — better pricing and DX
/remember Sprint deadline is Friday: auth integration with Clerk
/remember Kai is blocked on Clerk SDK refresh token bug
/remember Leo needs help with the auth middleware tests
```

These become 4 independent rows. Nothing links them. "Why did we pick Clerk?" works (semantic search finds "Clerk" in 3 items). But "What's at risk for Friday?" fails — there's no connection between the deadline, the blocker, and the unfinished work.

Real-life memory is a **graph**, not a list. Facts relate to other facts. Decisions have reasons. People own work. Events supersede earlier events. A personal AI needs this structure to answer questions that require traversal, not just retrieval.

## Design

### Core Idea

Every vault item, on ingestion, is parsed by the LLM into **entities** and **relationships** (triples). These form a personal knowledge graph stored alongside the vault. The vault item remains the source of truth — the graph is a derived index.

On recall (`/ask`), the graph is traversed to expand context beyond what text search alone would find. The LLM receives both search results AND graph context.

### Controlled Vocabulary + Freeform Labels

The graph uses **canonical edge families** — a controlled vocabulary of ~20-30 relationship categories — plus freeform labels. The LLM maps to canonical families at extraction time, and can add a freeform label for specificity.

This is necessary because supersession detection, confidence decay, and traversal all depend on recognizing that `deadline`, `due_on`, and `must_finish_by` are semantically the same edge. Without canonical families, a freely-invented predicate like `must_finish_by` would never match `deadline` for supersession.

**Canonical edge families** (starter set, extensible):

| Family | Examples | Decay half-life |
|--------|---------|-----------------|
| `identity` | is, named, known_as | 10 years |
| `relationship` | child_of, spouse_of, works_for, friend_of | 5 years |
| `attribute` | allergic_to, born_in, speaks | 10 years |
| `preference` | likes, prefers, favorite | 1 year |
| `takes_medication` | takes, prescribed, dosage | 6 months |
| `has_appointment` | appointment, scheduled_for, booked | 1 month |
| `deadline` | due_on, deadline, must_finish_by | 1 month |
| `status` | blocked_on, working_on, completed | 1 month |
| `owns` | owns, purchased, has | 2 years |
| `financial` | costs, earns, budgeted, owes | 6 months |
| `recommended` | recommended, chose, selected, picked | 2 years |
| `location` | lives_at, located_in, works_at | 1 year |
| `event` | attended, happened_at, occurred | permanent |
| `opinion` | thinks, believes, concerned_about | 1 year |

The LLM extracts: `{"family": "deadline", "label": "sprint must be done by", "subject": "auth", "object": "Friday"}`. The `family` is canonical (used for supersession, decay). The `label` is freeform (preserved for display).

Entity types remain freeform — the LLM decides if something is a person, technology, project, etc. No code changes needed per domain.

### Data Model

**Triples** — stored inside per-persona vault files (same encryption as vault items):

```sql
-- Lives in each per-persona .sqlite file (health.sqlite, work.sqlite, etc.)
-- NOT in identity.sqlite — triples contain sensitive facts that respect persona encryption.
CREATE TABLE kg_triples (
    id             TEXT PRIMARY KEY,  -- UUID
    subject        TEXT NOT NULL,     -- entity ID (from kg_entities in identity.sqlite)
    edge_family    TEXT NOT NULL,     -- canonical family: "deadline", "takes_medication", etc.
    edge_label     TEXT,              -- freeform label: "sprint must be done by" (display only)
    object         TEXT NOT NULL,     -- entity ID or literal value
    confidence     TEXT DEFAULT 'high',  -- high | medium | low (at extraction time)
    state          TEXT DEFAULT 'active', -- active | superseded | retracted
    valid_from     TEXT,              -- ISO timestamp: when this fact became true
    valid_until    TEXT,              -- ISO timestamp: when no longer active (NULL = current)
    last_confirmed TEXT,              -- ISO timestamp: latest reconfirmation (NULL = never)
    created_at     TEXT NOT NULL      -- extraction timestamp
);

CREATE INDEX idx_kgt_subject ON kg_triples(subject);
CREATE INDEX idx_kgt_object ON kg_triples(object);
CREATE INDEX idx_kgt_family ON kg_triples(edge_family);
CREATE INDEX idx_kgt_active ON kg_triples(state) WHERE state = 'active';
```

**Evidence** — links triples to the vault items that support them (many-to-many):

```sql
-- Lives in the same per-persona .sqlite file as the triples.
CREATE TABLE kg_evidence (
    id          TEXT PRIMARY KEY,
    triple_id   TEXT NOT NULL REFERENCES kg_triples(id),
    source_item TEXT NOT NULL,     -- vault_item ID that supports this triple
    role        TEXT NOT NULL,     -- 'origin' | 'reconfirmation' | 'supporting'
    source_type TEXT DEFAULT 'user',  -- user | contact | system | unverified
    created_at  TEXT NOT NULL
);

CREATE INDEX idx_kge_triple ON kg_evidence(triple_id);
CREATE INDEX idx_kge_source ON kg_evidence(source_item);
```

One triple can have many evidence links (3 separate notes all say "Dad takes Metformin").
Deleting a vault item → deletes its evidence rows → if a triple has zero remaining evidence → auto-delete (derived fact has no source of truth).
Reconfirmation adds a new evidence row with `role = 'reconfirmation'` and updates `last_confirmed`.

**Supersession links** — many-to-many:

```sql
-- Lives in the same per-persona .sqlite file.
CREATE TABLE kg_supersessions (
    id            TEXT PRIMARY KEY,
    old_triple    TEXT NOT NULL REFERENCES kg_triples(id),
    new_triple    TEXT NOT NULL REFERENCES kg_triples(id),
    reason        TEXT,              -- LLM's explanation: "deadline moved", "manager changed"
    source_item   TEXT NOT NULL,     -- vault_item that triggered the supersession
    created_at    TEXT NOT NULL
);

CREATE INDEX idx_kgs_old ON kg_supersessions(old_triple);
CREATE INDEX idx_kgs_new ON kg_supersessions(new_triple);
```

This is many-to-many because:

**One new fact can supersede many old facts:**
```
"We're cancelling the auth sprint"
  supersedes → (auth-sprint, deadline, "Tuesday April 15")
  supersedes → (Kai, blocked_on, "Clerk SDK bug")
  supersedes → (Leo, assigned_to, "auth middleware tests")
  supersedes → (auth-sprint, status, "in progress")
```

**One old fact can be superseded by multiple new facts:**
```
"The team is splitting into two pods"
  old: (team, working_on, "auth + billing monolith")
  superseded by → (pod-A, working_on, "auth")
  superseded by → (pod-B, working_on, "billing")
```

**Query patterns:**
- "Who is my manager?" → `valid_until IS NULL` → Steve
- "Who was my manager before Steve?" → `kg_supersessions WHERE new_triple = Steve's triple` → Jay's triple
- "What did cancelling the sprint affect?" → `kg_supersessions WHERE source_item = cancellation_item` → all 4 superseded triples
- "What was the original deadline?" → walk the chain: `old_triple` → `old_triple` → until no more predecessors
- "How many times did the deadline change?" → count chain length for `(auth-sprint, deadline, *)` supersession entries

**Entity registry** — opaque IDs in identity.sqlite, display labels per-persona:

Entity NAMES can be sensitive ("Metformin", "divorce lawyer", "layoff plan"). Storing
them in always-open identity.sqlite would leak information from locked personas. So the
global registry stores only opaque IDs. Display names and aliases live inside the
persona-encrypted vaults alongside their triples.

```sql
-- Lives in identity.sqlite — opaque IDs only, no sensitive names.
-- Enables cross-persona entity deduplication without leaking what the entity IS.
CREATE TABLE kg_entities (
    id          TEXT PRIMARY KEY,  -- stable UUID (opaque)
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

```sql
-- Lives in each per-persona .sqlite file — display names are persona-scoped.
-- "Metformin" appears only in the health vault's entity labels.
-- "Kai" might appear in both work and general with the same entity ID.
CREATE TABLE kg_entity_labels (
    entity_id   TEXT NOT NULL,     -- references kg_entities.id in identity.sqlite
    canonical   TEXT NOT NULL,     -- display name: "Kai Nakamura", "Metformin"
    entity_type TEXT NOT NULL,     -- person | technology | medication | project | ...
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(entity_id)              -- one canonical label per entity per persona
);

CREATE TABLE kg_entity_aliases (
    entity_id   TEXT NOT NULL,     -- references kg_entities.id
    alias       TEXT NOT NULL,     -- "Kai", "the backend guy", "K"
    confidence  TEXT DEFAULT 'high',
    created_at  TEXT NOT NULL,
    UNIQUE(alias, entity_id)
);

CREATE INDEX idx_kgel_entity ON kg_entity_labels(entity_id);
CREATE INDEX idx_kgea_alias ON kg_entity_aliases(alias);
CREATE INDEX idx_kgea_entity ON kg_entity_aliases(entity_id);
```

**Storage split:**
- `kg_entities` → `identity.sqlite` (opaque UUIDs only — no names, types, or aliases)
- `kg_entity_labels` + `kg_entity_aliases` + `kg_triples` + `kg_evidence` + `kg_supersessions` → per-persona `.sqlite` files (encrypted)

This means:
- Locked health vault → "Metformin" is invisible (label is encrypted). The opaque UUID exists in identity.sqlite but reveals nothing.
- Cross-persona deduplication: if "Kai" appears in work AND general, both personas have a `kg_entity_labels` row pointing to the same UUID. The UUID links them without leaking the name across persona boundaries.
- Entity resolution at ingestion time: Brain resolves aliases by scanning `kg_entity_aliases` in unlocked personas. If the target persona is locked, resolution is deferred.

### Temporal Consistency — Supersession Model

This is critical. Facts change. Deadlines move. Decisions get reversed. Managers change. Medications get adjusted.

**Supersession is decided by the LLM at ingestion time, not by string matching.**

When the user stores a new fact, the extraction pipeline:
1. Extracts entities and relationships from the new item
2. For each new triple, queries existing triples involving the same entities
3. Asks the LLM: "Does this new fact update, contradict, or supersede any existing fact?"
4. If yes: creates a bidirectional supersession link

This happens **at the moment the user tells Dina**, when the context is freshest. A future search doesn't need to figure out supersession — it's already recorded.

**Example: Manager change (1:1 supersession)**

```
January — user stores: "Jay became my manager"
  Triple T1: (my-manager, is, Jay)

April — user stores: "Steve is my new manager"
  LLM sees existing: T1 (my-manager, is, Jay)
  LLM decides: supersession
  
  T1 updated: valid_until = 2026-04-07
  T2 created: (my-manager, is, Steve), valid_from = 2026-04-07
  kg_supersessions: (old=T1, new=T2, reason="manager changed")
```

**Example: Deadline moved (1:1 supersession)**

```
Monday — "Sprint deadline is Friday"
  Triple TA: (auth-sprint, deadline, "Friday April 11")

Wednesday — "Deadline moved to Tuesday — Kai's blocker took longer"  
  TA updated: valid_until = 2026-04-09
  TB created: (auth-sprint, deadline, "Tuesday April 15")
  kg_supersessions: (old=TA, new=TB, reason="Kai's blocker took longer")
```

**Example: Sprint cancelled (1:many — one fact supersedes many)**

```
Thursday — "We're cancelling the auth sprint, pivoting to billing"
  LLM sees 4 active triples related to auth-sprint
  All 4 get valid_until set
  TC created: (auth-sprint, status, "cancelled")
  kg_supersessions:
    (old=TB deadline, new=TC, reason="sprint cancelled")
    (old=T3 Kai-blocked, new=TC, reason="sprint cancelled")
    (old=T4 Leo-assigned, new=TC, reason="sprint cancelled")
    (old=T5 sprint-in-progress, new=TC, reason="sprint cancelled")
```

**Example: Team split (many:1 — one fact superseded by many)**

```
"The team is splitting — Pod A does auth, Pod B does billing"
  Old: T6 (team, working_on, "auth + billing")
  T6 gets valid_until set
  T7: (pod-A, working_on, "auth")
  T8: (pod-B, working_on, "billing")
  kg_supersessions:
    (old=T6, new=T7, reason="team split into pods")
    (old=T6, new=T8, reason="team split into pods")
```

**Why the LLM decides, not string matching:**

The predicate for "David is picking up Carlos" might be `pickup_by`. The predicate for "Rosa is doing the pickup instead" might be `handled_by` or `picking_up`. String matching fails. But the LLM understands that both are about who picks up Carlos, and the second replaces the first.

The supersession prompt:

```
New fact extracted: (Carlos, handled_by, Rosa)
Source text: "Rosa is doing the pickup instead"

Existing active facts about Carlos:
  [T1] (Carlos, pickup_by, David) — from "David is picking up Carlos"
  [T2] (Carlos, has_appointment, "dentist 4 PM") — from "Carlos has dentist at 4"

Does the new fact SUPERSEDE any existing fact? 
Return the ID of the superseded fact, or "none".
```

LLM returns: `T1` — because "instead" signals replacement.

**Query semantics:**
- "Who's picking up Carlos?" → `valid_until IS NULL` → Rosa
- "Who was originally picking up?" → follow `supersedes` chain → David
- "What's the deadline?" → `valid_until IS NULL` → Tuesday April 15
- "What was the original deadline?" → follow chain → Friday April 11
- "How many times did the deadline change?" → chain length → 2
- "Show me the history of manager changes" → walk the full chain

**Supersession is bidirectional:**
- Old triple points forward: `superseded_by → new triple`
- New triple points backward: `supersedes → old triple`
- This forms a linked list — walk forward for "what replaced this?" and backward for "what did this replace?"

### Negation / Retraction

Retraction is distinct from both supersession and deletion:

| Operation | What it means | Example | Old triple state |
|-----------|---------------|---------|-----------------|
| **Supersession** | Replaced by a different fact | "Steve is my manager" replaces Jay | `state = superseded`, link to replacement |
| **Retraction** | No longer true, nothing replaces it | "Kai is not blocked anymore" | `state = retracted`, no replacement |
| **Deletion** | Was never true, or user wants it forgotten | "Forget that Carlos is allergic to peanuts" (was wrong) | `state = deleted`, removed from all queries including history |

Supersession: the world changed (new manager). Retraction: a condition ended (blocker resolved). Deletion: the record was wrong or unwanted (mistake, privacy).

**At ingestion time**, the LLM detects retraction the same way it detects supersession:

```
New text: "Kai resolved the Clerk SDK bug, no longer blocked"

Existing active triples for Kai:
  [T3] (Kai, blocked_on, "Clerk SDK refresh token bug")
  [T7] (Kai, works_on, auth)

LLM prompt: Does this new fact SUPERSEDE, RETRACT, or leave unchanged each existing fact?
  T3: RETRACT — "no longer blocked" means the condition ended, not replaced
  T7: UNCHANGED — Kai still works on auth
```

T3 gets `state = retracted`, `valid_until = now`. No supersession link is created — there's nothing that replaced it.

**At recall time**, retracted triples behave like superseded ones for current-state queries (filtered out by `state = 'active'`). But for history queries they behave differently:

- "What blocked Kai?" → retracted triples are included (it happened, it's history)
- "Is Kai blocked on anything?" → retracted triples excluded (no longer true)
- "What issues did we have with Clerk?" → retracted blocker IS relevant (it happened and was resolved)

### Confidence Decay

A fact's reliability decreases over time if it's never reconfirmed. "Dad takes Metformin 1000mg twice daily" stored 2 years ago, never mentioned again, is dangerous to return with the same confidence as a fact stored last week.

**Confidence has two dimensions:**

1. **Extraction confidence** — how sure was the LLM about the extraction? Set once at ingestion. Stored in the `confidence` field (high/medium/low).
2. **Temporal reliability** — how likely is this fact to still be true? Decreases over time. NOT stored — computed at query time.

**Why temporal reliability is computed, not stored:**

If you stored a decay value, you'd need a background job to update every triple periodically. That's expensive and fragile. Instead, compute it at query time:

```
temporal_reliability(triple) =
    if triple.state != 'active': return 0
    age_days = (now - triple.created_at).days
    
    # Facts about stable things decay slowly
    # Half-life is defined per canonical edge family (from the table above)
    FAMILY_HALF_LIFE = {
        'identity': 3650,        # 10 years — born_in, named, etc.
        'relationship': 1825,    # 5 years — child_of, spouse_of, etc.
        'attribute': 3650,       # 10 years — allergic_to, speaks, etc.
        'preference': 365,       # 1 year — likes, prefers, favorite
        'takes_medication': 180, # 6 months — dosages change
        'has_appointment': 30,   # 1 month — transient
        'deadline': 30,          # 1 month — transient
        'status': 30,            # 1 month — blocked, working_on, etc.
        'owns': 730,             # 2 years
        'financial': 180,        # 6 months — costs, budgets change
        'recommended': 730,      # 2 years — decisions persist
        'location': 365,         # 1 year — people move
        'event': 36500,          # permanent — events happened
        'opinion': 365,          # 1 year — opinions drift
    }
    half_life = FAMILY_HALF_LIFE.get(triple.edge_family, 365)
    
    return extraction_confidence * (0.5 ** (age_days / half_life))
```

The LLM doesn't need this formula — it receives the age and extraction confidence alongside each triple and reasons about reliability naturally. But the formula determines **ranking**: when multiple triples compete for the same query, older unconfirmed facts rank lower.

**Reconfirmation resets the clock:**

When the user stores a new item that confirms an existing fact (not supersedes, not retracts — just reaffirms), the triple's `created_at` is NOT updated (that's the extraction timestamp), but the `last_confirmed` column (already in the `kg_triples` schema) records the latest confirmation.

`temporal_reliability` uses `COALESCE(last_confirmed, created_at)` as the anchor. A 2-year-old medication triple that was reconfirmed last week has full reliability.

**The LLM detects reconfirmation at ingestion time:**

```
New text: "Picked up Dad's Metformin refill from CVS"

Existing triples for Dad:
  [T1] (Dad, takes, "Metformin 500mg once daily") — created 6 months ago

LLM: Does this SUPERSEDE, RETRACT, RECONFIRM, or leave unchanged?
  T1: RECONFIRM — refill implies the medication is still active
```

T1 gets `last_confirmed = now`. No new triple created. The fact is refreshed.

**Source authority** lives on evidence rows, not on the triple, because a single triple can have mixed support:

```
Triple: (API, status, "ready")
  Evidence 1: source_type = 'contact'  (Kai said it)
  Evidence 2: source_type = 'system'   (CI pipeline confirmed it)
  Evidence 3: source_type = 'user'     (I verified it myself)
```

At query time, a triple's effective authority is the **highest** among its evidence rows:
- `user`: 1.0 (highest — the user said it)
- `system`: 0.9 (machine-confirmed, e.g., CI, bank statement)
- `contact`: 0.7 (someone else said it — might be wrong)
- `unverified`: 0.4 (forwarded text, third-party content)

A triple with only `contact` evidence scores 0.7. Add a `user` evidence row (reconfirmation) → score jumps to 1.0. This is why source_type belongs on evidence, not the triple.

### The Operations on Truth

A personal AI must handle two categories of operations on facts:

**Four ingestion-time operations** — detected by the LLM when a new item is stored, when context is richest:

| # | Operation | What it means | Triple effect |
|---|-----------|---------------|---------------|
| 1 | **Store** | New fact enters the world | `state = active`, evidence row created |
| 2 | **Supersede** | Replaced by a different fact | old: `state = superseded`, link in `kg_supersessions` |
| 3 | **Retract** | No longer true, nothing replaces it | `state = retracted`, no replacement link |
| 4 | **Reconfirm** | Still true, refresh reliability | `last_confirmed = now`, new evidence row with `role = 'reconfirmation'` |

These are semantic operations — the LLM interprets meaning. "Steve is my new manager" → supersede. "Kai is not blocked anymore" → retract. "Picked up Dad's Metformin refill" → reconfirm. They must happen at ingestion time because deferring to query time loses the context that makes them detectable.

**One control-plane operation** — triggered by user action or policy, not by semantic interpretation:

| # | Operation | What it means | Triple effect |
|---|-----------|---------------|---------------|
| 5 | **Delete** | Was never true, or user wants it forgotten | Triple removed. All evidence rows removed. Supersession links cleaned up. |

Delete is NOT an ingestion-time operation. The LLM does not decide to delete — the user does ("forget this") or the system does (vault item deleted → evidence removed → orphaned triple auto-deleted).

**Evidence-driven lifecycle:**

```
Vault item created → extraction → triples + evidence rows created
Vault item reconfirmed → new evidence row, last_confirmed updated
Vault item deleted → evidence rows deleted → if triple has 0 evidence → auto-delete
User says "forget X" → entity + triples + evidence all deleted (cascading)
```

The evidence table is what makes this correct. A triple with 3 supporting vault items survives deletion of any one of them. A triple with 1 evidence row that gets deleted → auto-deleted.

**Three kinds of removal — each has different semantics:**

| Kind | Trigger | What happens | History? |
|------|---------|-------------|----------|
| **Retract** | LLM: "this fact ended" | `state = retracted`, triple stays | Yes — history queries find it |
| **Auto-delete** | Zero evidence remaining | Triple + supersession links removed | No — source of truth is gone |
| **User forget** | `/graph forget Entity` | Entity + labels + aliases + triples + evidence hard-deleted | No — explicit erasure |

Retraction preserves history because the source vault items still exist. Auto-delete removes history because the sources are gone (a derived index shouldn't outlive its sources). User forget is unconditional erasure.

### Extraction Pipeline

**Where it runs:** Brain staging pipeline, after classification, before vault resolve.

**When it runs:** On every item. Even "buy milk" produces useful triples: `(user, needs_to_buy, milk)`, `(milk, category, grocery)`. Accuracy is more important than cost — missing an extraction means missing a connection later. The LLM returns an empty list for items with no extractable relationships, which is cheap.

**Extraction prompt:**

```
Given this text stored by the user, extract entities and relationships.

Text: "Kai recommended Clerk over Auth0 for auth — better pricing and DX"

Return JSON:
{
  "entities": [
    {"name": "Kai", "type": "person", "aliases": []},
    {"name": "Clerk", "type": "technology", "aliases": []},
    {"name": "Auth0", "type": "technology", "aliases": []},
    {"name": "auth", "type": "feature", "aliases": ["authentication"]}
  ],
  "relationships": [
    {"subject": "Kai", "family": "recommended", "label": "recommended for auth", "object": "Clerk", "confidence": "high"},
    {"subject": "Clerk", "family": "recommended", "label": "chosen over", "object": "Auth0", "confidence": "high"},
    {"subject": "Clerk", "family": "attribute", "label": "used for", "object": "auth", "confidence": "high"}
  ],
  "properties": [
    {"entity": "Clerk", "key": "advantage", "value": "better pricing and developer experience"}
  ]
}
```

**Entity resolution:** Before inserting, check `kg_entity_aliases` for matches. "Kai" might already exist as entity `kai-nakamura-uuid`. If so, link to existing entity. If not, create new.

**Cost control:** Use the lite model (gemini-flash-lite) for extraction — it's structural, not reasoning. ~$0.001 per extraction.

### Graph-Expanded Recall

When the user asks `/ask Why did we pick Clerk?`:

**Current flow:**
1. Semantic search → finds 3 items mentioning "Clerk"
2. LLM reasons over those items → answers

**Graph-expanded flow:**
1. Semantic search → finds 3 items mentioning "Clerk"
2. Entity lookup → resolves "Clerk" to entity `clerk-uuid`
3. Graph traversal (1-2 hops):
   - `Clerk ← recommended ← Kai` (who recommended it)
   - `Clerk → chosen_over → Auth0` (what it replaced)
   - `Clerk → used_for → auth` (what project)
   - `auth → deadline → "Friday April 11"` (when it's due)
   - `Kai → blocked_on → "Clerk SDK refresh token bug"` (current issues)
4. LLM receives search results + graph context → much richer answer

**The graph doesn't replace search — it expands it.** Search finds the starting items. The graph finds the connected facts that search alone would miss.

### Traversal Depth

- **1 hop:** Direct relationships of matched entities. Fast. Always run.
- **2 hops:** Relationships of relationships. "Kai recommended Clerk" → "Kai is blocked on SDK bug" (Kai → blocked_on → bug, which relates to Clerk). Run for complex queries.
- **No unbounded traversal.** Cap at 2 hops, max 50 triples returned. The LLM doesn't need the whole graph — it needs the relevant neighborhood.

### Persona Isolation

The knowledge graph enforces persona encryption boundaries:

- **Entities** (`kg_entities`) live in `identity.sqlite` as opaque UUIDs only — no names, types, or aliases. Not sensitive.
- **Triples** (`kg_triples`, `kg_evidence`, `kg_supersessions`) live inside per-persona encrypted `.sqlite` files — same encryption as vault items.
- When the health vault is locked, health triples are cryptographically inaccessible. No health-derived facts leak into the always-open identity database.
- Graph traversal for a work query does NOT cross into health triples (different SQLite files, different DEKs).
- Exception: the LLM can request cross-persona traversal for the owner when all involved personas are unlocked (same rules as vault cross-persona queries).

### Relationship with Existing Systems

**Person entity linking (already built):**
The `people` and `person_surfaces` tables in the current code are the first version of this. They extract person names and link them to contacts. The knowledge graph generalizes this to ALL entity types, not just people.

**Migration path:** `people` → `kg_entities` (opaque IDs only), `person_surfaces` → `kg_entity_labels` + `kg_entity_aliases` (per-persona). The existing person extraction becomes a specialization of the general extraction pipeline.

**Contact matcher / subject attributor:**
These already resolve "Kai" → contact. The knowledge graph uses the same resolution for all entities, not just contacts.

**Sensitive signals:**
Health/finance keyword detection already exists. The knowledge graph would carry domain tags on entities (`Clerk` is technology/work, `Metformin` is medication/health), making routing more precise.

## Examples

### Tech Lead (your scenario)

```
Store: "Kai recommended Clerk over Auth0 for auth — better pricing and DX"
Store: "Sprint deadline is Friday: auth integration with Clerk"
Store: "Kai is blocked on Clerk SDK refresh token bug"
Store: "Leo needs help with the auth middleware tests"
Store: "Deadline moved to Tuesday — Kai's blocker took longer than expected"
```

Graph after all 5 stores:

```
Kai ─── recommended ──→ Clerk
Kai ─── works_on ──────→ auth
Kai ─── blocked_on ────→ "Clerk SDK refresh token bug"  [superseded]
Clerk ─ chosen_over ──→ Auth0
Clerk ─ used_for ─────→ auth
auth ── deadline ─────→ "Friday April 11"  [superseded]
auth ── deadline ─────→ "Tuesday April 15"  [current]
Leo ─── needs_help ───→ "auth middleware tests"
Leo ─── works_on ─────→ auth

Supersession links (kg_supersessions):
  "Deadline moved to Tuesday" supersedes "Friday April 11"
    reason: "Kai's blocker took longer than expected"
  "Kai resolved the SDK bug" supersedes "Kai blocked on SDK bug"
```

Query: "Are we on track for the auth deadline?"
→ Graph: current deadline is Tuesday (Friday was superseded, link preserved), Kai's block was resolved (superseded), Leo still needs help
→ Answer: "The auth deadline was moved from Friday to Tuesday. Kai's Clerk SDK blocker is resolved. Leo still needs help with middleware tests — that might be the remaining risk."

Query: "What was the original deadline and why did it change?"
→ Graph: follow supersession chain backward from current deadline
→ Answer: "Originally Friday April 11. Moved to Tuesday April 15 because Kai's blocker on the Clerk SDK refresh token bug took longer than expected."

### Parent (existing archetype)

```
Store: "Carlos has a dentist appointment Thursday at 4 PM"
Store: "David is picking up Carlos from the dentist"
Store: "David can't do pickup, Rosa is doing it instead"
```

Graph:

```
Carlos ─ has_appointment ─→ "dentist Thursday 4 PM"
Carlos ─ pickup_by ───────→ David
                              └─ superseded_by → (Carlos, pickup_by, Rosa)
Carlos ─ pickup_by ───────→ Rosa (current)
                              └─ supersedes → (Carlos, pickup_by, David)
```

Query: "Who's picking up Carlos?"
→ Graph: current `pickup_by` → Rosa
Query: "Wasn't David supposed to pick up Carlos?"
→ Graph: follows supersession link → "Yes, originally David, but Rosa replaced him."

### Caregiver

```
Store: "Dad takes Metformin 1000mg twice daily"
Store: "Dr. Martinez reduced Metformin to 500mg once daily — A1C improved"
```

Graph:

```
Dad ─── takes ──→ "Metformin 1000mg twice daily"
                    └─ superseded_by → (Dad, takes, "Metformin 500mg once daily")
Dad ─── takes ──→ "Metformin 500mg once daily" (current)
                    └─ supersedes → (Dad, takes, "Metformin 1000mg twice daily")
Dad ─── a1c ───→ "improved" 
```

Query: "What's Dad's Metformin dose?"
→ Graph: current → "500mg once daily"
Query: "What was the previous dose?"
→ Graph: follows supersession → "1000mg twice daily"
Query: "Why was it reduced?"
→ Graph: "a1c improved" (linked by shared source item with the dose change)

## Implementation Plan

### Phase 1: Schema + Extraction (Core + Brain)

1. **Core:** Add `kg_entities` + `kg_deferred_deletes` to identity.sqlite (opaque IDs only). Add `kg_entity_labels` + `kg_entity_aliases` + `kg_triples` + `kg_evidence` + `kg_supersessions` to per-persona vaults (migration v12)
2. **Core:** Atomic API (not raw CRUD):
   - `POST /v1/kg/apply` — atomic extraction apply: takes extraction result, resolves entities, creates/supersedes/retracts/reconfirms in one transaction
   - `GET /v1/kg/query` — bounded traversal: entities → triples → evidence → source items
   - `POST /v1/kg/correct` — user corrections: merge entities, forget entity, manual retract
   - `DELETE /v1/kg/entity/{id}` — tombstone + deferred purge (immediate for unlocked personas, queued for locked)
3. **Brain:** Extraction prompt in staging pipeline (after classification, before resolve)
4. **Brain:** Entity resolution against existing `kg_entities` + contact aliases (conservative: high-confidence auto-link only, medium → create new + flag for review)
5. **Brain:** Four-operation detection: for each new triple, LLM classifies against existing triples as store/supersede/retract/reconfirm/unchanged

### Phase 2: Graph-Expanded Recall

1. **Brain:** Before `/ask` LLM call, resolve entities from the query
2. **Brain:** Traverse 1-2 hops from matched entities
3. **Brain:** Inject graph context (triples + source vault texts) into the LLM prompt alongside search results
4. **Brain:** State filtering — `state = 'active'` for current-state queries, include `superseded`/`retracted` for history queries
5. **Brain:** Confidence ranking — temporal reliability × source authority for ordering competing triples

### Phase 3: Graph Maintenance + User Correction

1. **Brain:** Merge/split entities when new information disambiguates ("Kai" and "Kai Nakamura" are the same)
2. **Brain:** Garbage collection — remove orphaned entities with no triples
3. **Brain:** Surface ambiguous entities for user review (medium-confidence links)
4. **Core:** Export graph as part of vault export (graph is derived, but useful to preserve)
5. **Telegram:** `/graph <entity>` — show triples + aliases for an entity
6. **Telegram:** `/graph merge <entity1> <entity2>` — merge two entities (fixes resolution errors)
7. **Telegram:** `/graph forget <entity>` — marks entity as tombstoned in identity.sqlite. Immediately deletes labels/aliases/triples/evidence from all currently unlocked persona vaults. For locked personas, a deferred-delete entry is queued in identity.sqlite. When that persona is later unlocked, the deferred queue is drained and the persona-local data is purged.
8. **Telegram:** `/graph forget <entity> --persona work` — delete only from work persona. Entity survives in identity.sqlite if other personas still reference it. If all persona references are gone, entity is tombstoned.

**Deferred-delete queue** (in identity.sqlite):

```sql
CREATE TABLE kg_deferred_deletes (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL,      -- entity to purge
    persona     TEXT NOT NULL,       -- which persona vault to clean when unlocked
    created_at  TEXT NOT NULL
);
```

On persona unlock, Core drains this queue: deletes labels, aliases, triples, evidence for the specified entity in that persona vault. If the entity has no remaining persona references after all deferred deletes complete, the entity row itself is removed from identity.sqlite.

### Phase 4: Graph-Aware Features

1. **Reminders:** Graph-enriched reminders ("dentist tomorrow" + graph → "Carlos's inhaler in the blue bag")
2. **Proactive:** Detect contradictions in graph (two active triples for same subject+edge_family)
3. **D2D:** Graph context in D2D message composition ("ask Mom about pickup" → graph knows Rosa = Mom, pickup is for Carlos at dentist)

## What This Is NOT

- **Not a full RDF/SPARQL system.** Simple triples in SQLite, traversed by application code, reasoned over by the LLM.
- **Not a replacement for the vault.** The vault item is the source of truth. The graph is a derived index. Delete the vault item → delete its evidence → orphaned triples auto-delete.
- **Not a free-form ontology.** Canonical edge families provide the structure supersession and decay need. Entity types remain freeform.
- **Not unbounded.** Max 2-hop traversal, max 50 triples per query. The LLM does the synthesis, not the graph engine.

## Key Design Decisions

1. **LLM extracts, not regex.** Regex can't handle "the backend guy recommended the new auth library." The LLM can.
2. **Canonical edge families, not free-form predicates.** ~20-30 canonical families (`deadline`, `takes_medication`, `recommended`, etc.) ensure supersession and decay work across items stored weeks apart. Freeform labels preserved for display.
3. **Four semantic operations at ingestion time.** Store, supersede, retract, reconfirm — decided by the LLM when context is freshest. Delete is a separate control-plane operation (user or policy action, not semantic interpretation).
4. **Supersession is many-to-many, stored in a junction table.** One new fact can supersede many old facts. One old fact can be superseded by multiple new facts. The `kg_supersessions` table captures the reason alongside each link.
5. **Retraction is distinct from supersession.** "Not blocked anymore" is different from "replaced by a different blocker." Retracted facts have no replacement link. They appear in history queries but not current-state queries.
6. **Evidence-based provenance (many-to-many).** One triple can be supported by multiple vault items. Deleting a vault item removes its evidence — if a triple has zero evidence left, it's auto-deleted (no source of truth remains). Reconfirmation adds evidence without creating a new triple.
7. **Entities are opaque UUIDs in identity.sqlite; everything else is per-persona.** `kg_entities` stores only UUIDs (no names, types, or aliases). `kg_entity_labels`, `kg_entity_aliases`, `kg_triples`, `kg_evidence` all live inside per-persona encrypted vaults. Locked persona = all meaningful derived data inaccessible (only opaque UUIDs and deferred-delete queue entries remain in identity.sqlite — no names, facts, or relationships leak).
8. **Confidence decays with time, reconfirmation resets it.** Computed at query time using half-life per edge family. "Picked up Dad's Metformin refill" adds a reconfirmation evidence row and refreshes `last_confirmed`.
9. **Source authority is a confidence multiplier.** User-stated > system-confirmed > contact-reported > unverified.
10. **Entity resolution is conservative.** High confidence → auto-link. Medium → create new entity, flag for review. Wrong merges compound and are catastrophic.
11. **Accuracy over cost.** Extract from every item. Missing a connection is worse than an extra LLM call.
12. **Atomic apply, not raw CRUD.** The API is `POST /v1/kg/apply` (extraction result → resolve + create + supersede + retract in one transaction), not individual triple mutation endpoints.
13. **Graph + source text at recall.** Triples provide traversability. Source vault items (via evidence links) provide narrative coherence.
14. **User can inspect and correct.** `/graph Kai` shows everything. `/graph merge` fixes resolution errors. `/graph forget` tombstones + deferred purge for locked personas.

## Critical Files

| File | Change |
|------|--------|
| `core/internal/adapter/sqlite/pool.go` | Migration v12: kg_entities + kg_deferred_deletes in identity.sqlite (opaque IDs); kg_entity_labels + kg_entity_aliases + kg_triples + kg_evidence + kg_supersessions in per-persona vaults |
| `core/internal/handler/knowledge_graph.go` | NEW: apply, query, correct, delete endpoints (not raw CRUD) |
| `core/internal/port/knowledge_graph.go` | NEW: Port interface |
| `brain/src/service/kg_extractor.py` | NEW: LLM-based entity/relationship extraction with canonical edge family mapping |
| `brain/src/service/kg_resolver.py` | NEW: Entity resolution (conservative) + four-operation detection (store/supersede/retract/reconfirm) |
| `brain/src/service/staging_processor.py` | Hook extraction after classification |
| `brain/src/service/guardian.py` | Graph-expanded recall in /ask pipeline |
| `brain/src/prompts.py` | Extraction prompt + graph context prompt |
| `api/components/schemas.yaml` | Triple, Entity, Alias schemas |
