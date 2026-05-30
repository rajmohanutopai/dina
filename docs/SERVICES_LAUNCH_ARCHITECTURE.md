# Services — Launch Architecture (capability discovery, pollution, coverage)

**Status: IMPLEMENTED.** All three Parts have landed. The shared
`capability-registry.ts` (+ byte-identical `@dina/protocol` copy),
`dimension-registry.ts`, and `subject_identifier.ts` exist; the
`com.dina.service.searchCapabilities` endpoint + `search_capabilities`
brain tool are wired; ingest/search/discovery/provider-ingress/egress all
canonicalize capabilities (alias↔canonical); PeerLens dimensions
canonicalize on the read/aggregate side with drop-unknown metering;
subject identity uses type-specific Tier-1 precedence + the per-type
identifier canonicalizer at `RESOLVER_VERSION = 'v3'`. See
`implementation-notes.html` (root) for the per-iteration build log,
design decisions, and the two documented divergences (dimension
write-side is clean-by-omission, not chips — see Part 2 Layer 2 below;
dimension query-construction is deferred — Part 2 Layer 4). This document
is now the as-built reference, not a plan.

---

## Root cause, in plain English (read this first)

If you've never seen this code, here is the whole problem in one picture.

**What "Services" does.** You ask Dina a real-world question — *"when
does bus 42 reach Castro?"* Dina doesn't know the answer herself. So she
has to (1) figure out **what kind of service** can answer this, (2)
**find a provider** who offers that kind of service, and (3) **ask
them**. Step 2 is a lookup in a directory (the "AppView"). Step 1 is the
part that's broken.

**The hidden middleman: the "capability."** Providers don't register as
"a bus." They register a *capability* — a short machine label for **the
kind of question they can answer**. A transit provider registers, say,
`transit_eta`. A restaurant registers `reservation`. When Dina searches
the directory, she doesn't search for "bus" — she searches for the
**capability string**. The directory then returns every provider who
published that exact string.

Think of the capability as a **filing-cabinet drawer label**. Providers
file themselves under a drawer. Dina, to find them, has to open the
*exact* drawer. There is no "search all drawers for buses" — she must
name the drawer.

### Problem 1 — Dina has to GUESS the drawer label, and a wrong guess finds nothing

Today, nothing tells Dina what the real drawer labels are. The code that
asks her to search has **one example baked into its instructions**:
"e.g. `eta_query` for transit ETAs." So when you ask about the bus, the
AI reasons *"arrival time… that's an ETA query"* and types the string
`eta_query` from memory.

This works **only if the AI's guess exactly matches the label the
provider filed under.** It's a blind guess at a drawer label:

- AI guesses `eta_query`. Provider filed under `bus_eta`. → **Different
  drawer. Zero results.** Dina says "I couldn't find a service," even
  though the bus provider is right there in the next drawer.
- Ask the same question twice and the AI might type `eta_query` once and
  `transit_eta` the next time. **Non-deterministic** — the feature works
  or doesn't depending on the model's mood.

The root issue: **there is no list of real drawer labels. The AI invents
the search key instead of choosing from what actually exists.**

### Problem 2 — Anyone can invent a new drawer label, so the drawers multiply (pollution)

The capability is a **free-form text field**. The only processing is
"lowercase it and trim spaces." Nothing forces two providers offering
*the same kind of service* to file under the *same* label.

So as real providers arrive, the *same* service splinters across many
drawers:

```
transit provider A  →  files under  "eta_query"
transit provider B  →  files under  "bus_eta"
transit provider C  →  files under  "transit_arrival"
```

These are three drawers for **one kind of service**. Now even if Dina
guesses perfectly, she opens *one* drawer and sees only *one third* of
the bus providers. The directory is **polluted** — the same concept
scattered under many synonyms, so no single search ever sees all of it.

This is the quiet killer: it doesn't error. It just silently returns an
incomplete answer, and it gets worse as more providers join.

### Problem 3 — Even a perfect search finds nothing if no provider exists

Suppose we fix the labels perfectly. You ask *"when's the 38 to
downtown?"* If **no transit provider has joined Dina yet**, the search
correctly returns nothing — and on a feature we're putting in the
marketing video, "nothing" on the first try reads as "broken."

### The fix, in one sentence

Stop letting either side use free text. **Define a small, official list
of drawer labels (a "canonical registry").** Providers get filed under
the official label even if they typed a synonym (no more pollution).
Dina, instead of guessing, is handed the list of labels **that actually
have providers behind them** and picks the matching one — or honestly
says "there's no Dina service for that yet" (no more blind guessing, no
more fake-empty results). That official list is the spine of everything
below.

> **One scaling note (settled).** The consumer-side step is shaped as
> `search_capabilities(intent, geo?)` — Dina passes the user's *intent*
> ("bus arrival time"), not a guessed label, and the AppView returns the
> matching real capabilities. At launch the candidate set is tiny (it's
> filtered to capabilities that actually have a provider, in 2 domains),
> so it just returns them all. At scale, the *kinds* of service are
> bounded (verb-like — hundreds, not millions of *instances*), so the
> same endpoint can rank candidate labels by an embedding of the intent
> and return the top ~10 — **a server-side swap, invisible to Dina, no
> client change.** We build the intent-based contract now and keep the
> implementation simple for launch. See "Layer 4" below.

---

## The three problems

1. **Consumer guessing (Bug 1).** Today the brain LLM *invents* the
   capability string (`eta_query`) from a single example in the
   `search_provider_services` tool description, then exact-matches. If
   the LLM's guess ≠ the provider's published string, search returns
   nothing — silent miss on the flagship feature.

