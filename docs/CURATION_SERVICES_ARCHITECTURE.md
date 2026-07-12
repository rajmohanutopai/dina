# Curation Services: Discovery by Earned Trust

## Architecture grounded in Dina's current system

**Status:** Design specification. Implementation is phase-gated.

**Purpose:** Let a person ask trusted specialist services for recommendations,
let their own Dina personalize those recommendations using private local context,
and make the specialists accountable through signed outcomes over time.

This document describes how to build that system from Dina's existing service,
PeerLens, identity, plugin-release, grant, and AppView mechanisms. It also states
where additive protocol work is required and where the protocol cannot provide
an absolute guarantee.

---

## 1. The idea in plain language

A user can follow a trusted specialist such as a book curator, a technology
reviewer, a librarian, or a specialist AI.

When the user asks Dina for a recommendation:

1. The specialist ranks items using its own expertise and corpus.
2. Dina applies the user's private preferences and constraints locally.
3. The specialist does not receive vault data unless the user explicitly grants
   access.
4. Dina shows why each result was selected and how much evidence exists.
5. Later, the user can report whether the recommendation actually worked.
6. Those outcomes gradually build or reduce the specialist's standing.

The intended division of labor is:

> Curators explore. Reviewers and outcomes verify. Dina decides what fits the
> user.

---

## 2. Scope and non-goals

### 2.1 In scope

- Discovering and subscribing to specialist recommendation services.
- Querying one or more subscribed curators.
- Keeping personal vault context local by default.
- Producing signed, schema-validated curation responses.
- Proving that a private response existed before its outcome was known.
- Publishing optional outcome attestations.
- Computing domain-scoped curator standing from public evidence.
- Supporting multiple independently operated scorekeepers.
- Showing sponsorship and conflict disclosures.
- Reusing Dina services and PeerLens instead of creating a parallel network.

### 2.2 Non-goals

- Guaranteeing that no curator is ever influenced by money.
- Making an authenticated D2D query anonymous in V1.
- Proving that a person actually bought, read, visited, or used a recommended
  item without an independent receipt.
- Producing one universal and objectively correct reputation number.
- Automatically publishing private user activity.
- Treating human reviewers and automated curators as behaviorally identical.
- Replacing ordinary PeerLens reviews.

---

## 3. Architectural position

A curator is an ordinary Dina service with a standardized recommendation
capability. It is not a new privileged actor and it does not receive a protocol
badge.

The system uses four existing layers:

| Layer | Existing Dina mechanism | Curation use |
|---|---|---|
| Identity | DIDs, service URIs, runtime issuers | Identify operator, service and response signer |
| Execution | Services and D2D/HTTPS response paths | Submit recommendation queries and receive answers |
| Public evidence | PeerLens records in ATProto repos | Publish digests, commitments and outcomes |
| Evaluation | AppView scoring and conformance | Compute curator evidence summaries and standing |

The new work is additive:

- a response-commitment record or commitment-log format;
- an outcome-attestation record;
- curator behavior epochs;
- curator-specific score dimensions;
- signed scorekeeper manifests and snapshots.

The architecture does not require a second service registry or a second trust
graph.

---

## 4. Roles

### 4.1 Subscriber

The person whose Dina asks for recommendations. The subscriber chooses the
curators and scorekeepers to use. Local preferences always override network
defaults.

### 4.2 Curator operator

The person or organization responsible for operating the curator. The operator
is identified by `operator_did`.

### 4.3 Curator service

The specific published service that answers recommendation queries. It is
identified by `service_uri`, not merely by the operator DID.

One operator can publish several independent curators. Standing from a phone
curator must not automatically transfer to the operator's book curator.

### 4.4 Runtime issuer

The identity authorized to sign responses from a hosted curator runtime. This
may differ from the PDS repository identity, following the runtime-issuer model
from the plugin architecture.

### 4.5 Outcome attester

The person who reports whether a review or curator recommendation held up. An
attestation is evidence, not proof that the underlying action occurred.

### 4.6 Scorekeeper

An AppView-like service that deterministically computes curator evidence from
a declared public input set and a published algorithm configuration. A user may
choose one or more scorekeepers.

---

## 5. Curator identity and behavior epochs

Standing must not attach to an operator DID alone. The standing key is:

```text
(service_uri, scope_id, behavior_epoch)
```

The related identifiers are:

