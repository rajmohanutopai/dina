# Working Memory — Design

**Status:** Draft, pre-implementation. Replaces the hard-coded scenario list
in `brain/src/prompts.py` (search for "bus/train/flight ETAs" — that's the
stopgap this doc retires).

**Author:** Dina team
**Date:** 2026-04-18


## 1. Problem

The reasoning agent (`brain/src/service/vault_context.py`) defaults to
`search_vault` for almost every question. That works when the vault has
50 items; it breaks once the vault holds thousands. Two concrete failure
modes we've already seen:

1. **Natural-language service queries miss the public-services path.**
   A user asks "when does bus 42 reach Van Ness?" — the LLM correctly
   geocodes the place, then spends six turns calling `search_vault` for
   bus data that was never stored, hits `max_turns_reached`, and returns
   a generic answer. Live transit data cannot be in the vault; searching
   it is a guaranteed waste.

2. **Vault queries don't know what's in the vault.** The current tools
   (`list_personas`, `search_vault`, `browse_vault`) describe vault
   *structure* (persona names, recent summaries) but not vault *scope*
   (what topics / entities are actually covered). With 5,000 items the
   "recent summaries" are a keyhole view; the LLM must guess whether to
   search.

We need the LLM to know, before calling any tool, **what kinds of things
the user has captured in memory and what's top of mind right now** — the
same thing a human carries around as working memory.


## 2. Non-goals

- Replacing `search_vault`. The ToC is a routing aid; full content
  retrieval still happens through existing tools.
- Building a generic recommender or trending-topics engine.
- Surfacing information from locked personas. A locked persona's topics
  do not appear in the ToC until unlocked.
- Static "importance" boosts. If a topic isn't being mentioned, it
  isn't top of mind; that's the honest signal. Direct queries
  (`/ask what medications do I take?`) still find low-salience items
  through `search_vault`.


## 3. Design principles

| Principle | Why |
|---|---|
| Working memory, not inventory | A flat listing of every topic fails at scale; humans don't recall that way either. Salience-ranked, decaying. |
| EWMA mechanism, ACT-R shape | Power-law decay is the cognitive-science reference; exponential decay is a well-known approximation that costs O(1) per event and O(1) per read. |
| Recency × frequency, nothing else | No static importance, no editorial boosts. Signal from behavior, not authorial intent. |
| ToC is a context map, not a router | It tells the LLM "you have relevant context here," not "the answer lives here." Live questions still hit public services; ToC just parameterizes them. |
| No scenario enumeration | The LLM must generalize, not pattern-match a hand-written list. |


## 4. Data model

One row per topic per persona.

```sqlite
CREATE TABLE topic_salience (
    persona TEXT NOT NULL,
    topic TEXT NOT NULL,               -- canonical topic name
    kind TEXT NOT NULL,                -- 'entity' | 'theme'
    last_update INTEGER NOT NULL,       -- unix seconds
    s_short REAL NOT NULL DEFAULT 0,    -- EWMA, tau=14d
    s_long  REAL NOT NULL DEFAULT 0,    -- EWMA, tau=180d
    live_capability TEXT,               -- e.g. 'appointment_status' if the
                                        --   entity's DID publishes one
    live_provider_did TEXT,             -- the DID to query via public_services
    sample_item_id TEXT,                -- one recent vault item for inspection
    PRIMARY KEY (persona, topic)
);
CREATE INDEX topic_salience_rank ON topic_salience(persona, s_long DESC);
```

Persisted in Core (same SQLCipher persona databases as other indexed
state). Exposed to Brain through a new narrow endpoint
`GET /v1/memory/toc?persona_filter=...` (read-only, Brain-allowlisted).


## 5. Scoring

One formula, two timescales:

```python
def salience(row, now_ts):
    dt_days = (now_ts - row.last_update) / 86400
    s_short = row.s_short * math.exp(-dt_days / 14)
    s_long  = row.s_long  * math.exp(-dt_days / 180)
    return s_long + 0.3 * s_short
```

On every mention (ingest-time):