2. **Pollution (Bug 2).** `capability` is a free-form string at both
   ingest and search (only `.trim().toLowerCase()`). Different providers
   coin `eta_query` / `bus_eta` / `transit_eta` → fragmented namespace →
   consumers find only the providers who happened to pick the same word.

3. **Coverage.** Even with perfect matching, an off-script query
   ("when's the 38 to downtown") returns nothing if no provider exists.
   On a flagship feature, first-use emptiness reads as "broken."

## Decisions (locked)

- **NO public-data fallback.** Feeding a public feed/scrape to the LLM
  for a live answer risks hallucinated facts on the one feature where
  verifiable correctness is the whole point. Dina answers **only from a
  real signed provider, or honestly says nothing.** Public-data Q&A is
  ChatGPT's job.
- **Scoped coverage, honest empty-state.** Seed real providers for a
  small set of marketed domains; anything else → graceful "No Dina
  service for that yet" card. **2 domains** at launch so cross-domain
  query testing surfaces mis-routing.
- **The registry is a SHARED CODE MODULE, not a runtime fetch (P2 —
  corrected).** Earlier this said "brain reads it at runtime via xRPC."
  That is WRONG for one consumer: **Core's provider ingress check
  `isCapabilityConfigured` is sync-by-design** (`service_config.ts` —
  "sync hot paths… don't need to await"). It cannot `await` an AppView
  call at D2D ingress. So the canonical resolver must live where every
  consumer can call it **synchronously and locally**:
  - **Source of truth:** one authored registry module (AppView authors +
    owns the vocabulary).
  - **Distribution:** published/exported as a **shared module/generated
    artifact** that AppView, Brain, Core, and mobile all import — *code*,
    not a network call. (Mirrors how `@dina/protocol` is the shared wire
    contract.) AppView is standalone (not in the root workspace), so the
    practical mechanism is a generated/copied registry file or a tiny
    published package consumed by both sides — NOT cross-workspace
    imports and NOT an ingress-time HTTP hop.
  - **No drift:** a single generator/source; a check-in test asserts the
    AppView copy and the `@dina/*` copy are byte-identical (same pattern
    as the OpenAPI `generate:check` gate).
  - The `search_capabilities` xRPC still exists — but for **coverage**
    ("which canonical capabilities have providers right now"), NOT to
    *transport the vocabulary*. Vocabulary = code; coverage = query.
- **Discovery is INTENT-BASED, not "list the catalogue."** This is the
  decision that matters for the near future, so it's stated here as
  locked. The consumer tool is `search_capabilities(intent, geo?)` — Dina
  passes the user's *intent* in natural language ("when's the bus"), and
  the AppView returns the real, canonical capabilities that can serve it.
  We do **not** dump the whole capability list for the LLM to scan.

  Why this is the right call for the near future (not just today):

  1. **Same cost at launch.** With 2 domains and a coverage pre-filter
     (only capabilities that *have* a provider), the candidate set is
     tiny — the endpoint just returns all matches. No ranking, no
     embedding needed yet. Zero extra launch work vs. a dump.
  2. **It scales without a client change.** Capability *kinds* are
     bounded — verb-like (`transit_eta`, `reservation`, `appointment`,
     `price_quote`…), hundreds at maturity, not the millions of provider
     *instances*. When the with-provider set eventually grows large, the
     AppView embeds the `intent` and cosine-ranks against precomputed
     canonical-description embeddings → returns the top ~10. That's a
     **server-side swap behind the same endpoint** — Dina's tool contract
     never changes, no app relaunch, and it reuses the gemini-embedding
     infra we already run (no new vector dependency).
  3. **It makes the Bug-1 fix *robust*, not just *patched*.** Passing the
     intent (not a guessed label) means at scale the **retrieval does the
     intent→capability mapping deterministically** (embedding match),
     instead of an LLM scanning a long dumped list and guessing. The same
     interface that fixes guessing at launch (tiny list → LLM picks)
     becomes the deterministic fix at scale (embedding picks).
  4. **`top ~10`, never `~100`.** Retrieval narrows to a set the LLM can
     reason over precisely. Dumping 100 candidates wastes tokens and
     dilutes selection; specific intents resolve cleanly in the top
     handful.

  Net: build the intent-based contract now, keep the implementation
  trivial for launch, and the scale upgrade is invisible. We are NOT
  building embedding retrieval tonight — only the contract shape and the
  coverage-filtered launch implementation. See Layer 4.

## The canonical capability registry (source of truth, in appview)

`appview/src/shared/capability-registry.ts` — a static, closed list for
launch:

```
interface CanonicalCapability {
  canonical: string;        // 'transit_eta'
  aliases: string[];        // ['eta_query','bus_eta','arrival_time',...]
  description: string;      // human/LLM-readable "what this answers"
  domain: string;           // 'transit' | 'appointments' (for grouping/marketing)
}
```

**Canonical names = the INCUMBENT strings (release-risk decision, locked).**
`eta_query` is already the capability string across the TS tool
descriptions, `appview_stub.ts`, and the demo. To avoid a cross-cutting
rename of every config/schema/test/demo path the night before launch, the
**canonical name is the incumbent**, and tidier names become aliases:

**The 2 launch domains are LOCKED to what is actually seedable (P2 —
corrected; "dining" was aspirational).** The existing demo paths are
transit (`eta_query`, bus42-agent) and a clinic appointment check
(`appointment_status`, Dr Carl demo — `appview_stub.ts`). Building a
fresh dining provider the night before launch is a shortcut we are NOT
taking; we use the two that already have working provider+responder code:

- **transit** → canonical `eta_query` — "Estimated arrival time for a
  public transit route at a stop." aliases: `transit_eta`, `bus_eta`,
  `arrival_time`, `next_bus`. (params: route + stop/location)
- **appointments** → canonical `appointment_status` — "Check the status /
  next availability of an appointment with a provider." aliases:
  `appointment_query`, `appt_status`, `booking_status`. (params:
  patient_id + date) — a deliberate contrast to ETA: different param
  shape + intent (identity-bearing params, no geo), so cross-domain
  routing AND the requester-autofill path are exercised.

(Dining/`reservation_availability` is a clean *post-launch* third domain
when a real provider exists — same registry shape, additive.)

This registry powers all five uses below from one definition.

## The five layers

> **Review correction (P1a/P1b — verified in code).** The original draft
> scoped canonicalization to the AppView *index only*. That is wrong and
> would break execution two ways:
>
> - **Provider ingress is an EXACT match.** `service_config.ts`
>   `isCapabilityConfigured` does `hasOwnProperty(cfg.capabilities, cap)`,
>   and `bypass.ts` denies inbound `service.query` with `not_configured`
>   if it misses. So if the consumer sends a *canonical* string the
>   provider's *local config* doesn't have verbatim, the provider drops
>   its own query. Canonicalization MUST be consistent at the provider
>   boundary too (Layer 5), not just in the AppView index.
> - **Sibling maps must be re-keyed together.** Ingest normalizes
>   `capabilitiesJson` but stores `capabilitySchemasJson` and
>   `responsePolicyJson` raw; search reads `schemasObj[normalized]`. If
>   the array is canonical but the schema/policy maps stay alias-keyed,
>   search returns the provider with a NULL schema/hash. Layer 2 must
>   canonicalize the **keys of those maps**, not just the array.

### Layer 1 — Canonical registry + alias resolution (pollution fix)
- `resolveCanonicalCapability(raw): string | null` — trim/lowercase, then
  map through the alias table → canonical. Returns `null` for a string
  not in the registry. Pure function; the shared module every other layer
  imports (see "registry is a shared code module" above).

**Unknown capabilities are NOT indexed as public/canonical (P1 —
corrected; this was a pass-through hole).** An earlier draft let unknown
strings "pass through normalized," which re-opens the exact pollution
this fix closes — an unknown `bus_eta` would sit in the public index as a
canonical-ish label nobody else searches for. For the closed launch
vocabulary, an unrecognised capability is **not surfaced in public
discovery.** Concretely:
- **Ingest (Layer 2) — per-capability, NOT per-profile (P2 corrected):**
  the `services` row has only a **row-level** `isDiscoverable` boolean
  (`db/schema/services.ts`), no per-capability flag. So "mark the unknown
  one non-discoverable" must NOT toggle the whole profile off — a provider
  with one known (`eta_query`) + one unknown (`weird_thing`) capability
  must still be discoverable for the known one. The fix is at the
  **array level, not the row level:** store only the **known canonical
  capabilities** in the public `capabilitiesJson` (and only their entries
  in the re-keyed `capabilitySchemas`/`responsePolicy`). Unknown
  capabilities are **dropped from the public arrays + metered**
  (`service.capability.unknown{cap}`) — kept (if anywhere) on a
  side/audit field, never in the searchable `capabilitiesJson`. Profile
  stays discoverable; only the unknown capability is excluded.
- **Search (Layer 3):** a consumer query for an unknown string resolves
  to `null` → returns the honest empty-state, never a partial-namespace
  hit.
- Same philosophy as the dimension drop-unknowns rule (Part 2, P1e):
  unknown ⇒ quarantined + visible, never silently treated as canonical.

### Layer 2 — Ingest canonicalization (provider side, pollution at source)
- `appview/src/ingester/handlers/service-profile.ts`: run each published
  capability through `resolveCanonicalCapability` before storing. A
  provider who publishes `bus_eta` is indexed as `eta_query` (canonical).
- **P1b — re-key the sibling maps to match.** After canonicalizing the
  `capabilities` array, rebuild `capabilitySchemas` and `responsePolicy`
  so their KEYS are the canonical names too (`capabilitySchemas['bus_eta']`
  → `capabilitySchemas['eta_query']`). Otherwise `search`'s
  `schemasObj[normalizedCapability]` lookup returns null and the provider
  surfaces with no schema/hash. On a key collision (two aliases of the
  same canonical in one record) keep the first and log.

### Layer 3 — Search canonicalization (consumer side, exact-match safety)
- `appview/src/api/xrpc/service-search.ts`: replace the bare
  `.trim().toLowerCase()` with `resolveCanonicalCapability` so a search
  for any alias hits the canonical index entry. (The `matchedSchema`
  lookup at line ~259 then resolves because Layer 2 re-keyed the map.)

### Layer 4 — Consumer discovery (Bug 1 + coverage, in one)

The contract is **intent-based**, not "dump the list" — Dina passes what
the user *wants*, the AppView returns the real capabilities that can
serve it. This is what removes the guessing AND scales.

