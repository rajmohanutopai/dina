# Trust Network — V1 Plan

**Goal:** Ship a social review system where attestations are tagged against reviewer DIDs whose individual trust scores are computed from observable signals. Subjects (a chair, a YouTuber, a restaurant, a service) inherit a trust-weighted aggregate score so the user can answer "which one should I pick?". Bilateral cosignature is an optional enhancement, not foundational. Adversarial mitigations (sybil resistance, mutual-praise detection, statistics-aware aggregation) are explicit V2 work — the V1 wire format and DB schema are designed so V2 mitigations re-weight existing records without invalidating them.

**Non-goals (deferred to V2+):**
- Sybil farm detection
- Mutual-praise / reciprocity rings
- Defamation moderation surface (negative-signal records exist as `flag` lexicon, but UI surfacing is V2)
- Federation across AppView instances
- Statistics-aware aggregation (Bayesian priors, confidence bands beyond a flat n<3 cutoff)
- Same-as merges across pseudonymous DIDs

## 1. Architectural decisions (locked)

| # | Decision | Why |
|---|----------|-----|
| 1 | **Reviewer-identity trust, not subject-side opaque score** | The credibility comes from the reviewer's identity + network position; the subject score is a transparent aggregate |
| 2 | **Trust score is computed in V1**, not deferred | User cannot pick from a list of subjects without ranked output |
| 3 | **Trust-weighted ranking in search + browse** | Same reasoning as #2 |
| 4 | **Bilateral cosignature is optional**, surfaced as "co-signed by N reviewers" | Promotes a review without being load-bearing |
| 5 | **Pseudonymous DIDs per namespace**, derived `m/9999'/4'/N'` | Reviewer privacy across topics; `N` is the namespace index |
| 6 | **Forward-compat lexicons** — V2 adds optional fields; lexicon ID + atproto's native lexicon versioning carry the schema version | V2 mitigations re-weight existing records, never wipe them |
| 7 | **Three-tier subject resolution** (global identifier → name+author-scoped → canonical chain) | Already present in AppView; V1 builds on it without extending |
| 8 | **`flag` record exists in V1 lexicon, ignored by V1 scorer** | Lets the wire format land before the moderation UX is designed |
| 9 | **Trust score function is named + versioned (`trust_score_v1`)** | V2 introduces `trust_score_v2` alongside; UI reads whichever is freshest |
| 10 | **Cold-start fallback: option (1)** — when viewer has no contacts, drop the network-position term and rank by `account_age × sqrt(review_count) × consistency` | Degrades gracefully; no global reviewer reputation that contradicts the social framing |
| 11 | **V1 limitation banner** lives in Settings → "About Trust Network" + first-run modal | Disclosure without permanent screen-real-estate cost |
| 12 | **Trust bands**: low (0–33), medium (34–66), high (67–100); naked numeric score only when n ≥ 3 reviews | Bands soften noise at low N; numbers earn their place at higher N |
| 13 | **Mobile writes to PDS directly via `com.atproto.repo.createRecord`; AppView indexes from Jetstream firehose** | Standard atproto. AppView never proxies writes nor holds PDS credentials. Rate limit + signature gate at ingester (§3.5) |
| 14 | **V1 namespace identity = one PDS account with multiple verification methods** | Lowest-friction V1; namespace pseudonymity is "first impression" only — DID document is correlatable. V2 adds per-namespace PDS accounts for true pseudonymity |
| 15 | **Namespace key registered as `assertionMethod` in DID document**, id pattern `did:plc:xxxx#namespace_<index>` | AppView verifies records by resolving DID doc and matching the verification method id used in the commit |
| 16 | **Cosig requests get their own table (`cosig_requests`)**, not `dina_tasks` | Different lifecycle (cross-network, multi-day expiry); expiry-swept hourly |
| 17 | **Trust tab default landing = friends' recent reviews (1-hop, 14-day window)**, served by `com.dina.trust.networkFeed` xRPC | Teaches social-review framing on first open; doesn't require typing a query |
| 18 | **Compose flow calls `com.dina.trust.resolve` before publish** | Server returns canonical `subject_id` (or null + conflicts list for disambiguation); UI shows the canonical subject before the user commits |
| 19 | **Author edit = atproto-standard delete + republish**; no in-place edit | atproto records are immutable; AppView's incremental rescoring handles the recompute transparently |
| 20 | **Namespace deletion is "disable", not delete, in V1** | Hard delete requires PLC verification-method removal + bulk record tombstone. V1 ships disable (read-only marker on `namespace.profile`); V2 ships hard delete |
| 21 | **AppView enriches subjects with `category` + `metadata` JSONB at ingest** | Lexicon `SubjectRef` is intentionally sparse (publisher writes minimum); search needs richer context (sub-category, location, language, host, brand). Enrichment runs server-side from heuristics — publishers don't need to know the taxonomy |
| 22 | **Search filters extend beyond `type`**: `category`, `location` (lat/lng + radius), `language`, `metadata.*` predicates | Without these, "Italian restaurants in SF" can't be expressed and "chair reviews" surfaces phones. Type is the lexicon-level scope; category + metadata are the within-scope refiners |
| 23 | **Attestation language auto-detected at ingest** (franc-min) | Powers "show me reviews in languages I read" filter; same data later used to drive translate-on-display in V2 |

## 2. Open decisions (resolved)

| Question | Answer | Notes |
|---|---|---|
| What does empty-graph scoring use? | Account age × sqrt(review_count) × consistency | Degrades to "popularity, weighted by tenure" — adequate until contacts exist |
| Where does the V1-limitation banner live? | Settings → About Trust Network (always) + first-run modal (once) | First-run modal stores `trust_first_run_dismissed_at` in keystore |
| Pseudonymous DID derivation path? | `m/9999'/4'/N'` where `N` is the namespace index (0=default, 1+=user-named) | Pinned in `core/internal/identity/keygen.go`; Lite mirrors |
| Recovery flow per namespace? | Master seed regenerates all namespace keys deterministically; namespace metadata recovers from PDS records; PLC document re-resolves from the PLC directory | No additional recovery primitives in V1 |
| Naked score vs band threshold? | Numeric for n ≥ 3 reviews; band only below | Subject card shows "82 · 14 reviews" or "high · 2 reviews" |
| Trust score computation cadence? | Nightly batch + on-write incremental + cascade (capped at 1000) | See §5.4. Hot subjects (review_count > 10k) skip incremental and rely on nightly only |
| When does `flag` UI ship? | V2 — record exists, scorer ignores. V1 ingester rate-limits flags (10/author/day) to bound the defamation surface | Lets future moderators backfill flags against historical attestations |
| Network-position graph computation tier? | Compute per-request from PostgreSQL contact graph; cache result in Redis 60 s, key=`(viewer_did, graph_version)` | Latency budget ≤ 80 ms p95 |
| Public handle binding for namespaces? | Removed from V1 lexicon. V2 introduces verified-handle binding via DID-document service entry | V1 namespaces are pseudonymous-by-default |
| Mobile state management? | Custom subscribe + `useFocusEffect`, no `react-query`; XRPC client in `apps/mobile/src/trust/api.ts` | Matches notifications + reminders pattern |
| Cosig request inbound surface? | Unified inbox as `kind: 'approval'`, `subKind: 'trust_cosig'`. Tap → original attestation with Endorse / Decline sheet | Recipient stays inside the inbox flow |
| Cosig data model? | Dedicated `cosig_requests` table (NOT `dina_tasks`); hourly expiry sweeper job emits `trust.cosig.reject{reason: 'expired'}` and flips status | See §10 for table DDL |
| What happens to revoked DIDs (subject of type `did`)? | Attestations stay valid; UI shows "DID revoked" badge | Revocation is a public-key fact, not a moderation event |
| When does an orphan subject get deleted? | Weekly `subject_orphan_gc` removes subjects with `review_count = 0 AND last_attested_at < now - 90d` | Conservative window prevents flapping |
| XRPC auth model? | Read endpoints (`subject.search`, `subject.get`, `feed.network`, `subject.resolve`) public. Writes go directly to PDS via `com.atproto.repo.createRecord`; rate limit + namespace signature verification happen at AppView's **firehose ingester** | Mobile cannot get synchronous 429 — see §3.5 for async-failure UX |
| PDS write path? | Mobile calls `com.atproto.repo.createRecord` against the user's PDS using the namespace key as record-signing key; AppView never sees the write directly | Standard atproto pattern; AppView is a read-side service |
| Namespace identity in V1? | One PDS account, multiple namespace keys registered as `assertionMethod` verification methods in the user's DID document | First-impression pseudonymity. V2 = per-namespace PDS accounts for full segregation |
| Namespace key registration? | New namespace = mobile derives key + appends `assertionMethod` to DID document via PLC operation signed by recovery key + publishes `com.dina.trust.namespaceProfile` | See §3.5 for sequence |
| Search query semantics? | Postgres FTS (`english` config, no stop words, no stemmer) over `subjects.name` ⊕ `attestations.headline` ⊕ `attestations.body`; weighted A/B/C respectively | Tunable in `trust_v1_params` table |
| Empty `q` parameter behaviour? | Returns the network feed via `com.dina.trust.networkFeed` (1-hop reviewers, 14d window, sorted by reviewer trust × recency) | Same data the Trust tab landing renders |
| Subject type picker UX? | Auto-detect from input shape: `did:` prefix → did; URL → product OR content (heuristic on host); ISBN-13 / ASIN format → product; else show 3-row chooser (product / place / content) with "more types" expand for org / dataset / claim | Implemented in `apps/mobile/src/trust/identifier_parser.ts` |
| What is the `claim` subject type for? | Free-text claim ("Drinking 3L of water daily is healthy"). `name` carries the claim text. `subject.resolve` returns a per-author canonical subject so different framings of the same claim don't collide | Discovery via FTS over the claim text |
| Author edit flow? | Delete + republish. Mobile UI labels it "Edit"; under the hood it's two atproto operations | atproto record bodies are immutable; standard pattern |
| Mobile cache eviction? | LRU, max 200 subjects in memory; evicts on memory warning event (`AppState.memoryWarning`) | Bounds RAM on low-end Android |
| Offline publish queue? | Stash unsent attestations in keystore (`trust.outbox`); retry on `NetInfo` reconnect; surface in inbox if stuck > 24 h | Simple FIFO; max 50 queued items, hard-fail beyond |
| Barcode-scan dep? | `expo-barcode-scanner` (already in mobile workspace via existing dep tree). ISBN-13 / EAN-13 / UPC parsed by `apps/mobile/src/trust/identifier_parser.ts` | No new dependency required if scanner is already present; otherwise pulled in via Phase 1 week 22 |
| Reviewer profile screen? | `app/trust/reviewer/[did].tsx` — public attestations + trust band + namespace-name (if visible to viewer) | Linked from any reviewer entry on subject detail |
| Notification permission for cosig? | Reuse existing local-notifications permission set up in `_layout.tsx`; cosig request fires a local push when app is closed | No new permission prompt |
| Hot subject / hot reviewer bound? | Subjects with `review_count > 10k` skip incremental and rely on nightly batch only. Reviewers with `review_count > 5k` cap their cascade fan-out at the per-run 1000 limit (no skip) | Prevents O(N²) wave from a single popular subject |
| Cross-namespace timing correlation? | Documented limitation. Same-device same-time publishes from two namespaces are linkable by network observers and by anyone reading the DID document. Disclosed in first-run modal | V2 (per-namespace PDS) closes this |
| Master-seed storage location? | Same Expo SecureStore (mobile) and Core keystore (Lite/Go) as the root identity. Namespace keys are derived deterministically; they are never stored, only re-derived on demand | No new keystore primitive |
| Feature flag for V1 rollout? | `appview_config.trust_v1_enabled` boolean. When `false`, all `com.dina.*` xRPC endpoints return HTTP 503 and the firehose ingester skips trust-network lexicon records | Lets us dark-launch the schema without exposing UI |
| Lite participation? | Lite mobile (Expo) calls AppView the same as full mobile. Lite Core/Brain are not in the trust-network critical path — trust is an AppView concern, not per-node | Stated explicitly to avoid scope creep |

## 3. Lexicons

All records published as AT Protocol records under the user's PDS. Schemas frozen for V1. Optional fields reserved for V2 are explicitly enumerated.