```python
def touch(row, now_ts):
    dt_days = (now_ts - row.last_update) / 86400
    row.s_short = row.s_short * math.exp(-dt_days / 14)  + 1
    row.s_long  = row.s_long  * math.exp(-dt_days / 180) + 1
    row.last_update = now_ts
```

Coefficients (0.3 for s_short, 14d/180d taus) are starting points; tune
from real-usage traces before first ship.


## 5.5 Foundation we're building on

This design is largely plumbing on top of infrastructure that already
exists. Worth naming explicitly so we don't accidentally propose
parallel systems:

| Piece | Already in the codebase | Reuse in this design |
|---|---|---|
| **Per-persona HNSW index** | `github.com/coder/hnsw`, cosine distance, 768-dim, lives in Core (`core/internal/adapter/sqlite/hnsw_index.go`), hydrates on unlock, discarded on lock | Topic canonicalization nearest-neighbor lookup (§6.2). No new library, no new embedding pipeline. |
| **Hybrid search (FTS5 + vector)** | `0.4 × FTS5 + 0.6 × cosine` blend in `core/internal/service/vault.go` HybridSearch | `search_vault` unchanged — ToC is a routing aid on top of it, not a replacement. |
| **768-dim embeddings** | EmbeddingGemma / gemini-embedding-001 pipeline, already generates per-vault-item embeddings at enrichment time | Embed topic strings on extraction with the same model — ensures alias-matching operates in the same vector space as the rest of the vault. |
| **Staging enrichment LLM call** | Runs today during `staging_processor.py`; produces `content_l0` summaries | Extend the same call to also emit `entities: []` and `themes: []`. One call per ingest, no new LLM touchpoint. |
| **Contacts table (DID → name)** | In Core, Tier 0 `identity.sqlite` | Entity → DID resolution for the `live_capability` marker (§6.1). |
| **AppView service-profile lookup** | `GET /xrpc/com.dina.service.search` | DID → capability discovery for the `live_capability` marker (§6.1). |
| **Per-service auth allowlist** | `brainAllowed` in `core/internal/adapter/auth/auth.go`; exposes `/v1/service/*` and a handful of others to Brain | Add `/v1/memory/*` as a new prefix (narrow, read-only for ToC; POST-touch for ingest). |

Net new code: the `topic_salience` table, the touch/salience math
(~6 lines), the `/v1/memory/*` endpoints, the classifier call wiring,
and the prompt-template changes. Everything else is reuse.


## 6. What is a topic?

A **topic is a named handle for something that recurs in what the user
has told Dina** — a string the LLM can read and reason about. Think of
it as what you'd label a folder if you were organizing your life into
folders: "Sancho", "HDFC FD", "tax planning", "daughters school."

Three properties that make something a topic:

- **It labels a cluster of mentions, not a single item.** "Sancho" ties
  together 30 vault items that reference him. "my 2023-04-15 dentist
  visit" is an *item*, not a topic; "dentist appointments" *is* a topic
  because it spans multiple items.
- **It's the user's vocabulary, not a fixed taxonomy.** We don't have a
  master list of allowed topic names. The LLM invents them at ingest;
  canonicalization folds near-duplicates together.
- **It's a search hook, not an answer.** Seeing "HDFC FD" in the ToC
  tells the LLM *there exists vault content here worth searching* — not
  what the content says.

Two sub-kinds, differing in how they're extracted:

| Kind | What it is | Example | How extracted |
|---|---|---|---|
| `entity` | Named proper noun (person, place, org, named event) | Sancho, HDFC, Dr Carl, Castro Station | NER at ingest |
| `theme` | Recurring concern, domain, or common-noun phrase | back pain, tax planning, daughters school, work stress | LLM tag during enrichment |

Entities are mostly unambiguous (one "Sancho"); themes cluster fuzzily
("tax planning" ≈ "tax filing" ≈ "taxes"). Canonicalization handles the
fuzziness.

### 6.1 `live_capability` marker

