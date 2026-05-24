# Identity Hub Redesign — People as the canonical identity spine

**Status:** Phases A–D implemented + verified, **in-process AND out-of-process (home-node-lite)**. Greenfield (no migration compatibility required; dev data is disposable and will be wiped). See `implementation-notes.html` for the full decision/deviation/review log.
**Scope:** TypeScript stack only (`packages/`, `apps/mobile/`). The Go (`core/`) and Python (`brain/`) trees are deprecated reference.
**Owner:** TBD. Execute as a focused, phased build — each phase lands green before the next.

> **Scope discipline (read first).** This redesign fixes one concrete, present failure: an inbound DID
> cannot reliably resolve to a remembered fact about a person. The fix is a structured `person_id`
> spine (`person_identities` + `vault_item_subjects`). A larger, mature identity system has many more
> concerns — lifecycle/revocation, verification evidence, perspective-scoped relationships,
> source≠author≠subject provenance, group channels, agent relays. Those are **real but deliberately
> deferred** — see **§11**. We build the spine now and leave room for the rest; we do not pre-build
> structure for flows that don't exist yet (the project's standing rule: avoid premature structure;
> scope is judgment, not maximalism).

---

## 1. Why this exists (motivation)

Today identity is split across **three disconnected stores**, and the contact/person/preference data they hold drift apart because nothing keeps them coherent:

1. **D2D admission gate** — `knownContacts` set in `packages/core/src/d2d/gates.ts` (egress) + a parallel set in `packages/core/src/peerlens/source_trust.ts` (inbound). Decides "is this DID allowed to send me data that stages?"
2. **Contact directory** — `packages/core/src/contacts/directory.ts` + `repository.ts`. DID → {display_name, trust_level, preferred_for, …}.
3. **People graph** — `packages/core/src/people/repository.ts`. The semantic person model (canonical name, surfaces/aliases, relationship, `contact_did`, status).

The concrete failure that exposed this: in the bus/Quixote demo, Quixote's D2D message says **"I'm coming over"** (no name, only a DID). For Dina to enrich the resulting reminder with *"he loves eggs and bacon,"* it must resolve `DID → person → that person's remembered preference`. The data exists, but the link from the inbound DID to the remembered fact is fragile:

- Recall is done by **name-text/FTS matching** (reminder planner `resolveSenderHint` → people graph by DID, then FTS by name surfaces), not by a **structured `person_id` link** from the note to the person.
- A person is modeled as **1:1 with a single `contact_did`** column, which breaks under DID rotation, multiple devices, note-written-before-DID-exchange, and future email/phone/WhatsApp identities.
- Contact mutations are **scattered and fail-soft**: `addContact()` already mirrors to the people graph + gate (this works), but `updateContact`/`delete`/`block`/`unblock`/pairing/import do **not** uniformly re-sync all projections, and the gate sets have **no removal path** (block/delete never prune them).

> Reference note: the original Go/Python implementation stored relationship notes **tagged with the contact DID** and queried them **by DID** (`brain/src/service/nudge.py` `_query_relationship_notes(persona, contact_did)`; `core/internal/domain/contact.go` `Contact{DID, Aliases, PreferredFor}`). The TS port moved to a name/FTS approach and lost the robust DID→note linkage. This redesign restores a *better* version of that linkage (structured `person_id` links that survive identity rotation).

**Goal:** make the **People graph the single canonical identity hub**. Contacts, D2D trust, source-trust, and vault recall all **derive from `person_id`** rather than maintaining separate truth.

---

## 2. Target architecture (the correct model)

**A person/entity is the stable hub. Identifiers point to it. Facts attach to it.**

- **Facts/preferences attach to a `person_id`**, not to a DID or a loose note. "Don Quixote loves eggs and bacon" is recorded about the *person* Don Quixote.
- **A person/entity has many identities** (0..N): a DID per device, plus future email / phone / handle / WhatsApp. Identities are credentials that *point to* a person, many-to-one, and can rotate. This is `person_identities`, not a single column.
- **A "contact" is a person with a trusted, linked identity** — trust/sharing policy lives **per person**, not per DID (you trust the person, across their devices).
- **Inbound resolution:** `identifier (e.g. DID) → person_id → {surfaces, facts, trust}` — feeds both the admission decision (trust) and reminder/nudge enrichment (facts).

This survives the cases the current model and the original both get wrong: note-before-DID, key rotation, multiple devices, multiple channels.

### Entity types are first-class (the one structural hook we add now)