**Lexicon namespace decision (TN-DEC-001):** V1 keeps the existing `com.dina.trust.*` namespace already in production AppView. The plan was originally drafted with `com.dina.subject.*` names; those have been renamed throughout the doc to match the existing namespace. Lexicons §3.1–§3.3 (attestation, endorsement, flag) **already exist** in `appview/src/ingester/handlers/` — V1 work modifies them in place rather than creating new lexicons. §3.4 `namespaceProfile` is genuinely net-new; it's a V1 addition.

The V1 attestation field set in §3.1 below is the **subset the plan formally relies on**. The existing AppView attestation schema carries additional fields (sentiment, dimensions, evidence, mentions, related, bilateralReview, tags, text) that V1 leaves untouched — they continue to flow through the ingester unchanged. Audit task TN-AUDIT-002 documents the full superset.

### 3.1 `com.dina.trust.attestation`

```json
{
  "lexicon": 1,
  "id": "com.dina.trust.attestation",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "createdAt"],
        "properties": {
          "subject":     { "type": "ref",       "ref": "#subjectRef" },
          "headline":    { "type": "string",    "maxLength": 140 },
          "body":        { "type": "string",    "maxLength": 4000 },
          "rating":      { "type": "ref",       "ref": "#dimensionRatings" },
          "createdAt":   { "type": "string",    "format": "datetime" },
          "namespace":   { "type": "string",    "description": "Namespace key id (e.g. 'namespace_1') used to sign this record; resolved via the author's DID document. Defaults to root namespace when absent" },

          "_v2_reciprocityFlag": { "type": "boolean", "description": "Reserved for V2 mutual-praise detector" },
          "_v2_freshnessProof":  { "type": "string",  "description": "Reserved for V2 anti-stale signal" }
        }
      }
    },
    "subjectRef": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type":       { "type": "string", "knownValues": ["did", "content", "product", "place", "dataset", "organization", "claim"] },
        "did":        { "type": "string", "description": "When type=did" },
        "uri":        { "type": "string", "description": "Canonical URL (UTM/fragment-stripped)" },
        "name":       { "type": "string", "description": "Human label; combined with type+author for author-scoped resolution" },
        "identifier": { "type": "string", "description": "ASIN, ISBN, place_id, etc.; format-discriminated by prefix" }
      }
    },
    "dimensionRatings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["dimension", "value"],
        "properties": {
          "dimension": { "type": "string", "knownValues": ["overall", "quality", "value", "service", "accuracy", "freshness"] },
          "value":     { "type": "string", "knownValues": ["exceeded", "met", "below", "failed"] },
          "note":      { "type": "string", "maxLength": 280 }
        }
      }
    }
  }
}
```

**Validation rules:**
- Exactly one of `subject.did`, `subject.uri`, `subject.identifier`, or `subject.name` must be present.
- `rating` array is optional but if present must contain at least one entry with `dimension: "overall"`.
- `namespace` is optional; when present must match an `assertionMethod` id registered in the author's DID document.
- The record's commit signature must verify against the namespace key referenced in `namespace` (or the root key when absent). AppView's ingester rejects records that fail this check.

**Subject type semantics:**
- `did` — a person, organisation, or service identified by a DID
- `content` — a piece of content (article, video, post) identified by URL
- `product` — a physical or digital product identified by URL or ASIN/ISBN/UPC
- `place` — a location identified by Google place_id, OSM node, lat/lng + name, or URL
- `dataset` — a dataset, model, paper, or formal publication identified by URL or DOI
- `organization` — a company or institution identified by URL or DID
- `claim` — a free-text proposition ("Drinking 3L of water daily is healthy"); `name` carries the claim text. Different framings of the same claim resolve as separate per-author canonical subjects (tier 2)

### 3.2 `com.dina.trust.endorsement` (cosignature)

