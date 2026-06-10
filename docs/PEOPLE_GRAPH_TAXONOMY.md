# People Graph Taxonomy — Kind, Roles, and Relations

**Status:** design v2 (2026-06-10) · **Trigger:** "Bus Depot 42 appeared under Relations"
**Question that shaped it:** *"If he is my electrician, is he my contact or my relation?"*
**Design ruling (v2):** *"Everything is a heuristic and a gradient — the absolute cut
contact-vs-relation is not easy to do. Let the LLM decide."* The axes below remain the
**vocabulary** (what gets stored); the **judgment** of where an entity sits is an LLM
classification with confidence + user override — NOT a rule cascade. §"How classification
works" replaces v1's hand-coded grouping rules.

## The answer up front

He is **both, and neither alone**. "Contact", "relation", and "electrician" are answers to
three different questions, and the bug class we hit comes from collapsing them:

| Question | Axis | Where it lives |
|---|---|---|
| What **is** this entity? | **Kind** — person / organization | NEW (this doc) |
| Can I **reach** them, and how much do I trust the channel? | **Channel** — contact (DID), trustLevel, sharingTier | exists: `Contact` |
| What do they **do** for me? | **Roles** — electrician, dentist, transit… (plural!) | exists, scattered: `preferredFor[]`, received `service.offer`s, extracted `role_phrase` surfaces |
| What are they **to** me? | **Relation** — spouse/child/parent/sibling/friend/colleague/acquaintance | exists, unused by UI: `Contact.relationship` + `Person.relationshipHint` |

The user's instinct — *"relations as a higher level than kind"* — is exactly right:
**Kind** is the ontological substrate (an organization can never be a relation).
**Relation** is the human-meaningful layer on top of persons. **Roles** are orthogonal to
both: a person can be electrician AND friend; an organization has roles but no relation.

## Scenario table (the spec, as concrete cases)

| Entity | Kind | Contact? | Roles | Relation | Relations tab? |
|---|---|---|---|---|---|
| Emma (daughter, no Dina) | person | no | — | child | ✅ **Family** |
| Sancho (friend with Dina) | person | yes | maybe (his hobby service) | friend | ✅ **Friends** |
| Ravi the electrician | person | yes | electrician | acquaintance (unless also friend) | ✅ **Professionals** |
| Ravi, after he becomes a friend | person | yes | electrician | friend | ✅ **Friends** (role badge "electrician") |
| Bus Depot 42 | **organization** | yes | transit/eta | — (orgs have no relation) | ❌ never (Contacts → Services) |
| Emma's school | **organization** | yes | homework_status | — | ❌ never |
| Dr. Carl (person, runs a clinic) | person | yes | doctor | acquaintance | ✅ **Professionals** |
| Mia (vault-born, no DID) | person | no | — | unknown (hint absent) | ✅ **People** (unclassified) |
| Fresh human contact, zero vault evidence | person | yes | — | unknown | ❌ until evidence (today's rule) |
| Stranger DID (quarantine) | — | no | — | — | ❌ (not even a person row) |

Key consequences encoded above:
1. **Organizations are categorically excluded from Relations** — no heuristic, no evidence
   can promote them. They live under Contacts (a "Services" grouping there).
2. **Human service providers ARE relations** — under a Professionals section. The earlier
   view-filter heuristic got the bus depot right but would have wrongly hidden Ravi.
3. **Relation outranks role for grouping**: friend-who-is-electrician sits under Friends;
   the role becomes a badge. Roles are facts; relation is the social truth.
4. **Multi-role is normal** (electrician + friend); single-relation is enough for v1
   (primary relationship enum; free-form `relationshipHint` preserved as display detail).

## Why known_only makes this structural, not cosmetic

The known_only service design is literally "Contact D2D + grant": every private service a
user consumes REQUIRES the provider in their contacts (offer issuance and acceptance are
both contact-gated). So service entities accumulating in the contact directory — and, today,
the people graph — is not an edge case; it is the designed steady state. Without Kind, every
consumer of the people graph degrades as service adoption grows:
- Relations tab (the reported symptom),
- person-question resolution (`PeopleRepository` routing — "who is Bus Depot 42 to me?"),
- reminder enrichment's person-keyed pre-fetch,
- future briefing/nudge surfaces that enumerate "people in your life."

## Signal sources (how kind/roles/relation get set)

| Signal | Sets | Confidence |
|---|---|---|
| Add-contact toggle "Person / Business" | kind | user-asserted, authoritative |
| Received `service.offer` from a DID | adds role (the offered capability's category) | definitive for ROLE, **not** for kind — the electrician sends offers too |
| `preferredFor` tags ("my dentist") | role | user-asserted |
| Extraction `role_phrase` ("my electrician Ravi") | role (+hint) | suggested |
| Extraction relational hint ("Emma is my daughter") | relation | suggested → confirmable |
| Add/edit-contact relationship picker | relation | user-asserted |

Defaults: kind=person (humans are the common case; the add flow from a *service context*
may default the toggle to Business). Relation=unknown. No silent auto-org heuristics —
mislabeling a person as an organization erases them from Relations, which is worse than the
original bug.

## How classification works (v2 — the LLM decides)

The scenario table above is a **test fixture and prompt-grounding material, not code**.
No rule cascade maps relationship enums to sections; instead:

1. **Storage = facts, not verdicts.** The latent `people.entity_type` column
   (`human|org|service|device|agent|group`, default human — already in schema v5) plus
   `relationship_hint`, surfaces, `preferredFor`, and received offers are the evidence
   record. They are written by extraction and by user action, never by display logic.
2. **An LLM classification pass produces the verdict.** Riding the SAME machinery as
   person-link extraction (`extractPersonLinks` → `applyExtraction`: confidence,
   suggested→confirmed status, idempotent by source+version+fingerprint), the classifier
   reads an entity's evidence (name, how it was added, offers received, vault mentions,
   hints) and emits `{entity_kind, circle, confidence, evidence}` — where `circle` is the
   LLM's free judgment in a small vocabulary (family / friends / colleagues /
   professionals / not-a-personal-relation / unclear). "Unclear" is a first-class answer:
   gradient honored, no forced binning.