```text
operator_did       Who is accountable for operating the curator
service_uri        Which published curator service this is
scope_id           What domain the standing applies to
behavior_epoch     Which materially consistent behavior earned the standing
release_cid        Which immutable implementation/declaration release is active
runtime_issuer     Which key may sign live responses
```

Example:

```text
operator_did: did:plc:example
service_uri: at://did:plc:example/com.dinakernel.service.profile/books
scope_id: books.english.science-fiction
behavior_epoch: 3
release_cid: bafy...
```

### 5.1 Changes that preserve an epoch

- Security patches that do not change recommendation behavior.
- Infrastructure migration with identical signed behavior configuration.
- Performance improvements that leave corpus and ranking semantics unchanged.
- Model patch updates proven to preserve the declared behavioral contract.

### 5.2 Changes that create a new epoch

- Operator change.
- Material corpus change.
- Scope change.
- Human, computed or hybrid provenance change.
- Ranking methodology change.
- Runtime issuer change.
- Material model or prompt change.
- Sponsorship or ownership change that may affect judgment.

Subscriptions may continue across an epoch change, but Dina must show the
change. Standing from previous epochs remains visible as history and may seed a
small, clearly labelled prior. It must not silently become the new epoch's full
standing.

The immutable release and `behavior_hash` mechanisms from the plugin
architecture should be reused. A curator declaration points to an immutable
release CID. Material behavior changes produce a new release and behavior
epoch.

---

## 6. Protocol surface

The design should reuse existing records wherever their meaning already fits.

### 6.1 Existing service profile

A curator publishes a normal `com.dinakernel.service.profile` with a standard
curation capability, for example:

```text
com.dinakernel.curation.recommend
```

The capability uses frozen parameter and result schemas. Curation-specific
metadata may live in a linked declaration record rather than expanding every
service profile.

### 6.2 Curation declaration

The declaration describes what the curator claims to cover and how it is
operated.

Required conceptual fields:

```text
service_uri
operator_did
runtime_issuer
scope_id
scope_description
behavior_epoch
release_cid
provenance: human | computed | hybrid
corpus_description
corpus_version
coverage_claim
methodology_summary
conflict_disclosures
updated_at
```

`coverage_claim` is a declaration, not proof. A curator saying it covers every
English novel does not make that true. Scorekeepers and clients may later show
observed coverage separately.

### 6.3 Private curation response

A private curation response is a signed service response, not necessarily a
public ATProto record.

Required conceptual fields:

```text
response_id
service_uri
scope_id
behavior_epoch
release_cid
runtime_issuer
query_category
recommendations[]
issued_at
expires_at
nonce
signature
```

Each recommendation contains bounded, schema-validated data:

```text
subject_id
rank
rationale
curator_confidence
evidence_refs[]
sponsorship_disclosure
```

Curator content is untrusted input. Rationale text must never be interpreted as
tool instructions. Dina validates the response schema, bounds text and item
counts, strips unsupported presentation features, and supplies it to local
reasoning as quoted evidence.

### 6.4 Public response commitment

A later public outcome is meaningful only if the network can establish that
the private recommendation existed before the outcome was known.

The basic commitment is:

```text
commitment = SHA-256(canonical_response || random_salt)
```

The curator publishes a timestamped record containing:

```text
commitment
service_uri
scope_id
behavior_epoch
release_cid
issued_at_bucket
commitment_version
```

The raw query, requester DID, recommendations and salt are not public.

For low volume, the curator may publish one commitment record per response. At
scale, it publishes periodic Merkle roots and returns an inclusion proof with
each private response. The outcome references the commitment and includes only
the disclosure necessary for the selected privacy mode.

This provides ordering and existence evidence. It does not prove that the user
acted on the recommendation or that the recommendation was good.

### 6.5 Existing PeerLens collection as digest

Public curator digests should reuse `com.dinakernel.peerlens.collection` where
possible. A linked declaration or optional extension can identify:

```text
service_uri
scope_id
behavior_epoch
corpus_version
methodology_summary
```

A separate digest lexicon should be introduced only if the existing collection
cannot express the required immutable references and disclosures.

### 6.6 Outcome attestation

The outcome record can refer to either an ordinary review or a committed
curation response.

Required conceptual fields:

```text
attester_did
reference_type: review | curation_response
reference_uri_or_commitment
service_uri?            # required for curation outcomes
scope_id?
behavior_epoch?
subject_id
outcome: held_up | mixed | failed
elapsed_bucket
novelty_snapshot_ref?
text?
created_at
```