- **New xRPC `com.dina.service.searchCapabilities`**: input is a free
  `intent` query (+ optional geo); output is the canonical capabilities
  that (a) are in the registry AND (b) currently have ≥1 discoverable,
  non-tombstoned provider — each with `{canonical, description, domain}`.
  - **Launch implementation:** the with-provider set is tiny (2 domains),
    so it returns all matches — no ranking needed. Correct and simple.
  - **Scale implementation (same endpoint, server-side only):**
    capability *kinds* are bounded (verb-like — hundreds, not the
    millions of provider *instances*). When the with-provider set grows
    large, embed the `intent` and cosine-rank against precomputed
    canonical-description embeddings → return top ~10 (NOT 100 — narrow
    so the LLM selects precisely). Reuses the existing gemini-embedding
    infra; no new vector dependency; **Dina's tool contract never
    changes, no relaunch.**
- **New brain tool `search_capabilities(query, geo?)`**: the LLM calls
  this FIRST for a public-service question, passing the user's intent
  verbatim. It reads back the matching capabilities + descriptions, and:
  - one matches → proceed to `search_provider_services(canonical)` →
    `query_service`.
  - none match → return the honest empty-state ("No Dina service for
    that yet") WITHOUT inventing a capability or searching blind.
- **Routing-prompt update** (`ask_handler.ts` `PROVIDER_SERVICES_ROUTING_BLOCK`):
  replace "guess a capability" with "call `search_capabilities` with the
  user's intent, use a returned canonical capability, or say there's no
  service yet."

Why intent-based beats "dump the list": passing the intent (not a guessed
label) means at scale the **server-side retrieval does the
intent→capability mapping deterministically** (embedding match), instead
of the LLM guessing from a long dumped list. So the same design that
fixes Bug 1 at launch (tiny list, LLM picks) becomes the *robust*
fix at scale (embedding retrieval picks) with zero client change.

Why this solves both at once: the LLM can only pick capabilities that
*exist with providers* → no invented strings (Bug 1) AND no empty-result
flagship failures (coverage) — an unsupported intent ends at the honest
card immediately, no wasted search.

### Layer 5 — Provider-side ingress canonicalization (P1a — the miss that breaks execution)

The single most important correction. Discovery now hands the consumer a
**canonical** capability (`eta_query`), so `query_service` sends
`eta_query` over D2D. But the provider's Core checks inbound
`service.query.capability` with an **EXACT** lookup:

- `service_config.ts` `isCapabilityConfigured(cap)` →
  `hasOwnProperty(cfg.capabilities, cap)`
- `bypass.ts` denies with `not_configured` if that misses.

So if the provider's *local `ServiceConfig`* was set up with a synonym
(`bus_eta`) but the consumer sends canonical `eta_query`, **the provider
drops its own query.** Index-side canonicalization alone is not enough —
the canonical name must win at the provider boundary too.

**Provider ingress canonicalization is MANDATORY for real provider mode
(P2 — corrected; was "if time permits").** The fix:
- `isCapabilityConfigured` resolves the inbound capability through the
  shared `resolveCanonicalCapability` AND the stored config keys are
  canonicalized at config-load — so a provider configured with any alias
  accepts the canonical query. This stays **sync** (the resolver is a
  local code module, per the packaging decision — no `await`, no AppView
  hop), preserving the sync-hot-path invariant.
- This is **required, not optional, if real (non-seeded) providers are
  part of the release.** The "seed the demo provider's config with the
  canonical key" shortcut is a **demo-only** convenience for the 2 seeded
  providers — it does NOT cover real providers and must not be mistaken
  for the launch architecture.

Seeded-provider note (demo only): because we control the 2 launch
providers, their `ServiceConfig` can also be seeded with canonical keys
directly — but that is belt-and-braces on top of the mandatory resolver,
not a substitute for it.

Either way: **canonicalization must be consistent across index AND
provider ingress, or the bus answers nobody.** This is the layer the
original draft missed.

## Pollution: how it's avoided (summary)
- **At write (index):** ingest aliases → canonical, incl. re-keying the
  schema + policy maps (Layer 2). Seeded providers clean by
  construction; future open providers normalized.
- **At read (index):** search aliases → canonical (Layer 3). Consumer
  never misses a provider over a synonym, and `matchedSchema` resolves.
- **At discovery:** consumer picks from the canonical registry, never
  free-texts (Layer 4). Both ends reference one vocabulary.
- **At provider ingress:** the provider accepts the canonical capability
  it's queried with (Layer 5). Otherwise discovery succeeds but
  execution fails `not_configured`.

## Out of scope for Services (Part 1)
- PeerLens *review-dimension* vocabulary — **not out of the release**,
  just covered in **Part 2 below** (where it IS a hard launch gate). Out
  of scope for *Services Part 1* only.
- Open/any-provider capability creation with suggest-don't-merge
  canonicalization (post-launch; the static registry covers the closed
  launch vocabulary).
- Real external bridges (GTFS etc.). Launch uses seeded providers in the
  2 domains.

## Test plan
- appview unit: alias→canonical at ingest (array AND re-keyed
  schema/policy maps); alias→canonical at search; unknown capability →
  excluded from public discovery (not indexed as canonical);
  `searchCapabilities` returns only-with-providers ∩ registry (and, when
  the scale path is added, ranks by intent-embedding → top-N).
- shared-registry unit: AppView copy and `@dina/*` copy are
  byte-identical (drift gate).
- core unit: `isCapabilityConfigured` accepts a query whose capability is
  an alias of a configured canonical (resolver runs sync at ingress).
- brain unit: `search_capabilities` tool shape; routing-prompt asserts
  the discover-then-pick contract + the no-match empty-state string.
- **THE cross-boundary test (the failure this whole doc prevents — P2):**
  provider publishes/configures capability as the **alias** `bus_eta` →
  AppView indexes it under canonical `eta_query` (array + schema/policy
  re-keyed) → `search` for `eta_query` returns the provider WITH a
  non-null matched schema/hash → consumer sends D2D `service.query` with
  `eta_query` → **provider ingress ACCEPTS it** (not `not_configured`) →
  response comes back. End-to-end, one test, alias-in/canonical-through.
- live (sim, both domains): in-domain query for each domain answers via a
  real provider; an off-domain query returns the honest empty card.

---

# Part 2 — PeerLens review-dimension vocabulary (the OTHER pollution issue)

Same *class* of bug as Services capabilities (free-form vocabulary
fragmenting a matcher) but a **different and more dangerous failure
mode** — which changes the design.

---

## Root cause, in plain English (read this first)

**What a "dimension" is.** A PeerLens review isn't just thumbs-up /
thumbs-down. A good chair review rates *specific aspects*: lumbar
support, build quality, value. Each of those aspects is a **dimension**.
Dimensions are the whole point — they're what let Dina answer *"find me a
chair that's good for back pain"* by looking at the **lumbar_support**
dimension specifically, instead of an overall star average. Without
dimensions, PeerLens is just star ratings (i.e. Trustpilot). With them,
it's the thing only Dina can do.

**How a dimension score is computed.** To say "this chair's lumbar
support is well-rated," the system **groups every review's lumbar_support
rating together and tallies them** ("8 said exceeded, 2 said met"). That
grouping is done by the dimension's **name as a text string**. All
reviews that used the string `lumbar_support` get tallied together.

**The bug.** The dimension name is a **free-form text field** — whoever
writes the review types it. So two reviewers rating the *same* aspect can
write it differently:

```
reviewer A  →  "lumbar_support"
reviewer B  →  "back_support"
reviewer C  →  "lower_back_comfort"
```

The tallying groups by exact string, so these become **three separate
piles** — each with a fraction of the data. The "lumbar support score"
is now split three ways and **every one of them is wrong** (under-counted).

### Why this is WORSE than the Services bug — and why it's scary

With Services, a wrong/missing label gives you **zero results** — you
*see* the failure ("couldn't find a service") and go fix it.

With dimensions, a fragmented name doesn't error. The tally still runs;
it just **quietly produces a wrong number.** You get a confident
"lumbar support: good" computed from a third of the actual reviews.
**Silent corruption** — nobody notices until the recommendations are
subtly bad and trust erodes.

And it's **permanent.** A review is a cryptographically signed record on
the user's own data server — **immutable.** Once someone publishes a
review with `back_support`, that string is in the corpus forever. You can
*paper over* known synonyms when reading, but a stray free-text dimension
you didn't anticipate is lost data you can never reclaim.

So: **silent** + **permanent** = the dimension vocabulary must be locked
*before* the first review is ever written. That's why turning
dimension-writing ON at launch makes the write-side fix a hard gate.

### The fix, in one sentence

Same idea as Services: **don't let reviewers type free text.** Give each
product category a small official list of dimensions; the review form
offers them as **tappable chips** (you pick `lumbar_support`, you can't
type `back support`); and when tallying, map any stray synonym back to
the official name before grouping. Both ends speak one vocabulary, so the
piles never split.

## Current status (verified in code — important)

- `dimensionRatingSchema` (record-validator.ts): `dimension:
  z.string().max(100)` — **free-form**. `value` is a closed enum
  (`exceeded|met|below|failed`) — already safe.
- **`dimensions[]` is NOT written yet — but it ships ON at launch
  (locked).** Today neither the mobile write form nor Dina's
  `review_draft` tool emits dimensions (grep: `dimensions` appears only
  in the validator that accepts them and the aggregator that consumes
  them). That's a *clean slate to build on*, NOT a reason to defer —
  because dimensions are ON at launch, the canonical vocabulary +
  write-side enforcement must be in place before review #1. The clean
  slate is the chance to get it right from the first record.
- The aggregator (`sentiment-aggregation.ts`) groups
  `dimensionSummary[dim.dimension]` by the **raw string** — so the
  moment two records use `lumbar_support` vs `back_support`, they become
  two separate rows in the summary and the per-dimension consensus
  splits.

**Launch-gate status (P1d — no ambiguity):** dimension-writing is **ON**
at launch (see "Decisions (locked)" below — they agree, no
contradiction). Therefore the write-side fix (Layer 2) is a **HARD
launch gate**: immutable signed reviews are minted from day one and a
fragmented one can never be un-fragmented. There is no "if it stays off"
branch — the decision is ON.

## Why the failure mode is WORSE than Services (the key design driver)

| | Services capability | PeerLens dimension |
|---|---|---|
| Match type | exact-match | **aggregate (group-by)** |
| Wrong vocab → | **no results (visible)** | **split consensus (silent)** |
| You notice? | yes ("nothing found") | **no — scores are just quietly wrong** |
| Immutable records? | provider profile (re-publishable) | **review = signed PDS record, immutable** |

The combination — *silent corruption* + *immutable records* — is why
dimensions need **defense-in-depth (canonicalize at BOTH write and
read)**, where Services only strictly needed write+search. A dimension
that slips through fragments the aggregate forever and you never get an
error telling you.

## The pattern already exists — mirror it, don't invent

`USE_CASE_BY_CATEGORY` (write_form_data.ts, TN-V2-REV-006) is already a
**closed, per-category vocabulary keyed by the first slash-segment of
the category** (`tech/laptop` → `tech` list), where free-form input is
**silently dropped**. The dimension vocabulary is the same shape applied
to a different field. Consistency argument: do it identically so the two
vocabularies read and test the same way.

## The canonical dimension registry (per-category)

`DIMENSION_BY_CATEGORY` — mirrors `USE_CASE_BY_CATEGORY`:

```
interface CanonicalDimension {
  canonical: string;     // 'lumbar_support'
  aliases: string[];     // ['back_support','lumbar','lower_back_comfort']
  description: string;    // for the LLM (query-side) + the write-form chip label
}
// keyed by first slash-segment of the category
const DIMENSION_BY_CATEGORY: Record<string, CanonicalDimension[]>
// + a GENERIC fallback list (value, quality, reliability) for categories
//   without a specific entry — same as USE_CASE_BY_CATEGORY's generic set.
```

Launch categories (small, matched to what we can demo): e.g.
`furniture` → lumbar_support, comfort, build_quality, value, durability;
`dining` → food_quality, service, value, ambiance, accessibility.

## The four layers (mirrors Services, with the read-side safety net added)

### Layer 1 — Registry + alias resolver
`resolveCanonicalDimension(category, raw): string | null` — normalize,
map alias→canonical *within the category's list*; return `null` for an
unknown dimension. Pure function, unit-tested.

**P1e — unknown dimensions are DROPPED, never aggregated.** `null` means
"not in the vocabulary," and every caller treats it as **drop +
telemetry**, NOT "keep the raw string as long-tail." Keeping unknowns
would re-open the exact pollution this fix closes (a stray `back_support`
would aggregate under its raw key). Concretely:
- **Write side:** an unknown can't be produced — chips are closed
  (mobile) and the LLM is constrained to the injected list (Dina-draft).
  Belt-and-braces: drop any non-canonical before signing.
- **Read side (aggregator):** a record whose dimension resolves to `null`
  is **excluded from the group-by** and counted to a
  `peerlens.dimension.dropped_unknown{category}` metric — so drift is
  *visible* and a recurring unknown can be *promoted* into the registry
  later (additive, zero pollution).

The closed launch vocabulary is intentional; emergent/long-tail
dimensions are post-launch (Out of scope).

### Layer 2 — Write-side enforcement (BOTH write paths) — the primary fix
Because records are immutable, the dimension must be canonical *before*
it's signed:
- **Mobile write form — AS BUILT: clean by OMISSION (stronger than
  chips).** The original plan was chips drawn from the category's
  canonical list. Implementation found the mobile review form has **no
  dimension input at all** — `WriteFormState` / `AttestationV2Extras`
  carry no `dimensions` field, and `serializeFormToV2Extras` never emits
  one. So there is no free-text dimension surface to convert to chips; the
  app simply never writes `dimensions[]`. This is pollution-proof by
  construction (nothing to pollute) and is pinned by a lock-in test
  (`serializeFormToV2Extras` never produces a `dimensions` key, even on a
  fully-populated form). If a future build adds a structured dimension
  input, it MUST use canonical chips (`dimensionsForCategory()`); the
  lock-in test trips first to force that decision back into review.
  *(Dimensions enter the system today only via the wire ingester from
  third-party / imported records — exactly the case Layer 3 defends.)*
- **Dina's `review_draft` tool — DECISION LOCKED: (b) FORBID at launch.**
  Dimensions are ON, so the draft path is part of launch enforcement —
  there is no "later" / "when it begins emitting." The chosen option:
  **the `review_draft` tool does NOT emit `dimensions[]` at launch.**
  Dina can still draft a review's sentiment + body text ("Great chair,
  very comfortable"). AS BUILT this is enforced structurally: the draft
  LLM's output schema (`ComposeContextValues`) has **no `dimensions`
  field**, so even a hostile/over-eager model can't mint one — and a
  lock-in test asserts the merged draft, serialized to wire extras,
  carries no `dimensions` key. Combined with the form's clean-by-omission
  above, **no app-side path writes `dimensions[]` at all** at launch.
  Rationale: lowest-risk — the LLM (the one free-text source that could
  mint a polluting dimension into an immutable record on day one) never
  touches the dimension field. Post-launch upgrade to (a) — a structured
  dimension surface (chips and/or draft tool) emitting canonical
  dimensions via injected-list + drop-unknown — is additive and needs no
  migration.

### Layer 3 — Read/aggregate-side normalization — the safety net (NEW vs Services)
In `sentiment-aggregation.ts`, run each incoming `dim.dimension` through
`resolveCanonicalDimension` **before** the group-by. This catches any
record that slipped through with an alias (a future third-party client,
an old record, an import) so the aggregate stays merged even if a
non-canonical string reached the index. This is the deterministic,
alias-map version of the "LLM read-time normalization" fallback we
discussed — cheap, lossless for known aliases, runs every aggregation.

Why dimensions get this and capabilities don't strictly need it: the
failure is **silent** here. Write-side discipline can be bypassed by a
non-Dina client writing straight to a PDS; with exact-match capabilities
that just means "they don't show up," but with aggregation it means
"they silently corrupt the score." So we normalize on the way in AND on
the way out.

### Layer 4 — Consumer/query side (the personalization moat)
When Dina maps user context → a dimension weight ("back pain →
prioritize X"), she must map to the **canonical** dimension. Expose the
category's canonical dimension vocabulary (+ descriptions) to the
query-construction LLM so "back pain" resolves to `lumbar_support`
(canonical), matching what the aggregate is keyed on. This is the twin
of the Services `list_capabilities` step: the consumer selects from the
registry, never free-texts the dimension it's searching for.

## Pollution: how it's avoided (summary)
- **At write:** chips/LLM emit only canonical dimensions (Layer 2). The
  primary defense — immutable records are born canonical.
- **At read/aggregate:** alias→canonical before group-by (Layer 3). The
  safety net — a stray alias can't silently split the consensus.
- **At query:** consumer maps context → canonical dimension (Layer 4).
  Both ends key on the same vocabulary.

### Layer 5 — Category normalization (P2 — IN-SCOPE because dimensions are ON)

`category` is free-form at the validator (`z.string().min(1).max(200)`),
though the write form uses a closed enum. This is **not** a lower-priority
sibling — it is **part of the same launch gate**, because the entire
dimension system is *keyed by category*:

- `DIMENSION_BY_CATEGORY` lookup, the recency half-life
  (`category_halflife.ts`), and `USE_CASE_BY_CATEGORY` all key on
  `category` (first slash-segment).
- If `category` fragments (`furniture` vs `Furniture` vs `furniture/chair`
  vs `home_furniture`), the dimension vocabulary resolves to the wrong
  list — or the generic fallback — and the whole canonicalization chain
  silently mis-fires. A polluted category poisons dimensions downstream.

**String normalization is NOT enough — needs a category ALIAS registry
(P2 — corrected).** Plain `lowercase + first-slash-segment` does NOT map
`home_furniture → furniture` (my own example above breaks my own rule:
`home_furniture` has no slash, lowercasing leaves it `home_furniture`).
So category needs the *same alias-table treatment* as capabilities and
dimensions, not just string surgery:
- `CATEGORY_ALIASES: Record<string, string>` — `home_furniture →
  furniture`, `furnishings → furniture`, `restaurants → dining`, …
- `resolveCategoryKey(raw): string` — lowercase + first-slash-segment
  **then** map through `CATEGORY_ALIASES` → canonical category. (The
  string ops are a pre-pass; the alias table does the real work.)

Same write-clean + read-net treatment:
- **Write side:** already a closed enum in the form (app-written
  categories are clean). Keep it closed; do not loosen.
- **Read side (aggregator + dimension lookup):** run `category` through
  `resolveCategoryKey` **before** it's used to look up the dimension
  vocabulary or to group, so a non-app/third-party record with
  `Home_Furniture` still resolves to the `furniture` dimension list.
  Same pure-function/test shape as `resolveCanonicalDimension`. Must ship
  WITH the dimension fix — a fragmented category defeats Layers 1–4
  before they run.

## Decisions (locked — Part 2 summary)
- Dimension-writing **ON** at launch → write-side enforcement (Layer 2),
  drop-unknowns (Layer 1 / P1e), read-side net (Layer 3), and category
  normalization (Layer 5) are **all launch gates**.
- Per-category dimension sets **small** (4–5 each) — additive growth
  later, never un-fragmentable.
- Unknown dimensions **dropped + metered** (`peerlens.dimension.dropped_unknown`),
  never aggregated under a raw string.

---

# Part 3 — Product / Subject Identity (the THIRD pollution surface)

Reviews attach to a **subject** (a product, video, place, org…). "Which
subject does this review attach to?" is the same convergence problem as
capabilities and dimensions — and it has BOTH failure modes at once:
- **Fragmentation:** the same thing written differently → many subjects,
  reviews scattered (the dimension-style failure).
- **Conflation:** different things sharing a name → one subject, reviews
  wrongly merged (the *opposite*; unique to subjects).

## Root cause, in plain English

There is **no "add a product" step.** A subject is born the first time
someone reviews it: the system hashes a canonical form of the reference
into a **deterministic subject ID**; if a row with that hash exists the
review attaches, else it creates the row (`db/queries/subjects.ts`).

Two resolution tiers already exist:
- **Tier 1 — global identifier** (`did:` / `uri:` / `id:`): everyone
  referring to the same thing produces the same hash. Correct.
- **Tier 2 — name** (`name:<type>:<normalized_name>`): NFC + lowercase +
  whitespace-collapse + cap. Shared across authors (a prior per-author
  fragmentation bug is already fixed — see the file's own comment).

**Tier 2 is not enough, and we are NOT relying on it.** Two reasons:
1. **Conflation — "dozens of Aerons."** "Aeron Chair" is a product
   *line* with many SKUs (Size A/B/C, PostureFit, finishes). A bare name
   collapses every variant into one subject; variant-specific reviews
   pollute the line-level average.
2. **Fragmentation — phrasing.** "Aeron Chair" vs "Herman Miller Aeron"
   vs "Aeron office chair" hash to three subjects. Normalization fixes
   case/space/Unicode, NOT "different words for the same thing" (entity
   resolution — genuinely hard, not solved by normalization).

## Decision (locked): GLOBAL ID, no shortcuts

Subject identity at launch is **identifier-first**. A review resolves its
subject in strict priority order:

1. **Global identifier present → Tier 1, always.** The subject IS the
   identifier, at the identifier's natural granularity:
   - Physical product → `id:gtin:<barcode>` or `id:asin:<asin>` (variant
     level — the SKU the buyer actually buys).
   - Web content (YouTube video, article, blog post) → `uri:<canonical>`
     (the platform's stable content ID).
   - Place → `id:gplace:<place_id>` (or `did:` for a Dina-native entity).
   - Network entity → `did:plc:…`.

### Tier-1 precedence must be TYPE-SPECIFIC (P1b — current order is wrong for products)

Today the resolver hard-codes **`did > uri > identifier`**
(`subjects.ts` `generateDeterministicId`), and mobile can emit BOTH `uri`
and `identifier` on one ref (`publish_helpers.ts`). With the current
order, a *product* that carries both a store URL (`uri`) and a barcode
(`identifier`) resolves by the **URL** — the weaker, page-level,
fragmenting key — instead of the barcode (the correct variant-level key).
That's backwards for products.

Fix: precedence is **by subject type**, not one global order.
- `did` always wins when present (it's the strongest global identity).
- **Product / dataset / physical-good types:** `identifier` (barcode /
  ASIN / MPN) **beats** `uri`. The SKU id is more precise than whatever
  page URL was handy.
- **Content types (video, article, web content):** `uri` (canonical
  content URL/ID) **beats** `identifier`. The URL *is* the content's
  identity.
- Name is always the last resort.

This is a real (small) change to `generateDeterministicId` — make the
Tier-1 order a function of `ref.type`, not a fixed `did→uri→identifier`
cascade. **Must land before public writes (see versioning below), or
products silently bind to the wrong key forever.**

### RESOLVER_VERSION freeze (P1a — must bump or greenfield BEFORE public writes)

Subject IDs are explicitly **frozen** by `RESOLVER_VERSION = 'v2'`
(`subjects.ts`): the hash inputs are a wire-format contract, and ANY
change (the type-specific precedence above, or the URL canonicalizer
below) changes the hashes → **every existing subject_id breaks.** So:
- These Part-3 changes (type precedence + identifier canonicalizer) **must
  be implemented BEFORE any public review writes**, and shipped as a
  **`RESOLVER_VERSION` bump to `v3`** (or a greenfield reset of the
  subject table if we're pre-public — which at launch we are).
- If they land AFTER public writes exist, it's a migration that recomputes
  hashes side-by-side (the `v2:`/`v3:` prefix is the escape hatch the code
  already documents). For launch: **greenfield — bump to `v3`, no prior
  public subjects to migrate.**
2. **No identifier → Tier-2 name fallback, explicitly LINE-LEVEL and
   labelled as such.** A name-only subject aggregates at the product
   *line*, not the SKU. That is a *true, useful* signal ("the Aeron line
   reviews well for lumbar") — but the UI must label it line-level so a
   buyer doesn't read it as their exact variant. Variant detail goes in
   the review body, not a fake-specific subject.

The flow (form + Dina) is built to **capture an identifier as the happy
path** — scan a barcode, paste/recognise a URL — and only fall back to
name when none exists. No silent name-only minting where an ID was
available.

## New build item — the identifier canonicalizer (no shortcuts)

A raw URL is as fragmenting as a free-typed name (the same YouTube video
has many URL spellings: `www.`/no-`www.`, `youtu.be`, `&t=`/`&list=`
tracking params, http/https). So Tier 1 needs a **per-type
canonicalizer** before hashing — a sibling to `resolveCanonicalCapability`
/ `resolveCategoryKey`:

`resolveSubjectIdentifier(rawRef): {tier1Key} | null`
- **URL:** lowercase host, force https, strip `www.`, then **extract the
  platform content ID** — YouTube → `uri:youtube:<videoId>` (from `v=` or
  the `youtu.be/` path), drop `t=`/`list=`/`utm_*`; generic article →
  strip query+fragment+trailing-slash. Hash the *extracted ID*, not the
  raw URL.
- **Barcode/ASIN:** validate format, uppercase ASIN, zero-pad GTIN →
  `id:gtin:…` / `id:asin:…`. (Mostly passthrough; just format-normalize.)
- **Unknown/unparseable identifier:** do NOT invent a Tier-1 key — fall
  to Tier-2 name (or reject), same drop-don't-guess discipline as
  everywhere else.

This is the fifth instance of the canonicalization theme: extract the
stable identity, drop the noise, converge.

## Launch guidance (demo posture)

URL-identified subjects are the **cleanest** review surface — a video or
article has a single stable ID and **no variant problem at all**. So:
- **YouTube videos / articles** (URL → extracted ID) are the safest,
  most pollution-proof PeerLens demo. Lead product-review demos here.
- **Physical products:** demo only with a scanned barcode/ASIN
  (variant-correct). Avoid free-typed multi-variant gear on camera.
- **Places/services:** place ID or the Services D2D path.

## Test plan additions (Part 3)
- `resolveSubjectIdentifier` unit: the 5 YouTube URL spellings →
  identical `uri:youtube:<id>`; tracking params dropped; `youtu.be`
  short form == full form; article URL strips query/fragment.
- barcode/ASIN format-normalize → identical key regardless of input
  casing/padding.
- conflation guard: two DIFFERENT video IDs → two subjects (don't
  over-merge); same ID across authors → one subject (converge).
- name fallback only fires when no identifier is parseable.

## Out of scope (Part 3, post-launch)
- **Subject hierarchy** (model parent ↔ variant children, reviews at
  either level, roll-up aggregates "Aeron line: 4.5 / this Size B: 4.2").
  The code's Tier-3 `canonical_subject_id` (admin-merge) is the seed of
  this. Proper home for "dozens of Aerons"; a build, not launch-week.
- **Embedding-based entity resolution** for name-only fragmentation
  ("Aeron" ≈ "Herman Miller Aeron"). Hard; post-launch.

## Out of scope (all parts)
- Open/any-provider capability creation with suggest-don't-merge
  canonicalization (post-launch; static registries cover the closed
  launch vocabularies).
- Real external bridges (GTFS etc.) — launch uses seeded providers in the
  2 service domains.
- Embedding-based capability retrieval (Services Layer 4 scale path) and a
  dynamic/emergent dimension vocabulary — both post-launch; the contracts
  are built now so the upgrades are server-side only.