When an entity topic corresponds to a contact or provider that publishes
a Dina service capability, the topic row carries a `live_capability`
marker. This is what lets Dina answer "is my dentist appointment still
confirmed?" by combining vault context (appointment details) with a live
query to the dentist's DID.

Populated at ingest:

1. Staging enrichment extracts entity `Dr Carl`.
2. Brain resolves `Dr Carl` → `did:plc:drcarl` via the contacts table.
3. Brain looks up that DID's service profile in AppView.
4. If the profile advertises capability `appointment_status`, the topic
   row gets `live_capability = "appointment_status"` and
   `live_provider_did = "did:plc:drcarl"`.

Refreshes on contact re-resolve or on a TTL (e.g., daily check against
AppView). No marker → no live-capability path → classifier falls back to
vault-only with a degraded answer.

This is the mechanism that scales Dina's services model from big
institutions (BusDriver as SF transit) to personal relationships (your
dentist, mechanic, dog walker — each can publish a profile; your Dina
treats them identically).

### 6.2 Canonicalization

Store a canonical form; at extraction time map variants to the canonical
form via a `topic_aliases` table (separate, small) populated by:

1. Exact-match lookup on lowercase + simple stemming
2. Embedding-similarity lookup (> 0.9 cosine) against existing canonicals
3. If no match, the new variant becomes its own canonical

Step (2) reuses existing infrastructure: Core already runs an in-memory
HNSW index per persona (`github.com/coder/hnsw`, cosine distance,
768-dim embeddings) that hydrates on persona unlock for hybrid search.
The same index and embedding model apply directly to canonical-topic
nearest-neighbor lookup — no new library, no new embedding pipeline. We
just add a separate `topic_canonicals` node set within the existing
index, or a second small HNSW graph per persona scoped to canonicals
only. Either way it's a handful of lines of plumbing.

Getting this wrong fragments salience across duplicate rows. Start with
exact + stemmed match; promote to embedding similarity as soon as we see
fragmentation in real usage — it's cheap to add given the existing
HNSW foundation.


## 6.5 Two-axis routing model

Every user query decomposes along **two orthogonal axes** the classifier
reads from the query text (not from a scenario list):

1. **Source of context** — does the query need the user's own data?
   Self-referential grammar is the tell: *"my"*, *"I have"*, *"for me"*,
   *"supposed to"* → vault context needed. Generic grammar without a
   possessive — *"when does bus 42 come?"*, *"what's the weather?"* →
   vault not needed for context.

2. **Temporal nature** — does the answer depend on live state?
   Tense and aspect tell us. *"still confirmed?"*, *"right now"*,
   *"currently"*, *"on time?"* → live state needed. *"what did I say?"*,
   *"when is it scheduled?"*, *"what do I know about?"* → static.

The two axes form a matrix:

|  | **Static fact** | **Live state** |
|---|---|---|
| **Vault context needed** | Vault only | Vault (for context) + public_service (for state), compose |
| **Vault context not needed** | Trust network or general knowledge | Public_service only |

Four worked examples:

| Query | Source | Temporal | Sources called |
|---|---|---|---|
| "what medical conditions do I have?" | self | static | vault(health) |
| "is my dentist appointment still confirmed?" | self | live | vault(health) + public_service(appointment_status via Dr Carl's DID) |
| "is the Aeron chair worth buying?" | — | static | trust_network |
| "when does bus 42 come?" | not-self | live | public_service |

And the ToC's role: tells the classifier whether vault context is
*available* (the entity has been stored) AND whether a `live_capability`
path exists for that entity.


## 7. Mention attribution

Extend the existing staging enrichment step
(`brain/src/service/staging_processor.py`):

1. When an item lands in a persona, LLM enrichment already produces a
   one-line summary (`content_l0`).
2. Add two new outputs: `entities: []`, `themes: []`.
3. For each extracted topic, Brain calls
   `POST /v1/memory/topic/touch {persona, topic, kind}` on Core.
4. Core updates the EWMA counters.

No change to the vault item row itself. The topic index is a separate
derived structure; rebuild from scratch is safe (read items, walk
enrichment output, replay `touch`).


## 8. ToC render

The format the LLM sees, injected into the reasoning-agent system prompt
at turn zero:

```
Working memory (what's top of mind right now):

health: dentist appointment (2d ago), Dr Carl (3mo)
finance: HDFC FD (1w), 2025 tax return (2mo), SIP
general: daughters school (ongoing), reading list, home repairs
social: Sancho (2w), Albert (3mo)
```

Rules:
- Up to 50 topics total across unlocked personas, ranked by
  `salience`. Threshold (below which topics are elided) is dynamic based
  on salience distribution.
- Show age only for entity topics with a single clear timestamp; elide
  for themes that span many items.
- Omit locked personas entirely — not even their names.
- Refresh at every reasoning turn (cheap — it's a single indexed query).


## 9. Intent classifier

A small, fast LLM call before the reasoning agent starts. Gemini Flash
or equivalent, single turn, no tools. ~300ms.

**Architecture:** the classifier reads the ToC; the reasoning agent does
**not**. The reasoning agent receives only the classifier's structured
output. Two reasons:

1. **Token economy.** The ToC is ~400 tokens; loading it into every
   reasoning-agent turn (up to 5 turns per query) costs ~2000 tokens
   repeated per `/ask`. Classifier distills it once.
2. **No reinterpretation risk.** If both LLMs saw the ToC, they could
   disagree about what it meant — two LLM minds, one shared artifact,
   silently diverging. Classifier makes the routing decision; reasoning
   agent acts on it.

### 9.1 Source semantics (for the classifier's prompt)

The classifier doesn't memorize a list of scenarios. It reads these
three source definitions and decides for itself:

> - **vault** — the user's own captured data: preferences, relationships,
>   personal plans, life facts, past decisions, notes.
> - **trust_network** — peer-verified *opinions and reputation* about
>   products, services, vendors, people. Static (opinions at a point in
>   time).
> - **public_services** — live queries to service providers for *current
>   operational state* (ETA, status, availability, pricing, inventory).
>   Dynamic (changes minute to minute).

Then one instruction: *"For any query, name the sources needed. It can
be more than one."* The classifier generalizes from the definitions, not
from examples. No scenario list.

### 9.2 Classifier output

```json
{
  "sources": ["vault", "public_services"],
  "relevant_personas": ["health"],
  "toc_evidence": {
    "entity_matches": ["Dr Carl", "dentist appointment Apr 19"],
    "theme_matches": [],
    "persona_context": {
      "health": ["Dr Carl", "dentist appointment Apr 19", "knee pain", "blood tests"]
    },
    "live_capabilities_available": [
      {
        "provider": "did:plc:drcarl",
        "capability": "appointment_status",
        "for_entity": "Dr Carl"
      }
    ]
  },
  "temporal": "live_state",
  "reasoning_hint": "ToC shows 'dentist appointment Apr 19' and 'Dr Carl' in health persona; Dr Carl publishes appointment_status service. Read vault for appointment details, then query Dr Carl's service for live confirmation, synthesize."
}
```

Field-by-field:

- `sources` — ordered list of which sources to consult. Can be multi-valued.
- `relevant_personas` — for vault-bound queries, which persona(s) to search.
- `toc_evidence` — *what the classifier actually saw in the ToC* that drove
  the decision. Three sub-fields:
  - `entity_matches` — ToC entities appearing in the query
  - `theme_matches` — ToC themes matching the query's domain
  - `persona_context` — for each relevant persona, the topics the ToC shows
    (anchors the reasoning agent can latch onto)
  - `live_capabilities_available` — entities in the ToC whose
    `live_capability` marker means public-services can answer about them
- `temporal` — `static` | `live_state` | `comparative`.
- `reasoning_hint` — freeform summary tying it all together for the
  reasoning agent.

The `toc_evidence` block is what gives the reasoning agent concrete
anchors (and gives us debuggability when routing misses).

### 9.3 Placement

Guardian's `_handle_reason` runs the classifier before
`vault_context.gather_with_reasoning_agent`. Classifier output is
injected into the reasoning agent's first-turn context; the ToC itself
is not.

**Soft, not hard.** The classifier's output is advisory — the reasoning
agent can still call any tool if the query evolves or the classifier
missed something. We start with soft priming; tighten to hard
shortlisting only if we see the reasoning agent ignoring good advice.


## 10. Integration

- **Remove the stopgap rule** in `prompts.py` that enumerates transit /
  weather / delivery scenarios. The ToC + intent classifier provide the
  same routing without the hard-coded list.
- **Keep the existing tools** — `search_vault`, `browse_vault`,
  `search_public_services`, etc. ToC just primes the decision.
- **Drop `list_personas`** — the ToC supersedes it. Any call sites
  switch to reading the ToC.


## 11. Build order

Greenfield — no one is using the repo, no migrations, no feature flags.
A natural build order for fitting the pieces together:

1. **Schema + counters.** Add `topic_salience` + `topic_aliases`
   tables; write `touch()` + `salience()`.
2. **Topic extraction in the staging enrichment step.** Entities via
   NER, themes via LLM tags; wire `touch` calls.
3. **ToC read endpoint + Brain client** (`GET /v1/memory/toc`).
4. **ToC + intent-classifier context injection** into the reasoning
   agent's first turn. Replace the stopgap in `prompts.py` at the
   same time.


## 12. Edge cases

- **Stale vault data.** Items carry `occurred_at` (event time, not
  ingest time). Items with `occurred_at` in the past and no recent
  mention decay naturally; nothing special needed.
- **Seasonal topics.** "Diwali" spikes annually. Long-tau EWMA handles
  this — the spike from last November stays in `s_long` throughout the
  year, then re-spikes.
- **Cross-persona topics.** "Sancho" appears in social AND general. We
  store one row per (persona, topic) pair; the ToC render de-duplicates
  by topic name with "(in social, general)" annotation.
- **Locked personas.** ToC query filters by unlocked personas only.
  If the intent classifier believes a locked persona would be
  relevant, it emits a `locked_personas_may_contain_answer` hint and
  the reasoning agent surfaces: "some information may be in locked
  personas — unlock to include."
- **Topic explosion.** If topic count per persona exceeds ~500, we cap
  and retire the lowest-salience rows. Salience below 0.01 after
  decay → candidate for retirement.


## 13. Open questions

1. **Embedding-similarity canonicalization — V1 or V2?** Simpler V1
   (exact + stemmed match) risks fragmenting "tax plan" from "tax
   planning." More complex V1 (embedding-cosine) costs one embedding
   per extracted topic. Lean V1 simple, V2 embedding.
2. **How much does the intent classifier actually decide?** Hard
   shortlist (only these tools callable) vs soft priming (all tools
   available but preference expressed). Soft is safer; hard is more
   efficient. Start soft.
3. **LLM cost for theme extraction per ingest.** Gemini Flash is cheap
   but non-zero. If ingest volume is high, batch extraction. Measure
   before worrying.
4. **Do we care about the Hetzner / AppView side of memory?** Public
   services advertise capabilities; a user's trusted contacts advertise
   reputation. Should the ToC include "Sancho has a drone-delivery
   service" type facts from Trust Network? Probably yes, as a fourth
   kind — `kind='external_capability'`. Design TBD; defer to after
   vault ToC ships.
5. **Privacy surface of the ToC itself.** The ToC is a concentrated
   summary of what the user cares about. If it were ever exfiltrated,
   it would be a richer leak than individual items. Treat it like
   vault content — never log to stdout, never persist outside the
   persona's SQLCipher file.


## 15. Validation scenarios

The fifteen routing-behavior scenarios this design must satisfy, to be
exercised as real Telegram + Gemini end-to-end tests in
`tests/sanity/test_working_memory_routing.py`. Grouped by the §6.5 matrix
cell each lives in. Each scenario names the query, the pre-seeded vault
state it assumes, the routing the classifier should emit, and the
assertion on the final answer.

| # | Cell | Query | Pre-seed | Expected sources | Answer contains |
|---|---|---|---|---|---|
| 1 | self + static | "what's my FD rate at HDFC?" | Finance: "HDFC FD rate 7.8%" | vault(finance) | `7.8`, `HDFC` |
| 2 | self + static | "what health things have I been dealing with lately?" | Health: "knee pain off and on for 3 weeks", "blood test Apr 10 cholesterol high" | vault(health) | `knee` or `blood` or `cholesterol` |
| 3 | self + static | "when's Sancho's birthday?" | Social: "Sancho's birthday is June 12" | vault(social) | `June 12` or `Jun 12` |
| 4 | self + static | "what books am I reading?" | General: "reading Sapiens by Harari", "started The Three-Body Problem last week" | vault(general) | `Sapiens` or `Three-Body` |
| 5 | not-self + live | "when does bus 42 reach Van Ness?" | None — BusDriver publishes `eta_query` on AppView | public_services | `min` + map URL |
| 6 | not-self + static | "is the Herman Miller Aeron chair worth buying?" | None — trust network has reviews | trust_network | sourced language ("reviews say…", "peers rate…") |
| 7 | self + live (service available) | "is my dentist appointment still confirmed?" | Health: "dentist Dr Carl Apr 19 at 3pm"; contact `Dr Carl` → `did:plc:drcarl`; drcarl publishes `appointment_status` | vault(health) + public_service | `confirmed` or explicit status + appointment details |
| 8 | self + live (no service) | "is my flight AI 123 on time tomorrow?" | Travel: "AI 123 Tokyo Oct 20 2pm"; no flight-status provider registered | vault(travel) → attempt public_service → fallback | flight details + "no live status available" |
| 9 | self + comparative | "should I switch my FD from HDFC to ICICI?" | Finance: "HDFC FD 7.8%" + "ICICI savings account open" | vault(finance) + trust_network | current rate cited + comparative note |
| 10 | ambiguous | "what's on for tomorrow?" | Health: dentist Apr 19; General: "daughter school play Apr 19 evening" | vault (multiple personas) | both events |
| 11 | locked persona | "what appointments do I have?" (health persona locked) | Health locked (dentist item present but inaccessible) | vault (limited) + locked-persona hint | visible items + "unlock health to include more" |
| 12 | long tail | "what was that Harari book I started last year?" | Item stored 14 months ago, low salience | vault via search | `Sapiens` (or the correct title) |
| 13 | multi-hop | "how do I get to Dr Carl's office by bus?" | Health: "Dr Carl at 1234 Castro St, San Francisco" + BusDriver published | vault(health) for address → public_service(eta_query) for route | an ETA + reference to Castro / Dr Carl |
| 14 | self + static (recent-activity recall) | "did Sancho send me anything lately?" | Social: "Sancho messaged about dinner last Tuesday" | vault(social) with recency bias | `Sancho` + the recent content |
| 15 | not-self + live (generic) | "what's the weather in Bangalore right now?" | No weather provider registered | public_service attempt → honest "no provider" | "no weather service available" (not a hallucinated forecast) |

Each scenario has three failure modes we need to catch:

- **Wrong source**: classifier routed to vault when it should have gone
  external (or vice versa).
- **Dropped source**: classifier went only to vault when the compositional
  cases (7, 8, 9, 13) required both.
- **Hallucinated answer**: source said no, LLM made something up. This is
  the worst failure — why case 15 is on the list.

We write these as Telethon-driven tests using Alonso's bot, pre-seeding
the vault per scenario via `/remember`, then sending the query via
`/ask`. Actual Gemini — no mocks. The test file lives at
`tests/sanity/test_working_memory_routing.py` and is gated behind
`SANITY_WM_ENABLED=1` so normal test runs aren't billed on Gemini.


## 16. Anti-goals, restated

We are not:
- Enumerating scenarios in the system prompt.
- Adding static importance scores.
- Building a recommender.
- Surfacing locked-persona topics before unlock.
- Attempting a memory-persistence layer outside the vault.

We are:
- Making the LLM's implicit question ("what kinds of things might the
  user know?") answerable before it calls a tool.