The protocol must enforce at most one active outcome from one attester for one
reference and subject. Corrections use amendment/revocation semantics rather
than creating unlimited independent votes.

---

## 7. Response commitment flow

```text
Subscriber's Dina                 Curator                 Public repo
       |                             |                         |
       | signed query                |                         |
       |---------------------------->|                         |
       |                             | create response         |
       |                             | sign response           |
       |                             | hash(response + salt)    |
       |                             | publish commitment       |
       |                             |------------------------>|
       | private response + salt     |                         |
       | commitment reference        |                         |
       |<----------------------------|                         |
       | verify signature            |                         |
       | verify commitment           |                         |
       | store local receipt         |                         |
```

For a Merkle batch, the curator returns the leaf, salt and inclusion proof. Dina
accepts an outcome-eligible response only after the commitment or batch root is
observable from the configured public source.

If commitment publication fails, Dina may still show the recommendation, but
it labels the response `not publicly committed`. Such a response cannot improve
the curator's public outcome standing.

---

## 8. Query privacy

### 8.1 V1 guarantee

The defensible V1 guarantee is:

> Dina does not send vault contents or raw personal context to a curator by
> default. The curator may still see the authenticated Dina identity and query
> metadata required by the selected transport.

D2D authentication intentionally reveals the sender DID to the receiver. HTTPS
also reveals network metadata unless a relay or proxy is used. Therefore the
protocol must not claim that the curator "never sees you."

### 8.2 Information minimized by default

- Category-level intent rather than raw conversation text.
- No vault excerpts.
- No local personalization features.
- No relationship graph.
- Coarse locale only when required for the capability.
- Coarse time buckets in public commitments.
- No public requester identifier in commitment records.

### 8.3 Explicit context grant

If a user chooses to share context, the existing grant and approval machinery
applies. The grant declares:

```text
curator service_uri
context categories
allowed fields or summary schema
purpose
expiry
maximum uses
revocation status
```

Raw vault access is never granted to the remote curator. Dina assembles an
approved summary locally and sends only that summary.

### 8.4 Later anonymity options

Authenticated anonymity is not present in the current system. Possible future
approaches include:

- pairwise pseudonymous DIDs per curator;
- anonymous or blind-signed subscription credentials;
- a privacy relay that hides network metadata;
- batched or cached curator queries;
- private information retrieval for large static curator corpora.

Existing PeerLens namespaces provide presentation separation but are not fully
unlinkable from the root DID. They must not be marketed as anonymity.

---

## 9. Outcome privacy

Publishing an outcome can disclose reading, purchasing, medical, financial,
location or relationship activity. Outcome publication is always explicit.

The user receives three modes:

### 9.1 Private outcome

- Stored only in a local encrypted vault.
- Improves Dina's local personalization.
- Does not affect public curator standing.

### 9.2 Minimal public outcome

- Publishes outcome enum, response commitment and subject identifier.
- Omits free text by default.
- Shows the exact public payload before confirmation.
- Uses the root DID unless the user selects a namespace.

### 9.3 Pseudonymous public outcome

- Publishes through an existing PeerLens namespace.
- Clearly warns that the namespace may still be linkable through the DID
  document or activity patterns.

Sensitive categories default to private. A reference client must maintain a
category policy with at least health, finance, precise location, intimate
relationships, children and legal matters treated as sensitive.

Outcome prompts must be rate-limited and dismissible. Dina should prompt only
after an explicit local action such as saving a recommendation, marking it as
used, completing a related task, or opening an outcome reminder. Merely viewing
a recommendation is not evidence that the user acted on it.

---

## 10. Standing model

### 10.1 Shared evidence, separate calibration

Humans and curators use the same public identity and evidence substrate, but
they do not have to use an identical formula.

Human reviewer quality may depend on review history, evidence, corroboration,
vouches and coordination risk. Curator quality additionally depends on:

- outcome calibration;
- scope-specific sample size;
- coverage;
- freshness;
- declared confidence versus observed success;
- behavior-epoch stability;
- conflicts and sponsorship disclosure;
- coordination and Sybil risk.

### 10.2 Standing is a vector

Scorekeepers publish dimensions rather than hiding everything behind one
number:

```text
scope_id
behavior_epoch
outcome_rate
outcome_confidence
sample_count
freshness
coverage_observed
calibration_error
coordination_risk
disclosure_completeness
computed_at
```

A client may calculate a convenience band such as `established`, `developing`
or `unrated`, but it must preserve access to the underlying dimensions.