> **Note:** The plan originally named this primitive "binding". V1 uses the existing AppView lexicon `com.dina.trust.endorsement` — same concept (a cosignature on another reviewer's attestation), existing field names take precedence.

```json
{
  "id": "com.dina.trust.endorsement",
  "record": {
    "required": ["target", "createdAt"],
    "properties": {
      "target":    { "type": "string", "format": "at-uri", "description": "AT-URI of the attestation being co-signed" },
      "stance":    { "type": "string", "knownValues": ["endorse"], "description": "V1 endorse-only; V2 adds dispute" },
      "note":      { "type": "string", "maxLength": 280 },
      "createdAt": { "type": "string", "format": "datetime" }
    }
  }
}
```

### 3.3 `com.dina.trust.flag` (V1 record exists, V1 UI defers)

```json
{
  "id": "com.dina.trust.flag",
  "record": {
    "required": ["target", "reason", "createdAt"],
    "properties": {
      "target":    { "type": "string", "format": "at-uri", "description": "AT-URI of attestation OR subject" },
      "reason":    { "type": "string", "knownValues": ["spam", "fake", "harassment", "stale", "off-topic", "other"] },
      "note":      { "type": "string", "maxLength": 280 },
      "createdAt": { "type": "string", "format": "datetime" }
    }
  }
}
```

**V1 ingester behaviour:** index, store, do not feed scorer. **Rate limit at ingester: 10 flags per author per day** (a 24 h sliding window). Excess flags are dropped with a `flag.ratelimit` log line — the firehose record itself is not rejected. V2 unblocks scorer integration + moderation UI + the per-author quota tunable.

### 3.4 `com.dina.trust.namespaceProfile` (per pseudonymous identity)

```json
{
  "id": "com.dina.trust.namespaceProfile",
  "record": {
    "key": "literal:<namespace_id>",
    "required": ["name", "createdAt", "verificationMethodId"],
    "properties": {
      "name":                 { "type": "string", "maxLength": 64, "description": "User-chosen label (e.g. 'tech', 'restaurants')" },
      "verificationMethodId": { "type": "string", "description": "Fully-qualified id of the assertionMethod in the author's DID document, e.g. 'did:plc:xxxx#namespace_1'" },
      "disabled":             { "type": "boolean", "description": "When true, no further attestations should be published under this namespace. AppView treats existing records as read-only" },
      "createdAt":            { "type": "string", "format": "datetime" },

      "_v2_publicHandle":     { "type": "string", "description": "Reserved for V2 verified-handle binding" }
    }
  }
}
```

V1 namespace identity model is detailed in §3.5 (one PDS account, multiple `assertionMethod` keys). V1 ships disable, not delete; the `disabled` flag flips on user request and AppView refuses to ingest new attestations under that namespace.

### 3.5 PDS interaction model

V1 follows the standard atproto pattern: the mobile client writes records directly to the user's PDS via `com.atproto.repo.createRecord`, AppView indexes from the Jetstream firehose, and AppView never proxies writes nor holds PDS credentials.

#### 3.5.1 Where rate-limit + signature gates live

The lexicon-level integrity checks (rate limit, namespace-key signature, schema validation) run on the **firehose ingester**, not on a synchronous publish endpoint. When the ingester rejects a record:

- The record is dropped from the index with a `trust_v1.ingest.reject{reason, did, uri}` log line.
- The mobile client does NOT see a synchronous 429. Instead, the client maintains an "expected pending" set keyed on the AT-URI it generated; if a record fails to appear in the AppView index within 60 s of publish, it surfaces an inbox `system_message` ("Your review didn't post — rate limit reached" / "signature invalid" / etc.) and offers the user a re-try on the original draft.
- This trades synchronous-error UX for the architectural guarantee that AppView is read-only with respect to PDS state.

Mobile-side polling: `apps/mobile/src/trust/outbox.ts` keeps a small in-memory + persisted set of `{at_uri, draft_body, submitted_at}` rows. A 5 s timer polls `com.dina.trust.attestationStatus` (§6.5) for each pending AT-URI until the response transitions from `pending` → `indexed` (success) or `rejected` (surface inbox failure row), or the 60 s budget elapses (surface "stuck — retry?" inbox row).

#### 3.5.2 V1 namespace identity model

One PDS account per user (the user's existing root account). The DID document's verification methods grow as the user adds namespaces:

```json
{
  "id": "did:plc:xxxx",
  "verificationMethod": [
    { "id": "did:plc:xxxx#root",            "type": "Multikey", "publicKeyMultibase": "z6Mk..." },
    { "id": "did:plc:xxxx#namespace_0",     "type": "Multikey", "publicKeyMultibase": "z6Mk..." },
    { "id": "did:plc:xxxx#namespace_1",     "type": "Multikey", "publicKeyMultibase": "z6Mk..." }
  ],
  "assertionMethod": [
    "did:plc:xxxx#namespace_0",
    "did:plc:xxxx#namespace_1"
  ]
}
```

- `#namespace_0` is the root namespace, derived `m/9999'/4'/0'`. Auto-created on first Trust-tab visit.
- `#namespace_N` is the Nth user-created namespace, derived `m/9999'/4'/N'`.
- Records published under namespace `K` are signed with the keypair at `m/9999'/4'/K'`. The atproto commit references `verificationMethod` id `did:plc:xxxx#namespace_K` so AppView knows which key to verify against.

**V1 privacy caveat:** All namespaces share one DID document. Anyone reading the DID doc can see the user has N namespaces, and a network observer correlating signature key ids across records can tell which namespace each came from. **V1 namespaces are pseudonymous to first-impression observers, NOT to dedicated investigators.** The first-run modal copy reflects this honestly.

**V2 path:** True pseudonymity ships as per-namespace PDS accounts. Each namespace gets its own `did:plc:`, its own PDS account, its own DID document. V1 records continue to work at the original DID; V2 adds an "Upgrade to private namespace" flow that provisions a separate account, migrates records via PDS sync primitives, and rotates the namespace identity.

#### 3.5.3 Namespace creation flow

1. User taps "+ Add namespace" in `app/trust/namespace.tsx`
2. Mobile derives next available `m/9999'/4'/N'` keypair from master seed (Expo SecureStore on iOS, Android keystore on Android)
3. Mobile constructs PLC operation appending the new key as an `assertionMethod` verification method with id `did:plc:xxxx#namespace_<N>`
4. Mobile signs the PLC op with the rotation key (root account's recovery key, derived `m/9999'/2'/0'`)
5. Mobile submits PLC op to PLC directory; awaits acceptance (typically < 5 s)
6. Mobile publishes `com.dina.trust.namespaceProfile{name, verificationMethodId, createdAt}` record signed by the new namespace key
7. UI confirms once the namespace.profile record appears in AppView (via `subject.resolve` polling)

If the PLC op fails (rotation-key mismatch, directory rate limit), the mobile UI rolls back: no namespace.profile record is published, no key is exposed in the DID doc. Failure surface: inline error in the namespace creation modal.

#### 3.5.4 Namespace disable flow

1. User taps "Disable" in the namespace settings screen
2. Mobile publishes a delete-and-republish of `com.dina.trust.namespaceProfile` with `disabled: true` and the same `verificationMethodId`
3. AppView ingester picks up the change; subsequent attestations published under that namespace are rejected with `trust_v1.ingest.reject{reason: 'namespace_disabled'}`
4. The verification method stays in the DID document (so existing records can still be verified). V2 hard-delete will remove it via PLC op.

#### 3.5.5 Namespace recovery

Master-seed recovery regenerates all namespace keys. The DID document itself recovers via PLC directory. The `namespace.profile` records recover by re-resolving the user's PDS repo. The user sees the same set of namespaces with the same `name` labels post-recovery.

If the user manually rotates their root recovery key (separate flow, not in V1 trust scope) but doesn't re-derive namespace keys, namespaces become unrecoverable beyond the existing DID-doc snapshot. The recovery flow's master-seed export must include namespace key derivation; this is already true under §9 since derivation is deterministic.

### 3.6 Subject enrichment

The lexicon `SubjectRef` is intentionally sparse — the publisher provides only what they know (type + name OR uri OR identifier OR did). AppView enriches each subject row at ingest with the additional context that makes search useful. **Enrichment is server-side; publishers don't need to know the taxonomy.**

#### 3.6.1 Derived fields on `subjects`

| Column | Type | Source | Example |
|---|---|---|---|
| `category` | `TEXT` (normalised lowercase, optional second segment after `:`) | Heuristic from SubjectRef.type + uri host + identifier prefix | `'product:chair'`, `'place:restaurant'`, `'content:video'`, `'organization:university'` |
| `metadata` | `JSONB` | Type-specific extraction at ingest | See §3.6.2 |
| `language` | `TEXT` (BCP-47 tag) | Detected from `name` (when present) via `franc-min` | `'en'`, `'es'`, `'ja'`, `'und'` (undetermined) |
| `enriched_at` | `TIMESTAMPTZ` | Set when enrichment job runs; allows re-enrichment when the host map updates | — |

#### 3.6.2 Metadata schema by subject type

```ts
// type=product
{
  brand?: string;            // "Herman Miller"
  model?: string;            // "Aeron"
  identifier_kind?: 'asin' | 'isbn-13' | 'ean-13' | 'upc' | 'mpn';  // when SubjectRef.identifier present
  price_range?: 'budget' | 'mid' | 'premium' | 'luxury';            // V2 (skip in V1)
  product_category_path?: string[];                                   // ["furniture", "office", "chairs"]
}

// type=place
{
  lat?: number;
  lng?: number;
  city?: string;
  country?: string;          // ISO-3166 alpha-2
  place_type?: 'restaurant' | 'cafe' | 'shop' | 'lodging' | 'attraction' | 'service' | 'other';
  cuisine?: string;          // when place_type=restaurant ("italian", "thai")
  google_place_id?: string;  // when SubjectRef.identifier starts "place_id:"
}

// type=content
{
  host?: string;             // "youtube.com"
  media_type?: 'video' | 'article' | 'podcast' | 'image' | 'social_post' | 'other';
  author?: string;           // host-derived heuristic ("@username")
  published_at?: string;     // ISO datetime, when host metadata exposes it
}

// type=dataset
{
  doi?: string;
  arxiv_id?: string;
  publication_year?: number;
  domain?: string;           // "ml" | "biology" | "physics" | ...
}

// type=organization
{
  org_type?: 'company' | 'nonprofit' | 'government' | 'university' | 'media' | 'other';
  industry?: string;
  hq_country?: string;
  has_dina_service_profile?: boolean;
}

// type=did
{
  is_dina_user?: boolean;       // resolved from did:plc lookup
  is_service?: boolean;         // has com.dina.service.profile record
  service_capability?: string;  // mirror of provider's published capability
  did_method?: 'plc' | 'key' | 'web';
}

// type=claim
{
  domain?: string;              // "health" | "finance" | "political" | "scientific" | "other"
  // Future V2: structured claim type, related claims via canonicalSubjectId
}
```

All fields are optional — enrichment is best-effort. Missing fields just mean the subject won't surface for that filter.

#### 3.6.3 Enrichment heuristics (V1)

Implementation in `appview/src/util/subject_enrichment.ts`. Pure functions, no external network calls in V1.

**Type=product:**
- `SubjectRef.identifier` matches `^[A-Z0-9]{10}$` → `identifier_kind = 'asin'`, `category = 'product'`
- `SubjectRef.identifier` matches ISBN-13 / ISBN-10 checksum → `identifier_kind = 'isbn-13'`, `category = 'product:book'`
- `SubjectRef.uri` host = `amazon.*` / `flipkart.com` / `bestbuy.com` / etc. → `category = 'product'`, `metadata.host = <host>`
- `SubjectRef.name` matched against a curated keyword map (`furniture`, `book`, `phone`, ...) → adds second segment to category
- The keyword map is `appview/src/util/category_keywords.ts`, ~200 entries, maintained as a flat TS file

**Type=place:**
- `SubjectRef.identifier` starts `place_id:` → `metadata.google_place_id`, `category = 'place'`
- `SubjectRef.uri` matches `google.com/maps/...` → `category = 'place'`, parse query string for `q=` and lat/lng
- `SubjectRef.name` matched against place keyword map (`restaurant`, `cafe`, `hotel`, ...) → `metadata.place_type` and category second segment

**Type=content:**
- `SubjectRef.uri` host present → `metadata.host = <host>`, `category = 'content'`
- Host map: `youtube.com / youtu.be → media_type='video'`, `medium.com / substack.com / *.blog → media_type='article'`, `spotify.com/episode/... → media_type='podcast'`, `twitter.com / x.com / bsky.app → media_type='social_post'`. Map lives in `appview/src/util/host_category.ts`, ~50 entries.

**Type=dataset:**
- `SubjectRef.uri` matches `arxiv.org/abs/<id>` → `metadata.arxiv_id`, year parsed from id
- `SubjectRef.identifier` matches `doi:10.*` → `metadata.doi`

**Type=did:**
- AppView resolves the DID once at ingest; if a `com.dina.service.profile` record exists in the resolved repo, sets `metadata.is_service = true` and copies the published capability label.

**Type=organization:**
- `SubjectRef.uri` host TLD heuristic: `.edu → org_type='university'`, `.gov → org_type='government'`, `.org → org_type='nonprofit'` (weak), else default `org_type='company'`
- AppView keeps a flat allow-list of well-known orgs (Wikipedia QID-style identifiers) in `appview/src/util/known_orgs.ts` for higher-confidence mapping (~100 entries seeded).

**Type=claim:**
- No structured enrichment in V1. `metadata.domain` populated from a keyword scan over `name` (e.g. mentions of "drug", "medication" → `domain='health'`).

#### 3.6.4 Re-enrichment cadence

The enrichment job is idempotent. It runs:

1. **On subject creation** — the ingester, after creating a `subjects` row, immediately enqueues `subject_enrich(subject_id)`.
2. **Weekly batch** — `subject_enrich_recompute` runs Sundays 04:00 UTC against all subjects, picking up updates to the host/keyword maps. Cheap (~200k subjects × ~1 ms each = ~3 min).
3. **Manual** — `dina-admin trust enrich --subject <id>` for ad-hoc re-runs.

Updates to category-keyword and host-category maps land in the AppView codebase as TS source files; a deploy + re-enrichment batch follows.

## 4. AppView storage

### 4.1 New tables

```sql
-- Per-reviewer trust score (one row per (did, namespace) pair).
CREATE TABLE reviewer_trust_scores (
  id              BIGSERIAL PRIMARY KEY,
  did             TEXT      NOT NULL,
  namespace       TEXT      NOT NULL DEFAULT '',     -- '' = root identity
  score_version   TEXT      NOT NULL,                -- 'v1', 'v2' coexist
  score           SMALLINT  NOT NULL CHECK (score BETWEEN 0 AND 100),
  score_inputs    JSONB     NOT NULL,                -- raw signals (review_count, age_days, cosig_count, variance, etc.)
  computed_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (did, namespace, score_version)
);
CREATE INDEX idx_reviewer_trust_scores_did ON reviewer_trust_scores (did);

-- Per-subject aggregate. One row per (subject_id, score_version).
CREATE TABLE subject_scores (
  id              BIGSERIAL PRIMARY KEY,
  subject_id      TEXT      NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  score_version   TEXT      NOT NULL,
  score           SMALLINT  NOT NULL CHECK (score BETWEEN 0 AND 100),
  review_count    INT       NOT NULL,
  reviewer_trust_mass NUMERIC(10,2) NOT NULL,        -- Σ(reviewer_trust) used for normalisation
  score_inputs    JSONB     NOT NULL,                -- per-dimension breakdown, top-3 reviewers, etc.
  computed_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (subject_id, score_version)
);
CREATE INDEX idx_subject_scores_subject ON subject_scores (subject_id);
CREATE INDEX idx_subject_scores_score   ON subject_scores (score DESC) WHERE score_version = 'v1';

-- Add to existing `subjects` table for orphan GC.
ALTER TABLE subjects ADD COLUMN last_attested_at TIMESTAMPTZ;
CREATE INDEX idx_subjects_orphan_gc ON subjects (last_attested_at)
  WHERE last_attested_at IS NOT NULL;

-- Add enrichment columns to `subjects` (see §3.6).
ALTER TABLE subjects ADD COLUMN category     TEXT;
ALTER TABLE subjects ADD COLUMN metadata     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE subjects ADD COLUMN language     TEXT;
ALTER TABLE subjects ADD COLUMN enriched_at  TIMESTAMPTZ;
CREATE INDEX idx_subjects_category   ON subjects (category)        WHERE category IS NOT NULL;
CREATE INDEX idx_subjects_language   ON subjects (language)        WHERE language IS NOT NULL;
CREATE INDEX idx_subjects_metadata   ON subjects USING GIN (metadata jsonb_path_ops);
-- Lat/lng index for radius queries on places.
CREATE INDEX idx_subjects_geo ON subjects ((metadata->>'lat'), (metadata->>'lng'))
  WHERE metadata ? 'lat' AND metadata ? 'lng';

-- Add language column to `attestations` (already-existing table). Auto-detected
-- by ingester via franc-min on headline.
ALTER TABLE attestations ADD COLUMN language TEXT;
CREATE INDEX idx_attestations_language ON attestations (language) WHERE language IS NOT NULL;

-- FTS support for subject + attestation full-text search (see §6.1).
-- Subjects: weighted tsvector over name + category + metadata text fields.
ALTER TABLE subjects ADD COLUMN search_tsv tsvector;
CREATE INDEX idx_subjects_search_tsv ON subjects USING GIN (search_tsv);
-- Attestations: tsvector over headline + body, weighted A/B.
ALTER TABLE attestations ADD COLUMN search_tsv tsvector;
CREATE INDEX idx_attestations_search_tsv ON attestations USING GIN (search_tsv);
-- search_tsv is populated by trigger on insert/update — see migration body.

-- Cosig request lifecycle. One row per (requester, attestation, recipient) tuple.
-- Distinct table from `dina_tasks` (Core delegation) — cosig has cross-network,
-- multi-day expiry semantics that don't fit the local delegation model.
CREATE TABLE cosig_requests (
  id              BIGSERIAL PRIMARY KEY,
  requester_did   TEXT      NOT NULL,
  recipient_did   TEXT      NOT NULL,
  attestation_uri TEXT      NOT NULL,
  status          TEXT      NOT NULL CHECK (status IN ('pending','accepted','rejected','expired')),
  endorsement_uri     TEXT,                                 -- set on accept
  reject_reason   TEXT,                                 -- 'declined' | 'unknown' | 'expired'
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (requester_did, attestation_uri, recipient_did)
);
CREATE INDEX idx_cosig_requests_recipient ON cosig_requests (recipient_did, status);
CREATE INDEX idx_cosig_requests_expiry    ON cosig_requests (expires_at) WHERE status = 'pending';

-- Trust scoring runtime parameters. Hot-reloadable; the scorer reads on each run.
CREATE TABLE trust_v1_params (
  key             TEXT      PRIMARY KEY,
  value           NUMERIC   NOT NULL,
  description     TEXT      NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Seed rows: WEIGHT_VOLUME=0.25, WEIGHT_AGE=0.15, WEIGHT_COSIG=0.30, WEIGHT_CONSISTENCY=0.30,
--           N_VOLUME_TARGET=50, N_COSIG_TARGET=20, N_CONSISTENCY_MIN=3, VAR_MAX=0.25,
--           HOT_SUBJECT_THRESHOLD=10000, FRIEND_BOOST=1.5, FTS_WEIGHT_NAME='A',
--           FTS_WEIGHT_HEADLINE='B', FTS_WEIGHT_BODY='C'.

-- Records the firehose ingester rejected. Used by the mobile outbox watcher
-- to correlate AT-URIs the client published with their reject reason. Rows
-- expire after 7 days via a daily janitor job.
CREATE TABLE ingest_rejections (
  id              BIGSERIAL PRIMARY KEY,
  at_uri          TEXT      NOT NULL,
  did             TEXT      NOT NULL,
  reason          TEXT      NOT NULL,    -- 'rate_limit'|'signature_invalid'|'schema_invalid'|'namespace_disabled'|'feature_off'
  detail          JSONB,                  -- reason-specific context (limit_remaining, expected_key_id, etc.)
  rejected_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_ingest_rejections_at_uri ON ingest_rejections (at_uri);
CREATE INDEX idx_ingest_rejections_purge  ON ingest_rejections (rejected_at);

-- Mobile publish outbox watcher. Tracks AT-URIs the mobile client published
-- but hasn't yet seen indexed; used by §3.5.1's async-failure UX. AppView
-- doesn't write this — it's a mobile-side keystore record. Listed here for
-- conceptual completeness only.
```

### 4.2 Existing tables (unchanged)

`subjects`, `subject_identifiers`, `attestations`, `endorsements` already exist per `appview/src/db/schema/`. V1 only adds the two scoring tables above plus indexes.

### 4.3 Migration

Single forward migration `<YYYYMMDDHHMM>_trust_scores.sql` (timestamp set at PR-merge time per AppView convention). Creates the two scoring tables, adds `last_attested_at` column + index to `subjects`. No backfill required — scorer populates rows as it ingests new records; `last_attested_at` is populated by an on-write trigger from the attestations ingester (NULL → first-write timestamp; subsequent writes bump it forward).

## 5. Scorer

### 5.1 Inputs (per reviewer DID + namespace)

| Signal | Source | Computation | Edge case |
|---|---|---|---|
| `review_count` | `attestations` table | `COUNT(*)` filtered by `(author_did, namespace)` | — |
| `account_age_days` | First record on PDS | `now - MIN(created_at)`, capped at 365 | New account → 0 |
| `cosig_received_count` | `endorsements` table | `COUNT(*)` of endorsements whose `target` is one of this reviewer's attestations | — |
| `overall_variance` | `attestations.rating[overall]` | Per-author population variance of overall values mapped to numeric (see §5.3); skip if `review_count < 3` | When `review_count < 3` → `consistency_factor = 0.5` (neutral), do **not** compute variance |
| `network_hops_to_viewer` | Viewer's contacts graph | Computed at query time from PostgreSQL contact graph; cached in Redis 60 s, key=`(viewer_did, graph_version)` | No contacts → `0` for everyone (network term floors out) |

### 5.2 Reviewer score formula (`trust_score_v1`) — adopt existing AppView implementation

**Decision (TN-DEC-002):** V1 adopts the existing AppView scoring algorithm (`appview/src/scorer/algorithms/trust-score.ts`) as `trust_score_v1`, rather than implementing the simpler four-factor formula originally drafted in this section. The earlier draft is preserved in git history; this section now describes the actual implementation we'll use.

#### 5.2.1 Existing scorer (what V1 ships)

Output: `TrustScoreOutput { overallScore: number ∈ [0,1], components: {sentiment, vouch, reviewer, network}, confidence: number ∈ [0,1] }`.

Inputs (`TrustScoreInput`):

| Signal | Source | Used in |
|---|---|---|
| `attestationsAbout[]` | attestations whose subject is the DID being scored | sentiment |
| Each attestation: `sentiment, recordCreatedAt, evidenceJson, hasCosignature, isVerified, authorTrustScore, authorHasInboundVouch` | enriched at scorer time | sentiment |
| `vouchCount, highConfidenceVouches` | `vouches` table | vouch |
| `endorsementCount` | `endorsements` table | (statistics only) |
| `activeFlagCount, flagSeverities` | `flags` table | overall multiplier |
| `totalAttestationsBy, withEvidenceCount` | attestations authored by this DID | reviewer |
| `revocationCount, tombstoneCount` | revocations + tombstones authored by this DID | reviewer + coordination penalty |
| `helpfulReactions, unhelpfulReactions` | reactions on this DID's attestations | reviewer |
| `inboundEdgeCount` | `trust_edges` 1-hop counter | network |
| `delegationInboundCount` | `delegations` table | network bonus |

Composition:

```
overall = damping × (
  WEIGHT_SENTIMENT × sentiment(input) +
  WEIGHT_VOUCH     × vouch(input) +
  WEIGHT_REVIEWER  × reviewer(input) +
  WEIGHT_NETWORK   × network(input)
) + (1 - damping) × BASE_SCORE

# Multiplicative penalties:
for each flag.severity in input.flagSeverities:
  overall *= 0.3 if 'critical', 0.6 if 'serious', 0.85 if 'warning'
if input.tombstoneCount >= COORDINATION_TOMBSTONE_THRESHOLD:
  overall *= 0.4

clamp overall to [0, 1]
```

Sub-components:

| Component | Formula |
|---|---|
| `sentiment` | Time-decayed weighted average of attestation sentiments. Each attestation weight = `recency_decay × evidence_multiplier × verified_multiplier × bilateral_multiplier × authorTrustScore`; positive → +1, neutral → +0.5, negative → 0. Returns 0.5 when no attestations. |
| `vouch` | `min(1, log₂(1 + vouchCount) / log₂(11)) + min(0.2, highConfidenceVouches × 0.05)`, clamp [0,1]. Returns 0.1 when no vouches. |
| `reviewer` | `0.3 + helpfulRatio × 0.35 + evidenceRate × 0.25 - deletionRate × 2.0`, clamp [0,1]. Returns 0 if `totalAttestationsBy = 0`. |
| `network` | `min(1, log₂(1 + inboundEdgeCount) / log₂(51)) + min(0.2, delegationInboundCount × 0.04)`, clamp [0,1]. |
| `confidence` | Tiered by total signals: 0/0.2/0.4/0.6/0.8/0.95 at thresholds 0/3/10/30/100. |

All weights, multipliers, and thresholds live in `appview/src/config/constants.ts` today. V1 work moves them into the new `trust_v1_params` table for hot-reload without redeploy.

#### 5.2.2 Why this formula instead of the plan's earlier draft

- **Already implemented + tested.** The drafted formula would have shipped without the recency decay, evidence weighting, flag-severity penalty, or coordination signal that the existing scorer brings. No reason to ship the lesser version.
- **Aligns with Phase 2 soak.** Soak feedback tunes `trust_v1_params`; the same params drive both the V1 scorer and any future V2 alongside.
- **The draft's "reviewer base" and "network term" map cleanly onto the existing `components.reviewer + components.network`.** No semantic redesign needed.

#### 5.2.3 Score scale + viewer awareness

The existing scorer outputs `[0, 1]`. Mobile UI displays as `score × 100` rounded to integer (band thresholds at 33/66 stay the same). The plan's §5.3 subject-score formula stays unchanged conceptually but uses `overallScore × 100` per attestation when computing the trust-weighted aggregate.

Network-term-per-viewer (the 1-hop / 2-hop / 3+/unknown weights from the original draft) is **not** in `trust-score.ts` — that's a query-time addition. The `inboundEdgeCount` signal already carries network reach, but the per-viewer 1-hop boost lives in the search ranker (§7) instead of the reviewer score itself. This is cleaner: reviewer score is viewer-independent and cacheable; the friend-boost is applied at query time on top.

#### 5.2.4 V1 work to extend the existing scorer

- [ ] Add `score_version='v1'` stamping on every `subject_scores` and reviewer-score row write (TN-DB-001 / TN-DB-002).
- [ ] Move hardcoded `CONSTANTS` weights into the `trust_v1_params` table (TN-SCORE-009).
- [ ] Add namespace-aware scoping for reviewer scores so `(did, namespace)` produces independent scores (TN-SCORE-001).
- [ ] Cascade-on-write enqueue (TN-SCORE-004), orphan GC (TN-SCORE-005), cosig expiry sweeper (TN-SCORE-006), Redis cache (TN-SCORE-007), hot bounds (TN-SCORE-008), feature-flag gate (TN-SCORE-010).

### 5.3 Subject score formula (`subject_score_v1`)

For all attestations on a subject:

```
weighted_sum   = Σ(reviewer_trust_for_viewer × overall_value(attestation))
trust_mass     = Σ(reviewer_trust_for_viewer)
subject_score  = round(weighted_sum / trust_mass)     # ∈ [0, 100]
```

`overall_value(attestation)` extracts the rating entry where `dimension == "overall"`:

| `value` | Numeric |
|---|---|
| `exceeded` | 100 |
| `met` | 75 |
| `below` | 33 |
| `failed` | 0 |
| (no rating array, or no `overall` entry) | 50 (neutral) |

When `trust_mass == 0` (every reviewer has zero trust under the viewer's graph) the score is `null`; UI treats this identically to `n < 3`. When `review_count < 3`, the API returns `score: null` + `band: 'low'` + the raw reviewer list — UI renders "limited signal" instead of a number.

For `consistency_factor` in §5.2, the same mapping is rescaled to `[0, 1]` (exceeded=1.0, met=0.75, below=0.33, failed=0.0, default=0.5) and `overall_variance` is the population variance of those `[0, 1]` values for the reviewer's attestations. Theoretical max under a bimodal exceeded/failed pattern is `0.25`, so `VAR_MAX = 0.25` and `consistency_factor = 1 - clamp(overall_variance / 0.25, 0, 1)`.

### 5.4 Job design

| Job | Cadence | Trigger | Cascade |
|---|---|---|---|
| `reviewer_score_recompute` | nightly (cron 02:00 UTC) | All known DIDs | After: enqueue `subject_score_incremental` for every subject the changed reviewers have attested to (deduped) |
| `reviewer_score_incremental` | on-write | New attestation or endorsement involves DID `D` → recompute `D` only | After: if `reviewer_base` changed by ≥ 1 point, enqueue `subject_score_incremental` for every subject `D` has attested to |
| `subject_score_recompute` | nightly (cron 02:30 UTC) | All known subjects | None (terminal) |
| `subject_score_incremental` | on-write | New attestation on subject `S` → recompute `S` only | None (terminal) |
| `subject_orphan_gc` | weekly (cron Sunday 03:00 UTC) | Subjects with `review_count = 0 AND last_attested_at < now - INTERVAL '90 days'` | Cascading delete via FK on `subject_scores` |

**Cascade fan-out cap:** `reviewer_score_incremental` enqueues at most `min(N_attested_subjects, 1000)` downstream subject jobs per run. A reviewer with > 1000 attestations gets the remainder picked up by the next nightly batch. Prevents a single high-volume reviewer from saturating the queue.

**Idempotency:** all jobs upsert by `(did, namespace, score_version)` or `(subject_id, score_version)`. Re-running a job with the same input produces the same row.

**Job framework:** added to AppView Scorer's existing 9-job framework (see `appview/src/scorer/`). Implementation lands as `appview/src/scorer/jobs/trust_v1.ts` (computation), `appview/src/scorer/jobs/subject_orphan_gc.ts` (GC), and `appview/src/scorer/queue.ts` extension for the cascade enqueue path.

### 5.5 Score row stamping

Every score row written carries `score_version: "v1"`. V2 will write `score_version: "v2"` rows to the same table. The xRPC layer reads the freshest row by `computed_at`.

### 5.6 Network-position cache

The viewer's contact graph is computed live per request (1-hop and 2-hop sets) from the existing `contacts` table. To bound latency we cache:

```
key:    network:graph:<viewer_did>:<graph_version>
value:  { hop1: did[], hop2: did[] }      // sorted, deduped
ttl:    60 s
backend: Redis
```

`graph_version` is a monotonically increasing counter on the viewer's `contacts` row, bumped on every contact `add`/`remove`/`tier_change`. So a cache invalidation is `INCR network:graph_version:<viewer_did>` — old keys naturally TTL out, new requests hit a cold key.

Latency budget: ≤ 80 ms p95 for the search endpoint including this lookup. If we exceed budget in soak we'll precompute and store the graph snapshot per viewer; that's a perf optimisation, not a correctness change.

## 6. xRPC endpoints

All read endpoints under `com.dina.*`, served by the AppView Web daemon (port 3000). Writes happen at the user's PDS via `com.atproto.repo.createRecord` (see §3.5.1). AppView's role is read-side indexing + querying only.

| Endpoint | Kind | Auth | Rate limit |
|---|---|---|---|
| `com.dina.trust.search` | Read (xRPC query) | Public | 60 / IP / min |
| `com.dina.trust.subjectGet` | Read (xRPC query) | Public | 120 / IP / min |
| `com.dina.trust.resolve` | Read (xRPC query) | Public | 60 / IP / min |
| `com.dina.trust.networkFeed` | Read (xRPC query) | Public, viewerDid mandatory | 60 / IP / min |
| `com.dina.trust.attestationStatus` | Read (xRPC query) | Public | 600 / IP / min (high — outbox polls every 5 s) |
| `com.dina.trust.cosigList` | Read (xRPC query) | Public, recipientDid filter | 60 / IP / min |

**Why no `*.publish` / `*.delete` on AppView:** mobile writes records straight to the user's PDS using `com.atproto.repo.createRecord` and `com.atproto.repo.deleteRecord` with the appropriate lexicon ID. AppView ingests from the firehose and applies the rate-limit + signature gates there (see §3.5.1). Asynchronous-failure UX surfaces in the mobile inbox via the outbox-watcher pattern.

**Ingester gates** (run for every `com.dina.*` record received from Jetstream):

1. **Schema validation** — record must conform to its lexicon. Reject otherwise.
2. **Signature verification** — record's commit signature must verify against the `verificationMethod` id referenced in the record's `namespace` field (or root key when absent).
3. **Per-author rate limit** — attestation: 60/day, burst 5/min. Endorsement: 30/day, burst 3/min. Flag: 10/day. Excess records are dropped with `trust_v1.ingest.reject{reason: 'rate_limit'}`.
4. **Lexicon-specific validation** — e.g. attestation has exactly one of `subject.{did,uri,identifier,name}`; endorsement's `target` resolves to an existing attestation.

Failed records produce a `trust_v1.ingest.reject{at_uri, reason}` log + a `(at_uri, reason, ts)` row in `ingest_rejections` (a 7-day-retained table for outbox watcher correlation). The mobile outbox watcher polls `ingest_rejections` for AT-URIs in its expected-pending set.



### 6.1 `com.dina.trust.search` (query)

**Params:**
```ts
{
  q: string;                    // search query (FTS over subject.name + attestation.headline + attestation.body)
  viewerDid: string;            // for network-position computation

  // Lexicon-level scope filter (always strict: type=product never returns place).
  type?: SubjectType;

  // Within-type refiners (see §3.6 for how categories/metadata are populated):
  category?: string;            // exact match, e.g. 'product:chair', 'place:restaurant'
  categoryPrefix?: string;      // prefix match, e.g. 'product' matches 'product:chair' AND 'product:phone'
  language?: string | string[]; // BCP-47 tags; OR-match if array
  location?: {                  // radius query against metadata.lat/lng (places only)
    lat: number;
    lng: number;
    radiusKm: number;           // capped at 200
  };
  metadataFilters?: Record<string, string | number | boolean>;
                                 // exact-match against metadata.<key>; whitelisted keys only:
                                 // brand, place_type, cuisine, host, media_type, org_type, identifier_kind, domain
  minReviewCount?: number;       // default 0; useful for "established only"
  reviewersInNetwork?: 'any' | 'one_plus' | 'majority';
                                 // 'any' = no constraint; 'one_plus' = ≥1 1-hop reviewer;
                                 // 'majority' = >50% of reviewers are within 2 hops

  limit?: number;               // default 25, max 100
  cursor?: string;              // pagination
}
```

**Filter semantics:** all filters AND together. `type` is mandatory-strict (a chair search never returns places). `category` and `categoryPrefix` are mutually exclusive — use prefix when the user picks "Furniture" (covers chairs, desks, lamps); use exact when the user drilled into "Furniture › Chairs".

**Default behaviour without filters:** `q` runs against the FTS index alone, ranked per §7. UI exposes facets derived from the result set's `category` / `metadata` distribution so the user can refine.

**Response:**
```ts
{
  results: Array<{
    subject: SubjectRef;
    subjectId: string;
    score: number | null;       // null when n < 3
    band: 'low' | 'medium' | 'high';
    reviewCount: number;
    topReviewers: Array<{
      did: string;
      networkPosition: 'contact' | 'fof' | 'stranger' | 'unknown';
      trustBand: 'low' | 'medium' | 'high';
      headline: string;         // attestation preview
    }>;                          // top 3 by reviewer_trust_for_viewer
    relevance: number;
  }>;
  cursor?: string;
}
```

Ranking: see §7.

### 6.2 `com.dina.trust.subjectGet` (query)

**Params:** `{ subjectId: string; viewerDid: string; cursor?: string; limit?: number }`

**Response:**
```ts
{
  subject: SubjectRef;
  score: number | null;
  band: 'low' | 'medium' | 'high';
  reviewCount: number;
  reviewers: {
    contacts: ReviewerEntry[];     // 1-hop, sorted by trust desc
    extended: ReviewerEntry[];     // 2-hop, sorted by trust desc
    strangers: ReviewerEntry[];    // 3+/unknown, sorted by trust desc
  };
  cursor?: string;
}
```

### 6.3 `com.dina.trust.resolve` (query)

Returns the canonical `subject_id` for a SubjectRef, or `null` if the subject doesn't yet exist in the index. Used by the mobile compose flow to preview the canonical match before publish.

**Params:** `{ subject: SubjectRef; viewerDid?: string }`

**Response:**
```ts
{
  subjectId: string | null;
  reviewCount: number;             // 0 if subjectId is null
  lastAttestedAt: string | null;   // ISO datetime
  conflicts?: Array<{               // populated when ≥ 2 candidates match the SubjectRef heuristically
    subjectId: string;
    subject: SubjectRef;
    reviewCount: number;
  }>;
}
```

`conflicts` lets the mobile UI disambiguate when, e.g., two "Aeron chair" entries with different `identifier` values both partial-match the user's input. UI shows a chooser in that case.

### 6.4 `com.dina.trust.networkFeed` (query)

Returns the viewer's network-feed: recent attestations from the viewer's 1-hop contact set within a configurable window. Backs the Trust tab landing screen.

**Params:**
```ts
{
  viewerDid: string;
  windowDays?: number;             // default 14, max 90
  limit?: number;                   // default 25, max 100
  cursor?: string;
}
```

**Response:**
```ts
{
  items: Array<{
    attestationUri: string;
    subject: SubjectRef;
    subjectId: string;
    reviewer: ReviewerEntry;       // 1-hop only — by definition for this feed
    headline: string;
    body?: string;
    createdAt: string;
  }>;
  cursor?: string;
}
```

When the viewer has no 1-hop contacts, returns `items: []` and the UI swaps in a "Add contacts to see their reviews" prompt. (No global fallback — that would contradict the social-review framing.)

### 6.5 `com.dina.trust.attestationStatus` (query)

Polled by the mobile outbox watcher (§3.5.1) to determine whether a record it published has been indexed, rejected, or is still in flight.

**Params:** `{ atUri: string }`

**Response:**
```ts
{
  state: 'indexed' | 'rejected' | 'pending';
  indexedAt?: string;                     // when state='indexed'
  rejection?: {                            // when state='rejected'
    reason: 'rate_limit' | 'signature_invalid' | 'schema_invalid' | 'namespace_disabled' | 'feature_off';
    detail?: Record<string, unknown>;
    rejectedAt: string;
  };
}
```

`state: 'pending'` means AppView has neither indexed nor rejected the record. Mobile keeps polling until terminal (or 60 s budget elapses, then surfaces a "stuck — retry?" inbox row).

### 6.6 `com.dina.trust.cosigList` (query)

Returns the cosig requests addressed to a given recipient (used by the unified-inbox renderer to populate the badge count and to display the request rows).

**Params:** `{ recipientDid: string; status?: 'pending' | 'accepted' | 'rejected' | 'expired'; limit?: number; cursor?: string }`

**Response:**
```ts
{
  requests: Array<{
    id: number;
    requesterDid: string;
    attestationUri: string;
    attestationPreview: { subject: SubjectRef; headline: string };
    status: 'pending' | 'accepted' | 'rejected' | 'expired';
    expiresAt: string;
    createdAt: string;
  }>;
  cursor?: string;
}
```

## 7. Trust-weighted ranking

Search ranking formula:

```
rank = relevance
     × (subject_score_v1 / 100)
     × log(1 + review_count)
     × friend_boost
```

Where:
- `relevance` is the Postgres `ts_rank_cd` against the combined tsvector (subject.search_tsv weighted A, attestation.search_tsv weighted B aggregated per subject), with FTS weights `WEIGHT_NAME='A', WEIGHT_HEADLINE='B', WEIGHT_BODY='C'` from `trust_v1_params`.
- `friend_boost = 1.5` if any 1-hop reviewer has reviewed the subject, else `1.0`.

Ties broken by `review_count` then `computed_at`.

When `subject_score_v1` is null (n < 3), substitute `0.5` (neutral) so cold subjects still surface for relevant queries but rank below scored alternatives.

**Filters happen before ranking.** `type` / `category` / `language` / `location` / `metadataFilters` from §6.1 are applied at the SQL `WHERE` level so the ranking only sorts within the user's scope. This is what prevents "best chair" from surfacing places that happen to mention "chair" in a review body.

**V2 ranking inputs** that consume V1 enrichment:
- `metadata.published_at` (content) → freshness boost
- `metadata.distance_km` (places, computed from `location` filter) → distance penalty
- `language` match against viewer's `accept_languages` → language boost

## 8. Mobile UX

### 8.1 New screens

```
app/trust/index.tsx              — Trust tab landing: network feed + search bar
app/trust/[subjectId].tsx        — Subject detail (reviewer list + write own)
app/trust/write.tsx              — Compose attestation (subject picker + form)
app/trust/namespace.tsx          — Manage pseudonymous namespaces
app/trust/reviewer/[did].tsx     — Reviewer profile: their public attestations + trust band
app/trust/search.tsx             — Search results (FTS + filters)
```

The landing screen is `app/trust/index.tsx`; it renders the `com.dina.trust.networkFeed` response (1-hop reviewers' recent attestations, 14-day window) above the search input. Tapping a feed row deep-links into `[subjectId]`. When the viewer has no contacts yet, the feed swaps to a "Add contacts to see their reviews" prompt with a button to People tab.

### 8.2 Bottom-tab entry

The Reminders + Notifications tabs move to the hamburger menu (this PR). The Trust Network claims their bottom-bar slot (see §13).

### 8.3 Subject card (search result)

```
┌──────────────────────────────────────────┐
│  Aeron chair · Office furniture          │
│                                          │
│  82  HIGH                14 reviews      │
│  ★ 2 friends · 12 strangers              │
│                                          │
│  "Worth every penny for the back"        │
│  — Sancho · contact · trust HIGH         │
└──────────────────────────────────────────┘
```

Score format: numeric (n ≥ 3) or band-only (n < 3). Friends pill always present when ≥1 contact reviewed. Subtitle line ("Office furniture") comes from the subject's `category` second segment (§3.6.1) — provides immediate context so the user can tell at a glance what kind of subject this is.

### 8.3.1 Search facets

After the user submits a query, the search screen renders a horizontal facet bar above the results. Facets are derived from the `category` / `metadata` distribution of the result set:

```
[All]  [Furniture · 12]  [Phones · 8]  [Books · 4]  [Software · 2]   …
```

Tapping a facet adds it to the search params (`category` or `categoryPrefix`) and re-runs the query. Multiple facets can be active; they refine within the same `type` scope. Long-tail facets collapse under "More" once 5+ are visible.

For type-specific filters:
- **Places**: a "Near me" toggle (uses device lat/lng + 5 km radius) plus a city chip-set
- **Content**: media-type chips (Video / Article / Podcast / Social post)
- **Books**: a year-range slider derived from `metadata.publication_year`
- **Restaurants**: cuisine chips from `metadata.cuisine`

The facet bar is the bridge between the user's natural-language query and the structured filters in §6.1. UI doesn't expose `metadataFilters` directly — the facet bar is the affordance.

### 8.4 Subject detail screen

Sections: Header (subject + score), Friends (collapsible, sorted by trust), Friends-of-friends (collapsible), Strangers (collapsible). Each reviewer entry: trust band, network position, headline, body (tap to expand), cosig count, reported flag count (V2 visible).

### 8.5 Write attestation flow

1. **Pick subject** — search by name, paste URL, scan ASIN/ISBN, or "Reviewing a place near me" (taps lat/lng from device). Subject type auto-detected from input shape (`did:` → did, URL → product/content per host heuristic, ISBN-13/ASIN → product, lat/lng → place, else show 3-row chooser). Mobile calls `com.dina.trust.resolve` to preview the canonical match.
   - If `subjectId` exists → show "Reviewing **<name>** — N reviewers" inline confirmation
   - If `null` and no conflicts → show "Creating new subject" inline notice
   - If `conflicts` → present a chooser with each candidate's `reviewCount`; user picks one or "None of these"
2. **Confirm subject context** (when applicable) — for places, mobile prompts for lat/lng (one-tap "use my location" or pin-drop); for content, mobile parses the URL to show host + media-type preview ("YouTube video"). The user can correct if the auto-detected category is wrong; the corrected SubjectRef carries an explicit `name` and the publisher-set type, AppView's enrichment runs on top.
3. **Compose** — headline (required, ≤140), body (optional, ≤4000), per-dimension rating (overall required, others optional). Live character counters.
4. **Pick namespace** — defaults to root; selector lists user's namespaces. "Add new namespace" CTA links to `app/trust/namespace.tsx`.
5. **Publish** — mobile calls `com.atproto.repo.createRecord` against the user's PDS using the namespace key as record-signing key; AT-URI added to outbox watcher (§3.5.1) for indexing-confirmation.
6. **Confirmation** — outbox watcher sees the record indexed within 60 s and dismisses the inline "Posting…" indicator. On rejection (rate limit, signature failure), the inbox surfaces a `system_message` row with the failure reason and a "Try again" link back to the original draft.

**Note on enrichment:** the publisher does NOT manually classify their subject into a category. AppView's enrichment job (§3.6) derives `category`, `metadata`, and `language` from the SubjectRef + heuristics. The mobile compose flow captures only what the publisher actually knows (name, URL, identifier, optional lat/lng for places). This keeps the publish surface small and avoids forcing users into a taxonomy.

### 8.6 Edit own attestation

Atproto records are immutable, so V1 ships **edit = delete + republish** under the hood. UI labels the long-press menu item "Edit"; tapping opens the original draft in `write.tsx`. On publish, mobile (a) calls `deleteRecord` for the original AT-URI, then (b) calls `createRecord` with the updated body. Both are queued through the outbox watcher.

Race: if the user has an in-flight cosig request on the original attestation, the edit-republish breaks the endorsement (endorsement's `target` AT-URI no longer resolves). V1 surfaces a confirm dialog: "This review has 2 cosignatures. Editing will release them — they'll need to be requested again." V2 may add endorsement migration.

### 8.7 Delete own attestation

Long-press own row in subject detail → "Delete this review". Confirmation modal. Mobile calls `com.atproto.repo.deleteRecord`. Subject score recomputes within 5 s (incremental scorer triggered when ingester sees the tombstone).

### 8.8 First-run modal

Triggers when user opens Trust tab the first time. Single screen:
> Trust Network is a social review system. Reviews are tagged to identities — yours and people who reviewed before you. Right now, scoring relies on simple signals (review count, network position, history). It can be gamed by motivated actors, and your namespace identities are pseudonymous to first-impression observers but not to dedicated investigators. Use it as one input among many.

Dismissed once → flag in keystore. Settings → "About Trust Network" repeats the same text.

### 8.9 Reviewer profile screen

`app/trust/reviewer/[did].tsx`. Reached by tapping a reviewer entry on a subject card or feed row. Shows:

- Header: namespace name (if visible to viewer's network), trust band, network position relative to viewer, account age
- Tabs: "Reviews" (their attestations, paginated), "Co-signed by them" (endorsements they've published)
- Long-press on a review row: "Block this reviewer" — adds the DID to the viewer's mute list (V1 client-side only; no server-side block)

Reviewer's namespace name is `name` from `com.dina.trust.namespaceProfile` if the namespace is visible (i.e., DID document includes the verification method). For namespaces the viewer can't yet see, falls back to "Pseudonymous reviewer · #namespace_K".

### 8.10 Loading / error / empty states

- **Loading**: skeleton placeholder (3 grey rows mimicking the subject card layout) for search and subject detail; spinner for resolve and write submit
- **Error (XRPC failure)**: full-screen error card with "Try again" button; logs `trust_v1.client.error{endpoint, status}` to crash log
- **Error (429 rate limit)**: inline message at the top of the compose screen — "You've hit the daily limit (60 reviews/day). Try again in N hours." (server returns reset-time in `Retry-After`)
- **Error (offline)**: surfaced through `NetInfo`; inbox shows "Reviews queued — will post when back online" badge while outbox is non-empty (see §8.12)
- **Empty (search no results)**: "No matches for **<query>**" + "Did you mean to **create a new subject**?" CTA wiring to compose flow with the query as initial subject name
- **Empty (subject with zero reviews)**: "Be the first to review this" + Compose CTA. Possible when subject was created speculatively by ingester before any attestation landed.

### 8.11 Mobile state management

No new dependency (`react-query` etc.) — match the existing codebase pattern from `notifications.tsx` and `reminders.tsx`:

- `apps/mobile/src/trust/api.ts` exposes async XRPC client functions (`searchSubjects`, `getSubject`, `resolveSubject`, `getNetworkFeed`, `listCosigRequests`) plus a tiny in-memory cache + subscribe layer:
  - `subscribeSubject(id, cb)` — fan-out subscription; `cb` fires when the cached `getSubject` row updates
  - `invalidateSubject(id)` — called from mutation paths (publish/delete/cosig) so subscribers re-fetch
- Screens use `useFocusEffect` to refresh on tab focus
- Search has stale-while-revalidate: results show cached rows immediately, fire a background fetch, swap when fresh data arrives. Cache TTL 30 s
- Cosig + publish mutations call `invalidateSubject` on success; subscribers re-render
- **Cache eviction**: LRU, max 200 subjects in memory; `AppState.memoryWarning` evicts to 50

### 8.12 Offline publish queue

The mobile client buffers attestations / endorsements / cosig actions when offline:

- Outgoing records persist in keystore as `trust.outbox` (FIFO, max 50 items)
- `NetInfo` reachability change → flush queue, attempting publish in order
- Each retry's failure increments a per-row `attempt_count`. After 5 attempts or 24 h since first attempt, the row is moved to a "stuck" subset and surfaced as a `system_message` in the inbox: "3 reviews didn't post — tap to review and retry."
- The user can manually edit / delete stuck items from a Settings → Trust Network → Outbox screen (drilled to from the system message)

Offline-aware composer: while NetInfo reports unreachable, the publish button reads "Queue for later" and the confirmation toast is "Saved — will post when online."

Keeps the trust feature's runtime model identical to the inbox/reminders surfaces a maintainer already understands.

## 9. Pseudonymous DID derivation

Path: `m/9999'/4'/N'` where `N` is the namespace index (0 = root, 1+ = user-named).

Implementation:
- `core/internal/identity/keygen.go` — Go canonical implementation, used by Go Core
- `packages/keystore-node/src/derivation.ts` — Lite implementation, byte-equivalent
- `packages/keystore-expo/src/derivation.ts` — Expo implementation, byte-equivalent

Recovery: master seed regenerates all namespace keys deterministically. Namespace metadata (display name, optional public handle) lives in `com.dina.trust.namespaceProfile` records on the user's PDS — recovered by re-resolving the user's repo.

## 10. Bilateral cosignature handshake

V1 D2D message types (in `packages/protocol/src/d2d/`):

```ts
type CosigRequest = {
  type: 'trust.cosig.request';
  attestation_uri: string;       // target
  namespace: string;
  expires_at: string;            // ISO datetime
};

type CosigAccept = {
  type: 'trust.cosig.accept';
  attestation_uri: string;
  endorsement_uri: string;           // AT-URI of the endorsement record published on accept; returned to requester for visibility
};

type CosigReject = {
  type: 'trust.cosig.reject';
  attestation_uri: string;
  reason: 'declined' | 'unknown' | 'expired';
};
```

State machine (one row per `(requester_did, attestation_uri, recipient_did)` tuple in the `cosig_requests` AppView table — see §4.1 for DDL):

```
pending → accepted (→ endorsement record published; endorsement_uri stored)
        → rejected (declined | unknown)
        → expired (default 7 days; expiry sweeper flips status)
```

Optional in V1 — users can publish attestations without ever requesting cosignatures.

**Expiry sweeper:** hourly cron job `cosig_expiry_sweep` finds rows with `status = 'pending' AND expires_at < now`, flips their status to `expired`, sends a `trust.cosig.reject{reason: 'expired'}` D2D message back to the requester, and increments the corresponding inbox row to `kind: 'approval', subKind: 'trust_cosig', state: 'expired'` so the recipient sees the expired entry struck through.

**Recipient UX surface:** an inbound `trust.cosig.request` lands in the unified inbox (`apps/mobile/app/notifications.tsx`) as `kind: 'approval'` with `subKind: 'trust_cosig'`. Title: `"Sancho asked you to co-sign their review"`. Tap deep-links to the source attestation in `app/trust/[subjectId]` with an Endorse / Decline action sheet pinned to the bottom. Action choice emits `trust.cosig.accept` (publishes endorsement + sends D2D response) or `trust.cosig.reject`. Auto-expire fires `trust.cosig.reject{reason: 'expired'}` 7 days after the request and clears the inbox row.

**Sender UX surface:** the user's own attestation detail screen shows pending cosig requests inline (`"2 pending"`) and accepted cosigs as a "Co-signed by Sancho · Albert" footer once endorsements land.

## 11. Subject identifier graph

Already implemented in `appview/src/db/queries/subjects.ts` with three-tier resolution:
1. Global identifier (did, uri, identifier with type prefix) → deterministic ID via SHA-256
2. Author-scoped (`type + name + author_did`) → for "Aunt Rita's review of *that*" style
3. Canonical chain (`canonicalSubjectId` pointer with cycle guard) → for merges

V1 uses tiers 1 and 2. Tier 3 (same-as merges) lands in V2 once the moderator role is built.

URL canonicalisation rules (in `appview/src/util/url.ts`, ensure correct):
- lowercase scheme + host
- strip explicit default ports (`:80` for `http`, `:443` for `https`)
- drop fragment (`#…`)
- strip these tracking query params (case-insensitive prefix match where indicated):
  - `utm_*` (prefix), `mc_*` (prefix — Mailchimp)
  - `gclid`, `fbclid`, `igshid`, `yclid`, `msclkid`, `dclid`, `_ga`, `_gl`
  - `ref`, `source`, `src` — when the value matches `^[a-z0-9_-]{1,32}$` (heuristic: short opaque tokens are tracking, long values are real)
- sort remaining query params lexically by key (preserves multi-valued params in order of appearance)
- preserve trailing slash distinction (`/foo` ≠ `/foo/` — different content possible per RFC 3986)
- preserve scheme distinction (`http://` ≠ `https://` — different URLs per RFC; subjects under both eventually merge via canonical chain in V2)

## 12. Forward compatibility

V2 mitigations are policy/scoring changes, not lexicon changes. The score row's `score_inputs` JSONB carries everything needed:

| V2 work | What it consumes | What it adds |
|---|---|---|
| Mutual-praise detection | Reciprocal endorsement pairs in `score_inputs` | Re-weights `reviewer_base` with reciprocity penalty |
| Sybil clustering | Account-age, IP diversity, behaviour fingerprint | New `score_version: "v2"` row alongside V1 |
| Statistics-aware aggregation | Existing review_count + variance | Adds Bayesian prior; subject_score becomes a posterior with confidence band |
| Flag UI | Existing `com.dina.trust.flag` records | UI surfaces; scorer absorbs flagged-count signal |
| Federation | New AppView peer table | Cross-instance lookup; V1 records federate as-is |
| Same-as merges | Existing `canonicalSubjectId` field | Populated by moderator action |
| **Per-namespace PDS accounts** (true pseudonymity) | Existing `verificationMethodId` on `namespace.profile` records | New `_v2_pdsAccount` field on namespace.profile pointing at the migrated DID; mobile flow provisions separate PDS account; existing records stay at original DID |
| **Verified handle binding** | Existing `_v2_publicHandle` reserved field | Mobile publishes handle claim via DID-document service entry signed with namespace key; AppView verifies before displaying |
| **Per-IP / per-PDS rate limiting** | Existing `ingest_rejections` table + observability counters | Adds `dina-admin trust suspend-pds` command + automatic threshold-based suspension |
| **Author edit (in-place)** | n/a — atproto is immutable | Stays as delete+republish; V2 may add endorsement migration so cosigs survive edit |

V1 record format never breaks. The scorer can be upgraded in place without re-publishing. V2 PDS-account migration is opt-in per namespace; non-migrated namespaces continue under the V1 same-DID model indefinitely.

## 13. Operational concerns

### 13.1 Revoked DIDs (subject of type `did`)

If a subject's DID becomes unresolvable (PLC tombstoned, did:key controller signs a revocation), V1 keeps the attestations and the score row unchanged. The mobile UI shows a `DID revoked` badge on the subject card; the score still computes against the remaining review history. Reviewers can still write attestations against a revoked DID (e.g. to flag a vanished service). V2 may add a moderator-driven fold into a successor DID.

### 13.2 Reviewer disappears

If a reviewer's PDS goes offline or their DID is revoked, AppView keeps the cached attestations + endorsement records — the social proof is in the records themselves, not the live PDS. Their `reviewer_base` recomputes on the nightly batch using the cached state. The `account_age_days` term keeps growing (it's a function of `now - first_record`, not "PDS reachable").

### 13.3 Subject merges (V2)

V1 does not perform same-as merges. The `canonicalSubjectId` field in `subjects` exists and is `NULL` for V1 rows. V2 introduces a moderator role that sets `canonicalSubjectId` to point at a survivor row; `resolveCanonicalChain` walks the chain with the existing cycle guard. Score rows for merged subjects sum into the survivor on the next nightly batch.

### 13.4 Backfill / replay

The ingester is idempotent (insert-or-update by AT-URI). To replay from Jetstream, drop `attestations`, `endorsements`, `flags`, `subject_scores`, `reviewer_trust_scores` and re-cursor; subjects auto-reconstruct from incoming records. Estimated replay throughput at V1 scale (≤ 100k records): ~30 min on a single AppView ingester.

### 13.5 Data export (GDPR Art. 17 / Art. 20)

A user requesting deletion of their attestations calls `com.atproto.repo.deleteRecord` per record from the mobile client (V1 ships single-record delete only; V2 may add bulk delete). Once deleted from the PDS, AppView's ingester picks up the tombstone and removes the index row. `subject_scores` recomputes on the next incremental run. Export is satisfied by `com.atproto.sync.getRepo` against the user's PDS — AppView holds no data the PDS doesn't.

### 13.6 Capacity targets (V1)

| Metric | Target |
|---|---|
| Attestations stored | 1M |
| Reviewer DIDs scored | 50k |
| Subjects | 200k |
| Search p95 latency | ≤ 250 ms |
| Search throughput | 50 RPS sustained |
| Nightly batch wall-clock | ≤ 30 min for full scorer sweep |

Beyond these, scale is V2 work (sharded ingester, materialised subject-score views, score-row partitioning).

### 13.7 Hot-subject / hot-reviewer bounds

When a subject's `review_count > HOT_SUBJECT_THRESHOLD` (default 10,000), incremental scoring is skipped on writes — only the nightly batch updates that subject. Without this bound, a popular subject (e.g. a viral product page) would force AppView to read 10k+ reviewer-trust rows on every new attestation, blocking the firehose ingester.

When a reviewer's `review_count > 5000`, their cascade fan-out still hits the per-run 1000-subject cap (§5.4), so high-volume reviewers naturally rate-limit themselves. No additional bound needed.

Both thresholds are stored in `trust_v1_params` and live-tunable.

### 13.8 Observability

| Signal | Type | Source | Alert threshold |
|---|---|---|---|
| `trust_v1.scorer.job.duration_ms` | histogram | per-job tracer | p95 > 5× nightly mean for 3 consecutive runs |
| `trust_v1.cascade.depth` | counter | scorer/queue.ts | n/a (diagnostic only) |
| `trust_v1.network_cache.hit_ratio` | gauge | network_cache.ts | < 60% sustained for 1 h |
| `trust_v1.ingester.lag_seconds` | gauge | firehose ingester cursor | > 60 s sustained for 5 min |
| `trust_v1.ingester.reject_total{reason}` | counter | ingester gates | spike > 10× baseline for `reason = 'signature_invalid'` |
| `trust_v1.cosig.expiry_sweep.processed` | counter | cosig_expiry_sweep | n/a |
| `trust_v1.api.request.duration_ms{endpoint}` | histogram | xRPC handler | p95 > 500 ms for `subject.search` |
| `trust_v1.api.request.error_total{endpoint, code}` | counter | xRPC handler | spike > 1% error rate |

**Tracing:** every record carries a synthetic `trust_v1.trace_id` from PDS write through firehose ingest to score row. Stored in score-row `score_inputs.trace_id`. Allows post-hoc reconstruction: "where did Sancho's review of the Aeron chair land?"

**Logs:** structured (JSON), with `at_uri`, `reviewer_did`, `subject_id`, `score_version`, `phase` fields. Sensitive fields (review body, reviewer email if leaked) are redacted at the log layer.

### 13.9 Feature flag

`appview_config.trust_v1_enabled` boolean stored in AppView's existing config table. When `false`:

- All `com.dina.*` xRPC endpoints return HTTP 503 with body `{error: 'trust_v1_disabled'}`
- Firehose ingester skips trust-network lexicon records (`com.dina.trust.attestation`, `endorsement`, `flag`, `namespaceProfile`)
- Mobile UI hides the Trust tab (the Trust tab entry in `_layout.tsx` becomes `href: null` when the bootstrap detects the flag is `false`)
- Scorer jobs no-op (return success without computing)

Flips on/off via `dina-admin trust enable|disable`. Default: `false` until Phase 0 parity gate passes; flipped to `true` for soak.

### 13.10 Cross-namespace correlation (V1 limitation)

Documented limitation:

- All namespaces share one DID document. Anyone reading the DID document sees the user has N namespaces.
- A network observer correlating signature key ids across the firehose can tell which namespace each record came from. Same-device, same-time publishes from two namespaces are linkable.
- **V1 namespaces are pseudonymous to first-impression observers, NOT to dedicated investigators.**

Disclosed in §8.8 first-run modal and the Settings → About Trust Network screen. V2 (per-namespace PDS accounts) closes this gap.

### 13.11 Per-IP / per-PDS rate limiting

V1 ingester rate-limits per author DID (60 attestations/day, etc.). It does NOT rate-limit per IP or per PDS host. A motivated attacker can spin up cheap DIDs across many PDS hosts and saturate the index with cheap-DID spam. This is acknowledged V2 work (sybil resistance).

Mitigation in V1: `trust_v1.ingester.reject_total{reason: 'rate_limit'}` is monitored; a sudden spike triggers a manual ops-pager rather than automated mitigation. Operations runbook (deferred): `dina-admin trust suspend-pds <host>` to drop ingestion from a specific PDS.

## 14. Phase plan

### Phase 0 — Foundations (13 weeks)

| Week | Deliverable | Acceptance |
|------|-------------|------------|
| 1 | Lexicons frozen, validators landed | `appview/src/lexicons/` has all 4 record types; validator tests pass |
| 2-3 | DB schema + migration (all tables: scoring, cosig, params, ingest_rejections, last_attested_at) | All tables exist; migration is idempotent; seed rows for `trust_v1_params` populate |
| 4-5 | Ingester handles new lexicons + signature gate + rate-limit gate + feature-flag gate | Jetstream ingestion: attestation → row in `attestations`; endorsement → row in `endorsements`; flag → row in `flags` (10/author/day cap); records with bad signatures land in `ingest_rejections`; feature-flag-off skips records cleanly |
| 6-7 | Pseudonymous DID derivation in Go + Lite + Expo | Three implementations produce byte-identical pubkeys for `m/9999'/4'/0..3'/` (test vector pinned in `packages/protocol/conformance/vectors/`) |
| 8 | Scorer skeleton (jobs framework) + `trust_v1_params` reader + feature-flag reader | Stub jobs run on schedule; param table drives the math; flag-off makes scorer a no-op |
| 9-10 | `trust_score_v1` + `subject_score_v1` math | Score rows populate from fixture data; unit tests cover edge cases (n=0, n=2, n=100, all-failed, all-exceeded, bimodal) |
| 11 | Cascade enqueue path + `subject_orphan_gc` job + `cosig_expiry_sweep` job + Redis network-position cache + observability metrics | Reviewer-score change cascades to N≤1000 subjects; orphan GC deletes correctly; cosig expiry flips status; cache hit rate ≥ 80% in load test; metrics emit |
| 12 | Subject enrichment (`subject_enrich` job) + host/keyword maps + language detection on attestations + FTS tsvector triggers | Enrichment populates `category`/`metadata`/`language` for all SubjectRef shapes in fixture; FTS tsvector updates on insert/update; manual re-enrich CLI works |
| 13 | Phase 0 parity gate | Compare V1 score outputs against a fixture truth table; trust-score formula vectors pinned in `packages/protocol/conformance/vectors/trust_score_v1.json`; load test hits capacity targets §13.6; enrichment fixture truth table |

### Phase 1 — Publishing + reading (19 weeks)

| Week | Deliverable | Acceptance |
|------|-------------|------------|
| 14-15 | Ingester gates (rate limit, signature, schema) + `ingest_rejections` table + outbox-watcher contract | Bad records dropped with logged reason; mobile can correlate AT-URI to rejection within 60 s |
| 16-17 | XRPC: `subject.search` (with type/category/location/language/metadata filters), `subject.get`, `subject.resolve`, `feed.network`, `attestation.status`, `cosig.list` | Read endpoints serve seeded data; ranking deterministic; filter combinations correct; resolve handles conflicts; feed honours 1-hop scope |
| 18-20 | Mobile: Trust tab landing (network feed) + search results screen + facet bar + reviewer profile | Empty-graph state shows "Add contacts" prompt; FTS works; facets refine within type scope |
| 21-23 | Mobile: subject detail + reviewer list + cosig sender list | Full read path live; tapping reviewer drills to profile |
| 24-26 | Mobile: write/edit/delete flow + subject resolve + place lat/lng capture + namespace selector + outbox watcher | Round-trips through scorer; place reviews carry coordinates; offline queue flushes on reconnect; outbox surfaces stuck items |
| 27-28 | Mobile: namespace creation + disable flow + recovery test | New namespace publishes PLC op + namespace.profile; disable flag respected by ingester |
| 29-30 | Cosig handshake — D2D wire types + `cosig_requests` table + expiry sweeper + recipient inbox UX + sender pending list | A requests cosig from B, B sees inbox row, accepts, endorsement lands, A's attestation shows co-signature footer; pending requests expire correctly |
| 31 | Mobile: first-run modal + settings disclosure + V1 limitation banner | Banner copy reflects pseudonymity caveat |
| 32 | Phase 1 parity gate | End-to-end test: publish → search → see in friend's app, including cosig + facet refinement + place radius search; observability dashboards green |

### Phase 2 — Soak (4 weeks)

| Week | Deliverable | Acceptance |
|------|-------------|------------|
| 33-34 | Internal soak with 10+ users | Each publishes 5+ attestations; rankings feel correct; facet bar feels useful; flag enabled in production |
| 35-36 | Iteration on `trust_v1_params` weights + host/keyword map updates based on soak feedback + ops runbook | Weights tunable from config table; recompute on change; map updates trigger re-enrichment batch; runbook covers ingester lag, cascade backlog, cache flush, enrichment-job catch-up |

**Total V1: ~36 weeks (~8 months) build + ~4 weeks soak = ~10 months end-to-end.** Patch added ~5 weeks net vs. previous estimate (PDS architecture, ingester gates, namespace registration, edit flow, outbox watcher, observability, subject enrichment + facet UI).

## 15. Test strategy

Per phase:

| Tier | Where | What |
|------|-------|------|
| Unit | `appview/__tests__/scorer/trust_v1.test.ts` | Score formula edge cases (n=0, n=2, n=100, all-failed, all-exceeded, bimodal, single-extreme), fixture truth table |
| Unit | `appview/__tests__/scorer/cascade.test.ts` | Reviewer-score change enqueues correct subject set; cap at 1000 honoured |
| Unit | `appview/__tests__/scorer/network_cache.test.ts` | Cache hit/miss semantics, invalidation on contact change, TTL behaviour |
| Unit | `appview/__tests__/scorer/orphan_gc.test.ts` | Subject with `review_count = 0 AND last_attested_at < now-90d` is deleted; non-orphans untouched |
| Unit | `appview/__tests__/lexicons/` | Validator tests, malformed-input coverage |
| Unit | `appview/__tests__/util/url_canonical.test.ts` | Canonicalisation rules — UTM strip, sort, default-port strip, trailing-slash preservation, `ref`-heuristic boundary cases |
| Integration | `appview/__tests__/api/subject-search.test.ts` | XRPC contract, ranking deterministic against seeded data, public read auth-free |
| Integration | `appview/__tests__/ingester/gates.test.ts` | Signature-valid record indexes; signature-mismatch produces `ingest_rejections` row with `reason: 'signature_invalid'`; rate-limit-exceeded → `reason: 'rate_limit'`; namespace-disabled → `reason: 'namespace_disabled'`; feature-flag-off → `reason: 'feature_off'` |
| Integration | `appview/__tests__/api/attestation-status.test.ts` | Round-trip: publish to PDS → poll status → transitions pending → indexed; rejected record transitions pending → rejected with detail |
| Integration | `appview/__tests__/api/flag-ratelimit.test.ts` | 11th flag in 24h drops with `flag.ratelimit` log; 10 succeed |
| E2E | `tests/e2e/trust-network/` | Full publish → ingest → score → search round-trip across 2 nodes |
| E2E | `tests/e2e/trust-network/cosig.test.ts` | A requests cosig from B → B sees in inbox → accepts → endorsement lands → A sees co-signature footer |
| Mobile | `apps/mobile/__tests__/trust/` | Component tests for cards, lists, write flow, first-run modal, cosig inbox row |
| User-story | `tests/system/user-stories/11-trust-network.test.ts` | New scenario: Don Alonso publishes review, Sancho searches, sees friend boost |
| Property | `appview/__tests__/scorer/properties.test.ts` (`fast-check`) | Score always in `[0, 100]`; cascade fan-out always ≤ 1000; jobs idempotent under repeated invocation; subject_score increases monotonically as positive reviewers are added |
| Load | `tests/load/trust_network/` (k6) | Phase 0 capacity targets: 1M attestations indexed in ≤ 30 min; search 50 RPS p95 ≤ 250 ms; nightly batch ≤ 30 min wall-clock |
| Security | `appview/__tests__/security/` | Signature forgery rejected (wrong namespace key); rate-limit-bypass via fast DID rotation logged + counted; flag-spam at 11/day correctly drops; cosig request to non-existent attestation rejected; bearer-token from wrong DID rejected |
| Accessibility | `apps/mobile/__tests__/trust/a11y.test.tsx` | VoiceOver labels for trust bands ("trust score 82, high"); colour-contrast on score badges meets WCAG AA; tap targets ≥ 44pt |
| Recovery | `tests/e2e/trust-network/recovery.test.ts` | Wipe device → restore from master seed → namespaces present with same names → previously published attestations visible |
| Unit | `appview/__tests__/util/subject_enrichment.test.ts` | Heuristics produce expected `category`/`metadata` for: ASIN, ISBN-13, place_id URI, lat/lng URI, youtube.com URI, medium.com URI, arxiv.org URI, did:plc, did:key, .edu host, free-text claim |
| Unit | `appview/__tests__/util/host_category.test.ts` | Each entry in the host map produces the documented `category` + `media_type`; unknown hosts default to `category='content'` with `host` populated |
| Integration | `appview/__tests__/api/search-filters.test.ts` | `type=product` excludes places; `category='product:chair'` excludes phones; `location` filter excludes out-of-radius places; `language` filter respected; multiple filters AND together; `categoryPrefix` matches sub-categories |
| Integration | `appview/__tests__/api/search-facets.test.ts` | Facet bar derivation: result set with mixed categories yields ranked facet list; tapping a facet narrows correctly |

Conformance: trust-score formula vectors pinned in `packages/protocol/conformance/vectors/trust_score_v1.json`. Lite implementations must reproduce. Vectors cover the same edge cases as the scorer unit tests so a fresh implementation can verify byte-for-byte.

## 16. Files to touch

**Lexicons (mostly modify-in-place):**
- 🔧 Extend existing `com.dina.trust.attestation` lexicon — add namespace field semantics (no schema break)
- 🔧 Extend existing `com.dina.trust.endorsement` lexicon — confirm cosignature semantics match plan §3.2
- 🔧 Extend existing `com.dina.trust.flag` lexicon — confirm matches plan §3.3, add ingester-level rate-limit
- ✨ New: `com.dina.trust.namespaceProfile` lexicon (one of the few genuinely-new artifacts in V1)

**New (AppView storage + scorer):**
- `appview/src/db/schema/trust_scores.ts` (`reviewer_trust_scores`, `subject_scores`, `cosig_requests`, `trust_v1_params`, `ingest_rejections`, `subjects.last_attested_at`)
- `appview/src/db/migrations/<YYYYMMDDHHMM>_trust_scores.sql`
- `appview/src/scorer/jobs/trust_v1.ts` (reviewer + subject scoring)
- `appview/src/scorer/jobs/subject_orphan_gc.ts`
- `appview/src/scorer/jobs/cosig_expiry_sweep.ts`
- `appview/src/scorer/queue.ts` (extended with cascade enqueue path)
- `appview/src/scorer/network_cache.ts` (Redis network-position cache)
- `appview/src/scorer/params.ts` (loads `trust_v1_params` config rows)
- `appview/src/scorer/feature_flag.ts` (`trust_v1_enabled` reader)

**New (AppView ingester + xRPC):**
- `appview/src/ingester/gates/signature.ts` (namespace-key signature verify against DID-doc verification methods)
- `appview/src/ingester/gates/rate_limit.ts` (per-author quotas; per-IP/per-PDS deferred to V2)
- `appview/src/ingester/gates/schema.ts` (lexicon-shape checks beyond atproto's native validation)
- `appview/src/ingester/gates/feature_flag.ts` (skip records when `trust_v1_enabled = false`)
- `appview/src/api/xrpc/subject-search.ts`
- `appview/src/api/xrpc/subject-get.ts`
- `appview/src/api/xrpc/subject-resolve.ts`
- `appview/src/api/xrpc/feed-network.ts`
- `appview/src/api/xrpc/attestation-status.ts`
- `appview/src/api/xrpc/cosig-list.ts`
- `appview/src/util/url_canonical.ts` (URL canonicalisation rules from §11)
- `appview/src/util/identifier_parser.ts` (ISBN-13 / ASIN / EAN canonicalisation; shared with mobile via `@dina/protocol`)
- `appview/src/util/subject_enrichment.ts` (heuristic enricher from §3.6.3)
- `appview/src/util/host_category.ts` (curated host → `(category, media_type)` map, ~50 entries)
- `appview/src/util/category_keywords.ts` (curated keyword → `category` map, ~200 entries)
- `appview/src/util/known_orgs.ts` (curated org allow-list, ~100 entries seeded)
- `appview/src/scorer/jobs/subject_enrich.ts` (enrichment job + weekly batch)

**New (AppView observability):**
- `appview/src/observability/metrics.ts` (Prometheus metric definitions for §13.8)
- `appview/src/observability/tracing.ts` (`trust_v1.trace_id` propagation)

**New (mobile screens):**
- `apps/mobile/app/trust/index.tsx` (landing: feed + search bar)
- `apps/mobile/app/trust/[subjectId].tsx` (subject detail)
- `apps/mobile/app/trust/write.tsx` (compose / edit)
- `apps/mobile/app/trust/namespace.tsx` (manage namespaces)
- `apps/mobile/app/trust/reviewer/[did].tsx` (reviewer profile)
- `apps/mobile/app/trust/search.tsx` (search results)
- `apps/mobile/app/trust/outbox.tsx` (stuck-publish recovery, drilled from inbox system message)

**Reuse from existing TS Lite (`packages/core/src/trust/`):**
- 🔧 `cache.ts` (TrustScore cache with KV backing + 1h TTL) — already implemented; mobile imports as-is
- 🔧 `query_client.ts` (`TrustQueryClient` calls AppView xRPC) — already implemented; needs xRPC NSID alignment with current AppView surface
- 🔧 `pds_publish.ts` (signs + publishes attestations) — already implemented; **needs lexicon NSID update from `community.dina.trust.attestation` → `com.dina.trust.attestation`**, and SubjectRef extension (currently DID-only)
- 🔧 `network_search.ts` (entity / identity / topic search) — already implemented; mobile reuses
- 🔧 `source_trust.ts` (sender → trust classifier) — already implemented; reused unchanged
- 🔧 `levels.ts` (trust ring 1/2/3 levels) — already implemented; reused unchanged

**New (mobile services):**
- `apps/mobile/src/trust/api.ts` (thin facade over `packages/core/src/trust/{query_client, network_search}` + subscribe/invalidate cache layer)
- `apps/mobile/src/trust/score_helpers.ts` (band thresholds, format helpers)
- `apps/mobile/src/trust/identifier_parser.ts` (ISBN/ASIN/URL → SubjectRef; shared via `@dina/protocol`)
- `apps/mobile/src/trust/outbox.ts` (offline publish queue + watcher polling `attestationStatus`)
- `apps/mobile/src/trust/plc_namespace.ts` (PLC op for adding `assertionMethod`)
- `apps/mobile/src/notifications/cosig_inbox_handler.ts` (`subKind: 'trust_cosig'` rows + accept/decline action sheet)

**New (protocol package):**
- `packages/protocol/src/trust/types.ts`
- `packages/protocol/src/trust/identifier_parser.ts` (canonical implementation; mobile + AppView import)
- `packages/protocol/src/d2d/cosig.ts` (request/accept/reject types + state machine)
- `packages/protocol/conformance/vectors/trust_score_v1.json`

**Modified:**
- `core/internal/identity/keygen.go` (namespace derivation `m/9999'/4'/N'`)
- `packages/keystore-node/src/derivation.ts`
- `packages/keystore-expo/src/derivation.ts`
- `appview/src/ingester/handlers/` (handlers for new lexicons; flag rate-limit; `subjects.last_attested_at` upsert trigger)
- `apps/mobile/app/_layout.tsx` (tab bar + hamburger menu changes — done in this PR; Trust tab `href: null` when `trust_v1_enabled = false`)
- `apps/mobile/app/notifications.tsx` (new `subKind: 'trust_cosig'` row renderer)
- `apps/mobile/src/services/bootstrap.ts` (read `trust_v1_enabled` flag from AppView config endpoint at boot)
- `admin-cli/src/commands/trust.ts` (new commands: `trust enable`, `trust disable`, `trust suspend-pds`)

### 13.12 Enrichment job catch-up

When the host or keyword maps update (a deploy lands a new TS file), the next weekly `subject_enrich_recompute` batch picks up the changes for all existing subjects. For ~200k subjects at ~1 ms each, this completes in under 5 min — well within the nightly window. If a high-impact change needs immediate effect (e.g. a misclassified popular site), `dina-admin trust enrich --all` triggers an out-of-band batch run.

Weekly batches log `trust_v1.enrich.changed_total{field}` so we can see how many subjects flipped category / metadata after a map update — useful for evaluating heuristic changes during soak.

## 17. Glossary

- **Subject** — the thing being reviewed (chair, video, person, place, organisation, claim)
- **Attestation** — a single review by one reviewer of one subject
- **Endorsement** — a cosignature on someone else's attestation (V1 endorse-only); existing AppView lexicon `com.dina.trust.endorsement`. Plan-internal name "binding" is retired
- **Flag** — negative signal record (V1 stored, V1 UI deferred); rate-limited at ingester
- **Namespace** — a pseudonymous identity scoped to a topic; key derived `m/9999'/4'/N'`; registered as a verification method (`#namespace_N`) in the user's DID document
- **Verification method** — atproto/W3C DID concept; an entry in the DID document declaring a public key plus its purpose (`assertionMethod`, `keyAgreement`, etc.); namespace keys live here
- **Network position** — viewer-relative graph distance (1-hop contact, 2-hop, 3+/unknown)
- **Trust band** — discretised score (low / medium / high)
- **Score version** — `v1` or `v2`; V1 records remain valid under V2 scorer
- **Reviewer base** — context-free portion of a reviewer's trust score, range `[0, 60]`, stored in `reviewer_trust_scores.score`
- **Network term** — viewer-specific portion of a reviewer's trust score, range `[0, 40]`, computed at query time
- **Reviewer trust for viewer** — `reviewer_base + network_term`, range `[0, 100]`
- **Trust mass** — `Σ reviewer_trust_for_viewer` across attestations on a subject; the denominator in subject-score normalisation
- **Cascade enqueue** — when a reviewer's score changes, the queue gains one `subject_score_incremental` job per subject that reviewer has attested to (capped at 1000)
- **Graph version** — monotonic counter on viewer's contacts row, used for Redis network-cache key invalidation
- **Outbox watcher** — mobile-side mechanism that polls AppView for AT-URIs the client published but hasn't yet seen indexed; surfaces async failures via inbox system messages
- **Ingester gate** — synchronous validation step inside the firehose ingester (signature, rate limit, schema, feature-flag); failures land in `ingest_rejections`
- **Hot subject** — subject with `review_count > 10k`; skips incremental scoring, relies on nightly batch only
- **Hot reviewer** — reviewer with `review_count > 5k`; cascade fan-out still hits the per-run 1000-subject cap, no additional bound
- **First-impression pseudonymity** — the V1 namespace privacy posture: namespaces are unlinkable to the casual observer reading a feed but linkable to anyone who reads the DID document
- **Subject enrichment** — server-side derivation at ingest of `category`, `metadata`, `language` from the sparse SubjectRef the publisher writes; isolates the publisher from the taxonomy
- **Category** — normalised lowercase string identifying a subject's bucket, possibly with `:`-delimited second segment (`'product:chair'`, `'place:restaurant'`); driven by enrichment heuristics
- **Facet** — a UI affordance on the search results screen; tapping a facet adds a `category` or `metadata` filter to the live query
- **Host map** — `appview/src/util/host_category.ts`: curated list mapping URL hosts to `(category, media_type)`; updates require deploy + re-enrichment batch