3. **Triggers:** contact added (classify from name + context), `service.offer` received
   (re-classify with the new evidence), and the regular extraction passes when vault
   content references the entity. Each is one cheap LLM call; no runtime = classification
   stays pending and the entity renders as unclassified.
4. **User override is authoritative.** A correction on the contact/person detail screen
   (same confirm/correct pattern as surfaces) pins the classification; the LLM never
   overwrites a user-confirmed value (mirrors the existing `created_from llm→user`
   promotion).
5. **The Relations tab is render-only.** Sections render straight from stored
   classifications: Family · Friends · Colleagues · Professionals · People (unclear /
   pending). `entity_kind ≠ human` → not rendered in Relations (the one structural floor
   that is NOT a judgment call: an organization is not a relation by definition of the
   tab). Contacts tab mirrors with People / Services groupings.

Why this beats v1's rules: the electrician-who-becomes-a-friend, the aunt who is also the
family doctor, the school PTA mom who runs the bake-sale service — every interesting case
is a gradient the enum cascade would misfile. The LLM reads the same evidence a human
would and renders the same kind of judgment, with confidence, revisited as evidence
accrues.

## Non-goals (v1)

- No org↔person linking (Dr. Carl the person vs Carl Clinic the org stay separate entries).
- No multi-relation (friend AND colleague) — primary enum + free-form hint suffices.
- No changes to trust/sharing axes (orthogonal security concerns, deliberately untouched).
- No renaming of the `Relationship` enum (it already matches the desired circles).

## Implementation slice (v2)

1. **Wire the latent `entity_type`** through `Person` domain type + repository
   (read in rowToPerson; written by classification + contact-add; no schema change —
   column exists since v5).
2. **Classifier** (`packages/brain/src/pipeline/entity_classification.ts`): LLM call with
   the entity's evidence bundle → `{entity_kind, circle, confidence, evidence}`; applied
   through the people repo with suggested status; idempotent per evidence fingerprint;
   contract-tested with a stub runtime (same pattern as remember_runtime tests).
   A `circle` column (TEXT, default '') joins `entity_type` on the people table —
   greenfield schema bump.
3. **Triggers**: contact-add, offer-receipt, people-graph extraction pass.
4. **Relations tab**: render-only sections from stored circle; `entity_kind ≠ human`
   excluded; pending/unclear → "People". Replaces the v1 interim evidence heuristic.
5. **User override**: classification pin on contact detail (v2-minimal: long-press →
   pick circle; LLM never overwrites pinned).
6. **Brain person-question resolver**: excludes `entity_kind ≠ human` from person-entity
   resolution (service routing untouched — it works off contacts/offers).
7. Badge wording: "Paired" → "Linked".
8. **Tests**: scenario table above as table-driven contract tests against the classifier
   stub; repo round-trips; render grouping; resolver exclusion.