### 10.3 Statistical smoothing

Raw success rate is not standing. One successful outcome must not produce a
100 percent trusted curator.

The reference scorekeeper uses a published Bayesian or Wilson-style interval,
with:

- a conservative prior;
- minimum effective sample sizes;
- recency weighting;
- attester-quality weighting;
- capped novelty uplift;
- coordination penalties;
- confidence intervals shown separately from the mean estimate.

### 10.4 Domain scope

Standing never automatically crosses scope boundaries. A curator established
for mobile-phone reviews is unrated for medical advice or novels unless a
scorekeeper publishes an explicit, inspectable transfer rule. The reference
scorekeeper performs no cross-domain transfer in V1.

### 10.5 Behavior epoch transition

A new epoch starts unrated, with an optional capped prior derived from earlier
epochs. The UI distinguishes:

```text
Current epoch: developing, 8 outcomes
Previous epoch: established, 241 outcomes
```

The previous record remains visible but cannot be presented as evidence earned
by the new behavior.

---

## 11. Composition and popularity bias

The composition law is:

> Judgment ranks. Volume reassures.

Dina ranks candidates primarily by:

```text
curator judgment
x local personal fit
x outcome quality estimate
x user overrides
```

Attestation count affects confidence, not intrinsic rank. A famous item cannot
outrank a better-fit item merely because it has more reviews.

### 11.1 Unrated items

An unrated item recommended by an established curator is displayed as:

```text
Unverified item recommended by an established curator
```

It must not be displayed as a high-confidence item. Curator standing supports
confidence in the source, not proof about the item.

### 11.2 Exploration

The reference client may reserve an exploration slot for a high-fit,
low-attestation item in low-risk domains such as books, music or entertainment.

Exploration is not a universal protocol invariant. It is disabled by default
for sensitive or high-impact domains such as health, finance, legal decisions,
physical safety and large purchases. The user's explore/exploit preference is
local and cannot be overridden by a curator.

### 11.3 Novelty evidence

An outcome's novelty context must reference a signed scorekeeper snapshot or
public checkpoint showing the subject's evidence level at the relevant time.
The attester must not supply an unverified count.

Novelty uplift is bounded. It can reward useful early discovery but cannot
dominate outcome quality or attester credibility.

---

## 12. Scorekeeper reproducibility

A signed score alone is not reproducible. Every scorekeeper publishes a signed
manifest containing:

```text
scorekeeper_did
algorithm_name
algorithm_artifact_hash
parameter_set_hash
parameter_values_or_uri
input_checkpoint
record_inclusion_rules_hash
moderation_policy_hash
sybil_policy_hash
schema_versions
generated_at
expires_at
```

Each standing snapshot references the exact manifest and input checkpoint.

The current PeerLens score-version and conformance-vector mechanisms are the
foundation. Curator scoring extends them by freezing the complete parameter
set for each published version. Runtime parameter changes require a new
manifest identifier.

### 12.1 Input checkpoint

The checkpoint identifies the public record state used by the computation. It
must account for:

- ingester cursor;
- included PDS/repository set;
- known dead letters or missing ranges;
- tombstones and deletions;
- moderation exclusions;
- algorithm execution time.

Two scorekeepers are comparable only when their input and policy differences
are visible.

### 12.2 Multiple scorekeepers

Dina does not silently average arbitrary scores. The user chooses a local
policy:

- use one selected scorekeeper;
- show a median across compatible manifests;
- require agreement within a tolerance;
- show disagreement without collapsing it.

Scorekeeper disagreement is information, not automatically an error.

---

## 13. Sybil and coordination resistance

Human-paced publication is not automatic Sybil resistance. A curator may
recruit people, operate multiple DIDs, or reward favorable outcomes.

The existing PeerLens defenses should apply:

- vouch gating;
- account and identity history;
- graph distance;
- attester standing;
- coordination detection;
- anomaly detection;
- repeated curator-attester relationship detection;
- rate limits;
- revocation and flag history.

Additional curation rules:

- At most one active outcome per attester, response commitment and subject.
- Outcomes from closely coordinated attesters receive reduced effective
  weight.
- Outcomes from the curator operator or declared affiliates carry no public
  standing weight but may remain visible.
- Novelty uplift is capped and coordination-adjusted.
- A large number of low-standing outcomes cannot outweigh a smaller body of
  established independent evidence merely through volume.
- Scorekeepers expose effective sample size after weighting, not only raw
  record count.