Not every DID is a human. A DID may belong to a home node, device, agent, service provider, or organization, and "my dentist" might be a clinic or a service DID rather than a person. We carry an **`entity_type`** column on the hub row (`human | org | service | device | agent | group`, default `human`) so the same identity spine can hold non-human counterparts without forcing them into human-only behavior. This is a cheap modeling hook — **not** permission logic. Admission still depends on contact policy + message-type + public-service config + reservations + blocklist (see below).

### What stays separate (do NOT fold into People/contacts)

The **D2D admission policy** (the receive pipeline) is its own concern, because public service admits **non-contacts** by design. Admission is a function of:

`(sender→person trust, message-type, my-published-services, active reservations, blocklist, expiry)` → `stage-as-personal | route-to-service-handler | accept-as-query-reply | quarantine | drop`.

The branches (in `packages/core/src/d2d/receive_pipeline.ts` `receiveD2D`, step 5c):

- `service.query` from a stranger → admitted iff **we publish that capability** (`isCapabilityConfigured`). Routed to the service handler, not staged, sender not added as a contact.
- `service.response` → admitted iff there's an **open requester window** (the reservation/"callback ticket" in `packages/core/src/service/query_window.ts`) matching `(peerDID, queryId, capability)`, single-use, expiring.
- plain chat → the **contact gate** (`CONTACT_TRUST_LEVELS`); a stranger's personal message quarantines.
- blocked sender → dropped first (blocked beats bypass).