These measures reduce manipulation. They do not prove that every outcome is
truthful.

---

## 14. Economics and influence

The protocol cannot make paid influence structurally impossible. Payment can
happen outside the protocol.

The defensible invariant is:

> Payment is not an input to Dina's reference ranking formula. External
> influence remains possible and is addressed through disclosure, outcomes,
> plurality and revocation.

Curators may charge for access, accept patronage or receive tips. Every
declaration, response and digest supports structured disclosures:

```text
sponsored
affiliate_relationship
operator_ownership
free_product_or_service
other_consideration
conflict_statement
```

Missing disclosure is not proof of independence. Proven nondisclosure may be
reported through existing PeerLens flag/report mechanisms and reflected by
scorekeepers under a published policy.

A scorekeeper may itself be influenced. This is why scorekeeper manifests,
plural implementations and local choice are required.

---

## 15. Security requirements

### 15.1 Response validation

- Verify transport authentication.
- Verify response signature against the declaration's runtime issuer.
- Verify `service_uri`, scope, epoch and release CID binding.
- Verify response commitment before treating the response as outcome-eligible.
- Validate recommendation output against the pinned schema.
- Bound item count, text length and evidence references.
- Reject expired responses and replayed nonces.
- Treat rationale as untrusted data.

### 15.2 Endpoint safety

- Use the existing service endpoint resolution and allowlist rules.
- Block private-network SSRF for AppView/server-side fetches.
- Apply request timeout, response-size and redirect limits.
- Do not execute curator-supplied URLs or tool calls automatically.
- Open external links only through first-party confirmation UI.

### 15.3 Key and operator changes

- Runtime issuer rotation creates a material update.
- Operator change creates a new behavior epoch.
- Compromised issuers can be revoked.
- Responses signed after revocation are rejected.
- Historical responses retain the issuer and declaration version needed for
  verification.

---

## 16. End-to-end flows

### 16.1 Discover and subscribe

1. Dina searches ordinary service profiles for the curation capability.
2. Results show scope, provenance, disclosures and selected scorekeeper
   evidence.
3. The user subscribes to a specific `service_uri` and scope.
4. Dina stores the subscription locally as a service trust edge.
5. No subscription notification is sent to the curator.

The curator may still infer activity from later authenticated queries. V1 does
not promise traffic-analysis resistance.

### 16.2 Query and personalize

1. User asks Dina for a recommendation.
2. Dina derives a minimal category-level query.
3. Dina queries selected subscribed curators.
4. Each curator returns a signed, committed response.
5. Dina validates each response as untrusted evidence.
6. Dina loads relevant local context under normal vault rules.
7. Dina ranks candidates using curator judgment, local fit and public outcome
   evidence.
8. Dina shows sources, confidence and disclosures.

### 16.3 Record an outcome

1. User explicitly marks a recommendation as used or completes a linked local
   task.
2. Dina waits for a domain-appropriate interval.
3. Dina asks whether the recommendation held up.
4. User chooses private, minimal public or pseudonymous public.
5. Dina shows the exact payload and publishing identity.
6. If public, Dina publishes the outcome referencing the response commitment.
7. AppViews ingest and score the outcome under their declared policies.

### 16.4 Curator update

1. Curator publishes a new immutable release.
2. Dina compares scope and behavior hashes.
3. Non-material updates preserve the current epoch.
4. Material updates create a new epoch and show an update notice.
5. The subscription may remain active according to user policy.
6. Previous and current standing remain visibly separated.

### 16.5 Unsubscribe

1. User removes the local subscription.
2. Dina stops querying and weighting that service immediately.
3. No unsubscribe message is sent.
4. Cached responses follow the configured local retention policy.
5. Public outcomes remain public unless separately revoked or amended.

---

## 17. Functional requirements

### Subscriber

- Discover curators through existing service search.
- Inspect scope, provenance, operator, disclosures and standing dimensions.
- Subscribe and unsubscribe locally in one action.
- Choose scorekeepers and disagreement policy.
- Query selected curators without sharing vault content by default.
- See which curator contributed each recommendation.
- See item evidence separately from curator evidence.
- Control exploration behavior locally.
- Publish no outcome automatically.
- Preview the exact public outcome payload and identity.

### Curator operator

- Publish through the normal service-publication path.
- Declare scope, provenance, corpus, methodology and conflicts.
- Authorize a runtime issuer.
- Return signed, schema-valid responses.
- Commit outcome-eligible responses before results are known.
- Publish optional public collections/digests.
- Publish material changes as new behavior epochs.
- Never receive vault context without an explicit grant.

### Scorekeeper operator

- Ingest commitments, outcomes and relevant PeerLens evidence.
- Publish versioned curator score dimensions.
- Publish algorithm, parameters, checkpoint and policy hashes.
- Supply conformance vectors for the reference algorithm.
- Expose effective and raw sample counts.
- Preserve historical snapshots for audit.

### Reference client

- Fail closed on signature, issuer, epoch or commitment mismatch.
- Keep uncommitted recommendations usable but clearly labelled and ineligible
  for public outcome standing.
- Keep sensitive outcomes private by default.
- Separate confidence in a curator from evidence about an item.
- Never execute instructions embedded in curator text.

---

## 18. Invariants

1. **No curator caste.** Publishing a conforming service makes it eligible for
   discovery; standing comes from evidence, not an appointment.
2. **No vault context by default.** Personalization happens locally unless an
   explicit scoped grant says otherwise.
3. **Private claims require prior commitment.** An uncommitted private response
   cannot earn public outcome standing.
4. **Standing is scoped and epoch-bound.** It does not silently transfer across
   domains or material behavior changes.
5. **Evidence type is disclosed.** Human, computed and hybrid operation are
   explicit, but no type receives an automatic protocol penalty.
6. **Payment is not ranking input.** The reference algorithm ignores payment;
   external influence is disclosed and evaluated through outcomes.
7. **Public outcomes are optional.** No user activity is published merely
   because Dina inferred that an action occurred.
8. **Scorekeeper results are reproducible claims.** Every result identifies its
   algorithm, parameters, input and policy.
9. **Curator content is untrusted.** It can inform an answer but cannot instruct
   Dina or invoke tools directly.
10. **The user can exit.** Removing a curator or scorekeeper takes effect
    locally without permission from that party.

---

## 19. Implementation sequence

### Phase 0: validation without new public standing

- Publish one curator as an ordinary Dina service.
- Use the existing service response path.
- Personalize locally.
- Store signed response receipts locally.
- Collect private outcomes.
- Measure repeat queries, acted-on recommendations and voluntary outcome rate.

This phase validates whether users value the loop. It does not claim public
accountability.

### Phase 1: public commitments and minimal outcomes

- Freeze response canonicalization and commitment vectors.
- Add response commitment records.
- Add minimal outcome attestations.
- Add exact-payload consent UI.
- Add sensitive-category defaults.
- Add one reference curator scorekeeper algorithm.

### Phase 2: behavior epochs and reproducible scorekeepers

- Link curator declarations to immutable releases.
- Add behavior-epoch transitions.
- Publish scorekeeper manifests and snapshots.
- Add cross-scorekeeper comparison.
- Add curator score vectors and confidence intervals.

### Phase 3: scale and privacy hardening

- Batch commitments with Merkle roots.
- Add coordination analysis specific to curator outcomes.
- Add pairwise or anonymous query credentials if validated as necessary.
- Add paid-access integrations without feeding payment into ranking.
- Add private or organization-operated scorekeepers.

No phase should begin solely because the prior phase is implemented. Each phase
requires demonstrated usage of the preceding user loop.

---

## 20. Open decisions

- Exact canonical response encoding and salt requirements.
- Per-response commitment versus Merkle batching threshold.
- Curator declaration as service-profile extension versus linked record.
- Outcome subject disclosure required for public scoring.
- Sensitive-domain taxonomy and default retention periods.
- Behavior-epoch transition rules and capped prior size.
- Reference Bayesian/Wilson scoring formula.
- Novelty uplift shape and maximum contribution.
- Scorekeeper checkpoint representation over ATProto/Jetstream inputs.
- Pairwise identity or anonymous-token design, if pursued after V1.
- How private organization curators publish commitments and score manifests.

---

## 21. Honest product claim

The architecture can credibly claim:

> Follow specialists you trust. They contribute expert judgment; Dina privately
> decides what fits you; signed outcomes show which specialists hold up over
> time.

It must not claim:

- that paid influence is impossible;
- that authenticated curator queries are anonymous;
- that human outcomes are automatically Sybil-proof;
- that one standing score is objective truth;
- that a curator's declared corpus coverage has been proven;
- that public outcomes reveal nothing about the user.

The value is not perfect neutrality. The value is separation and choice:
curators judge, scorekeepers measure under visible rules, Dina personalizes
locally, and the user can replace any of them.