People/contacts answer *who and what trust level*. Admission still needs *message-type, public-service config, reservations, blocklist, expiry*. Keep them decoupled — the contact set is just **one input** to the policy. **Identity verification/lifecycle is an admission-layer concern, not an identity-schema concern** (see §11 for why we don't bake `verified+active` requirements into the schema yet).

---

## 3. Schema design

Runtime schema source (confirmed): **`packages/core/src/storage/schemas.ts`** — `IDENTITY_MIGRATIONS` (identity.sqlite) and `PERSONA_MIGRATIONS` (per-persona vault files), consumed by `packages/core/src/storage/bootstrap.ts`. Greenfield: edit the initial-schema migrations directly (no new migration files).

> **Fixtures are NOT updated (verified).** `packages/fixtures/schema/*.sql` (`identity_001.sql`, `persona_001.sql`) are a frozen *architectural-reference* schema validated by their own parser tests; they already diverge from the runtime `schemas.ts` (they contain **no** people-graph tables at all, and `identity_schema.test.ts` asserts "exactly 10 tables"). Editing them would *break* the fixture tests, not satisfy them. The single source this redesign edits is `schemas.ts`.

> **Cross-file integrity (no SQL FK across files).** `people`/`person_identities`/`person_surfaces`/`contacts` live in **identity.sqlite**; `vault_items`/`vault_item_subjects` live in **per-persona** SQLCipher files. They are separate database files — `vault_item_subjects.person_id` is a plain reference with **no SQL FK**. Integrity is enforced in repository logic: a recall that hits a `person_id` with no matching person row **skips and logs**, never throws. (We also do **not** add SQL FKs *within* identity.sqlite in this change — the people model never hard-deletes, lifecycle is a `status` flip, and FKs would require auditing `PRAGMA foreign_keys=ON` across every adapter. Integrity stays repo-enforced; revisit FKs separately. See §11.)

### 3.1 `people` (identity.sqlite) — drop `contact_did`, add `entity_type`

```sql
CREATE TABLE people (
  person_id         TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL DEFAULT 'human',      -- human | org | service | device | agent | group
  canonical_name    TEXT NOT NULL DEFAULT '',
  relationship_hint TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'suggested',  -- suggested | confirmed | rejected
  created_from      TEXT NOT NULL DEFAULT 'llm',        -- llm | manual | imported | user
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) WITHOUT ROWID;
```

Remove the `contact_did` column and `idx_people_contact_did` — superseded by `person_identities`. `relationship_hint` is a local-owner display hint; it is **not** for modeling third-party relationships ("Quixote's daughter") — that's deferred (§11).

### 3.2 `person_identities` (identity.sqlite) — NEW, the canonical link

```sql
CREATE TABLE person_identities (
  identity_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id         TEXT NOT NULL,
  identity_type     TEXT NOT NULL,            -- did | email | phone | handle | device
  identity_value    TEXT NOT NULL,
  verified          INTEGER NOT NULL DEFAULT 0,
  primary_identity  INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(identity_type, identity_value)        -- one identifier maps to exactly one person
);
CREATE INDEX idx_person_identities_lookup ON person_identities(identity_type, identity_value);
CREATE INDEX idx_person_identities_person ON person_identities(person_id);
```

`UNIQUE(identity_type, identity_value)` means an identifier maps to exactly one person; binding it elsewhere **re-points** the row (the repo upsert does this) rather than duplicating. `verified` is monotonic on upsert (never silently downgraded). Identity **lifecycle** (active/retired/revoked) and **verification evidence** are deferred (§11) — in Phase A all identities are written by explicit user/contact actions (`verified=1`).

> **Canonicalization (forward note, not built now):** when email/phone/handle identities get real write paths, normalize before the uniqueness check (email lowercase/trim, phone E.164, handle lowercase). DIDs are already canonical, and DID is the only type written in Phase A, so no canonicalizer is built yet.

### 3.3 `person_surfaces` (identity.sqlite) — unchanged

Existing table (name/nickname/role_phrase surfaces, status, confidence, `source_item_id`). **Kept as-is.** Role-phrase exclusivity stays *global* (as the Go-parity contract in `people/contract.ts` pins it). Perspective-scoped role phrases ("my daughter" from owner vs from Quixote) are deferred (§11) — there is no current flow that ingests third parties' statements about third parties, and changing this table now would churn a parity-locked contract.

### 3.4 `contacts` (identity.sqlite) — re-key to `person_id`

Today `contacts` is **DID-keyed** (`did` PK + `contact_aliases`). Target: **policy per person**.

```sql
CREATE TABLE contacts (
  person_id          TEXT PRIMARY KEY,          -- was: did
  display_name       TEXT NOT NULL,
  trust_level        TEXT NOT NULL DEFAULT 'unknown',   -- blocked | unknown | verified | trusted
  sharing_tier       TEXT NOT NULL DEFAULT 'summary',
  relationship       TEXT NOT NULL DEFAULT 'unknown',
  data_responsibility TEXT NOT NULL DEFAULT 'external',
  notes              TEXT NOT NULL DEFAULT '',
  preferred_for      TEXT NOT NULL DEFAULT '[]', -- JSON array of role categories
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
```

`getContact(did)` becomes `did → person_identities → person_id → contacts`. **This is the largest ripple** (the SQL table, the SQL repo, and the in-memory directory all re-key to `person_id`), but the public directory API stays **DID-facing** and resolves through identities, so the ~143 consumer call sites stay unchanged (D3's "limit churn" escape hatch). `contact_aliases` re-keys to `person_id` (its FK follows). Aliases conceptually belong on `person_surfaces` eventually (deferred §11). **Blocking stays on `trust_level='blocked'`** — no separate `blocked` column (a second deny state is the anti-pattern the original avoided). A DID is gate-eligible iff its person's `trust_level !== 'blocked'`.

### 3.5 `vault_items` (persona) — add `author_person_id`

Add to the `vault_items` CREATE:

```sql
  author_person_id TEXT NOT NULL DEFAULT '',  -- the sender, resolved to a person (inbound D2D); '' for owner-authored
```
```sql
CREATE INDEX idx_vault_items_author ON vault_items(author_person_id) WHERE author_person_id != '';
```
Keep the existing `contact_did` text field + FTS columns/triggers as-is (don't disturb the FTS triggers in this change). Splitting **source ≠ author ≠ subject** into separate raw-identity columns is deferred (§11) — the current D2D model has source == author == sender DID, and `author_person_id` (the resolved person) is the useful linkage.

### 3.6 `vault_item_subjects` (persona) — NEW, the canonical recall link

```sql
CREATE TABLE vault_item_subjects (
  item_id    TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  relation   TEXT NOT NULL DEFAULT 'about',   -- subject | mentioned | about
  confidence TEXT NOT NULL DEFAULT 'medium',
  source     TEXT NOT NULL DEFAULT 'manual',   -- llm | contact_match | manual
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, person_id)
) WITHOUT ROWID;
CREATE INDEX idx_vault_item_subjects_person ON vault_item_subjects(person_id);
```

**Subject linking is ambiguity-safe.** `/remember` writes a `vault_item_subjects` row only when the mention resolves to exactly one person:
1. exact identity match (text contains a DID/email/phone/handle), else
2. exact confirmed surface match (`Emma`, `Em`, `my daughter` — owner perspective), else
3. exactly one unambiguous confirmed person → link; else
4. **no subject link** — store the note unlinked and rely on the surface-FTS fallback (D4).

Aggressive fuzzy matching (`Emm`→`Emma` edit-distance, short-token guards) is deferred (§11); the safe default is "link on unambiguous confirmed match, else FTS fallback." Fuzzy/name matching is for *recall only* — it never verifies an identity or admits D2D traffic.

### 3.7 `person_facts` / preferences — DEFER

A structured/typed facts table is **not** built — `vault_item_subjects` + the note already captures "Don Quixote → loves eggs and bacon" (the note *is* the fact, linked to the person). Add a typed facts table only when a real need for queryable/typed facts appears. Premature structure otherwise. (§11)

---

## 4. `establishContact()` — the single contact-mutation path

One use-case is the **only** way to add/update a trusted person. All entry points route through it (add-contact UI, pairing, import-contacts, rename, block/unblock, delete/untrust, dev-peer auto-add, and future email/phone identity flows).

**Resolution order (find-or-create the person):**
1. Resolve by **identity** first: `person_identities` where `(identity_type, identity_value)` matches → existing `person_id`.
2. Else resolve by **unambiguous confirmed surface** (exactly one confirmed person with that name). If ambiguous → require clarification; do **not** auto-merge.
3. Else **create** a new person.

**Then atomically (single transaction):**
- `upsert person_identities` row for the DID/email/phone (set `verified`/`primary` appropriately). The upsert re-points the identifier if it previously pointed at a (e.g. rejected) person.
- `upsert` a **confirmed** display-name `person_surfaces` row; flip the person `status` to `confirmed` (explicit user assertion).
- `upsert` the `contacts` policy row (trust_level, sharing_tier, relationship, preferred_for, blocked).
- **Sync derived projections** (see §4.1).

**Idempotent:** adding the same contact twice updates in place (no duplicates).
**Rename:** updates `canonical_name` + the display-name surface.
**Delete/untrust:** removes the `contacts` policy row + prunes projections, but **preserves the person + history** (notes, surfaces) unless the person is explicitly deleted.

### 4.1 Derived projections (caches, not independent truth)

The D2D gate (`d2d/gates.ts`) and source-trust (`peerlens/source_trust.ts`) `knownContacts` sets are **derived caches** of "persons with a non-blocked trusted identity." `establishContact()`/`removeContact()`/block/unblock keep them in sync. **Add the missing removal path** — today block/delete never prune these sets (a real bug). Rule: a DID is in the gate iff its person has a non-blocked contact policy.

Because the gate/source-trust sets are **in-memory**, sync is not transactional with SQL. Add a `rebuildContactProjections()` helper that clears and rebuilds both caches from identity.sqlite, call it at boot/hydration, and prove with a test that projections recover after a missed in-memory update.

---

## 5. Decisions & rationale

- **D1 — Person-centric, not DID-centric.** Identities are many-to-one and mutable; the person is stable. (§2.)
- **D2 — Defer `person_facts`.** `vault_item_subjects` + notes suffice; avoid premature structure. (§3.7)
- **D3 — Re-key `contacts` to `person_id`.** Correct (policy per person) but the biggest ripple. Lands in Phase B; may retain a `getContact(did)` accessor that resolves `did→person→policy` to limit churn. Greenfield, so no migration needed.
- **D4 — Keep surface-FTS recall as a *fallback*.** `vault_item_subjects` is the primary recall path, but many notes won't have a subject link (older notes, ambiguous names, LLM didn't resolve). The person-scoped surface-FTS retrieval already in `reminder_planner.gatherVaultContext` stays as the backstop — do not delete it.
- **D5 — `Person.contactDid` field.** The `Person`/`ResolvedPerson` domain types currently expose `contactDid`. To limit ripple, **keep the field but populate it from the primary `did` identity** via a correlated subquery in the repo SELECTs (`(SELECT identity_value FROM person_identities WHERE person_id = people.person_id AND identity_type='did' ORDER BY primary_identity DESC, updated_at DESC LIMIT 1) AS contact_did`). Consumers (`resolver.ts`, reminder planner) keep working; the column is gone but the concept is derived. Revisit removing the field entirely once consumers are audited.
- **D6 — Admission policy stays separate.** (§2) The contact set is one input; message-type/public-service/reservations/blocklist/expiry are not identity concerns. Identity *verification/lifecycle* gating also lives in the admission layer, not the schema (§11).
- **D7 — Greenfield, in-place schema edit.** No migration files; edit initial schema directly so the schema reads as if person-identities was always the design; wipe dev DBs (sim/emulator). Confirmed no real data. (Flip to forward migrations before any real install ships — §11.)
- **D8 — Entity types are first-class, but inert for permissions.** `entity_type` lets services/orgs/agents/devices share the spine; it is a modeling hook, never an admission rule.
- **D9 — Subject links are ambiguity-safe.** `/remember` links only on an unambiguous confirmed person/identity match; otherwise leaves the note unlinked and relies on FTS fallback. Name/fuzzy matching never verifies an identity or admits D2D traffic.
- **D10 — Merges preserve recall.** `mergePeople(keep, merge)` re-points `person_identities` and `person_surfaces` to the survivor (within identity.sqlite). Subject links live in persona vaults (cross-file); recall tolerates a stale `person_id` via skip-and-log, and a fuller cross-vault re-point/redirect is a Phase C/§11 concern. Never merge in a way that silently drops links.
- **D11 — Identity hub is global; recall is persona-scoped.** `person_id` can be shared across personas, but `vault_item_subjects` lives in the persona vault. Any recall API that takes a `person_id` must also scope to the allowed/open personas — this is a privacy boundary, not an optimization.

---

## 6. Risks / gotchas (learned during scoping)

- **`schemas.ts` is the only schema source to edit.** Fixtures (`packages/fixtures/schema/*.sql`) are a frozen reference with their own parser tests and are intentionally **not** touched (see §3 note). The runtime schema tests assert against `schemas.ts` via `applyMigrations`.
- **FTS triggers reference `contact_did`.** The `vault_items_fts` virtual table + `vault_items_ai/ad/au` triggers list `contact_did` as an FTS column. Leave `vault_items.contact_did` in place (don't remove it in this change) so the triggers stay valid; `author_person_id`/`vault_item_subjects` are additive.
- **No backticks inside the SQL template literals.** `schemas.ts` migrations are JS backtick template strings; a backtick in an SQL `--` comment terminates the string. (Bit me once during Phase A.)
- **Two un-pruned `knownContacts` sets** (`d2d/gates.ts`, `peerlens/source_trust.ts`) have **no removal function** today. Add `removeKnownContact`/egress-removal, wire block/delete, and add a rebuild-from-DB path so projection drift self-heals on boot.
- **People curation methods unused.** `confirm/reject/merge/detach/confirmSurface` exist on the repo but have **zero production callers** — wiring them (People UI) is out of scope here but related.
- **Live two-device verification is tooling-fragile.** Metro Fast-Refresh does **not** re-bind already-bound handlers (e.g. `handleInboundD2D`) — a full app reload is required for a code change to take effect at runtime. MsgBox **redelivers** unacked messages on reconnect (duplicate dispatches). Prefer contract tests for verification; treat live runs as demo capture, with full reloads + a clean vault.
- **`addContact` already mirrors to the people graph** (`directory.ts:~158` `upsertContactPerson` → confirmed person + DID; `:~140` gate sync). The gap is that the write is fail-soft + scattered, not that it's absent. `establishContact()` centralizes + hardens it.
- **Cross-persona leakage is the privacy footgun.** `person_id` is global identity metadata, but memories are persona-vault data. Any recall API that accepts `person_id` must also derive an allowed persona scope (D11).

---

## 7. Phased implementation plan

Each phase ends **green** (typecheck + relevant tests) and is committed before the next.

### Phase A — Schema + `PeopleRepository`
**Files:** `packages/core/src/storage/schemas.ts`; `packages/core/src/people/repository.ts`, `domain.ts`, `resolver.ts`; schema/people tests; `packages/core/src/people/contract.ts` (kept as-is — role-phrase exclusivity unchanged).
**Changes:**
- Schema: add `people.entity_type`, `person_identities`, `vault_item_subjects`, `vault_items.author_person_id`; drop `people.contact_did` + its index.
- Repo: add `upsertIdentity(personId, type, value, {verified, primary})`, `resolveByIdentity(type, value) → Person|null`; rewire `findByContactDid` → identity lookup; `linkContact` → `upsertIdentity(did)`; `upsertContactPerson` → find-via-identity + create person + identity + confirmed surface; `mergePeople` → re-point `person_identities` (+ surfaces); SELECTs populate `contactDid` via the primary-did subquery (D5).
- `entity_type` is added as a **column only** (default `'human'`). It is *not* threaded through the `Person` domain type or row mappers yet — that plumbing is deferred until a consumer reads it (adding an unused interface field is the same premature structure we're avoiding). The column exists so a future provider/org flow needs no migration.
**Verify:** `cd packages/core && npx jest people schema storage`; `npx tsc -p packages/core/tsconfig.json --noEmit`.

### Phase B — `establishContact()` + route all mutations + projection sync
**Files:** new use-case (e.g. `packages/core/src/contacts/establish_contact.ts`); `packages/core/src/contacts/directory.ts` (re-key to person_id, D3); `d2d/gates.ts` + `peerlens/source_trust.ts` (add removal + rebuild paths); all mutation call sites from §8.5.
**Changes:** implement the §4 algorithm; route add-contact UI, pairing, import, rename, block/unblock, delete, dev-peer through it; sync gate + source-trust on add **and** remove; add projection rebuild from canonical DB state.
**Verify:** contacts + gate + source-trust tests; mobile typecheck.

### Phase C — `/remember`→subject-link + inbound `did→person→subjects` recall
**Files:** `packages/core/src/vault/repository.ts` + `crud.ts` (subject-link write methods, `author_person_id`); `packages/brain/src/staging/drain.ts` + `pipeline/post_publish.ts` + `pipeline/people_graph_extraction.ts` (write `vault_item_subjects` only on unambiguous person resolution); `packages/brain/src/pipeline/reminder_planner.ts` `gatherVaultContext` (recall via `did → person_id → vault_item_subjects` within allowed persona scope, keep surface-FTS fallback per D4); `packages/brain/src/nudge/assembler.ts`.
**Verify:** the Quixote contract test (§9) + existing reminder/nudge tests green.

### Phase D — Full test matrix
**Files:** new/updated tests under `packages/core/__tests__/` + `packages/brain/__tests__/`.

---

## 8. Complete code map (as of planning; verify line numbers before editing)

### 8.1 Schema
- `packages/core/src/storage/schemas.ts` — `IDENTITY_MIGRATIONS` (contacts ~21-45 incl. `contact_aliases`; people graph migration v5: `people`, `person_identities`, `person_surfaces`, `person_extraction_log`); `PERSONA_MIGRATIONS` (`vault_items` + FTS5 vtable/triggers; `vault_item_subjects`; `topic_salience`). Runner: `packages/core/src/storage/migration.ts`; adapter `packages/storage-node/src/migration.ts`; consumed by `storage/bootstrap.ts`.
- Fixtures (`packages/fixtures/schema/*.sql`) and their tests (`identity_schema.test.ts`, `persona_schema.test.ts`) are a frozen reference — **not** edited by this change.

### 8.2 PeopleRepository
- `packages/core/src/people/repository.ts` — `PeopleRepository` interface + `SQLitePeopleRepository`. Singletons `set/getPeopleRepository`. Methods: `applyExtraction, getPerson, listPeople, findByContactDid, resolveByIdentity, upsertIdentity, confirmPerson, rejectPerson, confirmSurface, rejectSurface, detachSurface, mergePeople, deletePerson, linkContact, upsertContactPerson, resolveConfirmedSurfaces, clearExcerptsForItem, garbageCollect`.
- `packages/core/src/people/domain.ts` — `Person` (`contactDid`, `entityType`), `PersonSurface`, `ExtractionResult`.
- `packages/core/src/people/resolver.ts` — `RepositoryPersonResolver`: `resolveByDID` (→ `findByContactDid`), `displayName`, `confirmedSurfacesMap`. `ResolvedPerson.contactDid`.
- `packages/core/src/people/contract.ts` — Jest parity suite (test support). Role-phrase exclusivity is global here — unchanged.

### 8.3 Contacts directory
- `packages/core/src/contacts/directory.ts` — in-memory `contacts`/`aliasIndex` Maps; `Contact` type; `addContact` (mirrors gate+source-trust+`upsertContactPerson`), `addContactIfNotExists`, `getContact` (SQL hydration), `listContacts`, `updateContact`, `deleteContact`, alias fns, `hydrateContactDirectory` (boot backfill into people graph), `setPreferredFor`/`getPreferredFor`/`findByPreferredFor`.
- `packages/core/src/contacts/repository.ts` — `SQLiteContactRepository` (persists `contacts`/`contact_aliases`).
- `packages/core/src/contacts/validation.ts`, `preferred_for.ts`.
- Boot wiring: `apps/mobile/src/storage/init.ts:97/114/121`; `apps/mobile/src/services/boot_capabilities.ts:330`.

### 8.4 D2D gate + source-trust
- `packages/core/src/d2d/gates.ts` — egress `knownContacts`; `addContact(did)` (re-exported as `addEgressGateContact`), `clearGatesState`, `blockDestination`/`unblockDestination`/`trustDestination`/`untrustDestination`, `checkContactGate`. **No removal fn.**
- `packages/core/src/peerlens/source_trust.ts` — inbound `knownContacts`; `addKnownContact`, `clearKnownContacts`, `classifySourceTrust`/`isContactRing1`. **No removal fn.**
- Mutated only from `contacts/directory.ts` (`addContact`, `getContact` hydration, `hydrateContactDirectory`).

### 8.5 Contact/person MUTATION call sites (route through `establishContact`)
- `apps/mobile/app/add-contact.tsx:98` (`addContact`); `apps/mobile/app/people.tsx:98` (`deleteContact`).
- `apps/mobile/src/hooks/useContacts.ts:95/108`; `useContactDetail.ts:106/121/133/145` (add/remove alias, update trust/notes); `usePhoneContacts.ts:129` (phone import).
- `apps/mobile/src/services/boot_capabilities.ts:120` (`addContactIfNotExists` dev-peer).
- `packages/brain/src/staging/drain.ts:709` + `pipeline/post_publish.ts:130` (`updateContact` last-seen touch); `enrichment/topic_touch_pipeline.ts:245` (`updateContact` preferredFor).
- Server: `packages/core/src/server/routes/contacts.ts:77/87`; CoreClient transports (`http-transport.ts:830`, `in-process-transport.ts:856`, `core-client.ts:439`).
- Person mutations: `packages/brain/src/staging/drain.ts:678` + `pipeline/people_graph_extraction.ts:165` + `server/routes/people.ts:99` (`applyExtraction`); `contacts/directory.ts:158/470` (`upsertContactPerson`). LLM tool feeding extraction: `packages/brain/src/reasoning/remember_tools.ts:115` (`link_to_person`), registered `composition/remember_runtime.ts:117`.
- Pairing: `packages/core/src/pairing/ceremony.ts` + `server/routes/pair.ts` do **not** touch contacts; contact creation after pairing is `add-contact.tsx:98`.

### 8.6 DID→person RESOLUTION sites
- `packages/core/src/people/resolver.ts` `resolveByDID`/`displayName` → `findByContactDid`.
- `packages/brain/src/pipeline/reminder_planner.ts`: `resolveSenderHint` (~702), `resolveReferencedPeople` (~632), `gatherVaultContext` (~406, called ~216) — the enrichment path.
- `getContact(did)` consumers: `packages/home-node/src/resolve_sender.ts:64`; `brain/src/pipeline/post_publish.ts:128`; `brain/src/staging/drain.ts:707/814`; `brain/src/routing/persona_selector.ts:280`; `brain/src/vault_context/assembly.ts:495`; mobile UI hooks.
- Nudge: `packages/brain/src/nudge/assembler.ts:73` `assembleNudge(contactDID, contactName)` — searches vault by **name** (FTS), not DID; change the caller that supplies the name, or switch to subject-link recall.

### 8.7 Vault write path + `/remember` chain
- Insert: `packages/core/src/vault/repository.ts` `storeItemSync` (~119-160, only `INSERT … vault_items`). Public API: `vault/crud.ts` `storeItem` (~198) / `storeBatch`. `VaultItemWrite` shape — add `author_person_id` + subject linkage here.
- `storeItem` callers: `staging/service.ts:408/508/745/794` (the staging→store junction); `server/routes/vault.ts:36`; `brain/src/staging/drain.ts:487`.
- `/remember` chain: `brain/src/chat/orchestrator.ts` `handleRemember` (~297) → `stagingIngest` → `core/src/staging/service.ts` `ingest`→`claim`→`resolve`→`storeItem`; people-graph apply after store at `brain/src/staging/drain.ts:665-693` + `pipeline/post_publish.ts:155-172` → `people_graph_extraction.applyPeopleGraphExtraction`. `person_surfaces.source_item_id` is the existing weak vault↔person link `vault_item_subjects` formalizes.

---

## 9. Test matrix (Phase D)

Core cases the redesign must lock. (Speculative cases for deferred features live in §11, not here.)

- add-contact creates person + identity + surface + contact policy.
- add-contact twice is idempotent (no dup person/identity/contact).
- rename updates display-name surface + `canonical_name`.
- block/unblock changes D2D admission (gate + source-trust pruned/restored).
- delete/untrust removes contact policy but **preserves** person + notes/surfaces.
- `/remember` about a known person creates a `vault_item_subjects` link.
- `/remember` with an ambiguous name (two confirmed matches) does **not** auto-link; relies on FTS fallback.
- inbound D2D from a person's DID retrieves their subject-linked memories (**the Quixote case**: confirmed contact + remembered preference + inbound "I'm coming over" → enriched scheduled reminder with the preference).
- two people with the same surface → clarification required, no auto-merge.
- multiple identities (two DIDs) on one person both resolve to that person.
- DID rotation/re-point: binding an existing DID to a new person re-points the identity (no UNIQUE violation, no duplicate).
- restart/hydration preserves all projections (gate, source-trust, people); `rebuildContactProjections()` recovers them.
- **persona-scoped recall non-leakage:** the same `person_id` with subject-linked facts in two persona vaults — recall from one persona does not surface the other's facts.
- **dangling subject-link safety:** a `vault_item_subjects.person_id` with no matching person row (cross-file) is skipped/logged, never throws.
- `entity_type='service'`/`'org'` person can be a trusted/preferred provider (not forced to `'human'`).

---

## 10. Execution checklist

- [x] Phase A: schema (+ `entity_type`) + repo + people/schema tests → green. (deep-reviewed)
- [x] Phase B: `establishContact()` + route mutations + projection sync (removal + rebuild paths) → green. (deep-reviewed)
- [x] Phase C: subject-link writes + inbound recall + `author_person_id` (persona-scoped; keep FTS fallback) → green. (deep-reviewed)
- [x] Phase D: test matrix incl. the Quixote discriminating-recall contract test → green. (deep-reviewed)
- [x] Out-of-process (home-node-lite): Core writes `vault_item_subjects` on apply (persona-threaded); `vaultItemsForPerson` + `peopleResolveByDid` Core surfaces + read backends; lite agentic loop seeded with the sender's subject-linked memories (`relatedMemories`). → green. (deep-reviewed)
- [ ] **Not committed** (per the no-commit-during-working-hours rule) — diff held in the working tree.
- [ ] Wipe dev DBs on sim/emulator; re-seed; live-verify the Quixote scenario (full reloads, clean vault).

---

## 11. Future / deliberately deferred

These are **real** concerns for a mature identity system and were raised during scoping (several by Codex). They are **out of scope for this redesign** — building them now would be premature structure for flows that don't exist yet, would churn parity-locked contracts, or would muddy the identity/admission layer separation. Documented here so (a) we don't regress the spine back to DID-only / name-FTS-only, and (b) we know where to extend when a real need appears.

- **Identity lifecycle (active / retired / revoked).** Today block/delete + `status` cover the present needs; a DID-rotation flow that must keep old DIDs for *history* while denying *new traffic* will want a `lifecycle_status` column on `person_identities` and an admission rule `verified=1 AND lifecycle_status='active'`. Build when key rotation / multi-device is a real flow. **Note:** this admission rule belongs to the admission layer (§2/D6), not the schema.
- **Verification evidence.** `verification_method` / `verification_evidence` / `verified_at` on identities, for audit and undo. `audit_log` covers provenance for now; add typed evidence when there's a verification UX that needs to explain/reverse a binding.
- **Perspective-scoped role phrases.** `person_surfaces.perspective_person_id` + `relationship_type` so "my daughter" from the owner and "my daughter" from Quixote don't collide. Requires reworking the **global** role-phrase exclusivity that `people/contract.ts` (Go parity) pins, and there is no current flow ingesting third parties' statements about third parties. Build with the first such flow.
- **Source ≠ author ≠ subject provenance.** `vault_items.author_identity_{type,value}` + `source_identity_{type,value}` for group channels (a channel transports; a person authors; someone else is the subject) and agent relays. Current D2D has source == author == sender DID; agent/MCP relay paths are deprecated in favor of the dina-agent CLI. `author_person_id` (resolved person) is the linkage we need now.
- **Group / shared channels.** A group/channel identity distinct from the author identity. Pairs with the provenance work above.
- **Agent / on-behalf-of delivery.** A service/home-node/agent DID delivering content for a human/org without becoming the remembered subject. Pairs with provenance + entity_type.
- **Identity canonicalization module.** A single canonicalizer for email (lowercase/trim), phone (E.164), handle (lowercase) before the uniqueness check. DIDs are already canonical and are the only type written today; build the canonicalizer with the first non-DID identity write path.
- **Aggressive fuzzy subject linking.** Edit-distance matching (`Emm`→`Emma`), short-token guards, "best single candidate" scoring, and explicit clarification UX. The safe default now is unambiguous-confirmed-match-or-FTS-fallback.
- **Cross-vault merge re-pointing.** `mergePeople` re-points identities + surfaces in identity.sqlite; re-pointing `vault_item_subjects` across *all* persona vaults (or a person-redirect table) is deferred — recall tolerates a stale `person_id` via skip-and-log until then.
- **SQL foreign keys within identity.sqlite** (`person_identities`/`person_surfaces`/`contacts` → `people`, `ON DELETE CASCADE`). Tempting, but the model never hard-deletes (lifecycle = `status` flip), and FKs require auditing `PRAGMA foreign_keys=ON` across every adapter/bootstrap path or they're silently inert. Integrity stays repo-enforced; revisit as a focused change.
- **Typed `person_facts`.** A queryable/typed facts table beyond note+subject-link. (§3.7)
- **People-curation UX.** Wiring `confirm/reject/merge/detach/confirmSurface` + split/undo-merge + "show identities linked to a person" + "revoke one identity" into a People UI.
- **Forward migrations.** Flip D7's in-place greenfield edits to append-only forward migrations before any install holds data that can't be wiped.
