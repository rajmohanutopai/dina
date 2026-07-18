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
- Proving that a response commitment was publicly observed before a scoreable
  outcome record was published.
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

| Layer           | Existing Dina mechanism               | Curation use                                      |
| --------------- | ------------------------------------- | ------------------------------------------------- |
| Identity        | DIDs, service URIs, runtime issuers   | Identify operator, service and response signer    |
| Execution       | Services and D2D/HTTPS response paths | Submit recommendation queries and receive answers |
| Public evidence | PeerLens records in ATProto repos     | Publish digests, commitments and outcomes         |
| Evaluation      | AppView scoring and conformance       | Compute curator evidence summaries and standing   |

The new work is additive:

- a response-commitment record or commitment-log format;
- durable commitment-ordering and outcome-observation checkpoint records, their
  proof archive and an independently retrievable batch-leaf artifact;
- portable evidence-event checkpoints for curator invalidation and lifecycle
  deletion ordering;
- a private witness-signed publication permit for minimum-delay enforcement;
- an outcome-attestation record;
- curator behavior epochs;
- curator-specific score dimensions;
- signed scorekeeper manifests and snapshots.

The architecture does not require a second service registry or a second trust
graph.

### 3.1 Mapping to shipping code

This specification is additive. The following table distinguishes mechanisms
that exist today from curation-specific work. The `Shipping foundation` column
names existing code; everything in `Curation work` remains unimplemented unless
a later status update says otherwise.

| Concern                                        | Shipping foundation                                                                                                                                                                       | Curation work                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability vocabulary                          | `packages/protocol/src/services/capability-catalog.ts` and `capability-registry.ts`                                                                                                       | Add `curation_recommend` as an official, read-only capability with frozen parameter and result schemas. It is not generic-intent-routable in V1. Add a versioned curation-scope registry aligned with the existing service-category vocabulary. Neither exists today.                                                                                                                                                                          |
| Service discovery                              | `appview/src/api/xrpc/search-capabilities.ts`, `service-search.ts` and the ordinary service-profile ingester                                                                              | Index curators for explicit discovery from Network/profile search. Discovery returns proof-carrying repository data; clients verify authorship and immutable references rather than trusting an AppView assertion.                                                                                                                                                                                                                             |
| Query dispatch                                 | `packages/brain/src/reasoning/service_tools.ts` and `service/service_query_orchestrator.ts`                                                                                               | Reuse the existing `query_service` transport path with the canonical curation-request hash bound into its detached signed authorization, but select only from the subscriber's local curator subscriptions in V1.                                                                                                                                                                                                                                |
| D2D execution and return                       | `packages/core/src/d2d/families.ts`, `packages/brain/src/service/service_handler.ts`, `packages/core/src/workflow/service.ts` and `packages/brain/src/service/workflow_event_consumer.ts` | Reuse `service.query`, provider workflow execution, `service.response` and workflow-event delivery. No separate curation transport lane.                                                                                                                                                                                                                                                                                                       |
| Service publication                            | `packages/brain/src/service/service_publisher.ts` and `appview/src/ingester/handlers/service-profile.ts`                                                                                  | Publish the ordinary profile plus a linked curation declaration.                                                                                                                                                                                                                                                                                                                                                                               |
| Local subscription                             | No curator-subscription repository exists                                                                                                                                                 | Add an encrypted Core `CuratorSubscriptionRepository`. A subscription is private local configuration, not a contact relationship or a public PeerLens trust edge.                                                                                                                                                                                                                                                                              |
| Local receipts and outcomes                    | Core SQLite repositories and encrypted vault storage                                                                                                                                      | Add durable repositories for response receipts, local decisions, follow-up eligibility and private outcomes.                                                                                                                                                                                                                                                                                                                                   |
| Context egress                                 | Grant and approval primitives exist, but `docs/CONTEXT_FIREWALL_DESIGN.md` is design-only                                                                                                 | Phase 0 sends no vault-derived context. Explicit remote context sharing requires the Context Firewall compiler, disclosure manifest, egress audit and approval path; those do not exist today.                                                                                                                                                                                                                                                 |
| Follow-up prompt                               | `packages/core/src/reminders`, `packages/core/src/workflow` and `packages/brain/src/chat/reminder_card.ts`                                                                                | Schedule a curation-outcome reminder and render a dedicated workflow/card from those existing mechanisms.                                                                                                                                                                                                                                                                                                                                      |
| Public publication                             | `packages/core/src/peerlens/pds_publish.ts` and the durable review publish-job pattern in `packages/core/src/review`                                                                      | Add curation-specific PDS records and durable publishers. The operator publisher verifies runtime signatures and writes commitments to the operator's PDS; attesters write outcomes to their own PDS repositories. Do not encode an outcome as an ordinary review merely to avoid a new lexicon.                                                                                                                                               |
| Witness permits, checkpoints and proof archive | No permit, commitment/outcome/discipline/evidence-event witness or proof-archive component exists                                                                                         | Extend the reference AppView with a private bounded permit endpoint, deterministic commitment, outcome, discipline and evidence-event observation, canonical source manifests, retrievable coverage-membership artifacts, bounded coverage prefixes, signed prefix finalizations and deterministic live coverage heads with retained declared-predecessor linkage proofs, checkpoint/refusal publication, signed proof construction and content-addressed proof retention. The witness role is logically separate from scoring even when one preview deployment runs both. |
| Preview witness-policy distribution            | `packages/protocol/src/constants.ts` and ordinary bundled mobile configuration are foundations only                                                                                       | Add signed outcome-evidence and score-witness policy artifacts containing the first-party witness DID, explicit quorums, source manifests, coverage obligations, checkpoint deadlines, clock/bucket rules, proof formats, policy-bound feasibility manifests and numeric retention/resource horizons; pin the exact applicable artifacts and fixtures in clients and scorekeepers.                                                                 |
| Ingestion and scoring                          | `appview/src/ingester`, `appview/src/scorer`, `appview/src/web/server.ts` and existing score-version/conformance mechanisms                                                               | Extend AppView with authority, commitment, outcome, evidence-event, coverage-chain/finalization/head and lifecycle handlers, curator scorer jobs, canonical signed/effective standing-status output, score-snapshot witnessing with bounded fresh coverage and curation xRPC methods. The reference scorekeeper is an AppView extension; independent scorekeepers may run the same component separately.                                                       |
| Immutable releases                             | `docs/PLUGIN_ARCHITECTURE.md` and `packages/protocol/src/plugins`                                                                                                                         | Reuse release CIDs and behavior digests for computed curators where applicable. Human curators use an immutable declaration/policy artifact; they are not required to pretend their judgment is executable code.                                                                                                                                                                                                                               |
| Reference curator SDK                          | Existing protocol schemas, service helpers and PDS publication primitives                                                                                                                 | Add a maintained SDK that owns canonical encoding, request verification, response and decline receipts, runtime signatures, commitment construction, operator-publisher handoff and conformance vectors. Curator authors implement recommendation logic rather than cryptographic plumbing.                                                                                                                                                    |
| Probe runner                                   | No probe-operator implementation exists                                                                                                                                                   | Phase 2 may add a separate runner and corpus publisher. It receives no protocol privilege, cannot act as its own recognizing scorekeeper, and cannot automatically change behavior epochs from probe evidence alone.                                                                                                                                                                                                                           |

`curation_recommend` belongs in the official catalog rather than the
custom-capability lane because clients must agree on its privacy class, request
binding, output schema and outcome semantics. Its V1 catalog policy is:

```text
action_class: read
privacy_class: personal
default_discoverability: public
intent_routable: false
requires_verified_provider: false
requires_subject_authorization: false
```

Generic intent routing is designed to find a provider for an otherwise
unbound service request. Curation is different: the subscriber deliberately
chooses whose judgment to use. V1 therefore discovers curators explicitly and
automatically routes only among locally subscribed curators. Scope-aware
generic routing may be considered later as a separately consented feature.

Official capability IDs are flat snake-case strings in the shipping registry;
dotted identifiers are reserved for custom capabilities.
`com.dinakernel.curation.*` is used for public ATProto record NSIDs, not for the
service capability ID. Providers remain free to publish custom curation methods
behind namespaced capabilities, but those methods do not automatically
participate in reference curator standing.

---

## 4. Roles

### 4.1 Subscriber

The person whose Dina asks for recommendations. The subscriber chooses the
curators and scorekeepers to use. Local preferences always override network
defaults.

### 4.2 Curator operator

The person or organization responsible for operating the curator. The operator
is identified by `operator_did`. Operator-authored public records live in that
DID's PDS repository. A hosted runtime does not gain permission to write into
the operator's repository merely because it may sign live responses.

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

### 4.7 Evidence witness

An independently identifiable service that validates public commitments and
outcomes, privately permits a bound outcome core after its minimum interval,
retains proof-bearing repository evidence and signs observations needed to
establish commitment-before-outcome order, portable outcome publication time and
cross-repository invalidation/deletion event order.
A witness is not an oracle for truth or quality. Its policy defines accepted
inputs, public-record coverage, permit and checkpoint quorums, clock and bucket
rules, response deadlines, refusal handling, retention and hand-off obligations.

### 4.8 Probe operator

An optional Phase 2 actor that submits standardized, signed and committed test
queries to measure hosted-runtime drift. A probe operator is not a protocol
validator, witness or privileged curator. A scorekeeper may recognize probe
evidence only under a pinned policy covering operator admission, disclosed test
corpus, sampling, rotation, conflicts and anti-gaming controls. A scorekeeper
cannot recognize probes it operates or controls, and a curator cannot supply
penalizing probe evidence about a competitor. Curator standing remains
computable without probe evidence; probes contribute only a separately labelled
drift signal and cannot by themselves create an effective behavior-epoch split.

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
service_profile_cid Which immutable service-profile version was used
scope_id           What domain the standing applies to
behavior_epoch     Which materially consistent behavior earned the standing
authority_epoch    Which operator-authorized runtime authority signed the response
declaration_uri    Which operator-authored behavior declaration is active
declaration_cid    Which immutable version of that declaration is active
authority_uri      Which operator-authored runtime authority record is active
authority_cid      Which immutable version of that authority record is active
release_uri        Which immutable implementation release is active, when applicable
release_cid        Which immutable version of that release is active
runtime_issuer_did Which DID may sign live responses
runtime_key_id     Which authorized verification method signed this response
capability_schema_hash Which exact request/response contract was used
```

Example:

```text
operator_did: did:plc:example
service_uri: at://did:plc:example/com.dinakernel.service.profile/books
service_profile_cid: bafyprofile...
scope_id: books.english.science-fiction
behavior_epoch: 3
authority_epoch: 7
declaration_uri: at://did:plc:example/com.dinakernel.curation.declaration/books-v3
declaration_cid: bafydeclaration...
authority_uri: at://did:plc:example/com.dinakernel.curation.authority/runtime-7
authority_cid: bafyauthority...
release_uri: at://did:plc:example/com.dinakernel.plugin.release/books-v3
release_cid: bafyrelease...
runtime_issuer_did: did:key:z6Mk...
runtime_key_id: did:key:z6Mk...#z6Mk...
capability_schema_hash: sha256:...
```

Every `*_uri` and `*_cid` pair is immutable input, not advisory metadata.
Ingesters derive `operator_did` from the repository author in `service_uri` and
derive each record author from its AT URI and repository proof. They reject
records whose copied DID fields disagree. A scorekeeper never trusts a
self-declared operator, curator or attester DID when the repository event can
provide it.

### 5.1 Changes that preserve an epoch

- Security patches that do not change recommendation behavior.
- Infrastructure migration with identical signed behavior configuration.
- Performance improvements that leave corpus and ranking semantics unchanged.
- Model patch updates proven to preserve the declared behavioral contract.
- Routine runtime-key rotation with unchanged operator and behavior declaration.
- Ordinary corpus growth within the declared update policy.

### 5.2 Changes that create a new epoch

- Operator change.
- Material corpus change.
- Scope change.
- Human, computed or hybrid provenance change.
- Ranking methodology change.
- Material model or prompt change.
- Sponsorship or ownership change that may affect judgment.

Subscriptions may continue across an epoch change, but Dina must show the
change. Standing from previous epochs remains visible as history and may seed a
small, clearly labelled prior. It must not silently become the new epoch's full
standing.

The immutable release and `behavior_hash` mechanisms from the plugin
architecture should be reused where they apply. A computed curator declaration
points to an immutable release CID. Material behavior changes produce a new
release and behavior epoch.

For a human or hybrid curator, `behavior_hash` covers the declared methodology,
scope policy, conflict policy and corpus-update policy. It cannot freeze human
judgment. Ordinary additions to a corpus do not create a new behavior epoch
when they follow the declared update policy; a material change in selection or
ranking policy does.

### 5.3 Authority epochs and key rotation

Security authority and recommendation behavior are independent dimensions.
Changing a runtime issuer increments `authority_epoch`, but does not by itself
reset `behavior_epoch` or standing. The new authority must be authorized by the
operator through the immutable, repository-signed grant and revocation lineage
below, which identifies its predecessor and bucket-aligned activation and
revocation boundaries.

The V1 publication model is operator-owned:

1. The hosted runtime signs a canonical response commitment entry with the
   authorized `runtime_key_id`.
2. An operator-controlled publisher verifies the runtime signature, exact
   authority grant, revocation lineage and activation window.
3. The publisher writes the commitment to the operator DID's PDS repository.
4. AppView and independent verifiers confirm both the repository authorship and
   the embedded runtime signature.

This is a deliberate separation of powers. The existing PDS publisher writes
to the DID authenticated by its session; it cannot safely make a hosted runtime
the author of an operator-owned record. A later design may support a runtime
repository plus operator co-signature, but V1 does not mix those authorship
models.

An operator or ownership change creates a new behavior epoch in addition to an
authority transition. Emergency compromise handling must define how receipts
near the compromise boundary are treated; V1 uses the conservative bucket rule
below rather than claiming exact-time proof.

V1 uses fixed one-hour UTC authority buckets:

```text
authority_time_bucket_seconds = 3600
issued_at_bucket = floor(issued_at_unix / 3600)
```

Authority activation and ordinary revocation take effect only at bucket
boundaries. An outcome receipt or verified-decline record is accepted as public
evidence only when its runtime key was authorized for the entire disclosed
bucket. Routine rotation therefore
activates at the next boundary. An emergency compromise may revoke immediately,
but the reference verifier conservatively invalidates every receipt in the
intersected bucket rather than revealing exact issuance time or guessing which
side of the boundary it belongs to. Later profiles may define a privacy-preserving
exact-time proof; V1 has no such fallback.

An authority grant is an immutable operator-authored
`com.dinakernel.curation.authority` record. Its conceptual fields are:

```text
service_uri
operator_did
service_profile_cid
declaration_uri
behavior_epoch
authority_epoch
runtime_issuer_did
runtime_key_id
capability_schema_hash
activation_bucket
predecessor_authority_uri?
predecessor_authority_cid?
authority_schema_version
created_at
```

The record author is derived from its AT URI and repository proof and must equal
the service operator. `activation_bucket` is a one-hour UTC bucket. The first
authority has no predecessor; every later authority identifies the exact URI and
CID of its immediate predecessor and increments `authority_epoch` by one. A
grant uses a fresh record key and is immutable: publishing another CID at the
same URI is authority equivocation, not an update. The repository-signed record
is the operator authorization; implementations do not rely on an unsigned copied
operator field or an unspecified additional signature.

The authority grant binds the stable `declaration_uri`, behavior epoch, profile
CID and capability schema, but deliberately does not contain `declaration_cid`.
The declaration contains the exact authority URI/CID, so placing the declaration
CID back inside the authority record would create an impossible hash cycle. The
operator publishes the authority grant first and then the declaration version
that binds it. Requests, receipts and commitments bind both final CIDs together,
so a verifier still checks the exact pair without requiring either record to hash
the other in both directions.

Revocation is a separate immutable operator-authored
`com.dinakernel.curation.authorityRevocation` record so that a receipt can retain
the original authority CID while later verifiers can apply a subsequent
compromise decision:

```text
authority_uri
authority_cid
service_uri
authority_epoch
revocation_mode: ordinary | emergency_compromise
revoked_from_bucket
replacement_authority_uri?
replacement_authority_cid?
reason_code
revocation_schema_version
created_at
```

An ordinary revocation's `revoked_from_bucket` must be a future bucket boundary
under the portable witness-observation rule below. Routine rotation consists of
a successor grant and a predecessor ordinary revocation with the same boundary;
the revocation's replacement URI/CID must identify that successor and the
successor must identify the revoked grant as its predecessor. Both records and
the final declaration version that binds the successor authority CID must verify
and reach the required authority-observation quorum before that boundary.
An emergency revocation identifies the intersected bucket and invalidates that
whole bucket and every later bucket for the revoked authority. A replacement
grant, when present, must name the revoked authority as its predecessor and may
activate no earlier than the first bucket after the invalidated emergency bucket.
Verifiers consume all authority grants and revocations present in their pinned
input checkpoint; they do not treat absence of a currently resolved mutable
record as proof that no revocation exists. Conflicting grants or revocations are
retained as authority equivocation and fail closed. The affected authority cannot
be made eligible by overwriting or deleting either record; recovery requires a
new non-conflicting authority lineage under a new behavior epoch.

An accepted witness makes authority timing and archival claims through a
canonical signed authority-observation artifact:

```text
target_type: authority_grant | authority_revocation
target_uri
target_cid
service_uri
authority_epoch
activation_or_revoked_from_bucket
related_authority_uri?
related_authority_cid?
transition_declaration_uri?   # required for every grant and ordinary revocation
transition_declaration_cid?   # required for every grant and ordinary revocation
target_repo_rev
target_proof_bundle_ref
target_proof_bundle_cid
transition_proof_bundle_ref?  # required for every grant and ordinary revocation
transition_proof_bundle_cid?  # required for every grant and ordinary revocation
source_id
source_cursor
source_position_proof_ref
source_position_proof_cid
first_observed_at_bucket
retention_mode: dependent_commitment | fixed_revocation
retention_until?              # required only for fixed_revocation
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_hash
authority_observation_schema_version
witness_signature
```

The signature is:

```text
Sign(
  "dina-curation-authority-observation-v1" ||
  canonical_authority_observation_without_signature
)
```

For the PDS-record form, repository authorship is derived from the observation
AT URI and signed repository proof and must equal `witness_did`. An offline form
qualifies only when the pinned witness policy explicitly accepts it. One witness
has one immutable observation per `(witness_policy_hash, target_uri,
target_cid)`; an idempotent retry is byte-identical, while two signed buckets or
proof bundles for that key are witness equivocation. The witness applies the
policy clock-source and rollback rules before assigning the bucket.

The target proof bundle contains the immutable authority record block, signed
operator-repository commit, MST inclusion path and versioned operator DID proof.
Every grant observation's transition bundle contains the final declaration
version that binds that exact grant. For an ordinary rotation, the grant and
revocation observations additionally contain the cross-linked predecessor
revocation and successor grant. A verifier rejects a copied bucket, URI, CID,
cursor or proof reference that does not match those bytes. The witness's
historical signing-key proof is content-addressed and retained with the artifact.

The portable observation bucket is the q-th earliest valid
`first_observed_at_bucket` from distinct witnesses accepted by the pinned policy,
where q is `authority_observation_quorum`. A grant is eligible at
`activation_bucket` only when its portable observation bucket is strictly less
than that boundary. For ordinary rotation, both the successor-grant and
predecessor-revocation observation quorums must be complete, must bind the same
cross-linked transition and declaration, and must fall strictly before the
shared activation/revocation boundary. This turns "future" into a replayable
property rather than an assertion inferred from payload or repository time. An
emergency revocation may necessarily be observed after its claimed boundary; its
observation proves archive intake, not the exact time of compromise.

An observation quorum is valid only when its q-th bucket is no more than
`maximum_authority_observation_quorum_delay_buckets` after its earliest included
bucket.
This policy bound lets each witness sign an immutable retention promise without
waiting to learn which other witnesses a later verifier will select.

Grant observations use `retention_mode: dependent_commitment` and omit a fixed
`retention_until`. Every commitment checkpoint that depends on the authority
embeds the complete signed observation quorum and retains it through that
checkpoint's own `retention_until`. Revocation observations use
`retention_mode: fixed_revocation`; each witness computes:

```text
revocation_policy_retention_until = revoked_from_bucket + 1
  + maximum_registry_evaluation_horizon_buckets
  + standing_evidence_retention_buckets
  + challenge_window_buckets

revocation_observation_retention_until = first_observed_at_bucket + 1
  + maximum_authority_observation_quorum_delay_buckets
  + standing_evidence_retention_buckets
  + challenge_window_buckets

retention_until = max(
  revocation_policy_retention_until,
  revocation_observation_retention_until
)
```

Consequently every member
of a timely selected quorum remains retained through the portable q-th bucket's
required window. This prevents a late or backdated revocation from expiring its
archive immediately without requiring an artifact to predict a future quorum.
Source cursors and signed refusals expose missing authority ranges. Deleting an
origin grant, revocation or transition record does not remove a complete observed
proof from later replay.

Authority invalidation is fail-closed for cryptographic eligibility but is not a
curator-controlled score reset. If a grant fork, conflicting revocation or
emergency compromise appears after a commitment or outcome had already reached
its required witness stage, the affected evidence is labelled
`authority_tainted` and handled by the monotonic-accountability rule in Section
10.8 using a complete evidence-event checkpoint quorum. It cannot earn new
ordinary positive weight, but excluding it cannot make the curator's displayed
estimate or convenience band more favorable.

### 5.4 Hosted-runtime honesty boundary

A release CID proves what was declared, not which model weights, prompt or
corpus a hosted runtime actually used. For hosted curators, behavior epochs are
operator attestations. Violations are detected and penalized, not prevented by
the protocol.

Because responses are private, ordinary scorekeepers cannot observe the full
response distribution. Optional Phase 2 drift signals may use public commitment
counts, selection-biased disclosed outcome claims, public digests,
commitment-discipline attestations, and standardized signed and committed probes
run by recognized probe operators. A scorekeeper using probes pins
`probe_policy_hash`; every published drift metric identifies its source and
sample policy. Probe behavior can itself be detected and gamed, so material
unexplained probe-only drift may trigger a warning but cannot create an effective
epoch split. Probe evidence may trigger review, but a scorekeeper-defined split
must be justified by the manifest's deterministic threshold applied to
independently admissible non-probe evidence without counting the probes. A
scorekeeper cannot admit probes it operates or controls, and a curator cannot
submit recognized probes against a competitor. Even independently corroborated
drift is evidence of changed behavior, not cryptographic proof of misconduct.

---

## 6. Protocol surface

The design should reuse existing records wherever their meaning already fits.

### 6.1 Existing service profile

A curator publishes a normal `com.dinakernel.service.profile` with a standard
curation capability, for example:

```text
curation_recommend
```

The capability uses frozen parameter and result schemas. Curation-specific
metadata lives in linked records rather than expanding every service profile.
The additive public NSID family is conceptually:

```text
com.dinakernel.curation.declaration
com.dinakernel.curation.authority
com.dinakernel.curation.authorityRevocation
com.dinakernel.curation.authorityObservation
com.dinakernel.curation.commitment
com.dinakernel.curation.commitmentCheckpoint
com.dinakernel.curation.outcomeCheckpoint
com.dinakernel.curation.disciplineCheckpoint
com.dinakernel.curation.evidenceEventCheckpoint
com.dinakernel.curation.witnessPolicy
com.dinakernel.curation.policySuccessorObservation
com.dinakernel.curation.policySuccessorSlotClosure
com.dinakernel.curation.witnessRefusal
com.dinakernel.curation.witnessCoverage
com.dinakernel.curation.witnessCoveragePrefixFinalization
com.dinakernel.curation.witnessCoverageHead
com.dinakernel.curation.outcome
com.dinakernel.curation.discipline
com.dinakernel.curation.scoreManifest
com.dinakernel.curation.scoreSnapshot
com.dinakernel.curation.scoreSnapshotCheckpoint
com.dinakernel.curation.scoreSnapshotRefusal
com.dinakernel.curation.scoreWitnessCoverage
com.dinakernel.curation.scoreCoveragePrefixFinalization
com.dinakernel.curation.scoreCoverageHead
```

Exact names remain subject to lexicon review, but curation outcomes must not be
overloaded onto an existing PeerLens record whose semantics differ.
`com.dinakernel.curation.authorityObservation` is the repository form of the
canonical signed artifact in Section 5.3; an active witness policy may also
accept its complete offline proof-bundle form.
`dina-curation-outcome-permit-request-v1` and its signed publication permit are
private protocol artifacts rather than NSIDs; the permit becomes visible only
when embedded in a published outcome.

### 6.2 Curation declaration

The declaration describes what the curator claims to cover and how it is
operated.

Required conceptual fields:

```text
service_uri
operator_did
service_profile_cid
runtime_issuer_did
runtime_key_id
authority_epoch
authority_uri
authority_cid
scope_id
scope_taxonomy_version
category_ids[]
scope_description
behavior_epoch
declaration_version
release_uri?                 # computed/hybrid executable release, when applicable
release_cid?
capability_schema_hash
behavior_contract_hash
provenance: human | computed | hybrid
corpus_description
corpus_version
corpus_update_policy
coverage_claim
methodology_summary
conflict_disclosures
outcome_policy_id
outcome_schema_version
repetition_policy_id
updated_at
```

The declaration does not contain its own CID. Its URI is derived from the
operator repository and record key, and its CID comes from the verified
repository commit. To avoid a hash cycle, the service profile links the stable
declaration URI; the declaration binds the exact service-profile CID. Every
response then binds both the exact profile CID and externally resolved
declaration URI/CID. Updating either record produces a new verifiable pair.

`coverage_claim` is a declaration, not proof. A curator saying it covers every
English novel does not make that true. Scorekeepers and clients may later show
source-labelled coverage evidence separately.

`scope_id` is not free-form. Reference standing uses a new versioned curation
scope vocabulary aligned with the service category taxonomy in
`docs/PUBLIC_SERVICES_TAXONOMY.md`. Each scope has a canonical ID, parent,
version, permitted service-category IDs and permitted query categories. A
custom namespaced scope may be shown to users, but it is not comparable in
reference standing until it maps to a canonical parent under a published rule.

For the release preview, the canonical V1 registry is a versioned artifact
maintained in the Dina repository and released with the protocol package.
Phase 1A cannot complete until that initial registry, its compatibility rules
and its update process are frozen. Repository review and a versioned protocol
release govern preview changes; decentralized or multi-party governance of
later registry versions remains an open decision and cannot retroactively alter
the meaning of V1 records.

The released V1 registry bundle also contains the exact outcome and repetition
policies available to each scope. Their identifiers, versions and canonical
content hashes are frozen with the scope registry. Phase 1 records cannot point
to an operator-defined policy outside that bundle. Governance of post-V1 policy
additions remains open, but the initial policy set is a Phase 1A dependency.

The request carries its requested scope and query category. The curator's
declaration must cover both, and Dina rejects a category-to-scope mismatch.
Responses and outcomes copy scope from the validated request and signed
receipt; the curator and outcome author cannot relabel it later. Scope aliases,
splits and merges have signed lineage so a curator cannot erase visible history
by minting a cosmetically different scope.

Each canonical scope points to a versioned outcome policy:

```text
outcome_policy_id
outcome_schema_version
outcome_dimensions[]
eligible_interaction_stages[]
evaluation_anchor: witnessed_commitment_v1
evaluation_bucket_seconds
minimum_evaluation_delay_seconds
maximum_evaluation_horizon_seconds
confidence_targets[]
scoring_mapping
standing_direction_by_dimension: higher_is_better | lower_is_better
neutral_value_by_dimension
```

The generic `held_up | mixed | failed` dimension is suitable only for declared
low-risk utility scopes. A medical recommendation, long-term financial choice,
book suggestion and transport estimate do not share one honest success target
or evaluation horizon. `selected` is a local funnel event and is never scored
as recommendation quality; only policy-eligible `acted_on` or `completed`
events may produce quality evidence. V1 fixes `evaluation_anchor` to
`witnessed_commitment_v1`, the maximum of the runtime-signed response bucket and
portable commitment-observation bucket, and fixes `evaluation_bucket_seconds`
to the same 3,600-second UTC bucket used for authority and receipt issuance.
Policies vary the minimum and maximum durations, not the V1 clock granularity. A
later protocol version may introduce another bucket size or an
acted-on/completion anchor only with a new response field, separately verifiable
coarse anchor-time proof and conformance vectors; it cannot reinterpret a V1
bucket.

Every scored dimension declares whether higher or lower values are favorable
and a neutral value under its canonical scoring mapping. These are security-
critical inputs to conflict handling and the monotonic no-suppression rule; a
scorekeeper cannot infer or reverse them locally.

The scope also points to a versioned repetition policy defining a repeat
cooldown, decay or half-life, maximum effective weight per window and the
material-change conditions that reset a series. This prevents repeated queries
about the same subject from manufacturing independent evidence.

### 6.3 Private curation request and response

The subscriber constructs a canonical private request containing:

```text
request_id
request_nonce
requester_binding
requester_signing_key_id
requester_did_resolution_proof_ref
requester_did_resolution_proof_cid
service_uri
service_profile_cid
declaration_uri
declaration_cid
behavior_epoch
authority_epoch
authority_uri
authority_cid
release_uri?
release_cid?
runtime_issuer_did
runtime_key_id
capability_schema_hash
scope_id
scope_taxonomy_version
outcome_policy_id
outcome_schema_version
query_category
query_payload
request_schema_version
issued_at
expires_at
```

The request hash is domain-separated:

```text
request_hash = SHA-256("dina-curation-request-v1" || canonical_request)
```

The subscriber signs one disclosure-minimized protocol authorization that can
later travel in a public receipt proof. This detached authorization is the sole
V1 request signature: it authenticates the complete private request indirectly
through `request_hash`, rather than introducing a second private-request
signature field. It reveals the canonical `query_category` so
an independent verifier can enforce category-to-scope congruence, while keeping
`query_payload` and `request_nonce` private:

```text
request_authorization_projection = {
  request_id, request_hash, requester_binding, requester_signing_key_id,
  requester_did_resolution_proof_ref, requester_did_resolution_proof_cid,
  service_uri, service_profile_cid,
  declaration_uri, declaration_cid, behavior_epoch,
  authority_epoch, authority_uri, authority_cid,
  release_uri?, release_cid?, runtime_issuer_did, runtime_key_id,
  capability_schema_hash, scope_id, scope_taxonomy_version, query_category,
  outcome_policy_id, outcome_schema_version,
  request_schema_version, issued_at_bucket, expires_at_bucket
}

requester_signature = Sign(
  "dina-curation-request-authorization-v1" ||
  canonical_request_authorization_projection
)
```

In V1 `requester_binding` is the root DID that may later author the outcome, and
`requester_signing_key_id` is its Dina signing verification method. The
content-addressed resolution proof pins the PLC operation or self-certifying DID
key needed to verify that method after rotation; a verifier never substitutes
only the current DID document. The provider recomputes `request_hash` from the
received canonical private request, requires exact equality with the detached
projection, verifies `requester_signature` and its key proof, and checks equality
of requester and recipient binding before executing. A transport may add its own
session authentication, but that is not a second curation-protocol signature and
cannot replace these checks. A later public verifier checks the same
detached signature, request hash, category and routing bindings; it rejects a
category not admitted by the pinned scope registry. It does not receive the
private payload or nonce and therefore cannot reconstruct the complete private
query from the request hash.

The V1 authorization lifetime uses the same 3,600-second UTC authority buckets.
`issued_at_bucket` is the first authorized bucket and `expires_at_bucket` is the
first unauthorized bucket; the private request's `expires_at` must equal that
boundary. A response or decline is valid only when its issuance bucket is in the
half-open interval `[issued_at_bucket, expires_at_bucket)`. This makes public
expiry verification conservative and deterministic instead of pretending an
undisclosed exact time can be recovered from two coarse buckets.

The immutable profile, declaration, behavior, authority, release, runtime key,
capability schema and outcome-policy fields are the exact contract selected by
the subscriber before dispatch. A response or decline must match all of them.
The provider cannot answer under an older or newer behavior declaration merely
because `service_uri` and `scope_id` are unchanged. If an authority rotates while
a request is outstanding, the client refreshes the records and signs a new
request; it never widens the old authorization after dispatch. For a sensitive
query, any such contract change invalidates the reusable outbound disclosure
decision and requires the policy to match the refreshed contract before another
request is sent.

An existing AT Protocol identity that does not yet publish a Dina-controlled
signing verification method may still receive and use curator recommendations
locally through its authenticated service session. It cannot create a V1 public
curation outcome or verified public discipline receipt until it adds such a
method with replayable DID lineage. The client must not substitute a PDS JWT, an
unavailable repository private key or an unpinned current DID key merely to make
public evidence appear enabled.

The unpredictable subscriber-generated nonce prevents dictionary recovery of
the private payload from a later public request hash, even when the disclosed
category and likely payload vocabulary are small. The transport signature and
the response both bind this hash.

V1 freezes every privacy- or replay-critical random value to exactly 32 octets:

```text
request_nonce
response_nonce
permit_request_nonce
response_salt
item_salt
```

The reference SDK generates each independently with an operating-system CSPRNG.
JSON encodes the octets as unpadded base64url, canonical hashing uses the decoded
octets rather than their text spelling, and decoders reject the wrong length,
padding, non-canonical alphabet and the all-zero sentinel used by negative test
vectors. A requester never reuses `request_nonce` under one signing key; a
runtime never reuses `response_nonce` under one runtime key; and a permit client
never reuses `permit_request_nonce` under one requester and witness policy.
Providers and witnesses retain bounded replay caches through the authorization
or permit lifetime plus the challenge window. Salts need not be published until
their proof is disclosed, but every response and claim receives a fresh value.
Protocol validation can enforce encoding, length and reuse; the SDK and security
review are responsible for verifying that generation actually uses a CSPRNG.

A private curation response is a signed service response, not necessarily a
public ATProto record.

Required conceptual fields:

```text
receipt_id
response_id
response_nonce
request_id
request_hash
request_authorization_projection
requester_signature
recipient_binding
service_uri
scope_id
scope_taxonomy_version
behavior_epoch
authority_epoch
service_profile_cid
declaration_uri
declaration_cid
authority_uri
authority_cid
release_uri?
release_cid?
runtime_issuer_did
runtime_key_id
capability_schema_hash
outcome_policy_id
outcome_schema_version
subject_resolver_version
eligibility_profile
recommendation_count
public_eligible_count
recommendations[]
outcome_claims[]
item_root
issued_at
expires_at
response_schema_version
canonicalization_version
receipt
```

Each recommendation contains bounded, schema-validated data:

```text
subject_ref
subject_ref_hash
subject_id
rank
rationale
outcome_eligibility: public | local_only
confidence_claims[]
evidence_refs[]
sponsorship_disclosure
```

`subject_ref` preserves the stable identifiers and resolver inputs used when
the recommendation was made. `subject_id` is the resolver's canonical subject
at that time, while `subject_ref_hash` and `subject_resolver_version` bind the
original interpretation. A later merge or split never rewrites the receipt.
AppView resolves the preserved reference through current lineage separately.

Each `public` recommendation has exactly one bounded `outcome_claim`; a
`local_only` recommendation has none and cannot affect public curator standing.
The claim contains only fields that may later be selectively disclosed:

```text
claim_id
subject_ref_hash
subject_id
rank
confidence_claims[]
sponsorship_disclosure
```

Each confidence claim has an explicit target and horizon:

```text
target_id
probability_e7
evaluation_horizon
```

For example, a probability is meaningful only as a claim such as “the
subscriber will still rate this recommendation `held_up` after 30 days,” not as
an unqualified confidence number. The applicable outcome policy declares which
targets are scoreable.

Each claim has a separate unpredictable `item_salt`. The item leaf is computed
over the claim without that salt, followed by the salt as a separate input.

Rationale and private evidence references are not part of the public claim.
The client verifies a one-to-one mapping between public-eligible recommendations
and claims and rejects every claim without a displayed recommendation. It then
recomputes the item root before accepting the response as outcome-eligible.
This prevents a conforming reference client from accepting hidden claims. It is
not independent proof of what a modified client rendered: the later outcome is a
curator-recipient co-attestation about the displayed set, subject to the same
collusion and attester-quality limits as the reported outcome itself.

For a non-empty response that claims Phase 1 public outcome eligibility, the
minimum profile requires exactly one public-eligible recommendation and it must
be rank one. Its `item_root` is the single item leaf and requires no Merkle path;
any additional displayed recommendations are explicitly `local_only`. A
response with no public-eligible claim remains usable locally but cannot earn
public standing. The client derives and verifies `recommendation_count` and
`public_eligible_count` from the displayed response before accepting the signed
projection. A public verifier proves that the curator committed those counts and
that the outcome author endorsed them; it cannot inspect the historical UI.

The schema keeps `outcome_claims[]`, `eligibility_profile` and `item_root` so
Phase 3 can add multiple public-eligible claims with selective-disclosure Merkle
proofs without changing the receipt envelope. Phase 1 does not require
general-purpose Merkle-tree or batch-ticket implementation merely to validate
the public outcome loop.

Curator content is untrusted input. Rationale text must never be interpreted as
tool instructions. Dina validates the response schema, bounds text and item
counts, strips unsupported presentation features, and supplies it to local
reasoning as quoted evidence.

V1 applies conservative limits below the shipping D2D body maximum:

```text
maximum recommendations                 20
maximum rationale per item              2,000 UTF-8 bytes
maximum evidence references per item    8
maximum encoded service response        192 KiB JSON
maximum encoded public outcome          64 KiB JSON
maximum leaves per commitment batch     65,536
maximum batch proof depth               16
```

Clients and ingesters fail closed before allocation or rendering when a limit
is exceeded. Schema versions may lower these limits but may not silently raise
them beyond transport or repository limits.

### 6.4 Public response commitment

A later public outcome is meaningful only if the network can establish that
the curator fixed a recipient-bound recommendation before the scoreable public
outcome record was published.

Commitments use a versioned canonical encoding and domain-separated hashes. The
leaf for one selectively disclosable recommendation is:

```text
item_leaf = SHA-256(
  "dina-curation-item-v1" ||
  canonical_outcome_claim_without_salt ||
  item_salt
)
item_root = MerkleRoot(item_leaf[])
```

For the minimum Phase 1 profile, `item_leaf[]` contains exactly one leaf and
`item_root = item_leaf`; `item_inclusion_proof` is empty. The general Merkle form
is the forward-compatible Phase 3 profile.

The private response projection commits the item root without committing the
private rationale text:

```text
response_projection = {
  receipt_id, response_id, response_nonce,
  request_hash, recipient_binding, service_uri,
  service_profile_cid, scope_id, scope_taxonomy_version,
  behavior_epoch, authority_epoch,
  declaration_uri, declaration_cid,
  authority_uri, authority_cid,
  release_uri?, release_cid?,
  runtime_issuer_did, runtime_key_id, capability_schema_hash,
  outcome_policy_id, outcome_schema_version,
  subject_resolver_version, eligibility_profile,
  recommendation_count, public_eligible_count, item_root,
  issued_at_bucket, expires_at_bucket,
  response_schema_version, canonicalization_version
}

response_commitment = SHA-256(
  "dina-curation-response-v1" ||
  canonical_response_projection ||
  response_salt
)
```

`receipt_id` is deterministic for one signed terminal disposition of one
authorized request:

```text
receipt_id = SHA-256(
  "dina-curation-receipt-v1" ||
  request_hash ||
  recipient_binding ||
  service_uri
)
```

The operator publisher enforces one active response commitment per `receipt_id`
from the private runtime handoff; a scorekeeper enforces it when a receipt is
disclosed in an outcome or discipline record. The opaque commitment stream alone
does not reveal undisclosed receipt IDs. A second distinct commitment for the
same revealed receipt identifier is operator equivocation. The receipt becomes
permanently `curator_conflicted`; the operator cannot select a favorable version
later, and recovery requires a newly authorized request. Every otherwise valid
signed artifact and commitment remains in the accountability input, while each
distinct commitment remains in the known commitment denominator. A conflict
discovered before permit issuance is refused. A conflict discovered after a
permit or accepted outcome does not erase that evidence: the reference scorer
uses at most one effective contribution for the receipt, takes the policy-defined
least-favorable value across otherwise valid conflicting outcome artifacts
bounded so it is never more favorable than the dimension's declared neutral
value, and adds operator-equivocation evidence. It never grants positive quality
credit from the conflict, but it also never lets the conflict improve the
curator's estimate or convenience band. One `receipt_id` therefore cannot create
two independent contributions, and a different recipient necessarily produces
a different projection and commitment.
The runtime also durably enforces one active terminal disposition per
`receipt_id`: either a response receipt or a decline receipt. An idempotent retry
returns the same signed artifact; changing disposition requires a newly
authorized request. If conflicting signed dispositions nevertheless become
public, verifiers retain all versions as curator equivocation. A decline cannot
invalidate a response outcome that already reached a required witness stage,
and a later response cannot turn a previously witnessed decline into positive
availability evidence. The request contributes no positive availability credit;
any previously admitted unfavorable evidence remains inside the Section 10.8
no-suppression counterfactual. That authorized request is permanently conflicted;
the curator must obtain a new request authorization rather than selecting a
favorable disposition after the fact.

The curator returns a signed per-recipient receipt containing:

```text
receipt_id
response_projection
response_salt
response_commitment
recipient_binding
request_authorization_projection
requester_signature
commitment_mode: per_response | batched
commitment_record_uri?
batch_ticket?
expected_publish_by?
runtime_signature
```

`runtime_signature` covers every preceding receipt field using the receipt's
canonicalization version; none of the requester authorization, recipient,
projection, commitment or batch-ticket bindings are unsigned metadata. The
verifier first checks `requester_signature`, then resolves the exact authority
URI and CID, confirms `runtime_key_id` was authorized for the entire disclosed
V1 issuance bucket, and verifies that the authority record was authored by the
operator repository.

The `curation-v1-minimal` profile accepts only `commitment_mode: per_response`.
The `batched` discriminator and its fields are reserved for the Phase 3 batch
profile; a Phase 1 verifier rejects that mode as unsupported rather than
partially implementing it. Reserving the discriminated envelope does not make
Phase 3 vectors part of the Phase 1 acceptance gate.

In per-response mode, the operator publisher normally publishes before the
runtime returns and the receipt includes `commitment_record_uri`. In batched
mode, the root and inclusion proof do not exist until the batch closes. The
immediate response therefore carries a signed provisional receipt with a batch
ticket and publication deadline.

The final batch record references a content-addressed, ordered leaf artifact:

```text
leaves_blob_ref
leaves_cid
leaves_digest
leaf_count
ordering_rule
batch_root
```

The artifact contains every ordered response commitment in the batch. Salts
make those values computationally opaque, while content addressing prevents
the curator from showing different leaf sets to different recipients. Any
verifier can fetch the artifact and derive the inclusion proof; finalization
does not depend on a curator endpoint remaining available or choosing to reveal
a particular leaf. Dina derives and stores the proof, then changes the receipt
from `provisional` to `outcome_eligible`. The recommendation remains usable
while provisional but cannot produce a scoreable public outcome. A missing or
late artifact becomes local commitment-discipline evidence.

In V1 the recipient binding is the authenticated requester DID. A public outcome
must be authored by that DID and must carry this receipt. Publishing the same
proof through a PeerLens namespace would still reveal the requester DID inside
`recipient_binding`, so V1 does not offer pseudonymous public curation outcomes.
A future pairwise-identity or blinded-binding mode may bind a one-time outcome
claim key instead, but that requires a separate cryptographic design and
conformance suite.

This receipt requirement is a hard security boundary. Knowledge of a public
commitment URI is not sufficient to publish a scoreable outcome. A firehose
observer who never received the private response cannot manufacture the
runtime signature, response preimage and any required item inclusion proof.

The operator publisher writes a commitment record containing either one
runtime-signed response commitment or a runtime-signed Merkle batch manifest:

```text
commitment?                 # per-response mode
batch_root?                 # batched mode
leaves_blob_ref?            # required for batched mode
leaves_cid?
leaves_digest?
leaf_count
commitment_stream_id
service_uri
service_profile_cid
scope_id
behavior_epoch
authority_epoch
declaration_uri
declaration_cid
authority_uri
authority_cid
release_uri?
release_cid?
runtime_issuer_did
runtime_key_id
capability_schema_hash
window_start_bucket
window_end_bucket             # exclusive
sequence_start
sequence_end
previous_commitment_uri?
previous_commitment_cid?
commitment_version
runtime_manifest_signature
```

The commitment window uses the same half-open one-hour UTC bucket convention as
request and authority authorization. For `curation-v1-minimal`, a per-response
commitment must set `window_start_bucket = issued_at_bucket` and
`window_end_bucket = issued_at_bucket + 1`. For a later batch,
`window_start_bucket` is the earliest included response bucket and
`window_end_bucket` is one greater than the latest included response bucket; the
batch profile defines a small maximum span. `runtime_manifest_signature` covers
both bounds. A witness verifies that the runtime key was authorized for every
bucket in the declared window before checkpointing the commitment.

The opaque commitment does not let the witness inspect an individual response's
issuance bucket. When a receipt is later disclosed, the verifier must therefore
check that its runtime-signed `issued_at_bucket` lies inside the commitment
window. The minimal profile additionally requires exact equality with the
single-bucket window. A batch outcome that discloses a bucket outside the window
is invalid even if its commitment leaf is present. A curator may declare an
unnecessarily broad valid batch window only within the profile maximum; doing so
extends storage and timing uncertainty and provides no scoring advantage.

The repository author is derived from the AT URI and must equal the service
operator. The operator publisher verifies the runtime manifest signature before
writing. The raw query, requester DID, recommendations and response salt are not
public. Individual batch leaves are public only as opaque salted commitments.
`leaf_count` and sequence continuity make known committed volume visible; they
do not reveal uncommitted private responses. Commitment streams are scoped to
one service, scope, behavior epoch, authority epoch and exact set of immutable
references.

The stream identifier is verifier-derived:

```text
commitment_stream_id = SHA-256(
  "dina-curation-commitment-stream-v1" ||
  service_uri || scope_id || behavior_epoch || authority_epoch ||
  service_profile_cid || declaration_cid || authority_cid ||
  release_cid_or_empty || capability_schema_hash
)
```

The first record starts at sequence one and has no predecessor. Every later
record binds both the URI and CID of its immediate predecessor, and
`sequence_end - sequence_start + 1` equals `leaf_count`. Commitment records use
fresh record keys and are immutable by convention; publishing another CID at an
existing URI is retained as equivocation rather than treated as an ordinary
update.

A witness and scorekeeper do not choose a favorable branch when two records
overlap, share one predecessor or claim the same sequence range. Every distinct,
otherwise valid response commitment across all witnessed branches remains in
`committed_response_count`; an identical response commitment republished in
several records counts once and is flagged. Forks, overlaps, gaps and URI/CID
replacements are separate commitment-discipline anomalies. Outcomes may still
reference an otherwise valid unique commitment, but a fork never removes another
branch from the denominator or erases its proof bundle. This all-branches rule is
deterministic across ingestion order and prevents operator or witness branch
selection from improving standing.

For low volume, the operator publisher may write one commitment record per
response. At scale, it publishes periodic Merkle roots plus complete leaf
artifacts, from which each client derives its inclusion proof. Delayed coarse
windows reduce query-timing correlation; the UI warns that low-volume
per-response commitments can still reveal service usage timing.

Repository CIDs and timestamps do not establish a total order between the
operator's repository and an attester's repository. Before constructing a
scoreable public outcome, Dina therefore obtains one or more signed commitment
checkpoints from witnesses accepted by its active witness policy:

```text
commitment_uri
commitment_cid
operator_repo_rev
commitment_proof_bundle_ref
commitment_proof_bundle_cid
operator_did_resolution_proof_ref
operator_did_resolution_proof_cid
retention_until
source_id
source_cursor
source_position_proof_ref
source_position_proof_cid
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
observation_kind: first_seen
observed_at_bucket
witness_policy_id
witness_policy_version
witness_policy_hash
checkpoint_schema_version
witness_signature
```

`witness_signature` uses
`dina-curation-commitment-checkpoint-v1 ||
canonical_commitment_checkpoint_without_signature`.

Phase 1B ships before scorekeeper selection, so the reference client includes a
signed and pinned `preview-default-witness-policy-v1` protocol artifact:

```text
accepted_witness_dids: [first-party Dina AppView witness DID]
required_coverage_witness_dids: [first-party Dina AppView witness DID]
commitment_observation_quorum: 1
outcome_observation_quorum: 1
discipline_observation_quorum: 1
authority_observation_quorum: 1
evidence_event_observation_quorum: 1
publication_permit_quorum_intersection: required
source_manifest_ref
source_manifest_cid
evidence_proof_resource_profile_ref
evidence_proof_resource_profile_cid
evidence_proof_resource_profile_hash
evidence_proof_feasibility_manifest_ref
evidence_proof_feasibility_manifest_cid
evidence_proof_feasibility_manifest_hash
coverage_checkpoint_interval_buckets
coverage_prefix_checkpoint_interval_buckets
maximum_coverage_prefix_finalization_delay_buckets
maximum_uncompacted_coverage_intervals
maximum_coverage_prefix_proof_hashes
maximum_coverage_prefix_proof_bytes
maximum_coverage_live_manifest_entries
maximum_coverage_live_manifest_bytes
maximum_coverage_head_catchup_generations
maximum_coverage_head_generation_gap_buckets
maximum_coverage_head_generations_per_bucket: 1
maximum_coverage_membership_entries
maximum_coverage_membership_bytes
required_commitment_proof: record + signed repo commit + MST path + DID proof
required_authority_proof: signed authority observation + record + signed repo commit + MST path + DID proof
required_outcome_proof: record + signed repo commit + MST path + DID proof
required_discipline_proof: record + signed repo commit + MST path + DID proof
required_policy_successor_proof?: signed observation/refusal + record + signed repo commit + MST path + DID proof # scheduled only
required_evidence_event_proof: canonical target set + complete event-specific proof bundle
required_coverage_membership_artifact: canonical entries + subset roots + content CID
required_coverage_prefix_finalization: signed repository record + exact prefix/proof/manifest equality
required_coverage_head_proof: deterministic head record + live current-repo commit + MST path + DID proof + bounded status proof
required_outcome_publication_permit: private signed token embedded on publication
outcome_publication_permit_quorum: 1
maximum_registry_evaluation_horizon_buckets
standing_evidence_retention_buckets
challenge_window_buckets
lifecycle_tombstone_retention_buckets
coverage_mode: exhaustive_valid_authorities_commitments_outcomes_discipline_policy_successors_and_evidence_events
maximum_authority_processing_delay_buckets
maximum_authority_observation_quorum_delay_buckets
maximum_commitment_checkpoint_delay_buckets
maximum_commitment_observation_quorum_delay_buckets
maximum_outcome_permit_response_delay_buckets
maximum_permit_request_lifetime_buckets
maximum_outcome_checkpoint_delay_buckets
maximum_outcome_observation_quorum_delay_buckets
maximum_discipline_checkpoint_delay_buckets
maximum_discipline_observation_quorum_delay_buckets
maximum_policy_successor_observation_delay_buckets? # scheduled only
maximum_evidence_event_checkpoint_delay_buckets
maximum_evidence_event_observation_quorum_delay_buckets
outcome_policy_registry_hash
outcome_observation_bucket_rule: use_policy_evaluation_bucket_seconds
clock_source_id
maximum_clock_uncertainty_seconds
clock_rollback_policy: fail_closed
signed_refusal_log: required
signed_private_permit_refusal: required
signed_coverage_chain: required
policy_issuer_did
policy_issuer_key_id
policy_issuer_did_resolution_proof_cid
witness_policy_lineage_id
predecessor_witness_policy_hash?
policy_sequence
policy_activation_bucket
rotation_mode: fixed | scheduled_successor
policy_successor_nomination_until_bucket? # exclusive; required only when scheduled
policy_new_work_until_bucket?       # exclusive; required only when scheduled
policy_completion_until_bucket?     # exclusive; required only when scheduled
policy_successor_source_id?         # required only when scheduled
lineage_compatibility_profile_ref
lineage_compatibility_profile_cid
lineage_compatibility_profile_hash
witness_policy_id
witness_policy_version
witness_policy_hash
policy_issuer_signature
```

Every field ending in `_buckets` is an exact non-negative integer count of the
policy's 3,600-second buckets, not descriptive text. Coverage-interval, permit-
request lifetime, standing, challenge and lifecycle retention counts must be
positive. Within this artifact,
`maximum_clock_uncertainty_seconds` is the only duration expressed in seconds.
Membership and live-manifest entry and byte limits, the head-catch-up limit and
the maximum head-generation gap are positive integers and are checked before
artifact allocation or full decoding. V1 requires exactly one maximum head
generation per closed state bucket. A lineage must publish a semantic update or
deterministic retention renewal no later than
`maximum_coverage_head_generation_gap_buckets` after its prior state bucket;
changing either cadence rule requires a new policy/schema version and vectors.
The evidence proof-resource profile's `coverage_head` root rule permits at least
one current root plus `maximum_coverage_head_catchup_generations` retained-version
roots, and its aggregate operation limits cover that complete catch-up without a
per-generation reset.
`required_coverage_witness_dids` is a non-empty, canonically sorted subset of
`accepted_witness_dids`. It is fixed before evidence is observed; every listed
witness must publish the complete source-relative coverage proof, represented as
the live deterministic head record and its raw chain before compaction, and as
that live head plus its selected uniquely finalized usable prefix and contiguous
raw suffix afterward. A scorekeeper cannot satisfy coverage by selecting a more
favorable unlisted or partial subset.
The coverage-prefix interval, maximum finalization delay, uncompacted-interval,
prefix-proof and live-manifest limits are positive integers. A policy must
schedule a prefix before either the raw suffix or its consistency proof can
exceed a pinned limit. A live manifest that exceeds its independent count or
canonical-byte limit is `coverage_unavailable`, never permission to omit a live
entry or prune locally.
Using checked arithmetic, it must also satisfy:

```text
coverage_prefix_checkpoint_interval_buckets
  + maximum_coverage_prefix_finalization_delay_buckets
  <= 1
     + max(
         maximum_registry_evaluation_horizon_buckets,
         lifecycle_tombstone_retention_buckets
       )
     + standing_evidence_retention_buckets
```

This ensures even an empty interval's minimum storage promise reaches the
prefix's finalization deadline. The challenge interval appears on both sides of
that storage calculation and therefore cancels from this policy inequality.
`policy_sequence` is a positive integer. A fixed policy omits the nomination and
both transition boundaries, `policy_successor_source_id`,
`required_policy_successor_proof` and
`maximum_policy_successor_observation_delay_buckets`; a scheduled policy carries
all six, and their field-presence and strict-ordering rules are part of canonical
validation. The named source must exist in the policy's source manifest, cover the
policy issuer's repository and include the fixed
`com.dinakernel.curation.witnessPolicy` collection. A candidate delivered outside
that source is not a same-lineage successor.
The proof-resource-profile ref/CID/hash are required in every policy. The CID
resolves to the exact canonical profile below and its embedded hash must
recompute; a witness cannot substitute local proof limits after seeing a target.
The evidence-feasibility-manifest ref/CID/hash are likewise required. The
manifest, its policy-projection binding and every exact fixture must verify before
the policy can activate; local fixture generation or an unsigned replacement is
not accepted.
The compatibility-profile ref/CID/hash are required in every policy and are
covered by `witness_policy_hash`. The CID resolves to the exact canonical profile
bytes and the embedded hash must recompute; all policies in one lineage carry the
same profile hash.
`maximum_registry_evaluation_horizon_buckets` must equal the largest horizon in
the content-addressed outcome-policy registry; a witness cannot shorten it
locally. Canonical policy bytes contain these values, so changing any duration
changes `witness_policy_hash`.
Every V1 `retention_until` is an integer exclusive UTC bucket boundary. Evidence
is inside retention exactly when the verifier's policy-clock bucket is less than
`retention_until`; no field mixes wall-clock timestamps with bucket indices.

The policy envelope is canonical and non-self-referential:

```text
witness_policy_hash = SHA-256(
  "dina-curation-witness-policy-hash-v1" ||
  canonical_policy_without_hash_and_signature
)

policy_issuer_signature = Sign(
  policy_issuer_key,
  "dina-curation-witness-policy-v1" || witness_policy_hash
)
```

The content-addressed proof-resource profile closes the validation workload for
public witness targets and private permit requests:

```text
evidence_proof_resource_profile {
  proof_resource_profile_version
  proof_block_retrieval_encoding: raw_cid_block_v1
  root_rules[] {
    proof_kind: authority_target | commitment_target | outcome_target |
                discipline_target | evidence_event | policy_successor |
                source_position | source_range | source_start |
                permit_attachment | coverage_prefix |
                coverage_prefix_finalization | coverage_head
    root_schema_id
    maximum_root_encoded_bytes
    maximum_roots_per_operation
    maximum_transitive_blocks_per_root
    maximum_transitive_encoded_bytes_per_root
    maximum_transitive_depth_per_root
  }
  schema_rules[] {
    schema_id
    child_cid_edges[] {
      field_path
      child_schema_id
      cardinality: exactly_one | zero_or_one | list
    }
    maximum_direct_children
  }
  maximum_total_roots_per_operation
  maximum_transitive_blocks_per_operation
  maximum_transitive_encoded_bytes_per_operation
  maximum_transitive_depth
  maximum_permit_request_encoded_bytes
  maximum_feasibility_manifest_encoded_bytes
  maximum_feasibility_fixture_encoded_bytes
  maximum_network_bytes_per_operation
  maximum_redirects_per_fetch
  maximum_concurrent_fetches_per_operation
  maximum_fetch_duration_ms
  evidence_proof_resource_profile_hash
}

evidence_proof_resource_profile_hash = SHA-256(
  "dina-curation-evidence-proof-resource-profile-v1" ||
  canonical_proof_resource_profile_without_hash
)
```

Root rules sort by `proof_kind`, schema rules by `schema_id` and child edges by
`(field_path, child_schema_id, cardinality)`. Every listed proof kind has exactly
one root rule, every root/child schema resolves exactly once and every schema is
reachable. Traversal, conflicting schema assignment, CID deduplication, cycle
rejection and longest-path depth use the typed-edge rules in Section 12. Canonical
root, root-count, transitive-block, encoded-byte or depth excess is an intrinsic
`policy_limit` failure. Network-byte, redirect, concurrency or wall-time excess
before canonical completion is `unavailable_artifact` and witness-health evidence,
not proof that the target itself is invalid. The reference witness and permit
endpoint enforce both classes cumulatively per operation before full decoding;
an implementation cannot reset a budget for each nested attachment.

`raw_cid_block_v1` means a successful proof-block fetch returns one response body
containing exactly the canonical raw octets whose recomputed CID equals the
requested CID, with no JSON/base64 wrapper and identity content encoding.
`maximum_network_bytes_per_operation` counts every response-body octet received
across successful, redirected, failed and retried fetches before semantic decode;
TLS, HTTP or relay framing and headers are excluded by definition. An endpoint
that cannot provide this encoding is `unavailable_artifact`. The cold-cache
feasibility path uses one successful body and no redirect or retry for each
distinct block, while operational vectors account for all additional bodies.

All canonical limits, the permit-request byte limit and both feasibility-artifact
byte limits are positive integers.
`maximum_redirects_per_fetch` may be zero; concurrency and duration are positive.
Unknown proof kinds, schema IDs or traversal rules fail closed. The initial
profile and its cross-runtime positive/limit vectors ship with the pinned policy;
`v1_nonweakening` requires the ref/CID/hash and every resolved byte to remain
identical.

A syntactically positive profile is not necessarily feasible. Every evidence
policy therefore pins an exact content-addressed `proof_feasibility_manifest`
through its required ref/CID/hash fields. Its closed projection is:

```text
proof_feasibility_manifest {
  feasibility_manifest_version
  profile_family: evidence | score
  feasibility_policy_projection_hash
  resource_profile_cid
  resource_profile_hash
  operation_fixtures[] {
    operation_kind: single_root | permit_request |
                    coverage_head_complete | coverage_head_conflict |
                    coverage_head_maximum_catchup
    proof_kind?             # required exactly for single_root
    fixture_ref
    fixture_cid
    fixture_hash
    expected_root_counts[] { proof_kind, count }
    expected_total_roots
    expected_transitive_blocks
    expected_transitive_encoded_bytes
    expected_transitive_depth
    expected_network_payload_bytes
  }
  feasibility_manifest_hash
}
```

The manifest's canonical encoded bytes are checked against
`maximum_feasibility_manifest_encoded_bytes` before its entry list is allocated.
Each fixture is checked against `maximum_feasibility_fixture_encoded_bytes`
before its roots or embedded block list are decoded. The exact fixture count is
derived from the closed root-rule and operation-kind sets below, so these per-
artifact limits also bound total activation work; oversized artifacts make the
policy malformed rather than partially activated.

Every fixture ref/CID resolves to this closed content-addressed artifact:

```text
proof_feasibility_fixture {
  feasibility_fixture_version
  profile_family: evidence | score
  operation_kind: single_root | permit_request |
                  coverage_head_complete | coverage_head_conflict |
                  coverage_head_maximum_catchup
  proof_kind?
  roots[] {
    proof_kind
    artifact_uri?
    root_cid
  }
  blocks[] {
    block_cid
    canonical_block_bytes
  }
}
```

Fixture family, operation kind and optional proof kind must equal the containing
manifest entry. The proof-kind field is present exactly for `single_root`, which
has exactly one root and whose manifest, fixture and root proof-kind values all
agree; every other operation omits it. A fixture root maps exactly to the Section
12 descriptor with `root_kind = proof_kind` and `artifact_cid = root_cid`;
`artifact_uri` follows the production root schema's exact presence rule. Roots
use the production typed schemas and total order
`(proof_kind, artifact_uri presence, artifact_uri_or_empty, raw root_cid bytes)`.
Blocks sort by raw CID bytes and are duplicate-free
and include every root block. `canonical_block_bytes` is the canonical unpadded
base64url encoding of the exact decoded block octets; padded, alternate-alphabet
or non-canonical encodings fail. Each CID must recompute from those octets, every
block must be reachable from a listed root through the production typed-child schema,
and every referenced child must be present; disconnected padding, a missing
block, an unknown edge or alternate decoding fails. Fixture metrics use the
production unique-CID deduplication rule; the separate worst-case inequalities
below deliberately assume no sharing and do not require impossible duplication
of content-identical policy blocks inside a fixture.

Each family manifest contains exactly one `single_root` fixture for every root-
rule proof kind. Evidence additionally contains exactly one `permit_request` and
one of each of the three coverage-head operation fixtures. Score omits
`permit_request` and additionally contains exactly the three coverage-head
operation fixtures with the required-witness multiplicity. Entries sort by
`(operation_kind, proof_kind_or_empty)` and root-count entries by `proof_kind`;
duplicates, unknown kinds and family-invalid kinds fail closed. Every fixture is a complete canonical positive proof graph,
not a declaration of counts. The validator resolves it, checks ref/CID/hash,
applies the production schema and traversal evaluator, and requires every
recomputed metric to equal the manifest. Optional branches are absent in
`complete` and required in `conflict`. The maximum-catch-up fixture contains the
complete mandatory root set at the policy maximum plus every conflict branch
that may coexist with that catch-up operation and increase its resource use. It
uses successor heads and includes every mandatory declared-predecessor linkage
artifact and child needed across the complete retained chain; generation-one
heads cannot stand in for their larger closures.

The feasibility policy projection removes exactly these fields and no others:

```text
evidence exclusion set = {
  evidence_proof_feasibility_manifest_ref,
  evidence_proof_feasibility_manifest_cid,
  evidence_proof_feasibility_manifest_hash,
  witness_policy_hash,
  policy_issuer_signature,
  witness_policy_id
}

score exclusion set = {
  score_proof_feasibility_manifest_ref,
  score_proof_feasibility_manifest_cid,
  score_proof_feasibility_manifest_hash,
  score_witness_policy_hash,
  policy_issuer_signature,
  score_witness_policy_id
}
```

Every other canonical policy field remains in the projection. In particular,
`predecessor_witness_policy_hash`, policy sequence and activation/transition
fields remain in an evidence successor. The family-specific hash domains are
`dina-curation-evidence-feasibility-policy-projection-v1` and
`dina-curation-score-feasibility-policy-projection-v1`. This removes the hash
cycle while binding every witness set, catch-up count, resource-profile reference
and numeric limit that affects fixture multiplicity. The manifest hash uses
`dina-curation-proof-feasibility-manifest-v1` over canonical manifest bytes
without that hash. Each `fixture_hash` uses
`dina-curation-proof-feasibility-fixture-v1` over the exact canonical closed
`proof_feasibility_fixture` bytes; `fixture_cid` is the content CID of those same
bytes. Under `raw_cid_block_v1`, `expected_network_payload_bytes` is the cold-
cache sum of the exact successful response-body lengths for every distinct
fixture block; it equals `expected_transitive_encoded_bytes`. Redirect, error and
retry bodies are absent from this positive fixture but count against the same
network budget in operational tests. The policy hash covers
the final manifest ref/CID/hash, so a different fixture set is a different policy
rather than local validator choice.

Each root is also admitted under its root rule's cumulative per-root block, byte
and depth maxima before consuming the shared operation budget. A root rule must
satisfy:

```text
maximum_transitive_blocks_per_root >= 1
maximum_transitive_encoded_bytes_per_root >= maximum_root_encoded_bytes
maximum_transitive_depth_per_root >= single-root fixture depth for that root kind
```

Its single-root fixture must fit every per-root limit. Using checked arithmetic, the
profile must additionally satisfy, for every operation/root multiplicity allowed
by the policy:

```text
maximum_total_roots_per_operation >= sum(root_counts)

maximum_transitive_blocks_per_operation
  >= sum(root_count * root_rule.maximum_transitive_blocks_per_root)

maximum_transitive_encoded_bytes_per_operation
  >= sum(root_count * root_rule.maximum_transitive_encoded_bytes_per_root)

maximum_transitive_depth
  >= max(root_rule.maximum_transitive_depth_per_root for every used root)

maximum_network_bytes_per_operation
  >= maximum_transitive_encoded_bytes_per_operation
```

For evidence coverage catch-up, `root_counts` includes one conflict-bearing
current head plus exactly `maximum_coverage_head_catchup_generations` retained
head versions; its current-root closure includes the maximum conflict branch
permitted by that root rule. These worst-case inequalities assume no CID
deduplication; sharing can reduce actual cost but cannot be required for
feasibility. A root exceeding its per-root limit is `policy_limit`; an admitted
root set cannot later fail aggregate canonical limits merely because several
individually valid roots were combined. A profile or fixture failing any check is
an invalid policy artifact, not a valid policy under which every target happens
to fail.

The content-addressed lineage compatibility profile has a closed V1 envelope:

```text
policy_compatibility_profile {
  compatibility_profile_schema_version
  compatibility_mode: fixed_no_successor | v1_nonweakening
  maximum_policy_drain_buckets? # required only for v1_nonweakening
  lineage_compatibility_profile_hash
}

lineage_compatibility_profile_hash = SHA-256(
  "dina-curation-policy-compatibility-profile-v1" ||
  canonical_compatibility_profile_without_hash
)
```

`fixed_no_successor` omits the drain field and rejects every successor. The Phase
1 preview uses that mode, and a policy carrying it must use
`rotation_mode = fixed`. A policy using `rotation_mode = scheduled_successor`
must carry `v1_nonweakening`. That mode has a positive maximum drain and
applies this complete comparison before a same-lineage successor is accepted:

- `witness_policy_lineage_id`, `policy_issuer_did`, accepted witness set,
  required coverage-witness set, outcome-policy registry, coverage mode, bucket
  rule, clock source, rollback rule, proof requirements, refusal/coverage
  requirements, proof-resource-profile and feasibility-manifest ref/CID/hash and
  all resource limits remain exactly equal;
- observation and permit quorums may stay equal or increase, and the resulting
  permit quorum must still satisfy the intersection rule;
- standing, challenge and lifecycle retention values may stay equal or increase;
- processing, checkpoint, quorum-delay, permit-lifetime, coverage-interval and
  clock-uncertainty maxima may stay equal or decrease;
- the source manifest changes only through the complete transition partition
  defined below. `v1_nonweakening` accepts only a one-to-one `continue` rule with
  `cursor_relation = identical_continuation` for every predecessor and successor
  source. The source IDs may change, but endpoint identity, filters, cursor
  profile, source-authentication profile, encoding, ordering, completeness
  semantics and continuation relation remain exactly equal. The predecessor's
  `policy_successor_source_id` must map
  through its unique continuation rule to the successor's
  `policy_successor_source_id`. `split`, `merge`, `retire`, `introduce` and every
  `content_addressed_mapping` require a new compatibility mode or a new lineage
  with an explicit client trust decision;
- policy ID/version/hash, sequence, predecessor, activation/transition boundaries
  and issuer key ID/proof may change only through their separately verified
  lineage, boundary and DID-key rules. Every other unclassified field remains
  exactly equal.

For a scheduled predecessor, the verifier also requires:

```text
0 < policy_completion_until_bucket - policy_new_work_until_bucket
policy_completion_until_bucket - policy_new_work_until_bucket
  <= compatibility_profile.maximum_policy_drain_buckets
```

The issuer signature is necessary but not sufficient: a correctly signed
successor that fails this comparison is `incompatible_successor`, not the next
policy. Weakening a listed rule requires a new lineage and bundled/user-approved
trust decision. A later profile that supports witness replacement, source
split/merge/retirement/introduction, changed source contracts or registry
evolution must use a new compatibility mode and conformance suite; it cannot
reinterpret `v1_nonweakening`.

The bundled client pin identifies the expected policy issuer and anchor hash. A
valid signature from another issuer, or a standalone valid issuer signature over
another hash, does not authorize a policy substitution. The only same-lineage
exception is the complete scheduled successor chain defined below.

`witness_policy_lineage_id` is stable across compatible policy rotations and is
itself pinned by the client. The first policy has sequence one and no
predecessor. A successor increments the sequence once, names the exact
predecessor hash and cannot activate before `policy_activation_bucket`. Changing
the lineage ID is a new trust domain, not a routine upgrade, and cannot authorize
an old receipt or inherit its standing without an explicit migration protocol.
Here, compatible means that the exact lineage profile above verifies; issuer
intent or a version-number increase is not a substitute.

The Phase 1 preview policy uses `rotation_mode = fixed`. Its transition fields are
absent and no same-lineage successor is valid; replacing it requires a new
bundled trust decision. The present schema freezes the structural semantics and
conformance fixtures for `scheduled_successor`, but no shipping client may enable
that mode yet: a signed future boundary does not prove to a client that real time
has crossed it. A rotation-capable post-preview policy uses
`scheduled_successor` and signs all three exclusive boundaries in its own canonical
bytes before it begins operation:

```text
policy_activation_bucket
  < policy_successor_nomination_until_bucket
  < policy_new_work_until_bucket
  < policy_completion_until_bucket

policy_successor_nomination_until_bucket
  + maximum_policy_successor_observation_delay_buckets
  <= policy_new_work_until_bucket
```

All additions and comparisons use checked arithmetic. The nomination boundary
closes the candidate set early enough for every required witness disposition and
the complete slot proof to exist before new-work activation. It is distinct from
the later ownership cutover and drain-completion boundaries.

Its direct successor must activate exactly at
`policy_new_work_until_bucket`. Before that boundary, the predecessor is the
policy for new permit requests; at and after it, every new request instance must
use the successor. Public-source target ownership is independent of local arrival
time: every target at a canonical source position below that source's deterministic
cutover cursor belongs to the predecessor, while every target at or above it
belongs to the successor. The predecessor may finish only pre-cutover source
targets, including an outcome already carrying a complete predecessor permit
quorum, and close the corresponding coverage even when a lagging witness receives
that target after activation. No permit signature or source target at or above the
cutover cursor is drain work. Those drain operations must finish strictly before
`policy_completion_until_bucket`. A fresh permit request,
changed core or successor-owned public target is not drain work. At the completion
boundary the predecessor signs nothing further. Existing predecessor proofs
remain historically valid through their own signed retention boundaries;
operational retirement never rewrites their observation buckets or invalidates
them early.

Successor selection is a complete-set decision, not whichever signed policy a
client sees first. The predecessor defines one logical slot:

```text
policy_successor_slot_id = SHA-256(
  "dina-curation-policy-successor-slot-v1" ||
  witness_policy_lineage_id || witness_policy_hash ||
  (policy_sequence + 1) || policy_successor_nomination_until_bucket ||
  policy_new_work_until_bucket
)
```

Every proposed direct successor is published as an immutable
`com.dinakernel.curation.witnessPolicy` record by `policy_issuer_did` and must
appear in `policy_successor_source_id` inside this half-open nomination range:

```text
slot_start_cursor = max_under_profile(
  policy_successor_source.start_cursor,
  CutoverCursor(profile, policy_activation_bucket)
)

slot_end_cursor = CutoverCursor(
  profile, policy_successor_nomination_until_bucket
)

slot_range = [slot_start_cursor, slot_end_cursor)
```

Each predecessor required-coverage witness independently closes that exact source
range in a signed `com.dinakernel.curation.policySuccessorSlotClosure`. Its
content-addressed membership artifact accounts for every `witnessPolicy` URI/CID
in the range as a signed successor observation or proof-bearing refusal and binds
the authenticated source-position and range proofs defined below. This is a
dedicated policy-source closure, not the predecessor's terminal all-target
coverage head. A verifier independently opens each candidate record and repository
proof; a refusal label cannot hide a candidate whose issuer signature, slot,
predecessor, sequence, activation, compatibility profile and source-position
checks pass.

The complete valid candidate set is the set of distinct `witness_policy_hash`
values that pass those intrinsic checks across every required-witness slot
closure. Republishing the same policy hash at another URI is retained as duplicate-
publication evidence but is one candidate. An unavailable candidate record or an
undecidable required-witness disposition makes the slot
`policy_transition_unavailable`. An empty valid set at slot closure is
`successor_missing`. Exactly one hash authorizes that successor. Two or more
distinct valid hashes are terminal `policy_lineage_equivocation`: no branch may
become current, later deletion cannot restore uniqueness, and recovery requires a
new explicitly pinned lineage. A candidate first entering the source at or after
`slot_end_cursor` cannot rescue, replace or fork the closed slot.

The canonical `policy_successor_slot_proof_bundle` defined with the closure schema
below is assembled and verified before `policy_new_work_until_bucket`; it is not a
scorekeeper assertion. It contains the complete required-witness closure set,
candidate bytes and source proofs, but deliberately does not claim that ordinary
predecessor drain work is finished. The later score transition bundle embeds this
exact slot bundle and adds terminal predecessor coverage plus the source bridge.

A future rotation-enabled client accepts a same-lineage successor only through a complete contiguous
issuer-signed chain from its bundled anchor hash, with exact sequence,
predecessor and boundary continuity, the unique closed successor slot proof above
and a successful compatibility-profile comparison at every edge. In addition, its
policy schema and bundled trust decision must pin a
`client_activation_clock_profile` defining the authenticated time source,
uncertainty interval, rollback behavior, durable last-accepted time and a
conservative proof that the lower bound of accepted time is at or after the
new-work boundary. The current schema has no such field, so current clients reject
`scheduled_successor` regardless of local wall clock. The future client does not
wait for the later terminal drain proof before routing new successor work. It
durably remembers the highest activated sequence it has verified and never moves
backward. A new installation anchored
at an older scheduled policy follows the same chain. If the successor chain is
unavailable at the predecessor's new-work boundary, the client fails closed for
new work; presenting the still-valid predecessor signature cannot extend its
signed operating interval. This turns successor withholding into visible
unavailability rather than a downgrade. Emergency early retirement and policy-
chain distribution governance require a separately signed post-preview profile;
neither may be inferred from a newer policy document or local wall-clock state.

`source_manifest_cid` identifies a canonical, content-addressed source contract:

```text
source_manifest_version
predecessor_source_manifest_cid?
sources[] {
  source_id
  transport: atproto_relay | jetstream | repository_export
  endpoint_identity
  collection_filters[]
  cursor_encoding
  ordering_semantics
  completeness_semantics
  cursor_profile_ref
  cursor_profile_cid
  cursor_profile_hash
  source_authentication_profile_ref
  source_authentication_profile_cid
  source_authentication_profile_hash
  start_cursor
  start_checkpoint_ref?
  start_checkpoint_cid?
  failover_equivalence_group? # reserved; MUST be absent in every V1 profile
}
source_transition_rules[]? {
  transition_kind: continue | retire | introduce | split | merge
  predecessor_source_ids[]
  successor_source_ids[]
  cursor_relation: identical_continuation | content_addressed_mapping | none
  mapping_rule_ref?
  mapping_rule_cid?
  transition_rule_hash
}
source_manifest_hash
```

`source_manifest_hash = SHA-256("dina-curation-source-manifest-v1" ||
canonical_source_manifest_without_hash)`. `source_manifest_cid` must resolve to
those same canonical manifest bytes, and the verifier must recompute the
embedded hash; the CID and the embedded SHA-256 value are distinct checks and
are not compared as if they used the same encoding.

Every source cursor belongs to a content-addressed profile with one closed
envelope:

```text
source_cursor_profile {
  source_cursor_profile_version
  cursor_profile_id
  transport
  cursor_encoding
  canonical_position_schema
  comparator_id
  range_semantics: start_inclusive_end_exclusive
  cutover_function_id: none | utc_time_position_v1
  maximum_position_bytes
  cursor_profile_hash
}

cursor_profile_hash = SHA-256(
  "dina-curation-source-cursor-profile-v1" ||
  canonical_cursor_profile_without_hash
)
```

The profile CID resolves to those exact bytes and its transport, encoding and
ordering fields must equal the enclosing source contract. Canonical source ranges
are half-open `[start_cursor, end_cursor)` under the profile comparator. Every
public target has one total canonical position; equal transport cursors are broken
by the profile's fixed event-identity tie-breaker, never ingestion order.

The source also pins how those positions and range frontiers are authenticated:

```text
source_authentication_profile {
  source_authentication_profile_version
  source_authentication_profile_id
  transport
  endpoint_identity
  verification_method_id
  verification_material_ref
  verification_material_cid
  position_proof_schema_id
  range_proof_schema_id
  start_proof_schema_id
  source_authentication_profile_hash
}

source_authentication_profile_hash = SHA-256(
  "dina-curation-source-authentication-profile-v1" ||
  canonical_source_authentication_profile_without_hash
)
```

The profile CID resolves to those exact bytes; its transport and endpoint identity
must equal the source entry. For an evidence source, every proof and nested
verification schema must exist in the evidence policy's proof-resource profile.
For a score source, the corresponding schemas must exist as typed descendants in
the score policy's input-role registry. The verification material pins the source
signing key, signed repository-log rule or other replayable authentication root.
A live TLS connection, witness database timestamp or unsigned Jetstream frame is
not a portable source proof.

Every covered public target carries one content-addressed position proof:

```text
source_position_proof {
  source_position_proof_version
  source_manifest_cid
  source_id
  source_authentication_profile_cid
  target_uri
  target_cid
  source_cursor
  source_event_digest
  source_checkpoint_cid
  source_authentication_proof_cid
}
```

Every closed source range carries one frontier/completeness proof:

```text
source_range_proof {
  source_range_proof_version
  source_manifest_cid
  source_id
  source_authentication_profile_cid
  start_cursor
  end_cursor
  range_checkpoint_cid
  range_authentication_proof_cid
}
```

Every source introduced by a policy transition also carries one authenticated
start proof. Fixed genesis policies may instead pin their start checkpoint in the
bundled trust anchor, but a same-lineage successor cannot rely on that exception:

```text
source_start_proof {
  source_start_proof_version
  source_manifest_cid
  source_id
  source_authentication_profile_cid
  start_cursor
  start_checkpoint_cid?
  start_authentication_proof_cid
}
```

The transport-specific verifier opens the named source-authentication material,
recomputes the event digest, range checkpoint or start checkpoint, verifies the
source signature or repository-log proof and requires every copied manifest,
source ID, URI/CID and cursor to match. A start proof authenticates the successor
source's declared initial frontier; it does not by itself prove continuity with a
predecessor. That relation is verified separately from both manifests, their
transition rule, the predecessor terminal range proof and the successor start
proof. A range proof establishes complete source output only under the source's
declared `completeness_semantics`; it does not prove that the upstream operator
never censored an event before signing its log. Position, range and start proof
bytes are retained with the enclosing checkpoint, refusal, slot closure, coverage
record or policy-transition bundle.

`utc_time_position_v1` is the only cutover function accepted by
`v1_nonweakening`. Its canonical position begins with an authenticated unsigned
64-bit `source_time_us` followed by the fixed event-identity tie-breaker, ordered
lexicographically. For a V1 3,600-second UTC bucket `b`:

```text
CutoverCursor(profile, b) = canonical_position(
  source_time_us = b * 3_600 * 1_000_000,
  tie_breaker = MIN
)
```

The multiplication uses checked unsigned arithmetic. `b` must be no greater
than `floor((2^64 - 1) / 3_600_000_000)`; a larger bucket, an intermediate
overflow or a result that the profile cannot encode is an invalid policy rather
than a wrapped cursor.

The source adapter must prove through the pinned position/range schemas that
`source_time_us` is the source-assigned ingress time represented by its
authenticated cursor/checkpoint, not a publisher field or the witness's receipt
time. A transport without that replayable proof uses
`cutover_function_id = none` and cannot participate in `scheduled_successor` under
`v1_nonweakening`; it remains valid for a fixed policy. Unknown comparator,
position or cutover-function IDs fail closed. The successor source manifest's
`start_cursor` must equal `CutoverCursor(profile,
predecessor.policy_new_work_until_bucket)`, and every predecessor terminal range
must end at that same position. Local arrival time affects deadline-health
evidence only; it never changes the owning policy. Every witness archive retains
the cursor-profile and source-authentication-profile bytes, including pinned
verification material, with the source manifest through the enclosing coverage
boundary, and every scheduled transition bundle carries them through its replay
boundary; a profile CID without bytes makes cutover unavailable.

The source list, filters and start positions are policy inputs, not values a
witness or scorekeeper chooses after seeing outcomes. V1 does not define source
failover equivalence: `failover_equivalence_group` must be absent, and loss of a
declared endpoint makes the affected range `coverage_unavailable`. A future
profile may continue through a failover source only after it defines a canonical,
content-addressed cursor and target-universe mapping, a bounded deterministic
evaluator, completeness semantics and cross-runtime vectors. A shared group
label or operator assertion is never such a proof. The contract can establish exhaustive handling
relative to accepted source output; it cannot prove that an upstream relay never
censored a valid repository event. That residual source trust is reported
separately.

A first or fixed policy omits predecessor transition fields. A scheduled
successor source manifest names the exact predecessor manifest CID and carries a
closed transition partition. Every predecessor source ID appears in exactly one
rule's predecessor set and every successor source ID appears in exactly one
rule's successor set. Extra, missing or repeated IDs fail before evidence is
processed. V1 permits only these cardinalities:

```text
continue:  1 predecessor, 1 successor
retire:    1 predecessor, 0 successors
introduce: 0 predecessors, 1 successor
split:     1 predecessor, 2 or more successors
merge:     2 or more predecessors, 1 successor
```

A many-to-many rule is invalid in V1 and requires an intermediate policy.
`retire` and `introduce` require `cursor_relation = none` and forbid mapping
artifacts. They make the source-set change explicit but do not by themselves
make it compatible with the current trust lineage. `identical_continuation`
applies only to `continue`, permits no mapping artifact and requires identical
endpoint identity, filters, cursor-profile CID/hash, source-authentication-profile
CID/hash, cursor encoding, ordering and completeness semantics plus the source
contracts' exact continuation relation.
`content_addressed_mapping` is the reserved structural marker for every split or
merge and for a continuation whose source contract changes; both mapping-rule
fields are then required. No current compatibility mode assigns semantic meaning
to that artifact or accepts it for same-lineage rotation. A future mode must freeze
a closed mapping-artifact schema, deterministic evaluator, target-ownership and
duplicate URI/CID rules, cursor algebra, resource limits and cross-runtime
conformance vectors before such a rule can prove continuity. Merely resolving the
CID, or an issuer asserting that the target universes are equivalent, is not a
proof. Under `v1_nonweakening`, every mapping-rule field is absent and every rule
is `continue + identical_continuation`.

Each rule is canonical and non-self-referential:

```text
transition_rule_hash = SHA-256(
  "dina-curation-source-transition-rule-v1" ||
  predecessor_source_manifest_cid ||
  canonical_transition_rule_without_hash
)
```

Rules sort by `(transition_kind, predecessor_source_ids,
successor_source_ids)`, with each ID list canonically sorted. The score-lineage
bridge later instantiates every precommitted rule at the predecessor terminal and
successor start positions; a scorekeeper cannot omit a source or invent a
transition after seeing the evidence. Retired-source historical evidence remains
subject to its original retention and no-suppression rules. An introduced source
makes no claim of historical coverage before its signed start checkpoint.

For each bounded source interval, the witness publishes an immutable
`com.dinakernel.curation.witnessCoverage` record:

```text
coverage_interval_id
coverage_kind: interval
source_manifest_cid
previous_coverage_uri?
previous_coverage_cid?
source_ranges[] {
  source_id
  start_cursor
  end_cursor
  source_range_proof_ref
  source_range_proof_cid
}
coverage_membership_artifact_ref
coverage_membership_artifact_cid
coverage_membership_count
processed_target_root
processed_target_counts_by_type
checkpoint_root
refusal_root
complete_event_root
incomplete_event_diagnostic_root
unexplained_gaps[]
deadline_violations[]
clock_health_state
opened_at_bucket
closed_at_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_hash
coverage_schema_version
witness_signature
```

`coverage_interval_id` and the signature use the domain separators
`dina-curation-witness-coverage-id-v1` and
`dina-curation-witness-coverage-v1`. Intervals form one append-only URI/CID chain
per witness policy and source manifest.

That raw chain is not replayed from genesis forever. Before its pinned
`maximum_uncompacted_coverage_intervals` or prefix-proof resource limit is
reached, the same witness publishes a tagged
`com.dinakernel.curation.witnessCoverage` record with
`coverage_kind: compacted_prefix` and this closed projection:

```text
coverage_prefix_id
coverage_kind: compacted_prefix
source_manifest_cid
prefix_sequence
previous_prefix_uri?
previous_prefix_cid?
compacted_through_coverage_uri
compacted_through_coverage_cid
compacted_through_closed_at_bucket
compacted_interval_count
cumulative_interval_count
cumulative_interval_chain_hash
prefix_consistency_proof_ref
prefix_consistency_proof_cid
terminal_source_cursors[] {
  source_id
  end_cursor
  source_position_proof_ref
  source_position_proof_cid
}
live_dependency_manifest_ref
live_dependency_manifest_cid
live_dependency_root
live_dependency_count
created_at_bucket
usable_from_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_hash
coverage_schema_version
witness_signature
```

Ordinary interval records have `coverage_kind: interval`, require every field in
the earlier interval projection and forbid every prefix-only field. Prefix records
require every field above and forbid interval roots, membership counts and
deadline arrays. The first prefix has sequence one and no predecessor prefix;
every successor increments once and binds the exact prior prefix URI/CID. The
immediately following raw interval names the prefix record's URI/CID in
`previous_coverage_uri/cid`; the prefix itself binds the compacted-through raw
head, so neither a cursor gap nor a second branch is hidden by compaction.
`compacted_interval_count` is positive. On sequence one,
`cumulative_interval_count == compacted_interval_count`; afterward it equals the
predecessor cumulative count plus the new compacted count under checked
arithmetic. `terminal_source_cursors` contains each source-manifest source exactly
once, sorted by source ID, and each cursor/proof equals the end of that source's
last compacted range. `created_at_bucket` is no earlier than every compacted
interval's `closed_at_bucket` and no later than the earliest newly compacted
interval's `closed_at_bucket + coverage_prefix_checkpoint_interval_buckets`.
Checked arithmetic and the uncompacted-interval count are enforced before
prefix construction.
The prefix AT URI author and signed repository proof must derive to `witness_did`.
Exact URI/CID redelivery is idempotent; two contents at one prefix sequence, two
children of one predecessor prefix or URI/CID replacement is witness equivocation
and makes that chain unavailable. Deleting either branch never restores
uniqueness.

`cumulative_interval_chain_hash` is a protocol-fixed rolling accumulator over
every ordinary interval since the source-manifest start:

```text
coverage_prefix_hash_0 = SHA-256(
  "dina-curation-coverage-prefix-empty-v1" || source_manifest_cid
)

coverage_prefix_leaf_i = SHA-256(
  "dina-curation-coverage-prefix-leaf-v1" ||
  canonical({
    coverage_record_uri: coverage_interval_uri,
    coverage_record_cid: coverage_interval_cid,
    source_ranges,
    retention_until
  })
)

coverage_prefix_hash_i = SHA-256(
  "dina-curation-coverage-prefix-step-v1" ||
  coverage_prefix_hash_(i-1) || coverage_prefix_leaf_i
)
```

The first prefix starts from `coverage_prefix_hash_0`; a successor starts from
the exact signed predecessor `cumulative_interval_chain_hash`. The consistency
attachment is not implementation-defined. It has this closed canonical schema:

```text
coverage_prefix_consistency_proof {
  consistency_proof_schema_version
  coverage_family: evidence | score
  policy_hash
  source_manifest_cid
  prefix_sequence
  previous_prefix_uri?
  previous_prefix_cid?
  previous_cumulative_interval_count
  previous_cumulative_interval_chain_hash
  new_intervals[] {
    coverage_record_uri
    coverage_record_cid
    coverage_record_ref
    repository_proof_ref
    repository_proof_cid
    previous_coverage_record_uri?
    previous_coverage_record_cid?
    source_ranges[]
    closed_at_bucket
    retention_until
  }
  new_interval_count
  resulting_cumulative_interval_count
  resulting_cumulative_interval_chain_hash
  resulting_closed_at_bucket
  proof_hash
}
```

For sequence one, both predecessor locators are absent, the previous count is
zero and the previous hash is the family-specific empty hash. A successor
requires both predecessor locators and copies the predecessor prefix's signed
count and hash. `new_intervals` follows exact URI/CID predecessor linkage from
that prefix or the source-manifest start; it is never sorted independently. The
first entry's previous fields are both absent for sequence one and otherwise
equal the predecessor prefix URI/CID. Every later entry names the preceding entry
URI/CID. Each copied source range, close bucket and retention boundary must equal
the resolved signed record and repository proof while constructing and
challenging the prefix. These copied leaf inputs remain in the content-addressed
attachment after that raw record expires. `new_interval_count` equals both the
list length and the prefix's `compacted_interval_count`; checked addition
produces the prefix's cumulative count, and replaying the family-specific
canonical leaf and step functions over the copied inputs produces its cumulative
hash, compacted-through URI/CID and `compacted_through_closed_at_bucket`. The
first range starts at every predecessor terminal cursor and the last range produces
the new terminal cursors. A duplicate URI/CID, URI with two CIDs, missing link,
range gap or overlap, wrong family/policy/manifest, or count/hash mismatch is a
conflict. The proof hash is:

```text
proof_hash = SHA-256(
  "dina-curation-coverage-prefix-consistency-proof-v1" ||
  canonical_consistency_proof_without_hash
)
```

The prefix consistency ref/CID resolves to these exact canonical bytes; family,
policy, source manifest, sequence, predecessor, cumulative count/hash and
compacted-through values must equal the signed prefix.
`coverage_family` is inside the canonical projection; score and evidence
artifacts therefore cannot be substituted. Hash count and canonical encoded
bytes may not exceed the applicable policy limits before full allocation or
record resolution. No library-default accumulator convention is accepted.

The live-dependency attachment is one canonical entry per compacted ordinary
interval that still carries a dependency beyond prefix usability:

```text
coverage_live_interval_manifest {
  live_manifest_schema_version
  coverage_family: evidence | score
  policy_hash
  source_manifest_cid
  prefix_sequence
  cumulative_interval_count
  cumulative_interval_chain_hash
  usable_from_bucket
  entries[] {
    coverage_record_uri
    coverage_record_cid
    membership_artifact_ref
    membership_artifact_cid
    effective_retention_until
  }
  entry_count
  entries_root
  manifest_hash
}
```

An entry is required exactly when the authenticated ordinary interval's
exclusive `retention_until` is greater than `usable_from_bucket`.
`effective_retention_until` must equal that signed value, and the membership
ref/CID must equal the interval's signed membership ref/CID. Entries sort by
`(effective_retention_until, coverage_record_uri, coverage_record_cid)` and
duplicate URI/CID identities, one URI with two CIDs or two entries for one
interval are invalid. `entry_count` and the canonical encoded artifact must not
exceed the family's pinned live-manifest entry and byte limits; both limits are
checked before allocating the entries. The prefix's live-manifest ref/CID
resolves to these exact bytes; the manifest's copied family, policy, source,
sequence, cumulative count/hash and usability must equal the prefix, as must its
root and count. Their root and manifest hash are:

```text
coverage_live_interval_leaf = SHA-256(
  "dina-curation-coverage-live-interval-v1" || canonical_entry
)

CoverageLiveMerkleV1([]) = SHA-256(
  "dina-curation-coverage-live-empty-v1"
)

CoverageLiveParentV1(left, right) = SHA-256(
  "dina-curation-coverage-live-node-v1" || left || right
)

CoverageLiveRootV1(leaves) = SHA-256(
  "dina-curation-coverage-live-root-v1" ||
  CoverageLiveMerkleV1(canonically ordered leaves)
)

entries_root = CoverageLiveRootV1(canonically ordered leaves)

manifest_hash = SHA-256(
  "dina-curation-coverage-live-manifest-v1" ||
  canonical_live_manifest_without_hash
)
```

For a non-empty leaf list, `CoverageLiveMerkleV1` repeatedly applies
`CoverageLiveParentV1` and duplicates the final node at every odd level exactly
as the Section 6.4 tree; zero-, one-, odd- and even-entry roots are frozen
vectors.

The interval and membership blocks are roots for typed traversal to every
target, refusal, event, checkpoint, snapshot and transitive proof block required
by that family's pinned resource profile. Unique-CID byte accounting, cycle
rejection, longest-path depth and bounded streaming use Section 12. The manifest
must include every qualifying interval even when two intervals reach the same
child CID. A successor carries every predecessor entry whose boundary remains
greater than its own `usable_from_bucket`, adds every newly qualifying interval,
and removes an entry only at or after its authenticated exclusive boundary.
Omission, substitution, root/count/hash mismatch, shortened retention or an
unknown typed edge is a prefix conflict and makes coverage unavailable.

The prefix signature and ID use
`dina-curation-witness-coverage-prefix-v1` and
`dina-curation-witness-coverage-prefix-id-v1`. The witness creates a prefix while
the complete raw chain and every dependency remain retrievable, derives both
buckets under the policy clock/rollback rules and sets:

```text
usable_from_bucket = created_at_bucket + challenge_window_buckets

retention_until = max(
  every live dependency's effective retention boundary,
  usable_from_bucket
    + coverage_prefix_checkpoint_interval_buckets
    + challenge_window_buckets
    + maximum_coverage_prefix_finalization_delay_buckets
)
```

The old raw proof remains the required path through the prefix's finalization
deadline. During the challenge interval, clients and score witnesses verify both
representations and report conflicts. At or after `usable_from_bucket`, the
witness must publish a separate repository-authored
`com.dinakernel.curation.witnessCoveragePrefixFinalization` record before the
exclusive deadline. Its closed projection is:

```text
coverage_prefix_finalization {
  prefix_finalization_id
  coverage_family: evidence | score
  policy_hash
  source_manifest_cid
  prefix_uri
  prefix_cid
  prefix_sequence
  compacted_through_closed_at_bucket
  cumulative_interval_count
  cumulative_interval_chain_hash
  terminal_source_cursors_hash
  consistency_proof_cid
  live_dependency_manifest_cid
  live_dependency_root
  live_dependency_count
  previous_finalization_uri?
  previous_finalization_cid?
  previous_finalization_chain_hash
  previous_cumulative_conflict_count
  previous_cumulative_conflict_chain_hash
  previous_cumulative_conflict_overflow: boolean
  verification_result: valid | conflict
  conflict_set_mode: complete | overflow
  overflow_reason?: list_limit | verification_budget_exhausted |
                    scan_incomplete_after_conflict
  scan_failure?:
    | {
        failure_target_kind: artifact
        traversal_path
        artifact_cid
        failure_class: missing_artifact | invalid_artifact |
                       transport_unavailable | operational_budget_exhausted
      }
    | {
        failure_target_kind: source
        source_id
        last_authenticated_cursor
        last_authenticated_cursor_proof_cid
        failure_class: source_unavailable
      }
  conflicts[] {
    conflict_code
    artifacts[] {
      artifact_uri?
      artifact_cid
    }
  }
  conflict_count
  conflict_set_root
  cumulative_conflict_count
  cumulative_conflict_chain_hash
  cumulative_conflict_overflow: boolean
  cumulative_chain_status: clean | conflicted
  finalized_at_bucket
  retention_until
  witness_did
  witness_key_id
  witness_did_resolution_proof_cid
  finalization_schema_version
  finalization_chain_hash
  witness_signature
}
```

The record URI author and repository proof derive to `witness_did`, which must
equal the prefix author. Its copied prefix, proof, manifest, root, count, policy,
source, cursor-hash and retention fields must match exactly. This evidence NSID
requires `coverage_family: evidence`; the score NSID below requires
`coverage_family: score`. Conflict entries sort by their complete canonical bytes
and are duplicate-free. `conflict_code`
is one of `prefix_identity_mismatch`, `consistency_proof_mismatch`,
`live_manifest_mismatch`, `raw_chain_fork`, `dependency_mismatch`,
`retention_mismatch` or `policy_limit`. Every entry carries one or two artifacts,
sorted by `(artifact_uri presence, artifact_uri, artifact_cid)`; URI is present
exactly for a repository record, and duplicate artifacts are invalid. The cursor
hash is:

```text
terminal_source_cursors_hash = SHA-256(
  "dina-curation-coverage-prefix-terminal-cursors-v1" ||
  canonical(prefix.terminal_source_cursors)
)
```

`conflict_set_root` uses the Section 6.4 duplicate-odd-node convention and these
closed functions:

```text
conflict_leaf = SHA-256(
  "dina-curation-coverage-prefix-conflict-leaf-v1" || canonical_conflict
)

PrefixConflictMerkleV1([]) = SHA-256(
  "dina-curation-coverage-prefix-conflict-empty-v1"
)

PrefixConflictParentV1(left, right) = SHA-256(
  "dina-curation-coverage-prefix-conflict-node-v1" || left || right
)

conflict_set_root = SHA-256(
  "dina-curation-coverage-prefix-conflict-root-v1" ||
  PrefixConflictMerkleV1(canonically ordered conflict_leaf values)
)
```

For a non-empty leaf list, `PrefixConflictMerkleV1` repeatedly applies
`PrefixConflictParentV1` with the same duplicate-odd-node rule. `conflict_count`
equals the retained list length. A `valid` result requires
`conflict_set_mode: complete`, an empty conflict set and complete successful raw-
chain, consistency-proof, live-manifest and resource-limit verification.
`conflict` requires at least one completely proven conflict certificate; every
certificate contains the incompatible signed artifacts sufficient to establish
that conflict independently.

`complete` requires `overflow_reason` and `scan_failure` absent and means the list
contains every conflict found by the complete deterministic verification scan
over the finalization's fixed prefix input. `overflow` requires exactly one
reason and a non-empty retained list containing at least one complete
incompatible pair. `scan_failure` is present exactly when the reason is
`scan_incomplete_after_conflict` and absent for both other reasons.

The scan constructs the Section 12 canonical root descriptors for every
interval/prefix input, visits them in total root order and traverses each typed
graph by canonical DFS. Signed predecessor relationships are verified after
retrieval and do not order sibling branches. A candidate conflict is buffered
when its second required artifact becomes available and is admitted only after
that root's schema, cycle and longest-depth checks complete. Admitted conflicts
are ordered by their complete canonical bytes. Before each root, child fetch or
decoded block, the verifier checks the cumulative canonical verification budget.
The cutoff is immediately before the first operation that would exceed it; the
over-limit block is not partially decoded. Conflict discovery itself updates a
bounded streaming smallest-prefix selector and count, so filling the output list
does not stop verification or masquerade as budget exhaustion. The same fixed
input and policy profile therefore produce the same verified prefix and cutoff.

`list_limit` is valid only when the scan completed and its full canonical list
exceeds the pinned conflict-count or encoded-finalization-byte limit. The
retained list is exactly the lexicographically smallest maximal prefix that fits
both limits. `verification_budget_exhausted` is valid only when the deterministic
scan hit its block, transitive-byte or depth limit after completely proving at
least one conflict. Its retained list is the lexicographically smallest maximal
prefix, within the conflict-list limits, of every conflict completely proven
before that cutoff. A bounded implementation may compute either prefix with
streaming top-N selection and byte accounting. For these two canonical reasons,
retrying the same fixed input and policy must produce the same reason, retained
bytes, root and CID.

`scan_incomplete_after_conflict` is valid only when at least one complete
conflict was proven and fit before the next deterministic traversal occurrence
failed with one of the closed `scan_failure` variants. `artifact` carries the
complete Section 12 `traversal_path` and exact failed `artifact_cid`, omits all
source fields and permits only `missing_artifact`, `invalid_artifact`,
`transport_unavailable` or `operational_budget_exhausted`. `source` omits the
path and artifact CID, carries the manifest `source_id`, last authenticated
cursor and its position/start-proof CID, and requires
`failure_class: source_unavailable`. It is used only when source enumeration
cannot construct the next canonical root descriptor; once a root CID is known,
failure belongs to the artifact variant.

Artifact failure classification has this precedence: a network-byte, redirect,
concurrency or fetch-duration limit reached before classification completes is
`operational_budget_exhausted`; absence of a complete transport response is
`transport_unavailable`; an authenticated definitive not-found response is
`missing_artifact`; and a complete response whose body fails the pinned encoding,
CID or typed-schema validation is `invalid_artifact`. No implementation may
choose a lower-precedence class after a higher one applies. The retained list is
the lexicographically smallest maximal prefix, within output limits, of conflicts
fully proven before the failed occurrence or source boundary.

Canonical-budget retries remain byte-identical for fixed input/profile.
Operational availability may improve before publication, so an unpublished
attempt may later become `complete`, `list_limit` or
`verification_budget_exhausted`. Once the witness publishes the immutable
finalization for that slot, exact URI/CID retries are byte-identical and a later
successful fetch cannot replace or heal its terminal conflict. The signed
failure descriptor and omitted-set claim remain at the accepted-witness boundary;
the retained incompatible pair, not the operational diagnosis, proves conflict.

The root commits only to the retained prefix. A remote verifier independently
proves each retained conflict and the resulting terminal conflict state, but
cannot prove from that prefix alone that additional conflicts existed or that a
claimed deterministic scan reached its stated cutoff. It treats those facts as
the accepted witness's signed assertion and never describes omitted branches or
their count as independently verified. Security
does not depend on that assertion: one retained incompatible pair is sufficient
to poison the lineage. Either mode permanently increments cumulative conflict
state. A verifier never requires an unbounded all-branch list merely to establish
that a conflict exists. A verifier replaying the complete fixed input rejects an
oversized `complete` list, a non-maximal or non-prefix overflow selection, or
different retained bytes for the same input; a verifier holding only the bounded
artifact checks its internal ordering and pairs but accepts the omitted-set
assertion at the explicit witness boundary.
If any canonical or declared scan stop occurs before one complete conflict is
proven, or if even the first
retained complete conflict cannot fit the conflict-proof limits, the witness
emits no conflict finalization and coverage is unavailable; it never fabricates
conflict or implicit validity. Once one pair is fully proven and fits, later
canonical exhaustion, missing or invalid artifacts, source failure or operational transport
failure cannot downgrade that conflict to recoverable availability.
Once `cumulative_conflict_overflow` becomes true it remains true. From that point
`cumulative_conflict_count` is a verified lower bound over retained certificates,
not an exact count of every observed branch; APIs and UI must label it accordingly.

For sequence one, both previous-finalization locators are absent and the prior
chain fields are assigned exactly as follows:

```text
finalization_chain_hash_0 = SHA-256(
  "dina-curation-coverage-prefix-finalization-empty-v1" ||
  canonical({ coverage_family, policy_hash, source_manifest_cid, witness_did })
)

previous_finalization_chain_hash = finalization_chain_hash_0

previous_cumulative_conflict_count = 0
previous_cumulative_conflict_overflow = false

cumulative_conflict_chain_hash_0 = SHA-256(
  "dina-curation-coverage-prefix-conflict-chain-empty-v1" ||
  canonical({ coverage_family, policy_hash, source_manifest_cid, witness_did })
)

previous_cumulative_conflict_chain_hash = cumulative_conflict_chain_hash_0
```

Every successor names the exact preceding finalization URI/CID and copies its
signed finalization-chain value, cumulative conflict count, cumulative overflow
flag and cumulative conflict-chain value. Checked arithmetic and these exact
functions derive the next state:

```text
cumulative_conflict_count =
  previous_cumulative_conflict_count + conflict_count

cumulative_conflict_overflow =
  previous_cumulative_conflict_overflow || conflict_set_mode == overflow

cumulative_conflict_chain_hash_n = SHA-256(
  "dina-curation-coverage-prefix-conflict-chain-step-v1" ||
  previous_cumulative_conflict_chain_hash ||
  canonical({
    prefix_sequence,
    verification_result,
    conflict_set_mode,
    overflow_reason,
    scan_failure,
    conflict_count,
    conflict_set_root,
    cumulative_conflict_count,
    cumulative_conflict_overflow
  })
)

cumulative_chain_status =
  clean      iff cumulative_conflict_count == 0
  conflicted iff cumulative_conflict_count > 0
```

The next finalization-chain value, deterministic slot ID and signature are:

```text
finalization_chain_hash_n = SHA-256(
  "dina-curation-coverage-prefix-finalization-step-v1" ||
  previous_finalization_chain_hash ||
  canonical_finalization_without_id_chain_hash_and_signature
)

prefix_finalization_id = SHA-256(
  "dina-curation-coverage-prefix-finalization-slot-v1" ||
  canonical({
    coverage_family,
    policy_hash,
    source_manifest_cid,
    witness_did,
    prefix_sequence
  })
)

witness_signature = Sign(
  witness_key,
  "dina-curation-coverage-prefix-finalization-v1" ||
  canonical_finalization_without_signature
)

DigestRkeyV1(digest_32_octets) =
  lowercase RFC 4648 base32(digest_32_octets), without padding
```

`DigestRkeyV1` encodes the 32 raw digest octets, not their hexadecimal text, and
emits exactly 52 characters from `[a-z2-7]`. The four unused bits in the final
base32 symbol are zero; a decoder must decode to 32 octets and reproduce the
input string on canonical re-encoding. It rejects uppercase, padding, alternate
alphabets, non-zero unused trailing bits and every non-canonical length. The
all-zero 32-octet digest encodes as exactly 52 lowercase `a` characters. The
record's AT URI uses
`DigestRkeyV1(prefix_finalization_id)` as its rkey. A finalization under any other
rkey is invalid. The client can therefore resolve the one expected slot directly;
different CIDs for that URI slot are replacement equivocation rather than
independent candidates hidden under arbitrary record keys.

Checked timing requires:

```text
usable_from_bucket <= finalized_at_bucket

finalized_at_bucket
  < usable_from_bucket + maximum_coverage_prefix_finalization_delay_buckets

finalization.retention_until == prefix.retention_until
```

The prefix, consistency proof, live manifest, finalization record and their
repository/DID proofs remain retrievable through this exclusive boundary. That
storage promise does not extend any expired member's scoreability.
Exact URI/CID redelivery is idempotent. Two finalizations for one prefix
sequence, two children of one prior finalization or a same-slot valid replacement
for an already finalized conflict are equivocation and keep the chain
unavailable. A successor whose current prefix verifies may carry
`verification_result: valid`, but it must preserve the positive cumulative
conflict count and `cumulative_chain_status: conflicted`; it cannot heal or hide
the earlier conflict.
After raw predecessor bytes and older finalizations expire, a fresh verifier
checks the latest accepted-witness signature, chain step, current prefix,
recomputes the current consistency attachment's leaf extension from its copied
inputs, and checks the live manifest and suffix without recursively fetching the
predecessor. The predecessor accumulator remains deliberately a signed witness
summary of expired history, not a claim that the verifier replayed unavailable
raw leaves.

Prefix sequence alone does not identify the current chain head. Each witness
therefore maintains one live, deterministic head slot in
`com.dinakernel.curation.witnessCoverageHead` using this closed projection:

```text
coverage_head {
  coverage_head_slot_id
  coverage_family: evidence | score
  policy_hash
  source_manifest_cid
  head_generation
  head_update_kind: semantic_update | retention_renewal
  head_state_bucket
  semantic_state_hash
  previous_head_cid?
  previous_head_transition_proof_ref?
  previous_head_transition_proof_cid?
  coverage_anchor_kind: source_start | finalized_prefix | raw_interval
  selected_prefix_uri?
  selected_prefix_cid?
  selected_prefix_finalization_uri?
  selected_prefix_finalization_cid?
  raw_head_uri?
  raw_head_cid?
  bounded_coverage_proof_ref
  bounded_coverage_proof_cid
  conflict_proof_ref?
  conflict_proof_cid?
  coverage_through_source_cursors[] {
    source_id
    end_cursor
    cursor_proof_kind: source_start | source_position
    cursor_proof_ref
    cursor_proof_cid
  }
  coverage_through_closed_at_bucket?
  cumulative_interval_count
  cumulative_interval_chain_hash
  previous_cumulative_chain_status?: clean | conflicted
  previous_cumulative_conflict_overflow?: boolean
  cumulative_chain_status: clean | conflicted
  cumulative_conflict_overflow: boolean
  coverage_status: complete | unavailable | conflicted
  status_reason_codes[]
  published_at_bucket
  retention_until
  witness_did
  witness_key_id
  witness_did_resolution_proof_cid
  coverage_head_schema_version
  witness_signature
}
```

The slot ID and stable rkey are:

```text
coverage_head_slot_id = SHA-256(
  "dina-curation-coverage-head-slot-v1" ||
  canonical({
    coverage_family,
    policy_hash,
    source_manifest_cid,
    witness_did
  })
)

coverage_head_rkey = DigestRkeyV1(coverage_head_slot_id)

witness_signature = Sign(
  witness_key,
  "dina-curation-coverage-head-v1" ||
  canonical_coverage_head_without_signature
)
```

The evidence NSID requires `coverage_family: evidence`; the score NSID below
requires `coverage_family: score`. `head_generation` is a checked positive
integer and `head_state_bucket` is a checked non-negative policy-clock bucket.
Generation one uses `head_update_kind: semantic_update` and omits
`previous_head_cid`, both previous-head-transition-proof fields,
`previous_cumulative_chain_status` and `previous_cumulative_conflict_overflow`.
Every successor increments generation exactly once, names the exact prior CID at
the same stable AT URI, carries both transition-proof fields and copies its
cumulative status and overflow flag. Updating this locator is the explicit
exception to immutable evidence record keys: each version is immutable by CID
and remains retrievable through its signed or enclosing retention boundary,
while the stable rkey identifies the live version. Relative to a retained
predecessor or a client's persisted state, a repeated/lower generation, skipped
generation, wrong predecessor CID, two CIDs for one generation or transition
from `conflicted` back to `clean` is rollback/equivocation. Clients persist the
highest accepted `(head_generation, CID)` per slot and reject regressions after
restart.

The transition-proof pair resolves to one closed content-addressed artifact:

```text
coverage_head_transition_proof {
  coverage_head_slot_id
  coverage_family: evidence | score
  policy_hash
  source_manifest_cid
  predecessor_head_uri
  predecessor_head_cid
  predecessor_record_block_cid
  predecessor_record_bytes
  predecessor_repository_commit_cid
  predecessor_mst_path_cid
  predecessor_witness_did_resolution_proof_cid
  transition_proof_schema_version
}
```

The predecessor URI is the same deterministic stable head URI, both predecessor
CID fields equal `previous_head_cid`, and `predecessor_record_bytes` is the
canonical unpadded base64url encoding of that exact record block. Decoding those
bytes and recomputing their content CID must produce
`predecessor_record_block_cid`; padded, alternate-alphabet, non-canonical or CID-
mismatched bytes fail. The signed repository commit plus MST path proves that
exact block occupied the stable rkey in one historical state of the witness
repository.
`predecessor_witness_did_resolution_proof_cid` equals the proof CID inside the
predecessor record; that historical DID proof authenticates its witness signature
and the repository commit key. The predecessor record's
slot, family, policy, source, generation, state bucket, semantic hash and current
cumulative fields must validate and match the successor transition. Recomputing
its semantic hash requires only the predecessor record bytes; the transition
check does not reopen that predecessor's bounded coverage dependencies after
their own retention expires. The successor's current bounded proof independently
establishes its current state.

This is a signed record-level declared-predecessor linkage proof, not repository-
history completeness. In this section, "immediate predecessor" means only the
head the successor declares at generation `n - 1`. The artifact does not prove
that `predecessor_repository_commit_cid` is an ancestor of the current live
repository commit, that no deleted or hidden repository commit intervened, or
that no unobserved sibling head existed at either generation. A client that has
independently retained another valid CID for the same generation still applies
the terminal locator-conflict rule; a fresh verifier without that observation
accepts only the declared linkage and must not label it append-only repository
continuity.

The successor is a signed retention carrier for this transition artifact,
including its inline predecessor record bytes, plus the repository commit, MST
path and DID proof through the successor's own `retention_until`. It does not
recursively extend the predecessor's bounded/conflict dependencies or any earlier
head version. Thus a fresh verifier can verify the declared one-generation
predecessor linkage for a still-current head while both unobserved repository
branches and older generations remain at the explicit accepted-witness-summary
boundary. Missing, mismatched or expired transition bytes make the successor
`head_history_unavailable`; they are never replaced by its copied fields alone.
The family's `coverage_head` typed schema declares the transition-proof CID as a
`zero_or_one` child and the repository commit, MST path and DID proof as exact
children of that artifact. `predecessor_record_block_cid` is a checked scalar,
not a child edge: its bytes are already inside the transition artifact and count
toward that artifact's canonical encoded size. If the same predecessor is also a
catch-up root, it receives only the full coverage-head root schema; the inline
copy creates neither a second CID occurrence nor a conflicting schema assignment.
All transition material therefore remains inside the same per-root and aggregate
block/byte/depth budgets without recursively reopening the predecessor's bounded
proof graph.

Head production uses a closed-bucket cut. A target, interval closure,
finalization or health transition belongs to state bucket `b` exactly when the
accepted witness assigned its canonical observation or transition bucket to
`b`; a source item learned later is never backfilled into an already closed
state bucket. The witness waits until bucket `b` has ended, computes one state
from every eligible item through that cut and, when an update is required,
publishes it in bucket `b + 1` with:

```text
head_state_bucket = b
published_at_bucket = b + 1
```

The witness publishes at most one head version per stable slot and
`head_state_bucket`. `conflicted` dominates `unavailable`, which dominates
`complete`, and every conflict known at the cut is represented by the bounded
complete or overflow proof rather than displaced by a later state. An item first
observed in bucket `b + 1` belongs to that next cut even if its origin payload
claims an earlier time. A verifier that independently proves a conflict after
the prior cut removes current status immediately; the next head makes that fact
portable. It does not continue displaying the earlier head merely because the
portable update is not due until the next closure. Publishing before the state
bucket closes, publishing twice for one cut, splitting same-cut events across
versions or suppressing a conflict known at the cut is equivocation. Health
diagnostics retain their individual event history even though the live locator
is coalesced.

The semantic state is the canonical closed `coverage_head` projection with
exactly these lineage, scheduling and derived fields removed:

```text
head_generation
head_update_kind
head_state_bucket
semantic_state_hash
previous_head_cid
previous_head_transition_proof_ref
previous_head_transition_proof_cid
previous_cumulative_chain_status
previous_cumulative_conflict_overflow
published_at_bucket
retention_until
witness_signature
```

Its hash is:

```text
semantic_state_hash = SHA-256(
  "dina-curation-coverage-head-semantic-state-v1" ||
  canonical_coverage_head_semantic_state
)
```

A changed anchor, bounded/conflict proof CID, cursor, current cumulative value,
status or reason changes that hash; changing the witness key or DID-resolution
proof does likewise. `semantic_update` is valid exactly when generation one is
being created or the hash differs from the retained predecessor. Repeated input
whose coalesced state has the same hash publishes no generation before renewal
is due. `retention_renewal` is valid exactly when the semantic hash is unchanged,
no semantic update exists for that cut and:

```text
head_state_bucket
  = previous_head.head_state_bucket
    + family_maximum_head_generation_gap_buckets
```

If a semantic change occurs in that due bucket it produces one
`semantic_update`, not a second renewal. Every valid successor therefore has a
strictly increasing state bucket no more than the family maximum generation gap
after its predecessor. An early renewal, semantic no-op, over-gap successor or
second same-cut version is invalid. Missing the maximum-gap renewal makes the
old head unavailable when its retention ends; a later record cannot pretend
that the omitted continuity step occurred.

A client with persisted `(generation, CID)` state is not a fresh verifier. When
the live generation is higher, it follows `previous_head_cid` through retained
head versions and repository proofs until it reaches that exact pair. The gap
must be no larger than the family's pinned catch-up-generation limit, every step
must decrement generation exactly once and the aggregate proof must stay inside
the applicable evidence or score live-head resource profile. A missing step,
expired proof, over-limit gap or chain that does not reach the persisted CID is
`head_history_unavailable`; the client removes current status and must not
silently apply fresh-install semantics.

Rebootstrap is an explicit local trust operation, never automatic error
recovery. A fresh installation, user-confirmed rebootstrap or bundled witness-
policy replacement records a new local
`(policy_hash, slot_id, generation, CID, accepted_at_bucket)` trust baseline and
an audit reason. That action accepts the current witness summary with the same
limitations as a fresh verifier and discards the old rollback comparison; UI and
telemetry must not describe it as verified continuity. State corruption,
application restart or an inconvenient catch-up failure cannot trigger it.
Two valid CIDs for one head generation are a verifier-derived terminal locator
conflict. No later head can make either predecessor canonical, so a client does
not accept a purported successor on one branch as repair. It retains or exports
both repository proofs, derives `head_equivocation`, removes current status and
waits for a new witness policy/lineage rather than expecting the conflicted
witness to self-certify recovery. The signed conflict-proof artifact below is
for conflicts inside an otherwise unique coverage-head chain; it cannot cure
equivocation of the live locator itself.

The terminal anchor is a closed union. The four selected-prefix fields are
present or absent together; the raw-head fields are likewise a pair:

- `source_start` has neither pair, omits
  `coverage_through_closed_at_bucket`, sets `cumulative_interval_count = 0` and
  uses `coverage_prefix_hash_0` for evidence or the identical construction with
  `dina-curation-score-coverage-prefix-empty-v1` for score coverage. Its source-cursor set
  exactly equals the manifest source set, each `end_cursor` equals that source's
  `start_cursor`, and every cursor entry uses its authenticated
  `source_start` proof. It is valid only for `unavailable` or `conflicted`, never
  `complete`.
- `finalized_prefix` has the selected-prefix quartet, no raw-head pair, a
  positive cumulative count and a required close bucket. The prefix is the
  latest uncontested, uniquely timely finalization whose cumulative chain state
  is copied through the bounded proof.
- `raw_interval` has the raw-head pair, a positive cumulative count and a
  required close bucket. The selected-prefix quartet is optional and, when
  present, identifies the uncontested finalized base before the contiguous raw
  suffix. Every terminal cursor entry uses a `source_position` proof.

The terminal anchor always means the last uncontested point. A conflicted record
never selects either branch after it. The content-addressed bounded proof
contains the authenticated source starts or the selected prefix, finalization,
live manifest, every contiguous uncontested raw interval and any challenged
prefix bridge needed to reach the terminal anchor. It recomputes the interval
count/hash, optional close bucket and every sorted terminal source cursor.
Field-pair, union-presence, proof-resource and family-specific limits apply
before traversal. This makes a fork or outage before the first closed interval
representable without inventing a raw head.

The conflict-proof pair is present exactly when `coverage_status: conflicted` and
absent otherwise. It resolves to this closed canonical artifact:

```text
coverage_head_conflict_proof {
  coverage_head_slot_id
  coverage_family: evidence | score
  policy_hash
  source_manifest_cid
  last_uncontested_interval_chain_hash
  conflict_set_mode: complete | overflow
  overflow_reason?: list_limit | verification_budget_exhausted |
                    scan_incomplete_after_conflict
  scan_failure?:
    | {
        failure_target_kind: artifact
        traversal_path
        artifact_cid
        failure_class: missing_artifact | invalid_artifact |
                       transport_unavailable | operational_budget_exhausted
      }
    | {
        failure_target_kind: source
        source_id
        last_authenticated_cursor
        last_authenticated_cursor_proof_cid
        failure_class: source_unavailable
      }
  conflicts[] {
    conflict_code
    artifacts[] {
      artifact_uri?
      artifact_cid
      artifact_repository_proof_cid?
    }
  }
  conflict_count
  conflict_set_root
  conflict_proof_schema_version
}
```

`conflict_code` is one of `raw_chain_fork`, `prefix_identity_mismatch`,
`prefix_finalization_equivocation`, `prefix_cumulative_conflict_reset` or
`prefix_chain_fork`. Conflicts and their artifacts use the canonical
ordering, URI-presence and duplicate rules of prefix-finalization conflicts;
repository proof CID is present exactly for a repository-record artifact. Count,
root and Merkle construction use the same functions with head-specific domains
`dina-curation-coverage-head-conflict-empty-v1`,
`dina-curation-coverage-head-conflict-leaf-v1`,
`dina-curation-coverage-head-conflict-node-v1` and
`dina-curation-coverage-head-conflict-root-v1`. The slot, family, policy, source
and last-uncontested chain hash must equal the enclosing head and bounded proof.
The artifact deliberately omits generation so an unchanged terminal conflict
proof can be retained across a valid head-retention renewal; the enclosing signed
head binds its exact CID. At least one fully verified conflict certificate is
required; a missing or incomplete artifact before that first certificate is
unavailability, while a later failure uses `scan_incomplete_after_conflict`.
Head-conflict scanning uses the exact deterministic root/typed-child traversal,
pre-operation budget cutoff, reason/failure presence and retained-set algorithm
defined for prefix finalization. `complete` has no reason or scan failure and contains every conflict
from a completed fixed-state-cut scan. `overflow: list_limit` uses the globally
smallest maximal prefix after a completed scan;
`overflow: verification_budget_exhausted` uses the smallest maximal prefix of
conflicts fully proven before the deterministic cutoff; and
`overflow: scan_incomplete_after_conflict` carries the exact scan-failure
descriptor and smallest maximal prefix proven before that failed occurrence.
All overflow forms require at least one independently sufficient incompatible
pair. The two canonical forms reproduce the same reason, bytes and root for the
same cut/profile; the scan-incomplete form follows the immutable-publication and
accepted-witness boundary above.

The root proves only the retained list; omitted conflicts and the asserted scan
cutoff remain at the accepted-witness boundary, and APIs must not report an exact
omitted count. Both modes set permanent conflict state because the retained pair
proves conflict independently; overflow never falls back to recoverable
`unavailable` merely because every branch cannot be scanned or fit. Root size,
retained conflict count and transitive traversal are bounded by the family's
pinned head-proof resource limits. On complete fixed-cut replay, a wrong reason,
late/early cutoff, non-maximal/non-prefix retained selection or retry-variant
bytes is invalid. A bounded-only verifier checks the retained proof and applies
the witness-assertion boundary above. Canonical or declared scan failure before one
complete conflict is proven, or inability to fit that first conflict, is
unavailability; any such failure after it is proven remains terminal
conflict.
`raw_chain_fork` maps to the same-named head reason; every other head-conflict
code maps to `prefix_conflict`.

The head's cumulative overflow flag is derived, never declared independently:

```text
cumulative_conflict_overflow =
  previous_cumulative_conflict_overflow_if_present
  || selected_prefix_finalization.cumulative_conflict_overflow_if_present
  || conflict_proof.conflict_set_mode == overflow
```

Generation one treats the absent previous value as false. A successor copies the
prior current value into its previous field, and `true -> false` is invalid.

`status_reason_codes` is a sorted duplicate-free subset of
`missing_artifact`, `overdue_interval`, `clock_unavailable`, `source_unavailable`,
`repository_rollback`, `raw_chain_fork`, `prefix_conflict`, `conflict_overflow`
and `policy_limit`.
`complete` requires no reasons, no conflict proof, a complete bounded proof,
`cumulative_conflict_overflow = false`, a
clean current cumulative status and, when present, a clean previous cumulative
status. `conflicted`
requires a fully verified non-empty conflict proof, includes at least one of
`raw_chain_fork` or `prefix_conflict` in its reasons and changes
`cumulative_chain_status` permanently to `conflicted`. `unavailable` requires at
least one non-conflict availability reason, omits the conflict proof and may
later recover only while the cumulative status remains clean. A selected prefix
with positive cumulative finalization conflicts forces `prefix_conflict` and
`conflicted`; a later clean prefix cannot reset it.
`conflict_overflow` is present exactly when cumulative overflow is true. It is a
terminal conflict reason, not the non-conflict `policy_limit` availability case,
and remains visible in every later head in that lineage.

Checked timing and base retention are:

```text
published_at_bucket = head_state_bucket + 1

if coverage_anchor_kind != source_start:
  coverage_through_closed_at_bucket <= head_state_bucket

if coverage_status == complete:
  coverage_anchor_kind != source_start
  published_at_bucket
    <= coverage_through_closed_at_bucket
       + family_coverage_checkpoint_interval_buckets

retention_until = max(
  every bounded- or conflict-proof dependency's effective retention boundary,
  published_at_bucket
    + family_coverage_checkpoint_interval_buckets
    + family_challenge_window_buckets,
  published_at_bucket
    + family_maximum_head_catchup_generations
      * family_maximum_head_generation_gap_buckets
    + family_challenge_window_buckets
)

at verification bucket v for a current head:
  head_state_bucket < v
  published_at_bucket <= v
  v < retention_until
```

Here the family fields mean `coverage_checkpoint_interval_buckets` and
`challenge_window_buckets` for evidence, and their `score_` counterparts for
score coverage; the two family head fields likewise select the evidence or score
catch-up-generation and maximum-generation-gap policy fields. The multiplication
uses checked arithmetic. Because every valid lineage publishes a semantic or
renewal generation no later than that maximum gap, the floor keeps a version
available until `K` later generations can exist even when semantic updates are
sparse. The witness retains each version's repository proof, bounded proof,
conflict proof and every transitive dependency through the version's resulting
`retention_until`; a head cannot claim a longer boundary while allowing the
proof needed to verify it to expire earlier. An enclosing score checkpoint may
extend those exact bytes further through that score's replay boundary.
The current head additionally extends only its declared predecessor-linkage
bytes as defined above. `v` is derived from the verifier's pinned policy clock,
not copied from a response or witness record. A future-dated state cut,
future-dated publication, expired current head or unavailable/rolled-back policy
clock removes current status. In particular, a repository record visible during
bucket `b` cannot claim the still-open state cut `b` and publication bucket
`b + 1`.

To establish *latest*, a scorekeeper or client resolves the stable head URI
directly against the live PDS endpoint authenticated by the policy-pinned witness
DID and its compatible current DID-resolution proof, obtains that endpoint's
current signed repository commit and MST path for the slot, and verifies the
repository key and record signature. A cached
or presenter-supplied older repository commit is historical proof only. Failure
to contact the pinned endpoint, authenticate its current commit or reconcile it
with the locally persisted generation is `source_unavailable` or
`repository_rollback`, never permission to choose another head. This is a live
statement by the accepted witness, not proof that no event exists outside its
pinned upstream source.

A fresh verifier does not infer an independently replayed generation history
from a large `head_generation` value alone. For `head_generation > 1`, it opens
the current head's declared-predecessor linkage proof and validates that
predecessor record, update kind, semantic-hash relation and generation/state-
bucket step. That validation does not establish repository-commit ancestry or
the absence of an unobserved sibling. A
valid generation-one head has no predecessor or transition proof; after validating
its current repository and bounded coverage proofs, the verifier records it as
the initial baseline. For later generations, it verifies every older
predecessor version still required by retention and otherwise treats history
before the declared predecessor's copied cumulative boundary as the accepted
witness's signed summary of expired head history. Persistent clients can
additionally detect rollback against their own highest accepted generation. This
is the same explicit witness-summary boundary used for expired raw coverage, not
a claim of globally append-only head storage or repository-commit continuity.
After accepting that summary, the
fresh verifier records the current pair as its durable baseline and follows the
persisted-client catch-up rule thereafter.

A complete bounded coverage proof is therefore the live current-repository proof
for the deterministic head slot plus the exact bounded proof it names: the latest
unexpired prefix with a unique timely `valid`, cumulatively clean finalization,
its live-dependency manifest and the contiguous raw suffix after it, or the full
bounded raw path before finalization. A prefix is a bounded replay anchor, not renewed evidence:
expired members remain excluded and their former values cannot be reconstructed
from or credited through the accumulator root. If a prefix or finalization is
missing, forked, late, expired without a successor, over limit or inconsistent
with the suffix, or if the live head cannot be authenticated, coverage is
unavailable. This keeps verification bounded while
preserving all evidence that can still affect a current score.
For a conflicted head, the last-uncontested bounded path and complete conflict
proof replace this complete-path requirement and keep coverage unavailable; for
an unavailable head, the bounded path may stop at the last verifiable anchor and
the stated non-conflict reason remains fail-closed.

`coverage_membership_artifact_cid` resolves to one canonical artifact containing
all interval members. Entries sort first by `entry_class` (`public_target` before
`evidence_event`), then public targets by `(source_id, source_cursor, member_type,
target_uri, target_cid)` and evidence-event entries by `(member_type,
event_id_or_diagnostic_id, source_positions_hash)`. They use one of these closed
projections:

```text
public_target_entry {
  member_type: authority_grant | authority_revocation | commitment |
               outcome | discipline | witness_policy_successor
  target_uri
  target_cid
  source_id
  source_cursor
  source_position_proof_ref
  source_position_proof_cid
  disposition: authority_observation | commitment_checkpoint |
               outcome_checkpoint | discipline_checkpoint |
               policy_successor_observation | refusal
  artifact_uri?
  artifact_cid
}

evidence_event_entry {
  member_type: complete_evidence_event | incomplete_event_diagnostic
  event_id?       # required only for complete_evidence_event
  diagnostic_id?  # required only for incomplete_event_diagnostic
  canonical_target_set_hash? # required only for complete_evidence_event
  observed_target_set_hash?  # required only for incomplete_event_diagnostic
  source_positions_hash
  artifact_uri?
  artifact_cid
}
```

Every public-target position proof and every enclosing source-range proof is
required, resolves under the source's pinned authentication profile and must agree
on source ID, cursor and manifest. A target outside every proven half-open range,
a cursor copied without its position proof or a range frontier lacking its
authentication proof is `coverage_unavailable`. The witness signature authenticates
the disposition; it is not a substitute for the upstream position/range proof.

A `witness_policy_successor` target with a non-refusal disposition opens this
canonical signed artifact:

```text
policy_successor_observation {
  policy_successor_slot_id
  candidate_policy_uri
  candidate_policy_cid
  candidate_witness_policy_hash
  predecessor_witness_policy_hash
  candidate_policy_sequence
  candidate_activation_bucket
  source_manifest_cid
  source_id
  source_cursor
  source_position_proof_ref
  source_position_proof_cid
  observed_at_bucket
  witness_did
  witness_key_id
  witness_did_resolution_proof_cid
  witness_policy_hash
  policy_successor_observation_schema_version
  witness_signature
}

witness_signature = Sign(
  witness_key,
  "dina-curation-policy-successor-observation-v1" ||
  canonical_policy_successor_observation_without_signature
)
```

The repository form is
`com.dinakernel.curation.policySuccessorObservation`; its AT URI author and
repository proof must derive to `witness_did`. An offline form is not accepted
when `required_policy_successor_proof` requires repository publication.

The observation proves source membership and witness handling, not candidate
uniqueness or compatibility by itself. Its predecessor policy, source ID/cursor,
slot and candidate URI/CID/hash must match the membership entry and independently
opened policy record. `witness_policy_hash` must equal
`predecessor_witness_policy_hash`; the observation cannot be signed under one
coverage policy while naming another as the successor-slot owner. A proof-bearing
refusal remains in the candidate prepass;
its reason cannot remove an intrinsically valid successor from the complete set.
For the authenticated `utc_time_position_v1` candidate position:

```text
candidate_source_bucket = floor(source_time_us / 3_600_000_000)

successor_disposition_deadline_exclusive = candidate_source_bucket + 1
  + maximum_policy_successor_observation_delay_buckets
```

Every required witness's observation or proof-bearing refusal must have
`observed_at_bucket < successor_disposition_deadline_exclusive`, using checked
arithmetic. A late disposition remains retained health evidence and cannot erase
the candidate, but it does not satisfy the scheduled transition; the slot is
`policy_transition_unavailable` rather than silently extending the predecessor.
The slot closure and every later policy-transition proof bundle retain these
observation/refusal bytes, source proofs and candidate repository proofs through
their respective replay boundaries.

Each required witness's dedicated slot closure has this canonical repository
form:

```text
policy_successor_slot_closure {
  policy_successor_slot_id
  predecessor_witness_policy_hash
  source_manifest_cid
  source_id
  slot_start_cursor
  slot_end_cursor
  source_range_proof_ref
  source_range_proof_cid
  slot_membership_artifact_ref
  slot_membership_artifact_cid
  slot_membership_count
  processed_candidate_target_root
  successor_observation_root
  refusal_root
  closed_at_bucket
  retention_until
  witness_did
  witness_key_id
  witness_did_resolution_proof_cid
  witness_policy_hash
  slot_closure_schema_version
  witness_signature
}
```

The membership artifact contains exactly the `public_target_entry` projection for
every fixed-collection source target in `slot_range`, including each target's
position proof and disposition artifact. Entries and subset roots use the coverage
Merkle rules below with slot-specific domain labels. The closure's witness and
policy must be one of the predecessor's exact required-coverage witnesses and
`witness_policy_hash == predecessor_witness_policy_hash`. Its source range and
range proof must equal the policy-derived slot boundaries. The repository author
must derive to `witness_did`, and the signature domain is
`dina-curation-policy-successor-slot-closure-v1`.

Every disposition must satisfy its candidate-specific deadline, and the closure
itself must satisfy `closed_at_bucket < policy_new_work_until_bucket`. Its exact
exclusive storage boundary is:

```text
retention_until = max(
  policy_completion_until_bucket
    + standing_evidence_retention_buckets
    + challenge_window_buckets,
  closed_at_bucket + 1
    + standing_evidence_retention_buckets
    + challenge_window_buckets
)
```

Anyone can assemble the immutable successor-slot proof from those signed
closures. It proves the closed candidate set before the boundary; it is not an
activation-time proof and cannot by itself show that the boundary has passed:

```text
policy_successor_slot_proof_bundle {
  slot_proof_bundle_schema_version
  policy_successor_slot_id
  predecessor_witness_policy_hash
  source_manifest_cid
  source_id
  slot_start_cursor
  slot_end_cursor
  required_witness_closures[] {
    witness_did
    closure_uri
    closure_cid
    closure_repository_proof_cid
    slot_membership_artifact_cid
    historical_witness_did_resolution_proof_cid
  }
  successor_candidate_publications[] {
    candidate_policy_uri
    candidate_policy_cid
    candidate_witness_policy_hash
    source_cursor
    source_position_proof_cid
    candidate_repository_proof_cid
  }
  valid_successor_policy_hashes[]
  successor_candidate_set_hash
  slot_proof_bundle_root
}

slot_proof_bundle_root = SHA-256(
  "dina-curation-policy-successor-slot-proof-bundle-v1" ||
  canonical_slot_proof_bundle_without_root
)
```

Closures sort by witness DID, publications by `(candidate_witness_policy_hash,
candidate_policy_uri, candidate_policy_cid)` and valid hashes by bytes. The
closure witness set must exactly equal `required_coverage_witness_dids`. Every
closure must prove the same complete source range; the publication list is the
exact URI/CID union across their membership artifacts. Any range disagreement,
missing position/range proof, undecidable disposition or closure at or after the
predecessor's exclusive new-work boundary is `policy_transition_unavailable`.
The intrinsic predicate derives the valid set and set hash; zero, one and
multiple-hash handling follows the terminal rules above. This bundle alone
authorizes the selected policy at the new-work boundary. It does not prove
predecessor drain completion or make a cross-policy score current.

An incomplete event is not assigned the canonical `event_id` of an event whose
target set is not yet proven. Its content-addressed signed diagnostic artifact
uses this closed projection:

```text
incomplete_event_diagnostic {
  diagnostic_id
  candidate_event_type
  service_uri?
  behavior_epoch?
  operator_did?
  observed_target_set[]
  missing_requirement_codes[]
  source_positions[] {
    source_id
    source_cursor
    source_position_proof_ref
    source_position_proof_cid
  }
  first_detected_at_bucket
  witness_did
  witness_key_id
  witness_did_resolution_proof_cid
  witness_policy_id
  witness_policy_version
  witness_policy_hash
  diagnostic_schema_version
  witness_signature
}

diagnostic_id = SHA-256(
  "dina-curation-incomplete-event-diagnostic-id-v1" ||
  canonical_diagnostic_without_id_and_signature
)

witness_signature = Sign(
  witness_key,
  "dina-curation-incomplete-event-diagnostic-v1" ||
  canonical_diagnostic_without_signature
)
```

Observed targets, missing-requirement codes and source positions are canonically
sorted and bounded by the witness policy. The artifact is witness-health data,
not a portable event or curator-quality claim. Its membership entry uses
`diagnostic_id`; only a later complete proof may create the separately derived
canonical `event_id`.

Every entry leaf and root is domain-separated:

```text
coverage_member_leaf = SHA-256(
  "dina-curation-coverage-member-v1" || canonical_coverage_member
)

CoverageSubsetRootV1(label, leaves) = SHA-256(
  "dina-curation-coverage-root-v1" || label ||
  MerkleRootV1(canonically ordered leaves)
)

processed_target_root = CoverageSubsetRootV1(
  "processed-targets", public_target_entry leaves
)

MerkleRootV1([]) = SHA-256("dina-curation-coverage-empty-v1")
MerkleParentV1(left, right) = SHA-256(
  "dina-curation-coverage-node-v1" || left || right
)
```

`checkpoint_root`, `refusal_root`, `complete_event_root` and
`incomplete_event_diagnostic_root` use `CoverageSubsetRootV1` over their
canonically selected entry subsets with fixed labels matching those field names. V1
duplicates the final node when a level has an odd count. The conformance vectors
freeze zero-, one-, odd- and even-member trees; implementations cannot substitute
a library-default Merkle convention.

The verifier resolves the membership artifact, checks its CID, requires
`coverage_membership_count` to equal its entry count and recomputes every root
and `processed_target_counts_by_type`. Every source target in a closed interval
must appear exactly once under a valid checkpoint/observation or signed refusal;
every completely proven covered evidence event appears under the event root.
Missing, duplicate, overlapping, reordered or forked intervals or membership
entries are explicit witness equivocation or coverage failure. A root without
the retained membership artifact is not replayable coverage.
Its exclusive retention boundary is computed exactly as:

```text
retention_until = max(
  every member artifact's fixed retention_until, when present,
  closed_at_bucket + 1
    + max(
        maximum_registry_evaluation_horizon_buckets,
        lifecycle_tombstone_retention_buckets
      )
    + standing_evidence_retention_buckets
    + challenge_window_buckets
)
```

A witness may compact an interval only when that interval, its membership
artifact and all transitive proof bytes remain under signed storage promise
through the prefix's exclusive finalization deadline. The policy's prefix cadence
and maximum finalization delay must make that possible under the minimum formula
above. A policy whose numeric fields cannot satisfy this inequality is invalid;
a late witness retains the raw chain and reports coverage unavailable rather than
publishing an unauditable prefix.

A grant-authority observation with
`retention_mode: dependent_commitment` has no fixed member boundary. The witness
retains it and its proof bundle through this enclosing coverage boundary; every
later commitment or discipline checkpoint that depends on it then carries the
longer evidence-specific retention promise. It is never treated as zero or
silently omitted from the membership artifact.

The coverage signature is a storage promise for both the membership artifact and
every member artifact/proof it names through `retention_until`, even when a
member's own boundary is shorter or absent. This extended storage does not extend
that member's scoreability; it only keeps the coverage decision replayable.
Incomplete-event diagnostics use the enclosing coverage record as their signed
retention carrier. The witness includes all of these bytes in archive export and
hand-off manifests. Member `artifact_cid` values resolve to the canonical
checkpoint, observation, refusal or diagnostic payload and its required proof
bundle; a database row or root alone is insufficient.

Per-witness processing deadlines are service-level coverage obligations, not
portable event clocks. Authority, commitment, outcome, discipline and scheduled
policy-successor deadlines start when
the target first appears at that witness's declared source cursor; an evidence-
event deadline starts when that witness has ingested the final target needed for
the complete event proof; and the permit-response deadline starts after an
authenticated, bounded request passes cheap local validation. The witness records
those anchors under its policy clock in the signed coverage chain. A missed
deadline is observable witness-health evidence and may leave the operation
unavailable, but it cannot fabricate or replace an authority, commitment,
outcome, discipline, policy-successor or evidence-event observation bucket. The witness must close an interval
within `coverage_checkpoint_interval_buckets`; silence or a broken chain is
reported as `coverage_unavailable`, never as exhaustive success.

The concrete witness DID and policy hash are pinned in the client/protocol
release, not fetched from an untrusted discovery response. The policy provides
verifiable ordering but not organizational independence. A user or later
scorekeeper may select a stricter policy with independent witnesses. The
reference Phase 1C scorekeeper accepts valid Phase 1B outcomes created under the
pinned preview policy so introducing scoring does not strand earlier evidence.
Quorum one is also a hard liveness and censorship dependency. Until independent
witnesses exist, the first-party witness can delay or suppress a scoreable public
outcome by selectively refusing its commitment checkpoint, private publication
permit or published-outcome checkpoint, even though the recommendation and
private outcome remain locally usable.

A checkpoint is normally a witness-authored
`com.dinakernel.curation.commitmentCheckpoint` record in the witness's own PDS
repository. Its URI, CID, repository proof and signature travel together. An
offline proof bundle may carry the same canonical signed payload, but the
active witness policy decides whether non-repository witnesses qualify.
The complete checkpoint proof embedded in an outcome contains the canonical
checkpoint payload above, `witness_signature`, and, when the policy requires
repository publication, the checkpoint record URI/CID and repository inclusion
proof. Versioned witness DID/key evidence may travel inline or through the
content-CID bound by `witness_did_resolution_proof_cid`; the accepted witness
archive retains it through the same `retention_until`. Embedding the signed
checkpoint payload while content-addressing large proof material keeps the
outcome bounded without reducing it to a non-portable checkpoint CID.
The referenced commitment proof bundle contains the commitment record block,
signed operator-repository commit, MST inclusion path and versioned DID/key
resolution proof plus the exact authority-grant record block and its repository
proof, complete accepted grant-observation quorum and every ordinary transition
artifact needed to establish that authority before its boundary. A new verifier
must not depend on the operator or witness PDS retaining either historical
revision.

A witness signs only after verifying repository authorship, immutable
references, runtime authorization and, for a batch, availability and digest of
the complete leaf artifact. Every outcome carries the complete canonical
commitment-checkpoint payload, witness signature and bound inline or
content-addressed versioned witness-key evidence in its signed payload. A
checkpoint URI or CID may also be included as a locator, but a CID alone is not
proof and is rejected by the V1 verifier. This makes the outcome signature
dependent on evidence that did not exist before public observation and keeps
replay independent of the witness repository retaining the checkpoint record.
Each witness keeps one immutable checkpoint per
`(witness_policy_hash, commitment_uri, commitment_cid)`. An idempotent retry is
byte-identical; another bucket or proof bundle for that key is witness
equivocation. The same record CID published under another AT URI is a distinct
observation target and cannot inherit the earlier URI's bucket.

The portable commitment-observation bucket is the q-th earliest valid
`observed_at_bucket` from distinct accepted witnesses, where q is
`commitment_observation_quorum`. The q-th bucket must be no more than
`maximum_commitment_observation_quorum_delay_buckets` after the earliest included
bucket. A later subset cannot replace a slow or incomplete quorum merely because
its timing is more favorable.

V1 treats `retention_until` as an exclusive UTC bucket boundary. For each
commitment checkpoint it is computed exactly as:

```text
commitment_retention_base_bucket = max(
  window_end_bucket,
  observed_at_bucket + 1 +
    maximum_commitment_observation_quorum_delay_buckets
)

retention_until = commitment_retention_base_bucket
  + maximum_registry_evaluation_horizon_buckets
  + standing_evidence_retention_buckets
  + challenge_window_buckets
```

The accepting witness stores or replicates the complete bundle under its content
CID through that boundary. The signed commitment window and checkpoint bucket
are public, so the witness derives the value without seeing a response preimage.
`retention_until` is immutable once signed. V1 evidence cannot remain scoreable
beyond it, and a URI/CID without retrievable proof-bearing content is not a valid
checkpoint. A later renewal protocol requires separate signed lineage and
conformance rules.

When a receipt is disclosed, let `r` be its runtime-signed response issuance
bucket and `c` the portable commitment-observation bucket. The verifier derives:

```text
evaluation_anchor_bucket = max(r, c)
```

This is the public evaluation clock used by permits and outcome horizons. The
response bucket remains useful private semantics, but a curator and requester
cannot manufacture elapsed public time by backdating it before the commitment
was witnessed. Policies may require multiple independent witnesses; they must
publish accepted witness and quorum rules.

An accepted witness policy defines deterministic validation, coverage, clock and
deadline rules. Its accepted outcome-policy registry and rule for using each
policy's `evaluation_bucket_seconds`, named clock source, uncertainty limit and
rollback behavior are pinned inputs, not mutable witness configuration. Clock
uncertainty above the limit or a rollback fails closed and produces an auditable
witness-health state; the witness must not issue a guessed permit or first-seen
bucket. A rotation-capable witness consumes every authority grant, authority
revocation, commitment, curation outcome, discipline record, witness-policy
successor candidate and covered invalidation or lifecycle-deletion proof set in
its declared source ranges. For each valid public
record it publishes the Section 5.3 authority observation or corresponding
commitment, outcome or discipline checkpoint; for each invalid record it
publishes a signed, reason-coded refusal. A lifecycle-root candidate that is
intrinsically valid but collides with another revision-one candidate remains a
candidate regardless of whether that witness checkpointed it before learning of
the collision or emitted the proof-bearing lifecycle refusal defined below. It publishes an
evidence-event checkpoint for each complete proven event; an incomplete candidate
remains a coverage/health diagnostic rather than being promoted to a canonical
event. Grant activation and
ordinary rotation require the portable authority-observation quorum before the
declared boundary; repository time alone cannot establish that ordering. Source
cursors, commitment sequence ranges and canonical event target sets make
unexplained gaps observable. A timeout remains an availability failure rather
than cryptographic proof of censorship, but the reference client records it
locally and never substitutes repository timestamps or an unaccepted witness.
Selective non-signing is a witness-policy violation and is reported separately
from curator standing.

A signed witness refusal is normally published as a witness-authored
`com.dinakernel.curation.witnessRefusal` record and contains:

```text
target_type: authority_grant | authority_revocation | commitment | outcome |
             discipline | witness_policy_successor
target_uri
target_cid
target_proof_bundle_cid?
source_id
source_cursor
source_position_proof_ref
source_position_proof_cid
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_hash
reason_code
observed_at_bucket
validated_target_retention_until?
retention_until
refusal_schema_version
witness_signature
```

The refusal signature uses
`dina-curation-witness-refusal-v1 ||
canonical_witness_refusal_without_signature`.

Reason codes are bounded to deterministic policy failures such as
`invalid_repository_proof`, `invalid_authority_lineage`, `revoked_authority`,
`unauthorized_runtime`, `unavailable_artifact`, `unsupported_schema` and
`policy_limit`; successor-specific reasons are `invalid_policy_successor` and
`outside_successor_nomination_window`, plus
`lifecycle_root_conflict_candidate` for an intrinsically
valid revision-one outcome or discipline record that collides with another root
candidate. A refusal does not make an outcome scoreable. An independently
valid authority, commitment, outcome, discipline or policy-successor target paired with a policy refusal, or a
missing refusal after the applicable deadline, is evidence about witness
coverage rather than curator quality.

`target_proof_bundle_cid` is required when enough target material exists to
authenticate the repository author and envelope; it is absent only for a bounded
reason such as `unavailable_artifact` or `invalid_repository_proof` where no
complete bundle can exist. `validated_target_retention_until` is present only
when the target and its own signed retention field were fully validated before a
later policy failure. A `lifecycle_root_conflict_candidate` refusal always carries
the complete repository-authenticated target and intrinsic-proof bundle. That
reason is a diagnostic statement about the witness's decision, not authority over
root-set membership: any refusal whose retained target proof independently passes
the closed intrinsic candidate predicate contributes the same candidate. A bare
URI/CID, unavailable proof or intrinsically invalid target cannot enter a root
set under any reason code. A refusal's exclusive boundary is exact:

```text
refusal_quorum_delay_buckets = max(
  maximum_authority_observation_quorum_delay_buckets,
  maximum_commitment_observation_quorum_delay_buckets,
  maximum_outcome_observation_quorum_delay_buckets,
  maximum_discipline_observation_quorum_delay_buckets,
  maximum_policy_successor_observation_delay_buckets
    when target_type == witness_policy_successor
)

refusal_base_retention_until = observed_at_bucket + 1
  + refusal_quorum_delay_buckets
  + max(
      maximum_registry_evaluation_horizon_buckets,
      lifecycle_tombstone_retention_buckets
    )
  + standing_evidence_retention_buckets
  + challenge_window_buckets

retention_until = max(
  refusal_base_retention_until,
  validated_target_retention_until if present
)
```

The witness retains the canonical refusal record, source locator evidence and
every available target-proof byte through that boundary. The enclosing coverage
record may impose a later storage boundary but cannot make the refused target
valid or extend its evidence eligibility.

**Portable evidence-event ordering.** Some security-relevant facts become
provable only after records from several repositories are joined. Repository
cursors cannot order those facts globally. An accepted witness therefore signs a
canonical `com.dinakernel.curation.evidenceEventCheckpoint` for every proven
curator-controlled invalidation and lifecycle deletion covered by its policy:

```text
event_id
event_type: authority_invalidation | receipt_commitment_conflict |
            terminal_disposition_conflict | operator_commitment_deletion |
            lifecycle_record_deletion
service_uri
behavior_epoch?
operator_did?
canonical_target_set[] {
  target_type
  target_uri
  target_cid
}
event_proof_bundle_ref
event_proof_bundle_cid
source_positions[] {
  source_id
  source_cursor
  source_position_proof_ref
  source_position_proof_cid
}
first_observed_at_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_hash
event_checkpoint_schema_version
witness_signature
```

The identifier and signature are domain-separated. The event identity projection
contains every semantic join key, not only the target set:

```text
event_identity_projection = {
  event_type, service_uri, behavior_epoch?, operator_did?,
  canonical_target_set
}

event_id = SHA-256(
  "dina-curation-evidence-event-id-v1" ||
  canonical_event_identity_projection
)

witness_signature = Sign(
  "dina-curation-evidence-event-checkpoint-v1" ||
  canonical_event_checkpoint_without_signature
)
```

The target set is sorted canonically and contains every URI/CID required to
prove the event. Event-specific proof rules are frozen in the witness policy:

- `authority_invalidation` contains the complete accepted authority grant,
  revocation, fork and authority-observation artifacts that make the lineage
  invalid.
- `receipt_commitment_conflict` contains both runtime-signed receipt projections,
  both operator commitments and their complete commitment checkpoints.
- `terminal_disposition_conflict` contains the runtime-signed response receipt,
  signed decline and every public proof needed to bind both to one request.
- `operator_commitment_deletion` contains the retained witnessed commitment and
  the complete signed operator-repository transition proving its removal.
- `lifecycle_record_deletion` contains the verified outcome or discipline head
  and the complete signed attester-repository transition proving its removal.

A Jetstream event, local ingestion time or one repository cursor is only a
locator and cannot fill `first_observed_at_bucket`. Each witness has one immutable
checkpoint per `(witness_policy_hash, event_id)`; two signed buckets or proof
bundles are witness equivocation. Repository publication is required when the
policy requires it, and record authorship must resolve to `witness_did`.

The portable event bucket is the q-th earliest valid bucket from distinct
accepted witnesses, where q is `evidence_event_observation_quorum`. A quorum is
valid only when its q-th bucket is no more than
`maximum_evidence_event_observation_quorum_delay_buckets` after its earliest
included bucket. Every reference score input that changes standing because of one of
these events includes the complete checkpoint quorum and proof bundle. If the
quorum is incomplete, the event may still fail ordinary cryptographic
eligibility, but the scorekeeper publishes `invalidation_order_unresolved` and
must not publish a more favorable standing result until portable ordering is
available.

Each event checkpoint uses the exact exclusive-boundary formula:

```text
event_local_retention_until = observed_at_bucket + 1
  + maximum_evidence_event_observation_quorum_delay_buckets
  + max(
      standing_evidence_retention_buckets,
      lifecycle_tombstone_retention_buckets
    )
  + challenge_window_buckets

retention_until = max(
  event_local_retention_until,
  every applicable target proof's fixed signed retention_until, when present
)
```

The quorum-delay padding guarantees that every member of a timely selected
quorum remains available through the portable q-th bucket's required window.
The event checkpoint retains dependent-retention authority observations and
their proof bytes through this computed boundary even though those observations
do not carry an independent `retention_until`.

**Private outcome-publication permit.** A post-publication observation cannot by
itself prove that an outcome was not constructed too early: a delayed witness
might first see an old record after the minimum interval. After the user confirms
the exact private permit request and frozen public outcome core, Dina therefore
requests a private, one-use permit from the witness quorum before publishing.
The request carries the complete receipt, commitment checkpoint, selected item
proof, canonical outcome core and, for an amendment, the complete active
predecessor outcome/checkpoint proof, but not the private query or rationale. It
is signed by the receipt-bound requester. Each witness verifies those bindings and
issues a canonical permit only when its conservative current-bucket lower bound
satisfies the policy minimum:

```text
permit_request_projection = {
  permit_request_id, permit_request_nonce,
  receipt_id, recipient_binding, requester_signing_key_id,
  requester_did_resolution_proof_cid,
  interaction_nullifier, outcome_core_hash,
  receipt_proof_hash, item_proof_hash,
  lifecycle_action, revision_number,
  supersedes_outcome_uri?, supersedes_outcome_cid?,
  superseded_outcome_proof_hash?,
  commitment_checkpoint_set_hash,
  portable_commitment_observation_bucket,
  evaluation_anchor_bucket,
  witness_policy_lineage_id, witness_policy_hash,
  issued_at_bucket, expires_at_bucket
}

permit_request_signature = Sign(
  "dina-curation-outcome-permit-request-v1" ||
  canonical_permit_request_projection
)

permit_request_id = SHA-256(
  "dina-curation-outcome-permit-request-id-v1" ||
  recipient_binding || permit_request_nonce || outcome_core_hash ||
  witness_policy_hash
)

permit_request_hash = SHA-256(
  "dina-curation-outcome-permit-request-hash-v1" ||
  canonical_permit_request_projection
)
```

The attachment hashes bind the exact canonical receipt, item, commitment
checkpoint and optional superseded-outcome proofs without publishing them. The
short request lifetime uses the same half-open V1 bucket rule and must satisfy:

```text
0 < expires_at_bucket - issued_at_bucket
expires_at_bucket - issued_at_bucket
  <= maximum_permit_request_lifetime_buckets
```

The witness's current policy-clock bucket must be inside that interval. A
witness verifies the request ID, requester key proof and every attachment digest
before considering timing or signing the permit:

```text
permit_request_id
permit_request_hash
receipt_id
commitment_uri
commitment_cid
response_commitment
recipient_binding
service_uri
scope_id
behavior_epoch
outcome_policy_id
outcome_schema_version
claim_id
subject_ref_hash
interaction_nullifier
outcome_core_hash
lifecycle_action
revision_number
supersedes_outcome_uri?
supersedes_outcome_cid?
response_issued_bucket
portable_commitment_observation_bucket
evaluation_anchor_bucket
permit_issued_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_lineage_id
witness_policy_hash
permit_schema_version
witness_signature
```

The permit signature projection is exact:

```text
witness_signature = Sign(
  witness_key,
  "dina-curation-outcome-publication-permit-v1" ||
  canonical_permit_without_signature
)
```

The witness independently derives the portable commitment and evaluation-anchor
buckets from the complete checkpoint quorum and rejects copied values. It
recomputes `permit_request_hash` from the complete canonical request projection,
verifies the receipt-bound requester signature and binds both the request ID and
hash into its signed permit.

Each witness maintains three distinct durable states:

```text
receipt_binding_key =
  (witness_policy_lineage_id, witness_did, receipt_id)

outcome_core_slot =
  (witness_policy_lineage_id, witness_did, interaction_nullifier,
   lifecycle_action, revision_number)

permit_decision_key =
  (witness_policy_hash, witness_did, permit_request_hash)
```

After complete requester, receipt, commitment and proof validation, but before
the minimum-delay decision, the witness atomically reserves `receipt_binding_key`
for the exact `(commitment_uri, commitment_cid, response_commitment,
recipient_binding)` tuple. A valid but too-early request persists only that
binding and returns a signed retryable `not_before_bucket`; it does not reserve
`outcome_core_slot`. An invalid or unauthenticated request reserves nothing.
Cancellation after a validated request does not erase the receipt binding.

When the request is mature, the witness atomically reserves
`outcome_core_slot -> outcome_core_hash` before signing. The same slot and core
are idempotent; another core for that slot receives a signed
`conflicting_outcome_core` refusal. An amendment uses its next revision slot only
after the complete active-predecessor proof passes the rules below. The permit
decision is then immutable per `permit_decision_key`: retrying the same signed
request returns byte-identical permit bytes.

While the active policy admits new work, a fresh, non-expired request for the
exact same slot and core must receive a new permit bound to its new request
ID/hash when every ordinary validation, maturity and clock check passes; the
prior same-core permit is not a refusal reason. This
does not create another outcome right: every permit still authorizes the same
lifecycle slot and core, and the public outcome consumes that slot once. It lets
every witness converge on one fresh request after an earlier request expired with
only a partial quorum. The client durably retains old requests and permits but
forms any one quorum from permits that all bind the same request ID/hash.

A different receipt tuple receives a signed `conflicting_receipt_binding`
refusal. Any multi-witness publication-permit policy must require intersecting
quorums, so two complete quorums cannot bind different tuples or cores unless at
least one witness has equivocally double-signed. For a fixed accepted set of `n`
witnesses and threshold `q`, V1 validates this as `2q > n`; a later
consensus-backed policy must specify an equivalent intersection proof.
If that happens, both proof sets and the witness equivocation remain visible and
the curator-controlled conflict is processed under Section 10.8 rather than
being used to discard the less favorable outcome.

A valid scheduled successor policy in the same lineage does not erase receipt or
core reservations. Every continuing witness preserves that durable state across
the activation boundary so a conflicting tuple or core remains detectable. State
continuity is anti-replay evidence, not authorization to renew old work.

The scheduled baseline permits a successor to authorize only a receipt whose
runtime-signed response issuance bucket is at or after the successor's activation
bucket. It never re-witnesses a predecessor commitment for a new permit, never
substitutes a successor observation bucket for the original portable commitment
bucket and never derives a fresh retention promise for that interaction. A
pre-activation receipt therefore has exactly two outcomes:

1. An outcome already published at a canonical pinned-source position below its
   deterministic cutover cursor, with a complete predecessor permit quorum already
   embedded, may finish checkpoint/refusal and coverage processing during the
   signed drain interval. The predecessor issues no permit and admits no new
   public target during drain. Its remaining signatures occur strictly before
   `policy_completion_until_bucket`.
2. Otherwise the user obtains a newly authorized curator request and response
   under the successor. That response uses a new request hash, receipt ID,
   commitment, interaction nullifier and evaluation clock. An unpublished
   receipt, incomplete predecessor permit quorum or outcome at or above the
   canonical cutover cursor is stranded rather than converted into successor
   authority.

An outcome authorized under the successor carries only successor-policy
authority observations, commitment checkpoints, permit quorum and outcome
checkpoints for that post-activation response. Proof sets from two policy hashes
cannot be combined. Historical predecessor proofs remain accepted through their
original signed retention boundaries, but cannot authorize new work or extend
their evaluation horizon after retirement.

A future atomic rollover protocol may relax this baseline only through a new
versioned profile. It must bind the complete predecessor checkpoint and
reservation state, preserve the original portable commitment bucket and
evaluation anchor, retain the original outcome-policy maximum-horizon deadline,
set every successor retention ceiling no later than the original signed ceiling
and prevent two lifecycle cores from becoming authorized. Without all of those
properties, rollover is invalid rather than a renewal mechanism. The Phase 1
preview ships one fixed policy; post-preview witness replacement cannot be
enabled merely by changing a bundled hash.

For `B = evaluation_bucket_seconds`, anchor bucket `a` and policy minimum `m`,
the first conservatively eligible permit bucket is exact:

```text
not_before_bucket = a + 1 + ceil(m / B)
```

A `too_early` refusal must carry that value. While the active policy still admits
new work, after the original request expires the user confirms the newly generated
exact request and its disclosure again.
That retry uses a fresh `permit_request_nonce`, request ID and validity window but
the same frozen outcome core, lifecycle slot and durable receipt binding. The
client sends the confirmed fresh request to the complete accepted witness set;
witnesses that issued an older request-bound permit issue another for this same
reserved core when the fresh request passes every check. No implementation may
round toward an earlier bucket or derive this value from wall-clock timestamps.

The V1 permit never relies on an implementation's interpretation of
“meaning-bearing.” It binds this closed projection for an original or amendment:

```text
outcome_core_projection = {
  outcome_core_schema_version, canonicalization_version,
  record_action, revision_number,
  supersedes_outcome_uri?, supersedes_outcome_cid?,
  superseded_outcome_proof_hash?,
  outcome_author_did, recipient_binding,
  reference_type: curation_response,
  receipt_id, claim_id,
  commitment_uri, commitment_cid, response_commitment,
  commitment_checkpoint_set_hash,
  receipt_proof_hash,
  item_claim, item_salt, item_inclusion_proof,
  item_proof_hash,
  service_uri, service_profile_cid,
  declaration_uri, declaration_cid,
  authority_uri, authority_cid,
  release_uri?, release_cid?,
  runtime_issuer_did, runtime_key_id, capability_schema_hash,
  scope_id, scope_taxonomy_version, query_category,
  behavior_epoch, authority_epoch,
  subject_ref, subject_ref_hash, subject_resolver_version, subject_id,
  outcome_policy_id, outcome_schema_version, outcome_values,
  interaction_stage, attribution,
  interaction_nullifier, interaction_series_ids,
  material_change_ref?, related_attestation_uri?,
  evaluation_anchor: witnessed_commitment_v1,
  evaluation_anchor_bucket,
  novelty_snapshot_ref?, text?
}

outcome_core_hash = SHA-256(
  "dina-curation-outcome-core-v1" ||
  canonical_outcome_core_projection
)
```

Arrays and maps use the outcome's pinned canonicalization version;
`interaction_series_ids` is sorted by dimension ID and `outcome_values` by its
policy-defined dimension order. Optional fields are encoded using the one
canonical absent-field rule and unknown fields are rejected rather than omitted
from the hash. The derived `outcome_author_did` must equal both
`recipient_binding` and the requester DID that signs the permit request.

The attachment hashes are also closed and domain-separated:

```text
receipt_proof_hash = SHA-256(
  "dina-curation-receipt-proof-v1" || canonical_complete_receipt_proof
)

item_proof_hash = SHA-256(
  "dina-curation-item-proof-v1" ||
  canonical({ item_claim, item_salt, item_inclusion_proof })
)

commitment_checkpoint_set_hash = SHA-256(
  "dina-curation-commitment-checkpoint-set-v1" ||
  canonical_checkpoint_proofs_sorted_by_witness_did
)

superseded_outcome_proof_hash = SHA-256(
  "dina-curation-superseded-outcome-proof-v1" ||
  canonical_complete_predecessor_outcome_and_checkpoint_proof
)
```

The final outcome carries the complete artifacts whose hashes appear in the
projection and, inside each permit proof, the canonical permit-request projection
and requester signature. The verifier recomputes every attachment hash and
`permit_request_hash`, verifies the requester's signature, and requires every
permit to bind that exact request ID/hash before accepting the permit quorum.
Every `permit_issued_bucket` must fall inside the request's signed half-open
issuance interval; permits over different request IDs or hashes cannot be mixed.
`outcome_publication_permit_proofs`, attester-controlled `created_at`, ordinary
repository metadata and the later external outcome checkpoint are the only
excluded record material: permit proofs cannot include themselves, and the
other excluded values are not scoring clocks or do not exist at permit time.
The published outcome embeds the complete permit quorum, so its signed record
could not have been constructed before those permits existed. A permit is valid
for only the bound interaction nullifier and core hash; it cannot authorize
another author, subject, value, receipt or correction. A corrected outcome needs
a new permit over its replacement core.
That permit request includes the complete accepted outcome and checkpoint proof
for the currently active predecessor. The witness verifies the same author,
receipt, claim, subject and nullifier, an exact URI/CID predecessor link and a
revision increment of one before issuing the replacement permit. It never issues
a replacement permit for an already active nullifier without that exact active
predecessor linkage. A revocation carries no replacement opinion and therefore
needs no minimum-delay permit.

The permit is an offline signed protocol artifact, not a public PDS record.
Publishing it before the outcome would reveal that a named recipient intends to
report on a curator interaction. The witness returns it privately, Dina stores it
durably and it becomes public only if the user completes outcome publication.
Cancelling before the permit request sends nothing; cancelling afterward leaves
no public record but the first-party preview witness has learned the disclosed
permit request. The confirmation UI states that fact. A timeout or refusal keeps
the private outcome usable and the public job in `awaiting_outcome_permit`; it is
not curator-quality evidence. A policy refusal returns a private signed artifact
binding the permit-request hash, bounded reason code, observation bucket, witness
policy/key and signature. It is locally auditable but is not published without a
separate user decision. Silence remains only a local timeout claim.

Signed refusals are canonical protocol artifacts, not ad hoc error strings:

```text
permit_request_hash
receipt_id
refusal_code: too_early | conflicting_receipt_binding |
              conflicting_outcome_core | clock_unhealthy | policy_rejected
retryable
not_before_bucket?             # required only for too_early
reserved_commitment_tuple_hash? # required for binding conflict
reserved_outcome_core_hash?     # required only for core conflict
reservation_state: receipt_binding_reserved | outcome_core_reserved | none
observed_at_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_lineage_id
witness_policy_hash
permit_refusal_schema_version
witness_signature
```

```text
witness_signature = Sign(
  "dina-curation-outcome-permit-refusal-v1" ||
  canonical_permit_refusal_without_signature
)
```

Only a request that passed authentication and bounded structural validation may
receive a signed refusal; malformed or unauthenticated traffic receives no
signed oracle response and reserves nothing. `too_early` and
`conflicting_receipt_binding` always report `receipt_binding_reserved`;
`conflicting_outcome_core` reports `outcome_core_reserved`. A conflict refusal
reveals only the applicable domain-separated reserved tuple or core hash.
The same `(witness_policy_hash, witness_did, permit_request_hash, refusal_code,
observed_at_bucket)` decision retries byte-identically. A later-bucket retry may
legitimately advance from `too_early` to a permit after maturity.

The refusal's exclusive `retention_until` uses the same evaluation-anchor,
registry-horizon, standing and challenge formula as a permit. The witness and
requesting Dina retain it through that boundary. It is availability and dispute
evidence about the witness, not curator-quality evidence, unless separately
published under a future consented policy.

Because unpublished permit requests are intentionally absent from the public
source, the witness's exhaustive public-record coverage cannot prove permit
availability or expose selective private refusal. The sole preview witness can
censor public standing at this stage with only local evidence on the affected
device. That is an explicit preview trust boundary, not a property repaired by
the later outcome checkpoint.

Permit signatures use the same accepted witness set, historical key proofs,
clock source, uncertainty rules and policy hash as checkpoints. The permit's
exclusive retention boundary is computed exactly as:

```text
retention_until = evaluation_anchor_bucket + 1
  + maximum_registry_evaluation_horizon_buckets
  + standing_evidence_retention_buckets
  + challenge_window_buckets
```

Complete permit payloads and key proofs travel in the outcome and are retained
in its outcome-checkpoint proof archive. This
private permit proves only that the accepted witness authorized publication of
that outcome core after its policy minimum under the witness clock. It does not
prove when the user formed the opinion or that the reported action occurred.

Before retiring the sole preview witness, the operator must publish an export
manifest for every unexpired checkpoint, coverage membership artifact and proof
bundle, and transfer each one to a documented successor archive that preserves
the original content CIDs.
The original witness signatures remain the ordering evidence; the hand-off
preserves availability rather than retroactively changing authorship. Without
continued operation or a verified hand-off, preview-era public standing loses
durable replayability and must be labelled unavailable rather than silently
trusted.

For a batch, the witness retains or requires replicated availability of the
complete leaf artifact until every included receipt has expired from public
outcome eligibility. Once an outcome is published, that outcome carries its own
batch inclusion proof; replay then needs the outcome proof plus the
witness-retained commitment record and batch root, not the complete leaf list.
Deleting the origin commitment or stopping artifact hosting cannot make an
already accepted outcome unverifiable.

The receipt, response preimage, item proof and accepted commitment checkpoint
establish that the curator signed a recipient-bound response containing this
subject and that its commitment was witnessed before the outcome was
constructed. They do not establish that the subscriber acted, that the
real-world result was not already known, or that the outcome is truthful. A
curator and subscriber can still collude; identity history, coordination
analysis and capped weighting address that risk rather than pretending
cryptography eliminates it.

The revealable projection uses the fixed V1 authority bucket. Exact request and
response times remain in the private signed response and local receipt metadata.
If an emergency compromise boundary falls inside a bucket, the scorekeeper
invalidates the entire bucket under Section 5.3; it does not reveal exact query
time or invoke an unspecified auxiliary proof to rescue the outcome.

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
curation response, but curation standing accepts the latter only with a valid
receipt and selective-disclosure proof.

Required conceptual fields for an original outcome or amendment:

```text
record_action: original | amendment
revision_number
outcome_core_schema_version
outcome_core_hash?          # required for curation outcomes; recomputed
canonicalization_version
supersedes_outcome_uri?       # required for amendment
supersedes_outcome_cid?       # required for amendment
superseded_outcome_proof_hash? # required for amendment
reference_type: review | curation_response
recipient_binding?          # required for curation outcomes; must equal derived author
receipt_id?
claim_id?
commitment_uri?
commitment_cid?
commitment_checkpoint_proofs[]? # complete signed checkpoint proofs; required for curation
commitment_checkpoint_set_hash?
outcome_publication_permit_proofs[]? # complete private permits; required for curation
response_commitment?       # required for curation outcomes
receipt_proof?             # request authorization + receipt + response preimage + batch proof
receipt_proof_hash?
item_claim?                # disclosed claim without private rationale
item_salt?                 # required with item_claim for curation outcomes
item_inclusion_proof?      # claim -> item_root
item_proof_hash?
service_uri?               # required for curation outcomes
service_profile_cid?
declaration_uri?
declaration_cid?
authority_uri?
authority_cid?
release_uri?
release_cid?
runtime_issuer_did?
runtime_key_id?
capability_schema_hash?
scope_id?
scope_taxonomy_version?
query_category?
behavior_epoch?
authority_epoch?
subject_ref
subject_ref_hash
subject_resolver_version
subject_id
outcome_policy_id
outcome_schema_version
outcome_values[]
interaction_stage: selected | acted_on | completed
attribution: curator_nomination | dina_selection | user_choice
interaction_nullifier
interaction_series_ids[] {
  outcome_dimension_id
  series_id
}
material_change_ref?
related_attestation_uri?
evaluation_anchor: witnessed_commitment_v1
evaluation_anchor_bucket
novelty_snapshot_ref?
text?
created_at                    # publication metadata; not a scoring clock
```

An original has `revision_number = 1` and no predecessor. An amendment is a
complete replacement outcome, uses the same verifier-derived interaction
nullifier, increments the active predecessor's revision by exactly one and binds
that predecessor's exact URI and CID. Every changed meaning-bearing field is
inside the replacement `outcome_core_hash`, so an amendment requires its own
publication permit and outcome checkpoint and must still satisfy the original
response's maximum evaluation horizon.

A revocation is a reduced record under the same outcome NSID:

```text
record_action: revocation
revision_number
supersedes_outcome_uri
supersedes_outcome_cid
interaction_nullifier
receipt_id
service_uri
scope_id
behavior_epoch
revocation_reason_code
created_at
```

It must be authored by the same repository DID as the active predecessor, retain
the same receipt, service, scope, epoch and nullifier, and increment the revision
by one. It carries no outcome values and cannot add standing, so it requires no
publication permit. It does require an accepted outcome checkpoint and becomes
effective only after its exact repository authorship, predecessor and checkpoint
proofs verify. A revoked interaction cannot be reactivated; a later opinion
requires a newly authorized request and receipt.

The V1 outcome author and attester root DID are derived from the outcome AT URI
and repository commit proof. They are not trusted from copied payload fields or
namespace presentation metadata. `outcome_values` contains only dimensions and
enum or numeric values permitted by the referenced outcome policy. Free text is
commentary and never silently mapped into a scored value.

An attester-controlled `created_at` or evaluation timestamp cannot prove that a
minimum delay elapsed. Repository timestamps are also not a portable global
clock. The private publication permit proves the minimum-delay side before
construction; after publication, a curation outcome becomes scoreable only when
an accepted witness also checkpoints the exact outcome URI and CID:

```text
outcome_uri
outcome_cid
outcome_repo_rev
outcome_proof_bundle_ref
outcome_proof_bundle_cid
retention_until
source_id
source_cursor
source_position_proof_ref
source_position_proof_cid
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
observation_kind: first_seen
observed_at_bucket
witness_policy_id
witness_policy_version
witness_policy_hash
checkpoint_schema_version
witness_signature
```

`witness_signature` uses
`dina-curation-outcome-checkpoint-v1 ||
canonical_outcome_checkpoint_without_signature`.

The checkpoint is normally a witness-authored
`com.dinakernel.curation.outcomeCheckpoint` record. Its retained proof bundle
contains the outcome record block, signed attester-repository commit, MST
inclusion path, versioned attester DID/key proof and every content-CID-bound
requester/runtime key artifact required to verify the embedded receipt. A
scorekeeper joins this external checkpoint to the outcome by URI and CID; it
cannot be embedded in the outcome because it is created only after that record
exists.

The outcome checkpoint is a first-observation statement, not a renewable timer.
Each witness keeps one immutable first-seen bucket per
`(witness_policy_hash, outcome_uri, outcome_cid)`. The same CID at another URI is
a distinct target and cannot inherit an earlier bucket. Under a multi-witness
policy, the portable quorum-observation bucket is the q-th earliest valid
first-seen bucket from distinct accepted witnesses in the scorekeeper's pinned
input checkpoint, where q is `outcome_observation_quorum`. This is deterministic
and does not let the scorekeeper choose a favorable subset. A checkpoint earlier
than the latest embedded permit bucket is invalid and does not count toward
quorum.
The q-th bucket must be no more than
`maximum_outcome_observation_quorum_delay_buckets` after the earliest included bucket;
otherwise the quorum is incomplete rather than selectively re-formed from a
later favorable subset.
Delayed first observation can make an otherwise honest outcome too late; it can
never substitute for the pre-publication permit or prove the minimum delay.

The permit-bucket comparison applies to original and amended outcomes. A
revocation has no permit; each revocation checkpoint must instead be no earlier
than the corresponding accepted first-observation bucket for its exact active
predecessor. The revocation carries no quality value, and its observation bucket
is used only for lifecycle ordering and proof retention, never to mature a new
outcome.

Each outcome checkpoint's exclusive retention boundary is computed exactly as:

```text
retention_until = observed_at_bucket + 1
  + maximum_outcome_observation_quorum_delay_buckets
  + standing_evidence_retention_buckets
  + challenge_window_buckets
```

The delay padding guarantees that every member of a timely selected quorum
remains available through the portable q-th bucket's full standing and challenge
windows. Evidence is scoreable only while both its commitment and every selected
outcome-checkpoint bundle remain inside their signed retention boundaries. The
accepting witness stores or
replicates the outcome checkpoint record, outcome record block, signed attester
repository commit, MST path and all required versioned DID/key proofs under
content-addressed references through that boundary. Replay must not depend on
either origin PDS or a mutable DID resolver retaining the historical material.

V1 fixes the active outcome policy's `evaluation_bucket_seconds` to `B = 3600`.
Let `r` be the response bucket, `c` the portable commitment-observation bucket,
`a = max(r, c)` the verifier-derived evaluation anchor, `p` the latest issuance
bucket among the complete embedded permit quorum and `o` the q-th earliest
accepted outcome-observation bucket. Exact times are hidden inside their
respective half-open UTC buckets. The verifier computes:

```text
evaluation_anchor_bucket = max(r, c)
permit_elapsed_lower_bound_seconds = max(0, (p - a - 1) * B)
observation_elapsed_upper_bound_seconds = (o - a + 1) * B
```

A permit bucket earlier than the evaluation anchor, or an observation bucket
earlier than the latest permit bucket, is invalid. Otherwise an outcome is
time-eligible only when `permit_elapsed_lower_bound_seconds` is at least the
policy minimum and `observation_elapsed_upper_bound_seconds` is at most the
policy maximum. Boundary equality is accepted. The attester does not supply
either elapsed value. Exact evaluation or action time is neither published nor
scored. This proves only that the bound outcome core was authorized after the
minimum and that the accepted witness quorum observed its record by the maximum;
it does not prove when the user formed the opinion or when the real-world action
occurred.

Before applying per-record score eligibility, a scorekeeper performs a closed
lifecycle-root-candidate prepass over every exact outcome and discipline target
in the pinned complete source-coverage input. An outcome target is a
`lifecycle_root_candidate` exactly when:

1. It declares `record_action = original`, `revision_number = 1`, no predecessor
   and the verifier-derived interaction nullifier.
2. Its repository proof, derived author, canonical schema, request authorization,
   receipt, immutable service contract, runtime authority, commitment and item
   proof pass checks 1 through 12 below.
3. The authority, commitment and permit portions of checks 14 and 16 pass, and the
   permit satisfies the lower-bound half of check 15. Outcome-observation quorum,
   maximum-horizon, repetition weighting and lifecycle-cardinality checks are
   deliberately excluded from this predicate.
4. Its exact URI/CID and complete repository-authenticated target proof occur in
   the complete closed coverage set for every DID in the owning policy's exact
   `required_coverage_witness_dids` array. There is no scorekeeper-defined
   applicability filter or favorable required-witness subset. Each required chain
   carries a terminal checkpoint or signed refusal for the target. Refusal reason
   does not affect membership when the scorekeeper can independently validate the
   retained target proof; a bare source event, URI/CID, unavailable proof or
   unretained refusal is insufficient. If any required chain cannot open enough
   proof to decide the intrinsic predicate, the slot is `coverage_unavailable`
   rather than treated as a one-root set.

The predicate is intrinsic and set-independent: it never asks whether another
root already exists, trusts a refusal label or depends on target arrival order. A
candidate with a late, missing or refused outcome checkpoint cannot earn
standing, but it still prevents the author or witness from selecting another
revision-one root for the same nullifier. A malformed, forged, unauthorized or
incompletely proven record does not enter the set and cannot burn a legitimate
slot. Discipline records use the
same prepass with their closed intrinsic schema, author, receipt or aggregate,
authority and deterministic-nullifier checks; their discipline checkpoint and
lifecycle-cardinality checks are excluded until after candidate collection.

The scorekeeper groups candidates by nullifier, computes the canonical root set,
then performs the ordinary eligibility and descendant-state checks. Thus a
witness may have checkpointed candidate A and refused candidate B while another
witness made the opposite arrival-order decision; both proof-bearing targets
still enter the same root set. A refusal never makes B scoreable. It only prevents
B from disappearing from lifecycle conflict detection.

For an original or amended curation outcome that remains eligible after that
prepass, a scorekeeper verifies all of the following:

1. The outcome repository proof is valid and its derived author matches the
   receipt's recipient binding.
2. The detached requester signature is valid under its pinned historical
   requester-key proof for the request hash, recipient, exact profile,
   declaration, behavior epoch, authority, release, runtime key, capability
   schema, service, scope, query category, outcome policy and authorization
   buckets bound by the response projection. The category is admitted by the
   pinned scope registry, and the response issuance bucket falls inside that
   half-open authorization interval.
3. `receipt_id` recomputes deterministically; the receipt, projection and permit
   reservation agree on the exact commitment tuple. Any distinct tuple for the
   identifier is retained and classified as curator equivocation under the
   monotonic-accountability rule rather than silently replacing this artifact.
4. Every profile, declaration, authority and release URI/CID pair resolves to
   the exact operator-authored record bound by the receipt. The authority grant
   and every applicable revocation have complete accepted authority-observation
   quorums, and an ordinary activation/rotation was observed before its boundary.
5. The runtime signed the receipt with the key authorized for the complete
   `issued_at_bucket` under the active profile.
6. Every contract field in the request authorization, including
   `query_category`, agrees with the projection, receipt and outcome; no
   stable-service-URI fallback, category/scope mismatch or stale-contract
   substitution is accepted.
7. The response commitment recomputes from the signed projection and salt.
8. The operator-authored commitment contains the response commitment directly
   or through the complete content-addressed batch artifact, and the disclosed
   response issuance bucket is inside its runtime-signed commitment window. The
   minimal profile requires the exact one-bucket window.
9. A complete commitment-observation quorum for the exact commitment URI/CID has
   valid accepted-witness signatures, derives one portable q-th bucket and was
   included in the outcome's signed payload; CID-only locators and a checkpoint
   for the same CID at another URI are insufficient.
10. The disclosed item claim and `item_salt` produce the item root through the
    profile-required inclusion proof.
11. The preserved subject reference and hash equal the signed claim. Current
    canonical subject resolution is computed separately through resolver lineage.
12. A complete accepted publication-permit quorum has valid historical witness
    keys, binds one valid receipt-bound requester-signed permit request whose issuance
    interval contains every permit bucket, and matches the exact receipt,
    commitment, claim, subject, interaction nullifier, portable commitment
    bucket, verifier-derived evaluation anchor and recomputed outcome-core hash.
13. A complete accepted outcome-checkpoint quorum matches the exact outcome URI
    and CID and carries valid repository, witness-signature and witness-key
    evidence.
14. Authority observations, commitment checkpoints, publication permits and
    outcome checkpoints use one compatible witness-policy ID/version/hash and
    satisfy its distinct quorums; proof sets from weaker or unrelated policies
    cannot be combined.
15. The verifier derives `evaluation_anchor_bucket = max(response_bucket,
portable_commitment_bucket)` and both the permit lower bound and outcome-
    observation upper bound fall inside the policy window measured from that
    anchor.
16. Every commitment-checkpoint, permit and outcome-checkpoint proof remains
    inside its signed `retention_until` boundary.
17. The completed prepass yields exactly one `lifecycle_root_candidate` for the
    nullifier, and this record is that original or a valid direct amendment of its
    one active predecessor under the rules below.
18. Repeat-series weighting obeys the referenced repetition policy.

The protocol enforces at most one active outcome from one attester for one
receipt and subject. Corrections use amendment/revocation semantics rather than
creating unlimited independent votes. Nullifier state is an atomic lifecycle
slot, not a permanent boolean:

```text
empty -> active(original revision 1)
any state derived from one original + second distinct lifecycle_root_candidate
  -> conflicted(root)
active(N) -> active(amendment N+1)
active(N) -> revoked(N+1)
active(N) -- verified PDS deletion --> deletion_pending_witness(active, N)
revoked(N) -- verified PDS deletion --> deletion_pending_witness(revoked, N)
conflicted(root | child) -- verified conflict-member deletion
  --> deletion_pending_witness(conflicted)
deletion_pending_witness(active, N) -- event quorum --> deleted_terminal(N)
deletion_pending_witness(revoked, N) -- event quorum --> revoked_deleted_terminal(N)
deletion_pending_witness(conflicted) -- event quorum --> conflicted_deleted_terminal
```

The verifier first builds the complete set of `lifecycle_root_candidate` records
for the nullifier using the set-independent prepass above. Exact redelivery of one
URI/CID is idempotent. A different URI or CID is a distinct original even when its
outcome core and permit quorum are byte-identical. If the set contains more than one member, the slot enters terminal
`conflicted(root)`: no original is selected, every descendant is non-contributing
and future evidence requires a newly authorized interaction. The retained
`conflict_set_hash` is computed over canonical `(record_uri, record_cid)` order and
grows monotonically if another candidate is discovered. Records that fail the
closed intrinsic predicate never enter the set. This root-conflict rule takes precedence
over every state derived from only one root, including active, amended, revoked,
deletion-pending and deletion-terminal states. Applicable witnessed deletions are
then replayed against the canonical conflict set. Replaying the same proof-bearing
input set therefore converges regardless of record arrival, restart or concurrent
ingestion order.

With exactly one lifecycle-root candidate, ingestion accepts an amendment only when its
exact predecessor is the current active head and every invariant identity field
is unchanged. In one transaction it marks the predecessor superseded and installs
the replacement as the sole active contribution; it never counts both. A revocation similarly replaces the
active head with a non-scoring terminal state. An out-of-order child remains
pending until its predecessor verifies. Two otherwise valid children of one
predecessor are an attester lifecycle fork: neither child becomes active and the
previous contribution is removed from current standing. That conflicted slot is
terminal; future evidence requires a newly authorized interaction. An invalid or
partially verified child cannot consume or alter the slot.

Repository deletion is a lifecycle event, not a rewind. A verified deletion of
an active original, amendment, revocation or visible fork child first moves the
slot to `deletion_pending_witness` with its prior state recorded. No superseded
predecessor becomes active, and no newly computed current score is published.
The corresponding terminal state is installed only after the portable deletion
event quorum. Deleting a superseded non-head record changes no lifecycle state.
Deleting one root- or child-conflict member never resolves the conflict or makes
another member active; `conflicted_deleted_terminal` records the witnessed
deletion while retaining the canonical conflict-set proof.
Recreating the same AT URI with a new CID, republishing the same nullifier under
another URI or delivering an old record after its deletion cannot reactivate
the slot.

The ingester retains a minimal proof-bearing lifecycle tombstone in its pinned
input archive:

```text
record_family: outcome | discipline
nullifier
terminal_state: deleted | revoked_deleted | conflicted_deleted
deleted_record_uri
deleted_record_cid
deleted_revision
previous_head_uri?
previous_head_cid?
conflict_set_hash?
prior_head_proof_hash
deletion_repo_commit_ref
deletion_repo_commit_cid
deletion_transition_proof_ref
deletion_transition_proof_cid
source_id
source_cursor
source_position_proof_ref
source_position_proof_cid
deletion_event_id
deletion_event_checkpoint_proofs[]
portable_deletion_bucket
retention_until
```

The tombstone is scorekeeper state derived from a complete
`lifecycle_record_deletion` evidence-event checkpoint quorum, its signed
repository transition proof and the already verified lifecycle head; a Jetstream
delete notification alone is only a locator. The transition bundle binds the
prior included URI/CID, the later signed repository commit and the path proving
its removal. `portable_deletion_bucket` is the q-th event-checkpoint bucket, not
local ingestion time. The tombstone is not an attester-authored revocation and
carries no opinion. Its event ID, source cursor and inclusion in the signed score
input make restart, delayed delivery and out-of-order replay deterministic. It
retains only the identifiers, commit proofs and hashes needed for anti-replay and
audit, not deleted outcome text.
If a deletion arrives before the prior record, ingestion holds it as an
`unresolved_deletion` keyed by repository URI and commit lineage; it does not
reserve an attacker-supplied nullifier. The slot changes only after the prior
record and transition proof both verify. If the prior content never becomes
recoverable, the input checkpoint exposes the unresolved deletion and makes no
claim about the unknown nullifier.

When the prior head and deletion transition verify but the event-checkpoint
quorum is still incomplete, the slot is `deletion_pending_witness`: the deleted
content is excluded and no predecessor reactivates, but every affected current
score output is pending/unavailable rather than recomputed from a locally timed
deletion. A previously finalized value may be shown only as explicitly stale
history. Completion installs the deterministic tombstone and permits a new
score; expiry or witness refusal leaves the slot visibly unavailable rather than
restoring evidence.

`retention_until` is recomputed from the complete event quorum as the maximum of
all affected signed proof boundaries and the event-checkpoint retention promises;
it never uses a scorekeeper clock. If applicable law forbids retaining even that
anti-replay marker, the scorekeeper erases it, labels the affected source interval
`erasure_unverifiable` and makes no claim that later replay can distinguish
reactivation from new evidence.

The nullifier is deterministic and verifier-derived, not an arbitrary value
chosen by the attester:

```text
interaction_nullifier = SHA-256(
  "dina-curation-interaction-v1" ||
  recipient_root_did ||
  receipt_id ||
  claim_id
)

series_id = SHA-256(
  "dina-curation-series-v1" ||
  recipient_root_did ||
  service_uri ||
  scope_id ||
  canonical_subject_anchor ||
  outcome_dimension_id
)
```

The outcome carries exactly one `interaction_series_ids` entry for every distinct
dimension present in `outcome_values`, sorted by canonical dimension ID. Missing,
duplicate or extra entries are invalid, and every `series_id` is recomputed by
the verifier. This permits one outcome to report several policy-defined
dimensions while applying cooldown and maximum effective weight independently
to each dimension. An amendment must retain the same dimension set; changing the
set requires a newly authorized interaction rather than rewriting the repetition
series.

V1 outcomes are authored by `recipient_root_did`; a namespace cannot change the
author or series key. A later pseudonymous binding must define a verifier-derived
stable anti-replay root so rotating one-time presentation keys cannot multiply
one interaction.

The interaction nullifier provides one lifecycle slot for the original outcome
and its direct amendments or revocation. The dimension-specific series
identifiers prevent farming with many technically distinct receipts for the same
curator, subject and outcome dimension. The scorekeeper applies the scope's
cooldown, time decay and maximum effective weight per window across each series.
A declared material change may start a new sub-series, but the previous series
remains linked and the reset rule is deterministic and auditable.

`canonical_subject_anchor` is derived from the preserved stable identifiers
under the pinned resolver version, not copied from the attester's current
`subject_id`. Resolver lineage maps that anchor forward during recomputation.

Subject evolution is non-destructive. A merge changes the scorekeeper's current
canonical grouping but never mutates the original `subject_ref`, receipt or
outcome. A split causes a versioned recomputation from preserved references;
ambiguous historical evidence is reduced or excluded under the resolver policy
rather than assigned by guesswork.

An ordinary `com.dinakernel.peerlens.attestation` and a curation outcome may
describe the same real-world interaction. The normal attestation contributes
item evidence; the curation outcome contributes curator evidence. A curator
scorekeeper counts that interaction once, using `related_attestation_uri` and
the interaction nullifier to prevent the ordinary review from becoming a
second independent curator outcome. Curation outcomes are distinct from
`com.dinakernel.peerlens.reviewRequest` and
`com.dinakernel.peerlens.comparison`; neither existing record earns curator
standing merely by referencing the same subject.

The reference curator scorer never treats an ordinary PeerLens attestation as a
curator outcome. If Dina creates both records from one outcome flow, the link is
mandatory and combined UI must not describe them as independent corroboration.
An independently authored, unlinked review may still contribute ordinary item
evidence, but it does not add a second curator-standing signal.

### 6.7 Commitment-discipline evidence

A curator that intentionally declines an authenticated request it processed
should return a private, runtime-signed decline receipt:

```text
receipt_id
request_hash
recipient_binding
request_authorization_projection
requester_signature
service_uri
service_profile_cid
declaration_uri
declaration_cid
scope_id
scope_taxonomy_version
behavior_epoch
authority_epoch
authority_uri
authority_cid
release_uri?
release_cid?
runtime_issuer_did
runtime_key_id
capability_schema_hash
outcome_policy_id
outcome_schema_version
decline_reason_code
retry_after_bucket?
declined_at_bucket
decline_schema_version
runtime_signature
```

Reference reason codes are bounded values such as `out_of_scope`,
`unsupported_request`, `policy_decline`, `capacity` and `temporary_failure`.
Free-form explanation remains private and unscored. The signature proves that
the authorized runtime handled and declined the recipient-authorized request
hash under the exact profile, declaration, behavior, authority, release,
capability schema and outcome policy selected by that request; it does not reveal
the query payload, prove that payload was schema-valid or in scope, or prove the
reason was honest.

With explicit opt-in, a subscriber may publish a rate-limited
`com.dinakernel.curation.discipline` record:

```text
record_action: original | amendment | revocation
revision_number
supersedes_discipline_uri?
supersedes_discipline_cid?
service_uri
scope_id
behavior_epoch?
evidence_type: signed_decline | timeout_claim | unsigned_refusal_claim |
               uncommitted_response_claim | late_commitment_claim
request_hash?
signed_decline_receipt?
decline_nullifier?
discipline_aggregate_nullifier?
discipline_series_id
observation_bucket?           # absent for revocation
covered_from_bucket?
covered_until_bucket?
claim_count?                  # absent for revocation
discipline_schema_version
created_at
```

A public discipline record contributes to the reference standing vector only
after the accepted witness policy checkpoints its exact URI/CID. Each witness
publishes an immutable `com.dinakernel.curation.disciplineCheckpoint`:

```text
discipline_uri
discipline_cid
discipline_repo_rev
discipline_proof_bundle_ref
discipline_proof_bundle_cid
source_id
source_cursor
source_position_proof_ref
source_position_proof_cid
observed_at_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
witness_policy_id
witness_policy_version
witness_policy_hash
discipline_checkpoint_schema_version
witness_signature
```

The signature uses `dina-curation-discipline-checkpoint-v1`. The proof bundle
contains the discipline record block, signed author-repository commit, MST path
and historical author DID/key proof. For `signed_decline`, it additionally
contains the complete detached requester authorization, runtime-signed decline,
authority grant/revocation lineage and accepted authority-observation quorum
needed to verify the runtime for the disclosed decline bucket. For an amendment
or revocation, it contains the complete active-predecessor checkpoint proof.

Each witness keeps one immutable checkpoint per
`(witness_policy_hash, discipline_uri, discipline_cid)`. The same CID under
another URI is a distinct source target; another bucket or proof for the same
key is witness equivocation and an idempotent retry is byte-identical. The portable discipline-observation
bucket is the q-th earliest valid `observed_at_bucket` from distinct accepted
witnesses, where q is `discipline_observation_quorum`, and must complete within
`maximum_discipline_observation_quorum_delay_buckets`. A later favorable subset
cannot replace an incomplete or over-delay quorum. It is an archive and
coverage clock, not proof that an unverified subscriber claim happened when its
payload says it did.

Each checkpoint's exclusive retention boundary is:

```text
retention_until = observed_at_bucket + 1
  + maximum_discipline_observation_quorum_delay_buckets
  + max(
      standing_evidence_retention_buckets,
      lifecycle_tombstone_retention_buckets
    )
  + challenge_window_buckets
```

That boundary covers the complete discipline proof bundle, including any
dependent-retention authority observations used to verify a signed decline.

The witness checkpoints or canonically refuses every discipline record in its
declared source range before `maximum_discipline_checkpoint_delay_buckets` and
includes the decision in the retained coverage membership artifact. A missing
discipline quorum makes its availability/discipline dimensions unavailable; it
never changes the curator's quality estimate through local ingestion alone.

An original discipline record has revision one and no predecessor. An amendment
or revocation must preserve the author, service, scope, evidence type and
verifier-derived decline or aggregate nullifier, increment the current active
revision by one and bind its exact URI/CID. State changes use the same atomic
single-head and root-set rules as outcomes: two distinct revision-one
lifecycle-root candidates for one discipline nullifier create a terminal root
conflict under every ingestion order, a replacement never adds a second raw or effective
contribution, an invalid child cannot consume the slot, and two valid children
make the slot conflicted and non-contributing. Exact URI/CID redelivery remains
idempotent; another URI or CID is distinct even when the claim payload is
identical. A revocation carries no claim count or evidence payload. A
`signed_decline` record may be revoked but not amended to another receipt: the
underlying runtime-signed terminal disposition is immutable. Amendments are
available only for cumulative unverified aggregates.
Outcome lifecycle deletion rules apply identically: deleting an active
discipline head enters `deletion_pending_witness` before the event quorum creates
its terminal nullifier tombstone, deleting a revocation does not reactivate its
predecessor, and deleting one fork child does not resolve the conflict. This
includes both
`decline_nullifier` and `discipline_aggregate_nullifier` slots.

Only `signed_decline` is curator-verifiable evidence. A timeout, refusal to sign,
uncommitted response or late publication is an attester claim because the
protocol cannot prove a missing message or record. Scorekeepers keep verified
declines and unverified claims in separate dimensions, apply identity and
coordination weighting, and never infer a complete private-query denominator.
For `signed_decline`, the discipline-record author must match
`recipient_binding`, `claim_count` is one, and the request hash and complete
receipt, including the detached requester authorization, are required. The
verifier recomputes `receipt_id`, checks the authorization interval and rejects a
conflicting active response disposition. Aggregated unverified claims omit
individual request hashes and receipts to reduce linkage.
Because that detached authorization reveals `query_category`, publishing a
verified decline reveals the same category even though it does not reveal the
private payload or nonce. Sensitive-scope decline evidence therefore defaults to
local-only and uses the same exact-payload public disclosure warning.

In V1 a verified decline is descriptive service-availability evidence, not a
negative quality outcome or proof of operator misconduct. In particular,
`out_of_scope` and `unsupported_request` carry no negative standing because the
public proof cannot establish the private request's eligibility. `capacity`,
`temporary_failure` and `policy_decline` may be displayed as separately labelled
availability counts, but they do not alter the quality estimate or convenience
band. Any later weighted interpretation requires a versioned public policy and
new conformance vectors; a scorekeeper cannot invent one locally.

The verifier derives replay and repetition keys rather than trusting arbitrary
values from the publisher:

```text
decline_nullifier = SHA-256(
  "dina-curation-decline-v1" ||
  recipient_root_did ||
  service_uri ||
  request_hash
)

discipline_series_id = SHA-256(
  "dina-curation-discipline-series-v1" ||
  recipient_root_did ||
  service_uri ||
  scope_id
)

discipline_aggregate_nullifier = SHA-256(
  "dina-curation-discipline-aggregate-v1" ||
  recipient_root_did ||
  service_uri ||
  scope_id ||
  evidence_type
)
```

Only one active discipline record may consume a `decline_nullifier`; corrections
use amendment or revocation lineage. Distinct requests remain in the same
discipline series, where the scorekeeper's pinned repetition policy applies a
cooldown, per-window contribution cap and diminishing weight. This prevents one
subscriber from multiplying either one receipt or a stream of freshly generated
requests into independent decisive evidence. Every aggregated unverified claim
requires `discipline_aggregate_nullifier`, and only one active aggregate record
may exist for one author, service, scope and evidence type. V1 deliberately does
not put a publisher-selected time window in this replay key because an unverified
claim has no portable trusted observation clock. `covered_from_bucket`,
`covered_until_bucket`, `observation_bucket` and `claim_count` are bounded
descriptive claims, not independent proof of requests or elapsed time. A newer
cumulative report replaces the active aggregate through explicit amendment
lineage; it does not add another raw or effective contribution. A scorekeeper
gives the one active aggregate at most one capped author-level contribution,
regardless of its claimed count. Aggregates also use the same series cap even
though they have no cryptographically provable per-request nullifier.

Discipline publication has its own exact-payload confirmation. The preview shows
the publishing DID, curator service, scope, evidence type, observation bucket
and every included request hash or signed receipt. It warns that a curator can
correlate a disclosed request hash with the private request it handled. Sensitive
scopes default to local-only discipline evidence; public publication requires a
fresh confirmation and is never implied by consent to publish an outcome.

---

## 7. Response commitment flow

```text
Subscriber's Dina       Runtime       Operator publisher    Public source/witness
       |                    |                  |                       |
       | private query + detached signed authorization                 |
       |------------------->|                  |                       |
       |                    | build response projection + commitment   |
       |                    | signed per-response manifest             |
       |                    |----------------->| verify authority      |
       |                    |                  | publish commitment    |
       |                    |                  |---------------------->|
       |                    | commitment URI/CID                       |
       |                    |<-----------------|                       |
       |                    | sign receipt including commitment URI   |
       | response + final receipt                |                    |
       |<-------------------|                  |                       |
       | request/receive signed commitment checkpoint                 |
       |<-------------------------------------------------------------|
       | verify all bindings; mark receipt outcome-eligible           |
       | confirm permit request; request/receive private permit       |
       |<------------------------------------------------------------>|
       | confirm final record; publish outcome + all proofs           |
       |------------------------------------------------------------->|
       | request/receive signed outcome-observation checkpoint        |
       |<-------------------------------------------------------------|
       | mark published outcome scoreable when policy permits         |
```

This is the `curation-v1-minimal` per-response order: commitment publication
precedes the final runtime signature because that receipt binds
`commitment_record_uri`. For a Phase 3 Merkle batch, the order deliberately
differs: the curator first returns a provisional receipt and batch ticket, then
the operator publisher exposes the complete content-addressed leaf artifact after
the batch closes and the client finalizes the receipt with its inclusion proof.
Dina derives the response inclusion proof itself. It
accepts an outcome-eligible response only after every binding verifies and an
accepted witness has signed a commitment checkpoint and, for a batch, its
available leaf artifact.

If commitment publication fails, Dina may still show the recommendation, but
it labels the response `not publicly committed`. Such a response cannot improve
the curator's public outcome standing.

If publication succeeds but the accepted witness is unavailable, Dina marks the
receipt `awaiting_commitment_witness`. The recommendation, local personalization
and private outcome remain usable. A durable job retries checkpoint acquisition
until the policy deadline or receipt expiry and persists any acted-on state
meanwhile. No public outcome is constructed until a complete accepted commitment
checkpoint proof is available. Recovery never falls back to repository
timestamps, an unknown witness or a weaker quorum. A signed witness refusal and
an unsigned timeout are shown and audited as different failure classes.

After explicit permit-request confirmation, Dina freezes the outcome core and
requests the private witness permit. Until the complete permit quorum arrives,
the durable job is `awaiting_outcome_permit`; the private outcome remains usable
and no public record exists. Dina then shows the exact final public record,
including the complete commitment checkpoint and publication-permit proofs. Only
after the user confirms that record does Dina publish it and mark the job
`awaiting_outcome_witness`. The witness checkpoints that exact outcome URI/CID.
Only then may a scorekeeper include it, using the permit bucket for the policy
minimum and quorum-observation bucket for the maximum horizon. Permit issuance,
outcome publication and outcome scoreability are separate durable states. If the
outcome witness is unavailable, the public record remains authored and visible
but contributes no standing unless a valid checkpoint quorum arrives within the
eligible horizon.

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

The private receipt binds that authenticated identity so a firehose observer
cannot publish an outcome for someone else's response. In minimal public mode,
revealing the binding adds no new identity beyond the outcome author's public
DID. It does make the curator-query relationship explicit, which the payload
preview must say plainly.

### 8.2 Information minimized by default

- Category-level intent rather than raw conversation text. The category is
  visible to the curator and becomes public only if the user later publishes a
  receipt-bearing outcome or verified decline.
- No vault excerpts.
- No local personalization features.
- No relationship graph.
- Coarse locale only when required for the capability.
- Coarse time buckets in public commitments.
- No public requester identifier in commitment records.

### 8.3 Sensitive-scope outbound confirmation

A category-level query can itself disclose sensitive information even when it
contains no vault-derived context. Before each query to a curator in a sensitive
scope, unless an active semantic disclosure policy covers it, the reference
client shows an outbound preview containing:

```text
curator operator and service_uri
authenticated requester DID visible to the curator
scope and query category
exact query_payload
transport and material network-metadata warning
grant duration and expiry, when confirmation may be remembered
```

The user must confirm before transmission. The default confirmation is one-shot
and binds the exact canonical payload digest. A reusable confirmation is allowed
only through an explicit sensitive-query disclosure policy containing:

```text
curator service_uri
requester identity
scope and purpose
service_profile_cid
declaration_uri and declaration_cid
behavior_epoch
authority_uri and authority_cid
release_uri and release_cid, when applicable
runtime_key_id
capability_schema_hash
outcome_policy_id and outcome_schema_version
request_schema_hash
allowed field paths
allowed semantic value classes or predicates
maximum uses
expiry
revocation status
```

Matching a JSON shape is never sufficient: `{ condition: string }` cannot
authorize every future medical condition merely because the field type remains
unchanged. Dina prompts again when the payload falls outside the semantic
policy, any binding or schema changes, the use limit is reached, or the policy
expires. Cancelling sends nothing. This is an egress confirmation even when no
vault grant is involved; it does not substitute for the stricter context grant
below.

### 8.4 Explicit context grant

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

This subsection describes target behavior, not a shipping claim. The semantic
Context Firewall and disclosure-manifest compiler in
`docs/CONTEXT_FIREWALL_DESIGN.md` are not implemented. Until they are, the
reference curation client disables vault-derived remote context entirely;
ordinary approval plus structured-PII scrubbing is not an adequate substitute.

### 8.5 Later anonymity options

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

V1 offers two outcome modes:

### 9.1 Private outcome

- Stored only in a local encrypted vault.
- Improves Dina's local personalization.
- Does not affect public curator standing.

### 9.2 Minimal public outcome

- Publishes policy-defined outcome values, response commitment and preserved
  subject reference.
- Publishes the canonical query category carried by the detached request
  authorization. This is required for public category-to-scope validation and
  can itself disclose sensitive intent; sensitive categories therefore remain
  private by default unless the final payload preview is explicitly confirmed.
- Reveals the committed `recommendation_count` and `public_eligible_count`.
  Observers can therefore infer how many additional `local_only` items were in
  the signed response, although they do not learn those items, their rationale or
  whether the user considered them. This set-size leakage is the V1 cost of
  making the curator-recipient count co-attestation publicly auditable; it does
  not prove what a modified client rendered.
- Omits free text by default.
- Publishes no exact action or evaluation time. The external outcome checkpoint
  and embedded commitment/permit proofs expose policy-defined coarse commitment,
  evaluation-anchor, permit and outcome-observation buckets, and ordinary
  repository/firehose publication metadata may still reveal when the outcome was
  posted.
- First shows the exact private permit request and intended public outcome core.
  After that confirmation, the permit request reveals the recipient, curator,
  scope, selected subject hash and intended outcome core to the accepted witness.
  Once the permit arrives, Dina separately shows the exact final public record,
  including generated proof fields, before publication. If the user cancels at
  either stage, no public record appears, but after the first transmission the
  witness has still seen the permit-request fields.
- Is authored by the authenticated requester root DID bound in the receipt.

### 9.3 Deferred pseudonymous outcome

PeerLens namespaces may separate presentation, but they cannot make a V1
curation outcome pseudonymous because the receipt proof exposes the bound root
DID. The reference client does not offer namespace publication for curation
outcomes. A future mode may use a one-time outcome key, pairwise DID or blinded
credential only after it preserves recipient authorization, replay resistance,
series deduplication and independent verification without revealing the root
DID.

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
outcome_schema_version
standing_status: current | unrated | pending | unavailable | expired
standing_status_reasons[]: invalidation_order_unresolved |
                           deletion_pending_witness |
                           proof_unavailable |
                           coverage_unavailable |
                           head_equivocation |
                           head_history_unavailable |
                           score_coverage_stale |
                           input_coverage_stale |
                           policy_transition_pending |
                           score_lineage_unavailable |
                           archive_unavailable |
                           erasure_unverifiable
last_finalized_snapshot_uri?
last_finalized_snapshot_cid?
stale_as_of_input_checkpoint?
outcome_dimension_summaries[] {
  dimension_id
  evaluation_horizon
  standing_direction: higher_is_better | lower_is_better
  unconstrained_conditional_estimate
  no_suppression_bound?
  conditional_estimate
  confidence_interval
  raw_count
  effective_count
  authority_tainted_effective_count
}
raw_outcome_count
effective_sample_count
committed_response_count
public_outcomes_per_commitment
claimed_acted_on_followup_rate?
commitment_discipline_evidence
freshness
coverage_evidence
coverage_evidence_source
calibration_error
nomination_quality
selection_quality
recommendation_set_size
coordination_risk
disclosure_completeness
selection_bias_warning
operator_controlled_invalidation_count
operator_equivocation_evidence
authority_compromise_evidence
no_suppression_constraint_applied
computed_at
```

Numeric current estimates and convenience bands are present only for
`standing_status: current`; `unrated` carries sample metadata but no inferred
quality. A `pending`, `unavailable` or `expired` snapshot cannot silently retain
current-looking numbers. A client may show the referenced last finalized
snapshot only as stale history, with its original checkpoint and expiry visible.
Status reasons are canonically sorted and are part of the signed score snapshot.
Those fields record the immutable status at snapshot/checkpoint construction.
At read time, the client derives an `effective_standing_status` without changing
the signed record. Expiry, a stale/unreachable required score-coverage head or a
newly observed conflict maps a signed `current` snapshot to effective
`expired`/`unavailable` and suppresses current-looking numbers. The unsigned read
wrapper carries:

```text
effective_standing_status: current | unrated | pending | unavailable | expired
effective_standing_status_reasons[]
verification_bucket
required_score_coverage_heads[] {
  witness_did
  coverage_head_uri
  coverage_head_cid
  head_generation
  current_repository_proof_cid
  bounded_coverage_proof_cid
  coverage_through_closed_at_bucket
}
```

Its reasons use the same closed reason set, including `score_coverage_stale` and
`coverage_unavailable`. A derived state can only remove currentness; it cannot
upgrade a signed non-current snapshot. APIs return both signed and effective
fields. A receiving client recomputes the verification bucket and freshness
rather than trusting the wrapper, so caches cannot pass off a local wrapper as
another signed snapshot.

A client may calculate a convenience band such as `established`, `developing`
or `unrated`, but it must preserve access to the underlying dimensions.

Each `conditional_estimate` means "estimate within published, policy-eligible
outcomes for committed responses." It is not an unbiased probability that an
arbitrary future recommendation will succeed. A scorekeeper must not shorten
the label to `success rate` when the public evidence cannot establish the full
denominator.

`public_outcomes_per_commitment` is the count ratio that public records can
actually support. It is not an action rate: one committed response may contain
several recommendations, users may never act, and public outcomes are optional.
An optional `claimed_acted_on_followup_rate` comes only from explicitly labelled
subscriber discipline records and is never merged invisibly into the
public ratio. `coverage_evidence` similarly names its source and sample policy,
such as public digests, subscriber claims or standardized probes; it is not
presented as observed population coverage when only a selected sample exists.

Calibration is computed only for confidence targets declared by the applicable
outcome policy and only after their evaluation horizon. A 7-day selection claim
cannot be compared with a 30-day held-up outcome, and `selected` events cannot
be repurposed as quality successes.

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

### 10.6 Attribution after local personalization

The curator nominates and ranks candidates; Dina may filter or reorder them
using private local context; the user chooses whether to act. These are separate
decisions and receive separate evidence.

A local decision receipt records, without automatic publication:

```text
curator_nominated
curator_rank
dina_adjusted_rank
shown_to_user
selected_by_user
acted_on
completed
outcome
contributing_curators[]
```

Reference standing gives nomination credit when the curator supplied the acted
on item. It gives rank-quality credit according to the curator's original rank.
It does not blame the curator for an item Dina introduced independently. When
several curators supplied the same item, the reference scorekeeper uses a
published fractional-credit rule and exposes the contributor set; it never
silently gives every curator one full independent success.

### 10.7 Missing outcomes and selective commitment

Public outcomes are voluntary and therefore subject to non-response and
selection bias. A curator can also commit only easy responses, reject difficult
queries, or label hard responses `not publicly committed`. No public log can
prove how many private responses or refusals a hosted curator omitted.

The reference client records commitment discipline locally: committed,
uncommitted, refused and timed-out queries. With explicit opt-in, it may publish
a rate-limited discipline record under Section 6.7. A valid signed decline
receipt is verified evidence that the curator acknowledged and declined the
authorized request hash, not that the private request was eligible or the reason
was justified. Timeouts, unsigned refusals, uncommitted responses and
late-commitment reports remain subscriber claims, not proof of a missing response
or record. Scorekeepers report each evidence class separately from outcome
quality and always expose the known committed-response count and
public-outcomes-per-commitment ratio. When the private response or acted-on
denominator remains unknown, the UI says so instead of inferring complete
coverage.

Subscriber claims are identity-weighted, coordination-checked and shown with
effective sample size. One subscriber cannot create a decisive penalty by
repeatedly reporting refusals. A curator that declines without signing creates
local discipline evidence, but the network sees only the subscriber's labelled
claim; absence of a signature is not converted into cryptographic proof.

### 10.8 Monotonic accountability under curator-controlled invalidation

A curator must not be able to improve standing by invalidating its own
unfavorable evidence. Curator-controlled invalidation includes emergency
authority revocation, authority forks, conflicting revocations, two commitments
for one receipt, conflicting response/decline dispositions, commitment origin
deletion and any operator-authored lineage event that makes previously admitted
evidence fail ordinary eligibility. These events may reveal a real compromise,
so the affected evidence is not silently treated as normal verified quality.
They also cannot function as a score reset.

Ordering uses accepted witness buckets, never repository timestamps or
cross-source cursor comparison. For this rule, a commitment reaches its
accountability stage at its portable commitment-observation bucket, and an
outcome reaches it at its portable outcome-checkpoint bucket. The invalidation
boundary `i` is the portable bucket of the complete evidence-event checkpoint
quorum from Section 6.4. Evidence with `accountability_stage_bucket <= i` is
treated as preceding the invalidation; equality is deliberately resolved against
the curator because bucket-level ordering cannot prove that invalidation came
first. Evidence with a strictly later stage is excluded from the counterfactual.
An event without a complete quorum leaves ordering unresolved and cannot produce
a more favorable reference standing result.

For each affected dimension, the reference scorer deterministically computes:

```text
ordinary_estimate = score(current ordinarily eligible evidence)

no_suppression_counterfactual = score(
  set-union of current evidence and unexpired evidence whose
    accountability_stage_bucket <= portable_invalidation_bucket,
  with one effective contribution per receipt,
  with conflicting outcomes reduced to the policy-defined least-favorable
    value per dimension and capped at that dimension's declared neutral value,
  with every distinct valid commitment retained in the denominator
)

published_estimate = less_favorable(
  ordinary_estimate,
  no_suppression_counterfactual,
  outcome_policy.standing_direction
)
```

For `higher_is_better`, `less_favorable` selects the lower point estimate; for
`lower_is_better`, it selects the higher. The published uncertainty interval is
the hull of both candidate intervals so invalidation cannot create false
precision. The convenience band uses the less-favorable decision bound: the
lower bound for `higher_is_better` and upper bound for `lower_is_better`.
Tainted artifacts, counts, invalidation reasons and the unconstrained estimate
remain visible so a client can distinguish uncertain compromise evidence from
ordinary outcomes.

Positive evidence that becomes tainted may still make the ordinary estimate
worse; the counterfactual never protects the curator from that downgrade. The
rule only prevents self-authored invalidation from producing an improvement.

The counterfactual is replayed from witnessed artifacts and portable event
ordering in the pinned score input, not copied from a mutable earlier score. An
event whose portable bucket is strictly earlier than every applicable
accountability stage can block ordinary standing and enters the
commitment/anomaly dimensions, but it does not manufacture a quality value that
never became eligible. A later behavior epoch starts under the normal capped
prior rule, while the prior epoch's unresolved compromise/equivocation warning
remains visible in service lineage; epoch rotation cannot erase it.

Independent moderator decisions, court-ordered erasure and attester-authored
outcome deletion are not curator-controlled invalidation. They follow the
published moderation or erasure policy and must expose their effect on the input
checkpoint. A scorekeeper may adopt a different transparent policy, but it
cannot claim reference compatibility unless it passes the
monotonic-accountability vectors.

### 10.9 Bootstrap without manufactured standing

At launch, every curator is `unrated`; absence of evidence is not a negative
score. Discovery initially relies on explicit subscription, declared scope and
provenance, ordinary service search, direct links and clearly labelled
first-party examples. A `featured`, `maintained by Dina` or catalog-placement
label is editorial metadata and must never be displayed or scored as earned
standing.

The first subscriber can still receive a private recommendation, personalize it
locally and retain a private outcome before any scorekeeper has data. Voluntary
public outcomes then create the first evidence. The reference deployment does
not seed synthetic outcomes, silently convert operator identity into reputation
or rank an unrated curator above another merely because Dina operates it. The UI
shows provenance, disclosures and sample count until enough evidence exists for
a statistically meaningful standing band.

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

### 11.4 Recommendation-set size

A curator must not improve its apparent success rate by returning many items
and later claiming whichever one worked. Parameter and result schemas impose a
small maximum result count. Scorekeepers retain the original rank and set size,
give less rank-quality credit to low-ranked selections, and never treat several
items from one response as independent successful queries.

The signed response projection commits `recommendation_count`,
`public_eligible_count` and `eligibility_profile`; disclosed item claims commit
their original ranks. The minimum Phase 1 verifier accepts public standing only
for the single rank-one claim. Counts supplied by the curator are recomputed
from the received response before the reference client accepts the receipt, so
that client will not later present a smaller set. Public verification establishes
that curator and outcome author endorsed the same counts, not that independent
software observed the historical display.

---

## 12. Scorekeeper reproducibility

A signed score alone is not reproducible. Every scorekeeper publishes an
immutable `com.dinakernel.curation.scoreManifest` record containing:

```text
score_manifest_id
scorekeeper_did
score_channel_id
algorithm_name
algorithm_artifact_ref
algorithm_artifact_cid
algorithm_artifact_hash
algorithm_artifact_format
parameter_set_hash
parameter_artifact_ref
parameter_artifact_cid
input_checkpoint
input_checkpoint_hash
input_proof_manifest_ref
input_proof_manifest_cid
input_proof_manifest_root
attester_score_checkpoint
item_score_checkpoint
scope_registry_version
subject_resolver_version
subject_graph_checkpoint
outcome_policy_registry_version
repetition_policy_registry_version
active_witness_policy_hash
evidence_policy_lineage_ref
evidence_policy_lineage_cid
evidence_policy_lineage_root
score_input_role_registry_ref
score_input_role_registry_cid
score_input_role_registry_hash
score_witness_policy_hash
probe_policy_hash?            # required only when probe evidence contributes
record_inclusion_rules_hash
moderation_policy_hash
sybil_policy_hash
schema_versions
input_proof_retention_floor_bucket
input_coverage_through_bucket
generated_at_bucket
expires_at_bucket
score_manifest_schema_version
```

```text
score_manifest_id = SHA-256(
  "dina-curation-score-manifest-id-v1" ||
  canonical_score_manifest_without_id
)
```

Its AT URI author and signed repository commit must derive to
`scorekeeper_did`. The record is immutable, and the score witness retains its
record block, repository proof and historical scorekeeper DID/key proof with
the snapshot proof bundle. A manifest URI/CID that cannot be independently
authenticated is not a reproducibility artifact.

`input_checkpoint_hash` is
`SHA-256("dina-curation-score-input-checkpoint-v1" ||
canonical_input_checkpoint)` and must equal the value copied into the score
snapshot. `standing_vector_hash` similarly uses
`dina-curation-standing-vector-v1` over the canonical vector. The algorithm and
parameter refs must resolve to the exact CIDs and hashes in the manifest; a
mutable URL, package tag or source hash without retained executable/parameter
bytes is insufficient.

`input_proof_manifest_cid` resolves to a canonical
`score_input_proof_manifest`:

```text
score_input_proof_manifest {
  proof_manifest_version
  input_checkpoint_hash
  input_artifact_set_root
  entries[] {
    artifact_role: authority_record | authority_observation |
                   commitment_record | commitment_checkpoint |
                   publication_permit | outcome_record | outcome_checkpoint |
                   discipline_record | discipline_checkpoint |
                   evidence_event_checkpoint | lifecycle_tombstone |
                   policy_successor_record | policy_successor_observation |
                   witness_refusal | incomplete_event_diagnostic |
                   source_manifest | coverage_record | coverage_membership |
                   attester_checkpoint | item_checkpoint |
                   subject_graph_checkpoint | moderation_input | sybil_input |
                   probe_artifact | algorithm_artifact | parameter_artifact |
                   scope_policy_bundle | outcome_policy_bundle |
                   repetition_policy_bundle | resolver_artifact |
                   record_inclusion_artifact |
                   evidence_witness_policy_bundle | evidence_policy_lineage |
                   evidence_policy_transition_bundle |
                   evidence_source_transition_mapping |
                   score_input_role_registry
    artifact_uri?
    artifact_ref
    artifact_cid
    artifact_hash?
    source_policy_hash?
    encoded_size_bytes
    retention_carrier: signed_artifact | enclosing_score_checkpoint
    retention_carrier_uri?
    retention_carrier_cid?
    effective_retention_until
  }
  entry_count
  transitive_block_count
  transitive_encoded_bytes
  transitive_max_depth
  input_proof_manifest_root
}
```

Optional-field presence is not implementation-defined. The score witness policy
and score manifest pin one content-addressed role registry:

```text
score_input_role_registry {
  role_registry_schema_version
  role_rules[] {
    artifact_role
    artifact_uri_mode: required | forbidden
    artifact_hash_mode: required | forbidden
    artifact_hash_rule_id? # present exactly when hash mode is required
    source_policy_hash_mode: required | forbidden
    retention_rule_id
    root_schema_id
    maximum_root_encoded_bytes
  }
  schema_rules[] {
    schema_id
    child_cid_edges[] {
      field_path
      child_schema_id
      cardinality: exactly_one | zero_or_one | list
    }
    maximum_direct_children
  }
  role_count
  schema_count
  score_input_role_registry_hash
}

score_input_role_registry_hash = SHA-256(
  "dina-curation-score-input-role-registry-v1" ||
  canonical_role_registry_without_hash
)
```

Role rules sort by `artifact_role`, schema rules by `schema_id`, and child edges
by `(field_path, child_schema_id, cardinality)`. There is exactly one role rule
for every value in the manifest's closed `artifact_role` enum and no extra rule.
Each hash-rule and retention-rule ID names a frozen deterministic function with
cross-runtime vectors; unknown IDs fail closed. A schema rule declares every
CID-bearing field that is recursively required for that canonical schema, the
schema used to decode each child and whether the field contains exactly one,
zero-or-one or a list of CIDs. Every root and child schema ID must resolve to one
registry rule, every schema rule must be reachable from at least one role root,
and duplicate field paths are invalid. Undeclared strings that look like CIDs are
not traversed; a missing required child, unexpected list/scalar shape or invalid
child CID is `invalid_manifest`.

The registry entry bootstraps under a protocol-fixed rule: role
`score_input_role_registry` forbids `artifact_uri` and `source_policy_hash`,
requires `artifact_hash = score_input_role_registry_hash`, uses
`retention_carrier = enclosing_score_checkpoint`, and has the protocol-fixed
leaf root schema ID `score_input_role_registry_v1`. Its schema rule has no child
edges; registry contents cannot make the bootstrap block recursively fetch data.
Before canonical decoding, a V1 verifier enforces bootstrap constants independent
of registry contents: the registry block is at most 262,144 encoded bytes,
`role_count` is exactly 36, `schema_count` is at most 64, each schema has at most
64 child edges, each field path has at most 16 segments and
`maximum_direct_children` is at most 4,096. Exceeding a constant fails before
allocating the declared collection; changing any constant requires a new
`role_registry_schema_version` and conformance vectors.
The existing `coverage_record` role's root schema is the closed discriminated
union of a `witnessCoverage` record with
`coverage_kind: interval | compacted_prefix` and a
`witnessCoveragePrefixFinalization` or `witnessCoverageHead` record; it is still
one role and does not change the count. Its NSID, typed child edges and field-
presence rules select exactly one branch before recursion. The analogous score-
coverage interval, prefix, finalization and head union is verified in the score-witness proof envelope
rather than inserted into the scorekeeper's input-role enum.
Every other entry's URI/hash/policy field presence, hash calculation, retention
carrier and root schema must exactly match its registry rule. This makes
repository records URI-bearing where required and content artifacts URI-less;
an implementation cannot attach an arbitrary URI, omit a required hash or choose
a more favorable retention carrier. The registry CID/hash in the manifest must
equal the score-witness-policy pin, and exactly one retained registry entry is
required in the input manifest.

`encoded_size_bytes` equals the exact CID-addressed root block length. Recursive
resource accounting uses the registry's schema graph:

```text
transitive_block_set = unique CIDs reachable from every primary artifact_cid
  by seeding its role's root_schema_id and repeatedly applying the pinned,
  schema-typed child-CID edges

transitive_block_count = count(transitive_block_set)

transitive_encoded_bytes = sum(
  exact CID-addressed encoded byte length for each block in transitive_block_set
)

transitive_max_depth = maximum child-CID edge count from a primary artifact block
```

Every bounded proof operation first constructs a closed root descriptor for each
semantic root:

```text
canonical_root_descriptor {
  root_kind       # proof_kind or artifact_role selected by the enclosing schema
  artifact_uri?   # present exactly for a repository-record root
  artifact_cid
}
```

Root descriptors sort by `(root_kind, artifact_uri presence,
artifact_uri_or_empty, raw artifact_cid bytes)` and are duplicate-free. This is
the operation's total root order; signed sequence/predecessor relationships are
validated as semantics after retrieval and never serve as a tie-breaker for
siblings. `root_ordinal` is the zero-based index in this sorted array.

Typed graph traversal is canonical depth-first pre-order. Starting at each root
in ordinal order, the verifier visits child occurrences in
`(field_path, list_index_or_minus_one, raw child_cid bytes)` order and completely
visits one child's subtree before its next sibling. An occurrence has this
canonical path:

```text
traversal_path {
  root_ordinal
  root_descriptor {
    root_kind
    artifact_uri?
    artifact_cid
  }
  edges[] {
    parent_cid
    field_path
    list_index?   # present exactly for a list edge
    child_cid
  }
}
```

`root_descriptor` is byte-identical to the descriptor at `root_ordinal` in the
operation's sorted root array; a wrong descriptor, wrong ordinal or descriptor
whose position cannot be reproduced from the available root set fails. The root
occurrence has an empty edge list. A CID on the current ancestry is a
cycle. A CID reached again outside the current ancestry must derive the same
schema; the verifier records the additional edge for longest-path calculation
but neither fetches nor expands that block again. Thus physical block/byte
accounting remains unique-CID, while schema conflicts and every alternate DAG
edge remain visible. Cycle detection and longest-path depth are computed over
this complete recorded typed graph, with canonical path bytes breaking any tie
between equal-depth paths. These rules, including the point before each unseen-
CID fetch/decode at which a budget is checked, are identical for evidence, score
and feasibility-fixture evaluation.

Primary blocks, policy-bundle members, repository proofs, transition members and
all other declared descendants count. A CID reached from several semantic entries
counts once toward physical block/byte limits even though each URI/CID semantic
identity remains separately committed. Every occurrence of one CID must derive
the same `schema_id`; conflicting schema assignments are `invalid_manifest`
rather than an implementation choice. The extracted child count may not exceed the
schema's `maximum_direct_children`, and a repeated CID on the current ancestry is
rejected as a cycle. `transitive_max_depth` is the maximum across every derived
root-to-block path, including a longer alternate path to an already fetched CID,
not the depth at which an implementation happened to discover it first.
Transport compression never reduces the
count: implementations count canonical block bytes after bounded streaming
decompression and before semantic decoding, while separately applying a network-
byte cap. The declared root sizes and all transitive totals are recomputed;
mismatch fails.
Fetching stops before the next unseen CID whose bounded body would exceed the
pinned block or byte limit. This is deterministic bounded streaming, not a claim
that an unknown remote block's size can be known before any bytes are read.
Depth is evaluated over the recorded DAG after each root's DFS closes. A root
that first makes the longest path exceed the pinned depth is the deterministic
depth cutoff; semantic results discovered under that root are buffered and not
admitted, while results from earlier fully validated roots remain available.

Entries are sorted by `(artifact_role, artifact_uri_or_empty, artifact_ref,
artifact_cid)`. `artifact_ref` is a physical retrieval hint, not semantic
identity. The manifest contains exactly one primary entry per semantic
descriptor; duplicate descriptors are invalid even when they use different
retrieval hints. Alternate archive locations belong in the external hand-off or
mirror manifest, not as duplicate score inputs. A URI-bearing artifact is
identified by its role, exact URI and CID; the same CID at another URI is a
distinct input and cannot be substituted or deduplicated. A URI-less artifact is
identified by its role and exact CID. Required
roles include every authority, commitment, permit, outcome, discipline,
evidence-event, policy-successor record/observation, witness refusal,
incomplete-event diagnostic, lifecycle
tombstone, source manifest, coverage record and membership artifact used by the
score; attester/item/subject dependency checkpoints; moderation and Sybil input
sets; probe artifacts when present; the algorithm executable; parameters; scope,
outcome and repetition policy bundles; and every content-addressed resolver or
record-inclusion input needed for replay. They also include exactly one
`evidence_policy_lineage` artifact matching the three lineage fields in the score
manifest and one `evidence_witness_policy_bundle` entry for every segment in that
artifact. Every successor segment also requires one
`evidence_policy_transition_bundle` entry matching its bridge, one
`policy_successor_record` entry for every candidate publication in its retained
slot proof bundle and
one `policy_successor_observation` or `witness_refusal` entry for each corresponding
required-witness disposition. Slot closures, membership artifacts and source
position/range/start proofs are mandatory typed descendants of the transition
bundle under the role registry. Every non-empty
mapping-artifact CID set in those transition bundles requires exactly one
URI-less `evidence_source_transition_mapping` entry per distinct CID. The current
`v1_nonweakening` profile requires that set to be empty.

An evidence-policy bundle is not an informal archive label. It has one closed
canonical projection:

```text
score_evidence_witness_policy_bundle {
  evidence_policy_bundle_schema_version
  witness_policy_cid
  witness_policy_hash
  compatibility_profile_cid
  compatibility_profile_hash
  evidence_proof_resource_profile_cid
  evidence_proof_resource_profile_hash
  policy_issuer_did_resolution_proof_cid
  evidence_policy_bundle_root
}

evidence_policy_bundle_root = SHA-256(
  "dina-curation-score-evidence-policy-bundle-v1" ||
  canonical_evidence_policy_bundle_without_root
)
```

The bundle entry's `artifact_cid` resolves to this projection and its
`artifact_hash` equals `evidence_policy_bundle_root`. Its content-addressed bundle
must also expose the exact canonical bytes for the policy, compatibility profile,
proof-resource profile and historical policy-issuer DID/key proof named by the
four member CIDs. No
extra member can change the canonical root or substitute for a missing required
member. The verifier recomputes the policy hash and issuer signature, the
compatibility-profile hash, proof-resource-profile hash and historical issuer-key
proof, then requires all profile and issuer fields to equal the opened policy. The entry carries
`source_policy_hash = witness_policy_hash` and
`retention_carrier = enclosing_score_checkpoint`; the score witness retains the
projection and all four member blocks through the score replay boundary. A
mutable policy URL, an archive that resolves the projection but omits any member
block, or successful origin lookup at initial scoring time is not a self-contained
replay bundle.

`active_witness_policy_hash` is the highest activated accepted evidence policy
responsible for new work at `generated_at_bucket`; it is not a declaration that
all score inputs were created under that policy. The lineage artifact makes the
cross-policy evidence set explicit:

```text
score_evidence_policy_lineage {
  lineage_schema_version
  witness_policy_lineage_id
  anchor_witness_policy_hash
  active_witness_policy_hash
  segments[] {
    policy_sequence
    witness_policy_ref
    witness_policy_cid
    witness_policy_hash
    predecessor_witness_policy_hash?
    source_manifest_ref
    source_manifest_cid
    policy_activation_bucket
    policy_successor_nomination_until_bucket?
    policy_new_work_until_bucket?
    policy_completion_until_bucket?
    policy_successor_source_id?
    segment_role: active | retired
    selected_coverage_heads[] {
      witness_did
      coverage_head_uri
      coverage_head_cid
      coverage_head_generation
      coverage_head_current_repository_proof_cid
      bounded_coverage_proof_cid
      covered_source_ranges[] {
        source_id
        start_cursor
        end_cursor
      }
      coverage_through_closed_at_bucket
    }
    predecessor_transition_bridge? {
      transition_proof_bundle_ref
      transition_proof_bundle_cid
      predecessor_terminal_heads_hash
      policy_successor_slot_id
      policy_successor_slot_proof_bundle_cid
      policy_successor_slot_proof_bundle_root
      successor_candidate_set_hash
      source_transitions[] {
        transition_rule_hash
        transition_kind
        predecessor_positions[] {
          source_id
          end_cursor
        }
        successor_positions[] {
          source_id
          start_cursor
        }
        mapping_rule_ref?
        mapping_rule_cid?
      }
      transition_mapping_hash
    }
  }
  segment_count
  evidence_policy_lineage_root
}
```

Segments sort by `policy_sequence`; coverage heads sort by `witness_did`; source
transitions sort by `transition_rule_hash`, and their positions and ranges sort
by source ID and canonical cursor encoding. The
lineage root uses `dina-curation-score-evidence-policy-lineage-v1` over the
canonical artifact without the root. It begins at the client-pinned anchor,
contains every contiguous successor through `active_witness_policy_hash`, and
repeats no sequence or policy hash. The fixed Phase 1 policy therefore produces
one segment and no transition bridge.

`evidence_policy_lineage_ref/cid` must resolve to these exact canonical bytes;
the verifier recomputes `evidence_policy_lineage_root`, requires it to equal both
the artifact and manifest copies, and requires the artifact's active hash to
equal the manifest's `active_witness_policy_hash`. Every segment policy ref/CID
must open the corresponding authenticated policy-bundle entry in the input-proof
manifest. A top-level active hash without that complete opening is not a policy
lineage.

No security-critical segment copy is authoritative. For each segment `s` and
its opened policy `p`, the verifier requires these exact equalities:

```text
s.policy_sequence == p.policy_sequence
s.witness_policy_hash == p.witness_policy_hash
s.predecessor_witness_policy_hash == p.predecessor_witness_policy_hash
s.source_manifest_cid == p.source_manifest_cid
s.policy_activation_bucket == p.policy_activation_bucket
s.policy_successor_nomination_until_bucket ==
  p.policy_successor_nomination_until_bucket
s.policy_new_work_until_bucket == p.policy_new_work_until_bucket
s.policy_completion_until_bucket == p.policy_completion_until_bucket
s.policy_successor_source_id == p.policy_successor_source_id
```

Optional-field presence must also match exactly. Segment one equals the pinned
anchor hash and has no predecessor or bridge. Exactly the final, highest-sequence
segment has `segment_role = active` and its hash equals
`active_witness_policy_hash`; every earlier segment has `segment_role = retired`
and exactly one transition bridge in its direct successor. The lineage artifact's
`witness_policy_lineage_id` must equal every opened policy's lineage ID and the
client-pinned value. The selected coverage-head witness IDs equal
`p.required_coverage_witness_dids`, and every opened head
must itself bind `p.witness_policy_hash` and `p.source_manifest_cid`. The direct
successor's source-transition instance set exactly equals the rule-hash set in
its opened source manifest. A copied-field mismatch, extra/missing active segment,
misplaced bridge or head from another policy is `invalid_manifest`; the verifier
never chooses the lineage copy over the authenticated policy.

The bridge digests are not implementation labels:

```text
predecessor_terminal_heads_hash = SHA-256(
  "dina-curation-policy-terminal-coverage-heads-v1" ||
  canonical_sorted_predecessor_selected_coverage_heads
)

transition_mapping_hash = SHA-256(
  "dina-curation-policy-source-transition-v1" ||
  predecessor_witness_policy_hash || witness_policy_hash ||
  canonical_sorted_source_transitions
)

successor_candidate_set_hash = SHA-256(
  "dina-curation-policy-successor-candidate-set-v1" ||
  policy_successor_slot_id ||
  canonical_sorted_distinct_valid_successor_policy_hashes
)
```

The referenced transition bundle has one closed canonical projection:

```text
score_evidence_policy_transition_bundle {
  transition_bundle_schema_version
  predecessor_witness_policy_hash
  successor_witness_policy_hash
  policy_successor_slot_id
  policy_successor_slot_proof_bundle_ref
  policy_successor_slot_proof_bundle_cid
  policy_successor_slot_proof_bundle_root
  successor_candidate_set_hash
  terminal_coverage_proofs[] {
    witness_did
    coverage_head_uri
    coverage_head_cid
    coverage_head_generation
    coverage_head_current_repository_proof_cid
    bounded_coverage_proof_cid
    historical_witness_did_resolution_proof_cid
  }
  successor_start_proofs[] {
    source_id
    start_cursor
    start_checkpoint_cid?
    source_start_proof_cid
  }
  mapping_rule_artifact_cids[]
  predecessor_terminal_heads_hash
  transition_mapping_hash
  transition_bundle_root
}

transition_bundle_root = SHA-256(
  "dina-curation-policy-transition-proof-bundle-v1" ||
  canonical_transition_bundle_without_root
)
```

Terminal proofs sort by witness DID, successor starts by source ID and mapping
artifacts by CID. The terminal-proof witness set must exactly equal the
predecessor policy's `required_coverage_witness_dids`; omission and substitution
fail. The successor-start source set must exactly equal the successor source
manifest, and the mapping-artifact CID set must equal the set required by its
transition rules. Primary counts and declared root sizes are checked before
recursive fetch; transitive blocks, bytes and depth use the score policy's pinned
registry and bounded streaming rules while referenced content is resolved. Under
`v1_nonweakening`, `mapping_rule_artifact_cids` is empty; a non-empty set is an
incompatible lineage before any mapping artifact is fetched or interpreted.

The verifier recomputes the successor slot from the predecessor, opens the exact
pre-activation slot proof bundle and requires its CID/root, boundaries, source,
required witness set and candidate-set hash to match the bridge. It reruns the
slot bundle's intrinsic candidate predicate without trusting observation/refusal
labels and requires `successor_witness_policy_hash` to be the sole valid hash.
The terminal drain proofs cannot add, remove or reinterpret a candidate. A missing
slot member, source proof or closure, a changed candidate set, zero valid hashes or
a selected branch from a fork preserves the slot's original terminal failure.

Every transition instance must open exactly one rule in the successor source
manifest, repeat its kind and mapping artifact exactly, and use position sets
equal to that rule's predecessor and successor ID sets. The complete instance set
must therefore be the same total partition as the signed rule set. A
`v1_nonweakening` bridge contains only one-to-one identical continuations and
proves the exact no-gap, no-overlap cursor relation under unchanged endpoint,
filter, ordering and completeness semantics. A structurally encoded retirement,
introduction, split, merge or content-addressed mapping is incompatible with that
profile even if its CIDs resolve. A future compatibility mode may admit one only
after defining the mapping semantics and verifier named in Section 6.4. Missing,
extra or duplicated rule hashes make the lineage unavailable.

For each predecessor source ID, every required predecessor coverage witness's
terminal head must close at the same canonical end cursor named by the transition
instance. For each successor source ID, the transition start cursor and transition-
bundle start proof must equal the opened successor source manifest's
`start_cursor`, optional start-checkpoint CID and authenticated source-start proof.
A disagreement is not resolved
by choosing one witness or cursor; it is `coverage_unavailable`. Under
`v1_nonweakening`, both positions must also equal
`CutoverCursor(opened_cursor_profile,
predecessor.policy_new_work_until_bucket)`. The predecessor owns the half-open
range below that position and the successor owns the range beginning there; an
entry's witness-local observation bucket cannot move it across the boundary.

`transition_proof_bundle_cid` opens the exact retained successor-slot proof bundle,
complete signed predecessor terminal coverage records and membership artifacts,
source position/range and successor start proofs, source-manifest bytes and
historical witness DID/key proofs needed to recompute the bridge. The verifier
recomputes its root and requires both embedded bridge hashes, the slot bundle root
and `successor_candidate_set_hash` to equal the lineage artifact and selected
successor. Its
`evidence_policy_transition_bundle` input entry uses
`retention_carrier: enclosing_score_checkpoint`; each current score witness
therefore preserves those transition bytes through that score's replay boundary
even after the predecessor coverage record's original availability promise has
expired. This archival carry-forward proves only policy/source continuity. It
does not renew any predecessor outcome, permit, checkpoint or standing
contribution beyond that artifact's own signed retention boundary.

If a future compatibility mode admits mapping artifacts, every corresponding
`evidence_source_transition_mapping` input entry has
`artifact_cid` equal to the source rule's `mapping_rule_cid`, no URI identity and
`source_policy_hash = successor_witness_policy_hash` and
`retention_carrier = enclosing_score_checkpoint`. The score witness retains the
exact mapping bytes, not merely the transition bundle's CID list, and the future
mode's verifier must recompute their canonical hash before evaluating the bridge.
A missing entry, archive without the mapping block, changed mapping bytes or
expired mapping carrier makes the policy lineage `coverage_unavailable`. This
rule is dormant for `v1_nonweakening`, whose mapping-entry count is exactly zero.

Every required coverage witness in a segment contributes one selected contiguous
coverage-chain head. For the active segment, it is the latest complete head used
by this score run. For a retired segment, it is the terminal head that accounts
for all targets admitted before the predecessor's new-work boundary and every
permitted drain disposition before its completion boundary. The transition
bridge proves, under the two pinned source manifests, the complete source-set
partition and every applicable cursor relation. A missing predecessor retirement,
unbound successor introduction or mapping that cannot prove its declared
relation makes the lineage `coverage_unavailable`; the scorekeeper cannot choose
the policy era with the more favorable records.

There is intentionally no half-closed score lineage during a scheduled drain. A
snapshot generated under a scheduled predecessor must expire no later than its
exclusive `policy_new_work_until_bucket`. From successor activation until every
required predecessor coverage witness has closed its terminal drain coverage and
the transition bridge verifies, no new public score is current; the client reports
`unavailable: policy_transition_pending` while retaining labelled history and
local recommendations. The first successor score then includes the completed
retired segment and all successor evidence through its active coverage heads.
This bounded availability pause prevents a scorekeeper from ignoring either
unfinished predecessor work or already-visible successor work.

All unexpired scoreable evidence created under a retired segment, plus every
still-live lifecycle, refusal, coverage, invalidation, no-suppression and replay
dependency for that evidence, remains in the input-proof manifest with its
original policy hash and retention boundary. A segment remains in the lineage
metadata after its evidence expires so the transition chain is reproducible,
and its transition proof bundle remains carried by the enclosing score
checkpoint, but expired evidentiary proof entries no longer contribute to a
fresh score. Whether an evidentiary entry remains required is derived from its
signed retention and the record-inclusion rules, never selected by the
scorekeeper.

The V1 lineage is cumulative and never prunes a retired segment or transition
bundle. If another scheduled activation would exceed the pinned score-policy
lineage entry/byte limits, clients report that standing will become unavailable
at cutover rather than dropping an old transition. A future compact prefix
accumulator requires a new versioned proof format and equivalence vectors; a
local database summary is not a valid substitute.

An exact URI/CID disposition is counted once even if adjacent source contracts
expose it. Predecessor drain work belongs to the predecessor segment; a response
first issued at or after successor activation belongs to the successor segment.
Conflicting ownership, a missing terminal head, a missing transition bridge or
an omitted retained predecessor dependency makes standing
`coverage_unavailable`. Cross-policy permit or checkpoint quorums remain
forbidden; the score merely aggregates independently valid evidence from the
complete lineage.

`source_policy_hash` is required for every entry derived from an evidence-witness
policy, including its authority observations, checkpoints, permits, refusals,
diagnostics, policy-successor publications/observations, coverage artifacts,
source manifest, policy bundle and any future source-transition mapping. It equals
the owning segment's exact policy hash; a successor candidate/disposition is owned
by the predecessor whose slot it fills, while a mapping is owned by the successor
segment that names its rule. It is forbidden on
the lineage artifact and cross-policy transition bundle themselves, and on inputs
such as algorithms or moderation sets that are not owned by one evidence-policy
segment. This turns what was previously an optional hint into a verified ownership
key whenever a policy produced the artifact.

The semantic dependency projection excludes retention-carrier fields and is
committed independently from the physical proof packaging:

```text
input_artifact_descriptor = canonical({
  artifact_role, artifact_uri?, artifact_cid,
  artifact_hash?, source_policy_hash?, encoded_size_bytes
})

input_artifact_descriptor_leaf = SHA-256(
  "dina-curation-score-input-artifact-member-v1" ||
  input_artifact_descriptor
)

input_artifact_set_root = SHA-256(
  "dina-curation-score-input-artifact-set-v1" ||
  MerkleRootV1(canonically ordered input_artifact_descriptor_leaf values)
)
```

The `input_checkpoint` contains this root. The proof manifest repeats it and
adds the retention carrier for every descriptor. It does not alter the semantic
input set merely by packaging the same bytes under a different witness archive
or changing `artifact_ref`; those changes alter the physical proof-manifest
bytes/CID but not `input_artifact_set_root`.

```text
input_proof_manifest_leaf = SHA-256(
  "dina-curation-score-input-proof-member-v1" ||
  canonical_input_proof_manifest_entry
)

input_proof_manifest_root = SHA-256(
  "dina-curation-score-input-proof-root-v1" ||
  proof_manifest_version || input_checkpoint_hash || input_artifact_set_root ||
  entry_count || transitive_block_count || transitive_encoded_bytes ||
  transitive_max_depth ||
  MerkleRootV1(canonically ordered input_proof_manifest_leaf values)
)
```

For `signed_artifact`, the entry names the exact checkpoint, permit, tombstone or
other signed carrier whose verified boundary equals
`effective_retention_until`; `retention_carrier_uri` and
`retention_carrier_cid` are required. An authority observation with
`retention_mode: dependent_commitment` uses the enclosing commitment or
discipline checkpoint as its carrier rather than inventing a missing boundary.
An incomplete-event diagnostic uses its exact signed coverage record as the
carrier; a witness refusal may use its own signed boundary or a later enclosing
coverage boundary, whichever is the declared effective carrier.
For immutable algorithm, parameter, policy and other reproducibility bytes with
no independent retention promise, `retention_carrier` is
`enclosing_score_checkpoint` and `effective_retention_until` equals the
manifest's derived `score_replay_until_bucket`; the score witness assumes that
storage obligation when it signs the snapshot checkpoint. In that mode
`retention_carrier_uri/cid` are forbidden because the checkpoint does not yet
exist when the proof manifest is hashed. The verifier uses the actual enclosing
checkpoint being evaluated and rejects the manifest outside that context.

The verifier first opens the policy-pinned role registry, validates every entry's
field-presence and root-size rule, then resolves the exact transitive closure under
the pinned block/byte/depth limits. It recomputes `transitive_block_count`,
`transitive_encoded_bytes`, `transitive_max_depth`, both manifest roots and the input checkpoint hash,
requires the descriptor root to equal the checkpoint's
`input_artifact_set_root`, rejects missing or extra required dependencies, and
computes:

```text
input_proof_retention_floor_bucket = min(
  every entry.effective_retention_until
)
```

The floor in the score manifest must equal that result. A bare database row,
mutable URI, unexplained aggregate root or dependency omitted from this manifest
cannot support a reproducible current score.

`score_channel_id` is a stable channel declared by the scorekeeper before a user
selects it; the V1 reference scorekeeper exposes one `reference` channel. A
scorekeeper may publish separately labelled algorithms only through distinct
channels. Clients pin the selected channel and never switch channels because a
different one currently has a more favorable value.

Each standing snapshot references the exact manifest and input checkpoint.
Evaluation maturity is derived from the embedded publication-permit quorum and
accepted outcome-checkpoint quorum under the pinned policy.
`generated_at_bucket`, ingestion time and attester `created_at` cannot substitute
for either proof or make an early outcome mature.

`input_proof_retention_floor_bucket` is the exact minimum
`effective_retention_until` recomputed from the canonical input-proof manifest,
including discipline, coverage and non-evidence reproducibility inputs rather
than an implementation-selected subset. The manifest must satisfy:

```text
generated_at_bucket < expires_at_bucket
score_replay_until_bucket = expires_at_bucket
  + score_witness_policy.maximum_score_snapshot_observation_quorum_delay_buckets
  + score_witness_policy.score_challenge_window_buckets
score_replay_until_bucket
  <= input_proof_retention_floor_bucket

if active_evidence_policy.rotation_mode == scheduled_successor:
  expires_at_bucket
    <= active_evidence_policy.policy_new_work_until_bucket
```

For each required coverage-witness chain in the active evidence-policy segment,
the input checkpoint resolves the deterministic live head slot, verifies the
current repository proof and monotonic generation, and selects its exact
contiguous `complete` bounded proof. A stale presenter-selected head is invalid.
`input_coverage_through_bucket` is the minimum
`coverage_through_closed_at_bucket` across those active selected heads; it is not chosen independently by the scorekeeper and a
faster witness or source cannot hide a lagging required one. A retired segment's
older terminal `closed_at_bucket` does not lower this current-input freshness
watermark forever. Instead, that segment must pass the separate terminal-
coverage and transition-bridge checks in the lineage artifact, and all of its
still-required evidence must remain in the input-proof manifest. Thus current
freshness and historical completeness are both mandatory but are not conflated
into one timestamp.

The evidence and score policies must use the same V1 bucket size and compatible
pinned clock source. The score witness verifies the active watermark and rejects
the whole run if any historical segment is incomplete:

```text
0 <= generated_at_bucket - input_coverage_through_bucket
generated_at_bucket - input_coverage_through_bucket
  <= maximum_score_input_lag_buckets

0 < expires_at_bucket - generated_at_bucket
expires_at_bucket - generated_at_bucket
  <= maximum_score_snapshot_validity_buckets
```

The later score checkpoint also bounds generation-to-public-observation delay as
specified in Section 12.3. Consequently `current` means current within the
selected score policy's disclosed freshness bounds, not that the score includes
every event that exists anywhere. A scorekeeper that stops recomputing cannot
keep an old favorable value current beyond the fixed validity bound.

The manifest is the authoritative run envelope. Every referenced snapshot and
its witness checkpoint must satisfy these exact equality rules:

```text
snapshot.input_checkpoint_hash == manifest.input_checkpoint_hash
snapshot.generated_at_bucket == manifest.generated_at_bucket
snapshot.expires_at_bucket == manifest.expires_at_bucket

checkpoint.input_coverage_through_bucket ==
  manifest.input_coverage_through_bucket
checkpoint.generated_at_bucket == manifest.generated_at_bucket
checkpoint.expires_at_bucket == manifest.expires_at_bucket
```

The checkpoint's snapshot URI/CID, series ID, logical key and sequence must also
equal the authenticated snapshot from its proof bundle. No verifier chooses one
copy as more favorable. An input-checkpoint mismatch is `invalid_manifest`; a
generation, coverage-watermark or expiry mismatch is `invalid_expiry`, and no
checkpoint is signed. Once the shared exclusive expiry boundary is reached,
clients mark the snapshot `expired`; retaining a copy as history does not make it
a current or reproducible score. A recomputation that omits expired evidence
publishes a new manifest, input checkpoint and snapshot rather than extending the
old expiry.

Scoring dependencies form an acyclic checkpoint graph. Run `N` may weight an
attester or item only from a finalized prior checkpoint such as `N-1`; it must
not consume a score produced by the same run or recursively use the curator
standing being computed. The manifest pins those dependency checkpoints,
scope and policy registry versions, subject resolver graph and complete evidence-
policy lineage so another implementation can replay the same graph rather than
merely the same arithmetic.

The current PeerLens score-version and conformance-vector mechanisms are the
foundation. Curator scoring extends them by freezing the complete parameter
set for each published version. Runtime parameter changes require a new
manifest identifier. The reference algorithm ships as a reproducible artifact,
such as a pinned container or deterministic WASM build, plus cross-runtime
conformance vectors. A source hash without a runnable environment is not a
complete reproducibility claim.

### 12.1 Input checkpoint

The checkpoint identifies the public record state used by the computation. It
must account for:

- ingester cursor;
- included PDS/repository set;
- accepted authority grant/revocation records, signed authority-observation
  quorums, authority source ranges, forks and unexplained gaps;
- curator-controlled invalidation events, complete evidence-event checkpoint
  quorums, portable event buckets and the artifacts needed to derive the
  affected tainted-evidence set;
- accepted commitment-, outcome- and evidence-event-checkpoint URI/CID sets and
  the content-addressed proof-archive manifest or root used for replay;
- accepted discipline-record/checkpoint URI/CID set, including verified-decline
  authority proofs and separately labelled unverified claim classes;
- witness source ranges, refusals, unexplained gaps and clock-health state under
  every segment of the pinned evidence-policy lineage, including each exact
  policy/source-manifest CID, the active segment's complete signed coverage-
  interval heads, every retired segment's terminal heads and transition bridge,
  and retained membership artifacts through every included cursor;
- subject resolver graph checkpoint and unresolved merge/split inputs;
- known dead letters or missing ranges;
- proof-bearing lifecycle tombstones, unresolved deletions and
  `erasure_unverifiable` source intervals;
- moderation exclusions;
- the canonical semantic `input_artifact_set_root` that the score input-proof
  manifest must later open completely;
- algorithm execution time.

Two scorekeepers are comparable only when their input and policy differences
are visible.

The canonical input checkpoint excludes the score manifest,
`input_proof_manifest_ref/cid/root`, score snapshot and score checkpoint. Those
later artifacts bind the already computed `input_checkpoint_hash`; including
any of them in that hash would create a self-reference. The semantic artifact
set root above still commits to every algorithm, parameter, policy, resolver and
evidence dependency used by the computation.

### 12.2 Multiple scorekeepers

Dina does not silently average arbitrary scores. The user chooses a local
policy:

- use one selected scorekeeper;
- show a median across compatible manifests;
- require agreement within a tolerance;
- show disagreement without collapsing it.

Scorekeeper disagreement is information, not automatically an error.

### 12.3 Anti-equivocation

A scorekeeper publishes each standing vector as an immutable
`com.dinakernel.curation.scoreSnapshot` record:

```text
score_snapshot_id
scorekeeper_did
score_channel_id
service_uri
scope_id
behavior_epoch
score_series_id
score_sequence
previous_snapshot_uri?
previous_snapshot_cid?
score_manifest_uri
score_manifest_cid
input_checkpoint_hash
standing_vector
standing_vector_hash
generated_at_bucket
expires_at_bucket
score_snapshot_schema_version
```

The repository author derived from the snapshot AT URI must equal
`scorekeeper_did`, and its referenced score manifest must be authored by that
same DID and channel. A stable series and sequence define the logical slot; the
manifest and input checkpoint are content, not escape hatches that create a new
slot:

```text
score_series_id = SHA-256(
  "dina-curation-score-series-id-v1" ||
  scorekeeper_did || score_channel_id || service_uri || scope_id || behavior_epoch
)

logical_score_key = SHA-256(
  "dina-curation-logical-score-key-v1" ||
  score_series_id || score_sequence
)

score_snapshot_id = SHA-256(
  "dina-curation-score-snapshot-id-v1" ||
  canonical_score_snapshot_without_id
)
```

Sequence one has no predecessor. Every later snapshot increments the sequence by
one and binds the exact URI/CID of its immediate predecessor. A scorekeeper must
not publish different snapshot content for one logical key or two children of
one predecessor. Fresh input or policy requires a new manifest or input-
checkpoint hash and advances this same series rather than overwriting the record
or manufacturing a new series. Repository inclusion proves current authorship,
but a PDS is not assumed to preserve deleted history.

The current snapshot is the unique, highest, contiguous, fully witnessed head of
the user-pinned series. A gap, two children, two contents for one sequence or a
URI/CID replacement makes that series `unavailable` and exposes the conflict;
neither clients nor witnesses choose a favorable branch. When the unique head
expires without a valid successor, older snapshots remain labelled history and
do not become current again.

Before Phase 1C exposes any score publicly, it ships and pins a separate
`preview-score-witness-policy-v1` artifact:

```text
accepted_score_witness_dids[]
required_score_coverage_witness_dids[]
score_snapshot_observation_quorum
score_source_manifest_ref
score_source_manifest_cid
score_input_role_registry_ref
score_input_role_registry_cid
score_input_role_registry_hash
score_live_head_resource_profile_ref
score_live_head_resource_profile_cid
score_live_head_resource_profile_hash
score_proof_feasibility_manifest_ref
score_proof_feasibility_manifest_cid
score_proof_feasibility_manifest_hash
score_coverage_checkpoint_interval_buckets
score_coverage_prefix_checkpoint_interval_buckets
maximum_score_coverage_prefix_finalization_delay_buckets
maximum_score_coverage_lag_buckets
maximum_uncompacted_score_coverage_intervals
maximum_score_coverage_prefix_proof_hashes
maximum_score_coverage_prefix_proof_bytes
maximum_score_coverage_finalization_conflicts
maximum_score_coverage_finalization_bytes
maximum_score_coverage_live_manifest_entries
maximum_score_coverage_live_manifest_bytes
maximum_score_coverage_head_encoded_bytes
maximum_score_coverage_head_conflicts
maximum_score_coverage_head_conflict_proof_bytes
maximum_score_coverage_head_catchup_generations
maximum_score_coverage_head_generation_gap_buckets
maximum_score_coverage_head_generations_per_bucket: 1
maximum_score_coverage_membership_entries
maximum_score_coverage_membership_bytes
maximum_score_input_proof_entries
maximum_score_input_proof_manifest_bytes
maximum_score_input_proof_blocks
maximum_score_input_proof_bytes
maximum_score_input_proof_depth
maximum_score_lineage_entries
maximum_score_lineage_bytes
maximum_score_snapshot_checkpoint_delay_buckets
maximum_score_snapshot_observation_quorum_delay_buckets
maximum_score_input_lag_buckets
maximum_score_publication_lag_buckets
maximum_score_snapshot_validity_buckets
score_challenge_window_buckets
required_score_snapshot_proof: record + signed repo commit + MST path + DID proof
required_score_input_proof_manifest: canonical complete artifact + retention carriers
required_score_lineage_proof: cumulative prior coverage + current source proof
required_score_coverage_membership_artifact: canonical entries + subset roots + content CID
required_score_coverage_prefix_finalization: signed repository record + exact prefix/proof/manifest equality
required_score_coverage_head_proof: deterministic head record + live current-repo commit + MST path + DID proof + bounded status proof
signed_score_refusal_log: required
signed_score_coverage_chain: required
clock_source_id
maximum_clock_uncertainty_seconds
clock_rollback_policy: fail_closed
score_witness_policy_id
score_witness_policy_version
score_witness_policy_hash
policy_issuer_did
policy_issuer_key_id
policy_issuer_did_resolution_proof_cid
policy_issuer_signature
```

The content-addressed `score_live_head_resource_profile` is separate from the
immutable score input-proof manifest because currentness is refreshed at read
time. Its closed projection is:

```text
score_live_head_resource_profile {
  score_live_head_resource_profile_version
  proof_block_retrieval_encoding: raw_cid_block_v1
  root_rules[] {
    proof_kind: current_head | catchup_head_version | head_conflict
    root_schema_id
    maximum_root_encoded_bytes
    maximum_transitive_blocks_per_root
    maximum_transitive_encoded_bytes_per_root
    maximum_transitive_depth_per_root
  }
  schema_rules[] {
    schema_id
    child_cid_edges[] {
      field_path
      child_schema_id
      cardinality: exactly_one | zero_or_one | list
    }
    maximum_direct_children
  }
  maximum_live_head_roots_per_operation
  maximum_transitive_blocks_per_operation
  maximum_transitive_encoded_bytes_per_operation
  maximum_transitive_depth
  maximum_feasibility_manifest_encoded_bytes
  maximum_feasibility_fixture_encoded_bytes
  maximum_network_bytes_per_operation
  maximum_redirects_per_fetch
  maximum_concurrent_fetches_per_operation
  maximum_fetch_duration_ms
  score_live_head_resource_profile_hash
}
```

Its hash uses
`dina-curation-score-live-head-resource-profile-v1` over canonical bytes without
the hash. Ordering, typed traversal, CID deduplication, cycle rejection,
longest-path depth, bounded streaming and intrinsic-versus-transport failure
classification are exactly those of the evidence proof-resource profile. The
root cap must be at least the checked product
`required_score_coverage_witness_dids.length *
(2 + maximum_score_coverage_head_catchup_generations)`, covering one current
head, the maximum catch-up versions and one conflict root per witness. All
required heads, catch-up versions and conflict artifacts share one aggregate
operation budget rather than receiving a fresh budget per witness or nested
proof. Canonical excess is `policy_limit`; network, redirect, concurrency or
deadline exhaustion is `coverage_unavailable`. The profile is immutable and its
ref/CID/hash are covered by `score_witness_policy_hash`.
The score feasibility-manifest ref/CID/hash are also mandatory policy fields and
covered by that hash. The manifest's score policy-projection binding and every
fixture must verify before activation; it cannot be generated locally after a
client sees the required witness count.

The policy-bound feasibility manifest and per-root/worst-case procedure above
also apply to this profile with `profile_family: score`. Its complete fixture has
one current-head root per required score witness. Its conflict fixture adds one
conflict root per witness, and its maximum-catch-up fixture adds exactly
`maximum_score_coverage_head_catchup_generations` predecessor-version roots per
witness **and** one conflict root per witness, exercising the largest valid
coexisting root set of `2 + maximum_score_coverage_head_catchup_generations` per
witness. For each operation, checked worst-case block and byte sums multiply each
root kind's per-root maximum by its exact count and by
`required_score_coverage_witness_dids.length`; depth is the maximum used per-root
depth. All CIDs are assumed distinct and no per-witness budget reset is allowed.
In those generic inequalities, `maximum_total_roots_per_operation` maps to this
profile's `maximum_live_head_roots_per_operation`; all other aggregate field
names are identical.
The aggregate canonical limits and network-byte limit must admit those sums.
Consequently every individually admitted set through the declared catch-up count
fits the shared profile; a positive policy/profile pair that passes only a
minimum-sized example is malformed and must not be activated.

All score-policy `_buckets` fields are exact non-negative counts of the V1
3,600-second bucket; the coverage interval, coverage-prefix interval, maximum
prefix-finalization delay, maximum coverage lag, snapshot validity and challenge
window are positive. Every score membership, finalization-conflict, finalization-
byte, live-manifest, head-byte, head-conflict, head-conflict-proof-byte, head-
catch-up, head-generation-gap, input-proof and lineage entry, block, byte and
depth limit is a positive integer. V1 requires exactly one maximum score-
coverage head generation per closed state bucket and a semantic update or
retention renewal no later than the configured generation gap. Primary
manifest size, entry count and
declared root sizes are checked before recursive resolution.
Every canonical and operational limit in the live-head resource profile,
including both feasibility-artifact byte limits, is positive except
`maximum_redirects_per_fetch`, which may be zero.
`accepted_score_witness_dids` is non-empty, canonically sorted and duplicate-free;
`score_snapshot_observation_quorum` is between one and its length, inclusive.
`required_score_coverage_witness_dids` is a non-empty, canonically sorted subset
fixed before a snapshot exists. Every listed witness must provide its complete
score-source coverage proof even when the observation quorum is smaller; clients
cannot choose the quorum whose source view hides a sibling or refusal. The
uncompacted score-coverage, prefix-proof, finalization, live-manifest and head
limits are positive and are enforced before resolving a cumulative prefix, head
or head-conflict proof. An oversized artifact makes score coverage unavailable;
it does not authorize omission.
Using checked arithmetic, the score policy must satisfy:

```text
score_coverage_prefix_checkpoint_interval_buckets
  + maximum_score_coverage_prefix_finalization_delay_buckets
  <= 1 + maximum_score_snapshot_checkpoint_delay_buckets
```

so even an empty raw score interval remains promised through prefix
finalization. V1 additionally requires:

```text
maximum_score_coverage_lag_buckets
  == score_coverage_checkpoint_interval_buckets
```

This equality gives a current score one declared, auditable freshness cadence;
a later version may allow a different positive bound only with new vectors and
product labelling.
`maximum_score_input_proof_manifest_bytes` bounds the canonical proof-manifest
block itself and is separate from `maximum_score_input_proof_bytes`, which means
the exact unique transitive encoded-byte sum defined above. The transitive block,
byte and depth limits are then enforced while each CID block is streamed, before
unbounded allocation or semantic decoding; a verifier never relies on an
untrusted `Content-Length`. The policy hash covers every field, the exact score-
input role registry, score live-head resource profile, score feasibility
manifest ref/CID/hash and content-addressed score source manifest, which uses the
canonical source-contract schema from Section 6.4.
Changing any witness, source, quorum, delay, proof or clock rule changes
`score_witness_policy_hash`.
The score-policy hash and issuer signature use
`dina-curation-score-witness-policy-hash-v1` and
`dina-curation-score-witness-policy-v1` with the same
canonical-without-hash-and-signature envelope rule as the evidence witness
policy. The bundled client pin fixes both the expected issuer and hash.

The preview may use the same first-party AppView process for outcome and score
witnessing, but the policy hashes and duties remain distinct. Quorum one provides
durable detection, not organizational independence. Its
`accepted_score_witness_dids` and `required_score_coverage_witness_dids` arrays
both contain exactly that first-party DID and its observation quorum is one.

The score witness also publishes contiguous
`com.dinakernel.curation.scoreWitnessCoverage` intervals with a canonical
projection rather than an implementation-defined health log:

```text
score_coverage_interval_id
score_coverage_kind: interval
score_source_manifest_cid
previous_score_coverage_uri?
previous_score_coverage_cid?
source_ranges[] {
  source_id
  start_cursor
  end_cursor
  source_range_proof_ref
  source_range_proof_cid
}
score_membership_artifact_ref
score_membership_artifact_cid
score_membership_count
processed_snapshot_root
processed_snapshot_count
snapshot_checkpoint_root
snapshot_refusal_root
unexplained_gaps[]
deadline_violations[]
clock_health_state
opened_at_bucket
closed_at_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
score_witness_policy_id
score_witness_policy_version
score_witness_policy_hash
score_coverage_schema_version
witness_signature
```

The interval ID and signature use
`dina-curation-score-witness-coverage-id-v1` and
`dina-curation-score-witness-coverage-v1`. Intervals form one append-only URI/CID
chain per score-witness policy and score-source manifest.

Score coverage uses the same bounded-prefix rule as evidence coverage. Before
the raw suffix reaches `maximum_uncompacted_score_coverage_intervals` or a prefix
resource limit, the witness publishes a tagged
`com.dinakernel.curation.scoreWitnessCoverage` record:

```text
score_coverage_prefix_id
score_coverage_kind: compacted_prefix
score_source_manifest_cid
prefix_sequence
previous_prefix_uri?
previous_prefix_cid?
compacted_through_score_coverage_uri
compacted_through_score_coverage_cid
compacted_through_closed_at_bucket
compacted_interval_count
cumulative_interval_count
cumulative_interval_chain_hash
prefix_consistency_proof_ref
prefix_consistency_proof_cid
terminal_source_cursors[] {
  source_id
  end_cursor
  source_position_proof_ref
  source_position_proof_cid
}
live_score_dependency_manifest_ref
live_score_dependency_manifest_cid
live_score_dependency_root
live_score_dependency_count
created_at_bucket
usable_from_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
score_witness_policy_id
score_witness_policy_version
score_witness_policy_hash
score_coverage_schema_version
witness_signature
```

Interval and prefix fields are mutually exclusive under the tagged schema. The
first prefix has sequence one; successors increment once and bind the exact prior
prefix URI/CID. The next raw interval points to the prefix URI/CID as its previous
score-coverage record. Positive compacted counts, checked cumulative-count
arithmetic, exact sorted source sets, authenticated terminal cursors and creation-
after-closure/deadline rules are identical to the evidence prefix, substituting
`score_coverage_prefix_checkpoint_interval_buckets`. The rolling accumulator
and consistency proof use the exact closed evidence-prefix attachment schema
with `coverage_family: score`, `policy_hash = score_witness_policy_hash`, the
score source manifest and score-specific
domains
`dina-curation-score-coverage-prefix-empty-v1`,
`dina-curation-score-coverage-prefix-leaf-v1`,
and `dina-curation-score-coverage-prefix-step-v1`. The prefix signature and ID use
`dina-curation-score-coverage-prefix-v1` and
`dina-curation-score-coverage-prefix-id-v1`. Leaves bind each interval's URI, CID,
canonical `{ coverage_record_uri: score_coverage_interval_uri,
coverage_record_cid: score_coverage_interval_cid, source_ranges,
retention_until }` projection. The consistency proof's ordered interval entries
resolve score-coverage records and their repository proofs, and all count, link,
cursor and resulting-hash rules apply without reinterpretation. Hash count and
encoded bytes must remain within the score policy's prefix limits.
Repository authorship, immutable retry, sibling-fork and deletion behavior are
identical to the evidence prefix under `score_witness_policy_hash`.

The live-score-dependency manifest uses the exact closed
`coverage_live_interval_manifest` schema with `coverage_family: score` and one
entry for each still-live compacted score interval. Its interval entry points to
that record's exact `score_membership_artifact_ref/cid`; typed traversal reaches
every unexpired checkpoint, refusal, snapshot/proof block and fork/no-suppression
dependency. A successor carries all predecessor entries whose exclusive
retention is later than its `usable_from_bucket`; removal, root/count/hash
mismatch or retention shortening fails the consistency proof. Exact CID
traversal, deduplication, cycle and byte accounting use the pinned score proof
schemas and transitive proof rules.

```text
usable_from_bucket = created_at_bucket + score_challenge_window_buckets

retention_until = max(
  every live score dependency's effective retention boundary,
  usable_from_bucket
    + score_coverage_prefix_checkpoint_interval_buckets
    + score_challenge_window_buckets
    + maximum_score_coverage_prefix_finalization_delay_buckets
)
```

Every compacted raw record must remain retrievable through the exclusive
finalization deadline. At or after `usable_from_bucket`, the witness publishes
`com.dinakernel.curation.scoreCoveragePrefixFinalization` using the exact closed
`coverage_prefix_finalization` projection, timing, conflict-set, chain, retention,
repository-authorship and equivocation rules above, with
`coverage_family: score`. It uses the same finalization domains because the
family, score policy hash and score source manifest are inside every canonical
projection. Its canonical encoded bytes and conflict count must not exceed
`maximum_score_coverage_finalization_bytes` and
`maximum_score_coverage_finalization_conflicts`, checked before conflict-list
allocation. Score finalization uses the same deterministic scan, pre-operation
cutoff, all three overflow reasons, reason/failure field-presence rules, retained-
prefix selection and accepted-witness assertion boundary as evidence coverage.
Once a complete incompatible pair has been proven and fits, later canonical or
operational failure remains bounded `overflow` conflict; the witness never
allocates or serializes an over-limit list. A valid score prefix requires one unique timely
`valid`, cumulatively clean
finalization; a current, overflow or historical conflict, missing/late
finalization or second branch makes it unavailable.

The score witness maintains
`com.dinakernel.curation.scoreCoverageHead` using the exact generic head schema,
`DigestRkeyV1` slot, monotonic generation, live current-repository proof,
cumulative-status and retention rules above with `coverage_family: score`. Its
canonical record must not exceed
`maximum_score_coverage_head_encoded_bytes`. Until finalization, the head's
bounded proof contains and compares the raw path; afterward it selects the latest
unexpired finalized prefix, its live dependencies and the contiguous raw suffix.
Any head-conflict proof must remain within
`maximum_score_coverage_head_conflicts` and
`maximum_score_coverage_head_conflict_proof_bytes`. The current head, every
catch-up version and all bounded/conflict descendants count once toward the
separate live-head profile's aggregate roots, blocks, encoded bytes, depth and
transport budgets across the complete required-witness set. Limits are checked
before list allocation and during bounded recursive fetch; they are not reset per
head and do not consume or borrow from the immutable score input-proof envelope.
Every DID in `required_score_coverage_witness_dids` must supply this
proof independently; a snapshot-observation quorum cannot replace the exact
coverage set. The selected snapshot must have a checkpoint disposition in every
required coverage proof. A required witness's signed refusal, undecidable gap or
conflicting sibling makes the score unavailable even when `q` other accepted
witnesses checkpointed it.

`score_membership_artifact_cid` resolves to a canonical, sorted artifact of:

```text
score_coverage_entry {
  snapshot_uri
  snapshot_cid
  source_id
  source_cursor
  source_position_proof_ref
  source_position_proof_cid
  disposition: snapshot_checkpoint | snapshot_refusal
  artifact_uri?
  artifact_cid
}
```

The artifact uses the canonical ordering and `MerkleRootV1` construction from
Section 6.4 with score-specific domains:

```text
score_coverage_leaf = SHA-256(
  "dina-curation-score-coverage-member-v1" || canonical_score_coverage_entry
)

ScoreCoverageSubsetRootV1(label, leaves) = SHA-256(
  "dina-curation-score-coverage-root-v1" || label ||
  MerkleRootV1(canonically ordered leaves)
)
```

The fixed labels are the corresponding root field names. The witness record
binds the artifact CID and count; a verifier resolves it and recomputes
`processed_snapshot_root`, `snapshot_checkpoint_root`,
`snapshot_refusal_root` and `processed_snapshot_count`. Every score snapshot in
a closed source interval is accounted for exactly once by a snapshot checkpoint
or signed refusal. A root or count without the retrievable membership artifact
is `coverage_unavailable`, not proof of exhaustive processing. A score refusal
binds the exact snapshot URI/CID, source cursor, bounded reason, observation
bucket, witness key and score-policy hash under the domain
`dina-curation-score-snapshot-refusal-v1`.

The refusal is an immutable
`com.dinakernel.curation.scoreSnapshotRefusal` record:

```text
snapshot_uri
snapshot_cid
snapshot_proof_bundle_cid?
source_id
source_cursor
source_position_proof_ref
source_position_proof_cid
reason_code: invalid_repository_proof | invalid_manifest |
             invalid_expiry | unavailable_artifact |
             unsupported_schema | policy_limit
observed_at_bucket
validated_snapshot_expires_at_bucket?
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
score_witness_policy_id
score_witness_policy_version
score_witness_policy_hash
score_snapshot_refusal_schema_version
witness_signature
```

`snapshot_proof_bundle_cid` is required whenever repository authorship and the
snapshot envelope validate and the refusal occurs at a later manifest, expiry or
policy check. `validated_snapshot_expires_at_bucket` is present only when the
witness fully validated that field despite refusing the snapshot for another
bounded reason.
The signature uses `dina-curation-score-snapshot-refusal-v1` over the canonical
record without its signature. One witness emits one immutable decision per
`(score_witness_policy_hash, snapshot_uri, snapshot_cid)`; an idempotent retry is
byte-identical, while a different decision for the same key is witness
equivocation. Its exclusive retention boundary is:

```text
refusal_base_retention_until = observed_at_bucket + 1
  + maximum_score_snapshot_observation_quorum_delay_buckets
  + score_challenge_window_buckets

retention_until = max(
  refusal_base_retention_until,
  validated_snapshot_expires_at_bucket
    + maximum_score_snapshot_observation_quorum_delay_buckets
    + score_challenge_window_buckets
    if that field is present
)
```

A refused record whose retained proof establishes valid scorekeeper authorship,
series, sequence and predecessor still participates in sibling-fork and same-key
equivocation detection. A witness cannot hide a structurally valid conflicting
snapshot by putting it under the refusal root instead of the checkpoint root.

The checkpoint/refusal deadline starts when the snapshot first appears at the
witness's pinned source cursor and is
`maximum_score_snapshot_checkpoint_delay_buckets`. The witness closes each
coverage interval within `score_coverage_checkpoint_interval_buckets`; a missed
target deadline is recorded, while an overdue, missing or forked coverage
interval makes affected scores `coverage_unavailable`. Each interval coverage
record's exclusive retention boundary is:

```text
retention_until = max(
  every member checkpoint or refusal retention_until,
  closed_at_bucket + 1
    + maximum_score_snapshot_checkpoint_delay_buckets
    + score_challenge_window_buckets
)
```

Without a complete chain through the snapshot cursor, the score is
`coverage_unavailable` rather than current.
The score witness retains every score membership artifact through its coverage
record's `retention_until` and includes it in archive export and hand-off
manifests.

Each accepted score witness publishes a canonical
`com.dinakernel.curation.scoreSnapshotCheckpoint`:

```text
snapshot_uri
snapshot_cid
logical_score_key
score_series_id
score_sequence
input_coverage_through_bucket
generated_at_bucket
expires_at_bucket
series_lineage_artifact_ref
series_lineage_artifact_cid
series_lineage_root
series_coverage_prefix_hash
snapshot_proof_bundle_ref
snapshot_proof_bundle_cid
observed_at_bucket
retention_until
witness_did
witness_key_id
witness_did_resolution_proof_ref
witness_did_resolution_proof_cid
score_witness_policy_id
score_witness_policy_version
score_witness_policy_hash
score_snapshot_checkpoint_schema_version
witness_signature
```

The signature uses `dina-curation-score-snapshot-checkpoint-v1`. The proof bundle
contains the snapshot record block, its referenced score-manifest record block,
signed scorekeeper-repository commits and MST paths for both records, repository
revisions and versioned scorekeeper DID/key proofs. It also retains every
entry in the canonical score input-proof manifest, verifies every retention
carrier and retains all `enclosing_score_checkpoint` entries through the
checkpoint boundary. A URI/CID without retrievable content is insufficient.
Before signing, the witness enforces every manifest/snapshot/checkpoint equality
defined in Section 12 and derives retention only from that shared run envelope.
Each witness keeps one immutable checkpoint per
`(score_witness_policy_hash, snapshot_uri, snapshot_cid)`; the same CID at
another URI is a distinct target.

`series_lineage_artifact_cid` resolves to a canonical cumulative proof for the
snapshot's selected series:

A source record enters a score series only after a bounded admission gate
verifies its signed repository proof, derives the repository author, parses a
supported outer snapshot schema, recomputes `score_series_id` from the
author/channel/service/scope/epoch fields and validates the sequence/predecessor
envelope. A copied scorekeeper DID, attacker-supplied series ID, unsupported
envelope or invalid repository proof remains accounted for by a source-coverage
refusal but is excluded from every series lineage. It cannot consume
`maximum_score_lineage_entries` for another scorekeeper. That per-series limit is
applied only after admission; separate global source-coverage limits still bound
malformed traffic.

A repository-authenticated admitted member that later fails manifest, artifact,
expiry or another deeper policy check remains in lineage as
`authenticated_refusal`. It can therefore expose a same-key or sibling conflict
instead of being hidden under a refusal root.

```text
score_series_lineage_artifact {
  score_series_id
  through_sequence
  score_source_manifest_cid
  prior_coverage_chain_head_uri?
  prior_coverage_chain_head_cid?
  prior_coverage_head_generation?
  prior_coverage_head_current_repository_proof_cid?
  prior_bounded_coverage_proof_cid?
  current_snapshot_source_id
  current_snapshot_source_cursor
  current_snapshot_source_proof_cid
  entries[] {
    score_sequence
    snapshot_uri
    snapshot_cid
    previous_snapshot_uri?
    previous_snapshot_cid?
    structural_status: canonical | authenticated_refusal
    checkpoint_or_refusal_uri?
    checkpoint_or_refusal_cid?
    proof_bundle_cid
  }
}
```

Entries are canonically sorted by `(score_sequence, snapshot_uri, snapshot_cid)`.
The current snapshot entry omits `checkpoint_or_refusal_uri/cid` to avoid a hash
cycle: the enclosing checkpoint signs the lineage artifact and current snapshot
proof together. Every prior admitted entry carries its exact checkpoint or
refusal reference. `sibling_conflict` is a verifier-derived
relationship among two or more admitted members, never an attacker-selected
entry status.
`series_lineage_root` is:

```text
series_lineage_leaf = SHA-256(
  "dina-curation-score-series-lineage-member-v1" ||
  canonical({
    score_sequence, snapshot_uri, snapshot_cid,
    previous_snapshot_uri?, previous_snapshot_cid?, structural_status
  })
)

series_lineage_root = SHA-256(
  "dina-curation-score-series-lineage-root-v1" ||
  MerkleRootV1(canonically ordered series_lineage_leaf values)
)
```

`series_coverage_prefix_hash` uses this closed projection:

```text
series_coverage_prefix_hash = SHA-256(
  "dina-curation-score-series-coverage-prefix-v1" ||
  canonical({
    score_source_manifest_cid,
    prior_coverage_chain_head_uri?, prior_coverage_chain_head_cid?,
    prior_coverage_head_generation?,
    prior_coverage_head_current_repository_proof_cid?,
    prior_bounded_coverage_proof_cid?,
    current_snapshot_source_id, current_snapshot_source_cursor,
    current_snapshot_uri: snapshot_uri,
    current_snapshot_cid: snapshot_cid,
    current_snapshot_source_proof_cid
  })
)
```

The prior head fields are all absent for sequence one and otherwise all present.
They bind the deterministic head slot's exact generation, live current-repository
proof and complete bounded score-coverage proof through that head. Before the
first finalized compacted prefix, that proof is the raw chain from the source-
manifest start. Thereafter it is the deterministic head's selected unexpired,
uniquely finalized prefix, its complete live-score-dependency manifest and every
contiguous raw interval after it. The prefix's cumulative rolling hash and consistency chain commit to the expired
raw history without requiring those no-longer-scoreable bytes in every proof.
Sequence one uses the canonical absent lineage-head encoding, but its separately
closed current coverage interval must still connect to the source-manifest start
or an accepted prefix rooted there. The artifact contains or content-addresses
that bounded coverage proof and every still-live snapshot/refusal payload and
repository proof needed to establish that no earlier structurally valid series
member was omitted. A copied prefix, head, position or current source proof from
another source manifest or snapshot fails the recomputed hash.

Witness-specific checkpoint/refusal and proof-bundle references are carried by
the artifact and its CID but excluded from `series_lineage_root`, so independent
witnesses can agree on one semantic history while retaining different source
proofs. A complete score-observation quorum must agree on `score_series_id`,
`score_sequence`, `logical_score_key`, snapshot URI/CID and
`series_lineage_root`; disagreement is an incomplete/conflicting quorum, never a
set from which the client chooses a favorable witness.

The current snapshot's checkpoint cannot include the later coverage record that
will contain that checkpoint without creating a hash cycle. After checkpointing,
the witness therefore closes the ordinary score-coverage interval containing the
current source position and checkpoint. The score is not current until that
separate interval is signed, retained and verified. A successor lineage artifact
then treats that closed interval as part of its prior coverage prefix.

That historical inclusion proof is necessary but not sufficient for a *current*
label. At verification bucket `v`, derived by the verifier from the pinned policy
clock rather than accepted from a response wrapper, the client refreshes each
exact required score witness's deterministic head slot from the live pinned
repository, verifies its current signed repository commit/MST proof, monotonic
generation and cumulatively clean `complete` status, performs any required
bounded catch-up to the locally persisted CID, and opens its bounded proof. The
complete required-witness refresh shares the score live-head resource profile's
single aggregate budget.
For every required head, checked arithmetic must satisfy:

```text
0 <= v - latest_required_head.coverage_through_closed_at_bucket

v - latest_required_head.coverage_through_closed_at_bucket
  < maximum_score_coverage_lag_buckets
```

For a finalized prefix followed by no raw suffix,
`coverage_through_closed_at_bucket` equals the authenticated `closed_at_bucket`
of its compacted-through interval from the consistency attachment/finalization
summary, not prefix creation or finalization time. The client must contact the
authenticated live witness PDS long enough to establish the current head. An
unreachable repository, missing head, fork, rollback, negative age
or age at or beyond the exclusive bound, over-limit catch-up or missing
continuity step makes the score stale/unavailable. An
old all-valid bundle proves only historical status; current status is a dynamic
freshness claim and cannot be carried indefinitely as an offline token.

The current snapshot's series lineage requires exactly one canonical entry at
every sequence from one through `score_sequence`, exact predecessor URI/CID
linkage and no structurally valid sibling. Locally observing a later sibling
immediately suppresses current display. Portable detection must appear in the
next required coverage closure, so even a client replaying the prior clean head
loses current status no later than `maximum_score_coverage_lag_buckets`. The next
coverage and lineage artifacts record the conflict; an older checkpoint is then
history, not a favorable branch the client may retain as current.

The witness's current checkpoint retention promise covers the lineage artifact,
selected deterministic score-coverage head version/current-repository/bounded
proof, the prefix and finalization selected by that head, raw suffix,
live-dependency manifest and
every referenced still-live predecessor checkpoint, refusal, membership artifact
and repository proof through that checkpoint's own `retention_until`. Expired raw
coverage bytes are represented only by the cumulative prefix root and cannot
regain score weight. Each valid successor therefore rolls the independently
replayable series proof forward without making the source-coverage proof grow
from genesis. If no successor arrives, the head expires and no older snapshot
reactivates. The score-sequence lineage itself remains cumulative in Phase 1; a
later compact series accumulator must preserve identical fork, predecessor and
anti-omission semantics under new conformance vectors.

The portable score-observation bucket is the q-th earliest valid bucket, where q
is `score_snapshot_observation_quorum`, and must complete within
`maximum_score_snapshot_observation_quorum_delay_buckets`. Let `o` be that
portable q-th bucket. Every selected checkpoint and the complete quorum must
satisfy:

```text
generated_at_bucket <= observed_at_bucket < expires_at_bucket
0 <= observed_at_bucket - generated_at_bucket
observed_at_bucket - generated_at_bucket
  <= maximum_score_publication_lag_buckets
o < expires_at_bucket
```

A late or already expired snapshot receives `invalid_expiry`; the witness cannot
create an immediately expired checkpoint and call it a valid historical
observation. Each accepted checkpoint uses:

```text
retention_until = score_replay_until_bucket
  = expires_at_bucket
    + maximum_score_snapshot_observation_quorum_delay_buckets
    + score_challenge_window_buckets
```

Two independently verifiable witnessed bundles with different snapshot content
for one logical key, or two witnessed children of one predecessor, are evidence
of equivocation even if one origin record is later deleted. A client marks the
affected series unavailable and exposes the scorekeeper conflict until it is
resolved under a future signed policy; it does not select a branch. A snapshot
is not current until its complete score-witness quorum exists, and it stops being
current at `expires_at_bucket`. Unwitnessed snapshots and reference-only archives
cannot support public standing. A client also rejects `current` when the manifest
or checkpoint violates the pinned input-lag, publication-lag or validity bound;
displaying the old value as labelled history does not extend those bounds.

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

- A public-commitment watcher cannot create a scoreable outcome without the
  runtime-signed recipient receipt, response preimage and any profile-required
  item proof.
- At most one active outcome per attester, receipt and subject.
- Correlated outcomes in one interaction series are cooldown-, decay- and
  window-capped under the scope's pinned repetition policy.
- Outcomes from closely coordinated attesters receive reduced effective
  weight.
- Outcomes from the curator operator or declared affiliates carry no public
  standing weight but may remain visible.
- Novelty uplift is capped and coordination-adjusted.
- A large number of low-standing outcomes cannot outweigh a smaller body of
  established independent evidence merely through volume.
- Scorekeepers expose effective sample size after weighting, not only raw
  record count.
- Ordinary PeerLens reviews and curation outcomes from the same interaction are
  linked and never counted as two independent curator outcomes.
- Scope slicing, rapid service replacement, unexplained within-epoch drift and
  selective commitment are explicit anomaly inputs.
- Recommendation-set size and original rank constrain outcome credit.

These measures reduce manipulation. They do not prove that every outcome is
truthful. They also cannot reveal every rejected query or uncommitted private
response. Standing therefore remains conditional on observable evidence.

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

Validation of untrusted public records is deliberately staged to prevent
verification amplification:

1. Enforce available root encoded-size, nesting, item-count and frozen-schema
   limits before expensive allocation or canonicalization.
2. Perform local structural checks, canonical hashing, author derivation,
   duplicate/nullifier rejection and signatures for which proof material is
   already present or cached.
3. Only after those checks pass, resolve immutable records and fetch
   content-addressed proof bundles. Evidence witnesses and permit endpoints apply
   their policy-pinned proof-resource profile, including its operational fetch
   budgets. Score verification applies the score-input role registry and signed
   score-policy block/byte/depth limits; implementations also enforce finite local
   fetch budgets without treating local transport exhaustion as intrinsic input
   invalidity. All canonical limits are cumulative during bounded streaming;
   fetches coalesce by CID and cache both valid content and bounded negative
   results. Canonical excess is `policy_limit`; transport-budget exhaustion is
   `unavailable_artifact`.
4. Run complete proof-chain, policy, horizon and scoring validation only after
   every required artifact is present. A malformed record must not trigger an
   unbounded number of attacker-selected network requests. Early nullifier
   checks are read-only; a nullifier lifecycle slot changes atomically only after
   complete validation, so an invalid original, amendment, revocation or
   unbound deletion event cannot burn a legitimate receipt, resurrect a
   predecessor or replace valid evidence.

The private permit endpoint applies the same bounded-validation order before any
remote proof fetch. It authenticates and rate-limits the requester first, enforces
`maximum_permit_request_encoded_bytes`, root count and the cumulative proof-
resource-profile limits, rejects malformed local hashes, then resolves the capped
immutable proof set. The endpoint durably separates the
receipt binding, revision-scoped outcome-core slot and request-instance decision.
The same `permit_request_hash` retries byte-identically; a fresh signed request
for the same reserved slot/core receives a new request-bound permit after all
ordinary checks pass, while a different core for that slot fails. Once a request is fully cryptographically
valid, the endpoint commits its separate receipt binding before evaluating
maturity or returning a response; a transport timeout after that transaction is
safe to retry. A too-early request reserves no outcome-core slot but retains that
receipt binding. An invalid request reserves nothing. Per-requester, per-service
and global budgets prevent unpublished permit requests from becoming an
unbounded verification workload.

For an amendment permit, the endpoint additionally resolves the complete active
predecessor proof bound by the request, verifies the exact URI/CID, revision and
invariant identity fields, and requires that predecessor to be the current active
head for the interaction nullifier. A consumed nullifier without valid direct
predecessor linkage is rejected. Permit issuance does not itself replace the
active head; only complete publication and outcome-checkpoint verification can do
so.

- Verify transport authentication.
- Before sending a sensitive-scope request, verify an active outbound
  confirmation bound to the exact payload digest or a semantic disclosure policy
  covering the curator, requester identity, scope, purpose, request schema,
  fields and values.
- Verify proof-carrying repository commits or CAR data for service profiles,
  declarations, authorities, authority observations, commitments,
  commitment/outcome/discipline/evidence-event checkpoints, outcomes, discipline
  records and coverage-membership artifacts. AppView discovery results are
  locators and indexes, not an authenticity oracle.
- Derive operator, record author and attester identities from AT URIs,
  repository proofs and, for ordinary non-curation PeerLens evidence, namespace
  lineage; reject conflicting copied fields.
- At private request ingress, recompute the canonical hash from the complete
  private request, enforce subscriber-nonce replay rules and verify the sole
  detached requester authorization over that hash. During public outcome
  verification, verify that same authorization, its pinned historical
  requester-key proof and its public recipient, exact profile,
  declaration, behavior epoch, authority, release, runtime key, capability
  schema, service, scope, query category, outcome policy and
  authorization-bucket bindings.
  Require response or decline issuance inside the half-open authorization
  interval and reject stale-contract substitution.
- Verify the response receipt against the runtime issuer authorized for that
  authority epoch and complete disclosed issuance bucket.
- Verify the authority grant's operator repository authorship, predecessor and
  activation bucket, its complete signed authority-observation quorum and every
  operator-authored authority revocation in the pinned input checkpoint. Require
  ordinary grant/rotation observation before the boundary. Reject authority
  forks, URI/CID replacement and every receipt in an emergency-compromise bucket
  from ordinary eligibility, then apply the no-suppression counterfactual when
  curator-controlled invalidation affects previously witnessed evidence and a
  complete event-checkpoint quorum establishes its portable boundary.
- Recompute deterministic `receipt_id`; require recipient and receipt identifier
  inside the response commitment and enforce the permit witness's atomic receipt
  binding. Retain later conflicts as equivocation under Section 10.8.
- Verify exact service-profile, declaration, authority and applicable release
  URI/CID pairs plus `runtime_key_id` and `capability_schema_hash` binding.
- Verify category-to-scope congruence against the pinned taxonomy version.
- Verify one outcome claim per recommendation and recompute the item root.
- Verify the operator repository authored the commitment and the authorized
  runtime signed the commitment entry or batch manifest. Verify the half-open
  commitment-window bounds, full-window runtime authorization and the disclosed
  response issuance bucket's membership; the minimal profile requires an exact
  one-bucket window.
- Derive the commitment stream ID and validate sequence length, predecessor
  URI/CID and all-branches fork/duplicate treatment without selecting a branch by
  ingestion order.
- For a batch, fetch and hash the complete content-addressed leaf artifact and
  derive the response inclusion proof independently.
- Verify an accepted commitment checkpoint before treating a response as
  public-outcome-eligible, a complete private publication-permit quorum before
  constructing an original or amended public outcome, and a separate accepted
  outcome-checkpoint quorum before treating any published lifecycle record as
  effective.
- For an original or amended public outcome, verify recipient binding, response
  preimage, item proof when required by the active profile, preserved subject
  reference, outcome-core permit binding, outcome policy,
  verifier-derived permit/observation bounds, atomic interaction-nullifier
  lifecycle and every dimension-specific repeat series. For a revocation, verify
  the same author and invariant identity fields as its exact active predecessor,
  the next revision, absence of outcome values and absence of a permit. Accept a
  consumed nullifier only for a fully verified direct amendment or revocation of
  its active head. Never use attester `created_at` as the evaluation clock.
- Validate recommendation output against the pinned schema.
- Enforce item, text, evidence-reference, encoded-body, batch-leaf, proof-depth,
  coverage-membership and primary score-input/lineage limits before expensive
  allocation or remote resolution; enforce transitive score block, canonical-byte
  and depth limits during bounded streaming before full decoding or rendering.
- Reject expired requests/responses and replayed request or response nonces.
- Verify decline receipts under the detached request authorization, authority
  and schema bindings; recompute the terminal disposition ID and reject a
  response/decline conflict. Never classify a timeout or unsigned refusal as a
  verified decline, or a signed decline as proof that the private request was
  eligible.
- Treat rationale as untrusted data.

### 15.2 Endpoint safety

- Use the existing service endpoint resolution and allowlist rules.
- Block private-network SSRF for AppView/server-side fetches.
- Apply request timeout, response-size and redirect limits.
- Do not execute curator-supplied URLs or tool calls automatically.
- Open external links only through first-party confirmation UI.

### 15.3 Key and operator changes

- Routine runtime issuer rotation creates a new authority epoch, not a behavior
  epoch, and requires signed authorization lineage.
- Operator change creates a new behavior epoch.
- Compromised issuers can be revoked.
- Responses in a revoked or intersected compromise bucket are rejected from
  ordinary eligibility. Previously witnessed evidence remains in the labelled
  no-suppression counterfactual so operator revocation cannot improve standing.
- Historical responses retain the issuer and declaration version needed for
  verification.
- Historical requester-signature and repository proof bundles retain the
  DID-resolution version and key evidence used to verify each authorization or
  signed commit. A verifier must not apply only the current DID document to old
  evidence after signing-key or repository-key rotation. For `did:plc`, the
  bundle references the relevant PLC operation proof; other DID methods require
  an accepted versioned resolution archive or witness policy.

### 15.4 Evidence lifecycle and disputes

- Amendments and revocations preserve the exact URI/CID of the superseded active
  record and advance its revision by one. State changes are atomic per nullifier;
  scorekeepers never count both versions, never let an invalid child consume the
  slot and fail closed on two valid children of one predecessor.
- Repository deletions are applied atomically against the verified lifecycle
  head. A valid transition excludes the deleted content and enters
  `deletion_pending_witness`; affected current score output remains unavailable
  until the complete evidence-event quorum creates the portable terminal
  nullifier tombstone. Deleting a revocation or fork child never restores a
  predecessor or resolves the fork. Deleting a superseded non-head does not alter
  current state.
- Deleting an operator commitment from its origin PDS does not invalidate an
  outcome already accepted against a complete witnessed proof bundle. The
  scorekeeper marks the commitment `origin_deleted` and replays from retained
  evidence.
- Origin deletion is not revocation. Exclusion requires a valid signed
  revocation under the pinned policy, a moderator decision or an applicable
  legal-erasure action. Each produces an explicit exclusion reason.
- Deleting a commitment associated with live outcomes is commitment-discipline
  and anomaly evidence. It cannot improve the curator's standing by making
  unfavorable outcomes disappear.
- A scorekeeper stops counting evidence after the checkpoint's immutable
  `retention_until`. Temporary proof unavailability before that boundary is
  labelled `proof_unavailable` and contributes no standing until verification
  succeeds again; it is not silently converted into a valid or invalid outcome.
- Witness retirement preserves evidence only through a verified export and
  content-preserving archive hand-off. Missing bundles make the affected
  historical standing unavailable and visible; a successor cannot manufacture a
  replacement observation time or witness signature.
- Deletion of an attester-authored outcome or discipline head removes that
  attester's contribution after terminal tombstone processing; the old nullifier
  cannot be republished as a fresh vote. Moderator takedowns and legal erasure
  propagate through the declared recomputation policy without silently treating
  operator deletion and attester deletion as the same event. Where the marker
  itself must be erased, the scorekeeper exposes the resulting unverifiable
  interval instead of claiming portable anti-replay.
- A curator may challenge an invalid receipt, signature, scope or attribution.
  It cannot suppress a valid unfavorable outcome merely by disputing the
  attester's judgment.
- Scorekeepers publish exclusion reasons and moderation-policy versions.
- Historical snapshots identify records later revoked or excluded so an audit
  can explain why a current score differs without continuing to expose content
  that must be removed.

---

## 16. End-to-end flows

### 16.1 Discover and subscribe

1. Dina explicitly searches ordinary service profiles for the curation
   capability; the generic intent router does not select a curator in V1.
2. Results show scope, provenance, disclosures and selected scorekeeper
   evidence.
3. The user subscribes to a specific `service_uri` and scope.
4. Dina stores the subscription in its encrypted local curator-subscription
   repository. It does not create a contact or public trust edge.
5. No subscription notification is sent to the curator.

The curator may still infer activity from later authenticated queries. V1 does
not promise traffic-analysis resistance.

### 16.2 Query and personalize

1. User asks Dina for a recommendation.
2. Dina derives a minimal category-level query, canonical scope,
   subscriber-generated request nonce and detached request authorization.
3. For a sensitive scope, Dina obtains the outbound confirmation in Section 8.3
   before transmitting anything.
4. Dina queries selected subscribed curators through the existing
   `service.query` workflow.
5. Each curator returns a signed recipient receipt and response commitment. The
   minimum profile has one public-eligible claim and no Merkle path; later
   multi-claim or batched profiles include or derive the required proofs.
6. Dina validates requester authorization, deterministic receipt/recipient
   binding, immutable references, public category-to-scope congruence, authority
   observation quorum and item root. It marks the response outcome-eligible only
   after verifying the operator-authored commitment, independently deriving any
   batch proof and obtaining an accepted commitment checkpoint.
7. Dina treats the response as untrusted evidence and loads relevant local
   context under normal vault rules.
8. Dina records a private decision receipt and ranks candidates using curator
   judgment, local fit and public outcome
   evidence.
9. Dina shows sources, confidence and disclosures.

### 16.3 Record an outcome

1. User explicitly marks a recommendation as used or completes a linked local
   task.
2. After the commitment quorum exists, the reference client derives the later
   response/commitment evaluation anchor and waits for the policy minimum before
   offering public publication; private recording may occur earlier. This local
   wait is a UX guard, while the witness permit is the portable verifier input.
3. Dina asks only the policy-defined outcome dimensions in user language.
4. User chooses private or public under the requester DID bound in the receipt.
5. Dina freezes and shows the exact private permit request, intended outcome
   core, publishing identity and disclosure that the accepted preview witness
   will see those fields.
6. If the user confirms, Dina signs and sends the permit request. The witness
   verifies the receipt, commitment, item, requester and timing bindings and
   returns a permit over that exact core only after the conservative minimum
   delay.
7. Dina assembles and shows the exact final public record with the detached
   request authorization and disclosed query category, signed recipient receipt,
   response preimage, any
   profile-required item proof, accepted commitment checkpoint, complete
   publication-permit quorum, interaction nullifier and interaction-series
   identifier.
8. Only after final confirmation does Dina publish that record. Cancellation
   leaves the private outcome intact and publishes nothing.
9. An accepted witness quorum checkpoints the exact outcome URI/CID. AppViews
   reject invalid, unbound, replayed or duplicate evidence and score it only when
   the permit lower bound and observation upper bound satisfy the declared
   evaluation policy.

### 16.4 Curator update

1. Curator publishes a new immutable declaration and, when applicable, release.
2. Dina compares scope, behavior and authority lineage.
3. Non-material behavior updates preserve the behavior epoch.
4. Routine issuer rotation advances only the authority epoch.
5. Material behavior updates create a new behavior epoch and show an update
   notice.
6. The subscription may remain active according to user policy.
7. Previous and current standing remain visibly separated.

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
- See when conditional outcome estimates have an incomplete or biased
  denominator.
- Control exploration behavior locally.
- Preview and confirm sensitive outbound curator queries, including the visible
  requester DID and exact query payload.
- Publish no outcome automatically.
- Preview and confirm the exact private permit request and witness disclosure,
  then separately preview and confirm the exact generated public outcome payload
  and identity, including the query category that becomes public.
- Preview the exact public discipline payload and identity under a separate
  confirmation; keep sensitive-scope discipline local by default.

### Curator operator

- Publish through the normal service-publication path.
- Declare scope, provenance, corpus, methodology and conflicts.
- Publish immutable service-profile, declaration, authority and release
  references and authorize a runtime issuer under a versioned authority epoch.
- Rotate or revoke runtime authority only through the immutable bucket-aligned
  grant/revocation lineage and obtain the required authority-observation quorum
  before an ordinary boundary; never overwrite an authority URI.
- Return request-bound, signed, schema-valid responses and recipient receipts.
- Return a signed decline receipt when intentionally declining an authenticated
  request the runtime processed.
- Use the reference curator SDK or pass its complete conformance suite; custom
  cryptographic implementations receive no compatibility presumption.
- Run an operator-controlled publisher that verifies runtime signatures before
  writing commitments to the operator's PDS repository.
- Commit responses before a local acted-on marker becomes eligible for a public
  outcome follow-up; local use and local outcome tracking remain available.
- When batching is enabled, publish sequence-continuous batches with visible
  leaf counts and complete content-addressed leaf artifacts before their
  deadlines so any client can derive its own finalization proof.
- Publish optional public collections/digests.
- Publish material changes as new behavior epochs.
- Never receive vault context without an explicit grant.

### Scorekeeper operator

- Ingest authority grants/revocations and their signed observation artifacts,
  commitments, outcomes, typed discipline records and their checkpoints,
  evidence-event checkpoints, witness-coverage chains and membership artifacts,
  repository tombstones and relevant PeerLens evidence.
- Publish versioned curator score dimensions.
- Publish algorithm, parameters, checkpoint and policy hashes.
- Pin prior attester/item score checkpoints, scope and policy registry versions,
  subject graph checkpoint and the complete evidence-policy lineage for every
  run.
- Resolve every active required evidence witness's deterministic head from its
  live current repository state, perform bounded continuity catch-up to durable
  local state, reject missing history, generation rollback or cumulative
  conflict, and bind the exact head generation/current-repository/bounded-proof
  CIDs into the input checkpoint.
- Derive every score-lineage segment field and role from its opened policy,
  verify the complete source-transition partition, deterministic cutover cursor,
  pre-activation successor-slot closure and later terminal drain bridge, and reject an omitted source,
  policy fork or compatibility-weakening successor rather than publishing a
  partial score.
- Pin the score-input role registry, validate every role's field-presence and
  traversal rule, and enforce unique transitive block/byte/depth limits during
  bounded streaming before publishing a reproducibility manifest.
- Supply conformance vectors for the reference algorithm.
- Expose effective and raw sample counts.
- Expose committed-response counts, public-outcomes-per-commitment ratios,
  optional claimed follow-up signals, source-labelled coverage evidence,
  selection-bias warnings and commitment-discipline evidence separately.
- Publish the ordinary and no-suppression estimates, tainted-evidence counts and
  operator invalidation/equivocation evidence; never let curator-controlled
  invalidation improve the reference-compatible result.
- Keep optional probe-derived drift evidence separately labelled and pin
  `probe_policy_hash` whenever it contributes to a published metric.
- Reject self-operated probes, curator-supplied competitor probes and probe-only
  effective epoch splits.
- Preserve historical snapshots for audit.
- Publish immutable PDS snapshots and make them available to accepted witnesses
  for durable anti-equivocation evidence.
- Derive the stable score series and sequence-scoped logical key, bind status and
  stale-history fields, cap snapshot expiry below the input-proof retention floor
  and obtain the pinned score-witness quorum before exposing a score publicly.

### Witness operator

- Apply the pinned validation policy uniformly to every authority grant,
  authority revocation, commitment, curation outcome, discipline record,
  witness-policy successor target and covered evidence event in the declared
  source ranges.
- Pin the canonical source manifest before processing, publish contiguous signed
  coverage intervals and retrievable membership artifacts on schedule, and
  account for every public source target by a valid artifact or refusal. Publish
  challenged, consistency-proven coverage prefixes before the raw suffix reaches
  its pinned limit, carry every live dependency forward, and publish a unique
  signed valid finalization by the pinned deadline or a conflict finalization
  when a mismatch is proven. Assign every event to one policy-clock state bucket,
  close that cut before signing and coalesce every eligible interval,
  finalization and health transition into at most one deterministic live-head
  version published in the following bucket. Publish no semantic no-op before
  the exact retention-renewal boundary, never exceed the signed maximum generation
  gap, preserve monotonic generation/conflict status and retain every referenced
  CID version and dependency through its effective boundary. Never redefine
  the source set after observing data or compact an unaudited gap.
- Build complete canonical evidence-event proof bundles and checkpoint every
  covered curator invalidation or lifecycle deletion; never substitute local
  ingestion time or cross-repository cursor comparison.
- Publish canonical authority observations and enforce the pre-boundary quorum
  for initial grants and ordinary rotations.
- Validate the canonical requester-signed permit request plus its request ID/hash,
  receipt, commitment, item, outcome-core and timing bindings before issuing a
  private one-use outcome-publication permit; bind that request ID/hash into the
  permit and never issue one under an unhealthy clock or weaker quorum policy.
- Atomically reserve each receipt's exact commitment tuple before permit signing
  and before the maturity decision; retain the binding after a valid too-early
  request and return a signed refusal for any conflicting tuple. At maturity,
  reserve the exact revision-scoped outcome core separately and make permit
  decisions idempotent per signed request hash; while the policy admits new work,
  permit a fresh request for the same slot/core so partial quorums can converge
  after expiry. During scheduled predecessor drain, issue no permits and process
  only public targets whose canonical source positions are below the cutover
  cursor; stop all predecessor signing at the completion boundary.
- Archive complete valid authority proof, publish a complete signed
  commitment/outcome/discipline checkpoint, or publish a signed, reason-coded
  refusal for an invalid public record within the applicable policy deadline. Publish every
  completely proven covered evidence event within its event deadline; expose
  unexplained sequence, cursor or canonical-event gaps without inventing an
  event from an incomplete proof set.
- Retain authority, commitment, outcome, discipline, evidence-event,
  policy-successor observation/refusal/slot-closure, source-authentication
  profiles and source position/range/start proofs,
  incomplete-event-diagnostic, coverage-membership, prefix-consistency, live-
  manifest, prefix-finalization and every retained coverage-head version/current-
  repository/bounded-proof/conflict-proof bundle through their normative or
  enclosing-coverage retention boundaries and make them retrievable by content
  CID. Event bundles
  include the target record bytes and repository-
  transition proofs needed to replay an invalidation or deletion after its origin
  changes.
- Use the policy-defined clock source and coarse bucket rules for outcome
  observation; publish clock-health diagnostics and never backdate a checkpoint.
- Publish archive health and coverage metrics without claiming that a successful
  checkpoint establishes recommendation quality.
- Before retirement, publish an export manifest and complete a verifiable
  content-preserving hand-off for every unexpired proof bundle.
- When separately acting as a score witness, use only the pinned score-witness
  policy and aggregate live-head resource profile, maintain its bounded signed
  and timely finalized source-coverage prefix plus contiguous raw suffix and
  deterministic live head, checkpoint or
  canonically refuse each exact snapshot URI/CID before its deadline, retain the
  authenticated manifest, snapshot and complete reproducibility proof, and
  refuse to combine score and outcome policy hashes as if they were one quorum.

### Reference client

- Ship and pin the signed Phase 1 preview witness policy and first-party witness
  DID; do not describe quorum one as independent witnessing.
- Pin the lineage compatibility profile, verify it at every scheduled policy
  edge, require the complete pre-activation successor-slot proof and deterministic
  source cutover position, and fail closed when the valid candidate set is empty,
  forked, unavailable or incompatible or exceeds the maximum drain window. Never
  extend the predecessor or select one branch as a fallback. Current clients use
  these rules for conformance only and reject scheduled activation until a future
  policy schema pins the authenticated activation-clock profile.
- Before displaying public standing, pin the separate score-witness policy,
  exact required score-coverage-witness set, score-input role registry and
  transitive proof limits plus the separate score live-head resource profile,
  resolve every required witness's deterministic head from a live current
  repository commit, require bounded continuity to the persisted CID, monotonic generation and
  complete bounded prefix/finalization/dependency/suffix proof plus the snapshot-
  checkpoint quorum, refresh every required source and
  enforce the exclusive maximum score-coverage lag, and
  reject an expired snapshot or one whose manifest exceeds its input-proof
  retention floor, input-lag, publication-lag or maximum-validity bound.
- Never discard persisted head-generation state merely to make a score current.
  A continuity gap is `head_history_unavailable`; only an explicit audited
  rebootstrap may establish a new baseline under the documented fresh-verifier
  trust boundary.
- Return signed and effective standing status separately; a read-time freshness
  failure may only downgrade display, carries the verification bucket and exact
  required heads, and never mutates or impersonates the signed snapshot.
- Require exact equality of the manifest, snapshot and checkpoint copies of
  input-checkpoint identity, coverage watermark, generation bucket and expiry as
  applicable; never select a favorable copy.
- Verify the score's cumulative series-lineage artifact and the separately closed
  coverage interval containing the current checkpoint; never display a branch
  whose predecessor or anti-omission proof has expired or disappeared.
- Fail closed on requested behavior-contract, repository authorship, immutable
  reference, signature, recipient, scope, authority, schema, item-proof, witness,
  nullifier, series, epoch, outcome-policy, size-limit or commitment mismatch.
- Keep uncommitted recommendations usable but clearly labelled and ineligible
  for public outcome standing.
- Keep `awaiting_commitment_witness` recommendations,
  `awaiting_outcome_permit` private outcomes and `awaiting_outcome_witness`
  publications usable/visible in their appropriate local states, retry all three
  witness jobs durably and never weaken the pinned witness or quorum policy
  during recovery.
- Keep verified deletions in `deletion_pending_witness` until their portable
  event quorum arrives; never restore a predecessor or display a newly computed
  current score while waiting. A prior score may appear only as stale history.
- Treat a missing, forked or overdue witness coverage interval as
  `coverage_unavailable`; never display the affected standing as current.
- Freeze and confirm the exact outcome core before requesting a permit; disclose
  what the permit witness sees, then separately confirm the exact generated
  public record after permit issuance. Never publish under a permit for another
  core or without final confirmation.
- Treat an amendment as a newly permitted replacement with a separate final
  preview. Show a revocation's exact predecessor and publishing identity before
  publishing it, but do not request a meaningless outcome permit for revocation.
- Keep sensitive outcomes private by default.
- Keep public curation outcomes and verified public discipline disabled for an
  identity without a Dina-controlled signing method and replayable key proof;
  preserve local recommendation and private-outcome use.
- Require the complete discipline-checkpoint quorum before displaying a public
  signed decline or subscriber discipline aggregate in curator metrics.
- Do not offer namespace or pseudonymous curation outcomes in V1.
- Separate confidence in a curator from evidence about an item.
- Show authority-tainted/equivocation warnings and derive convenience bands from
  the constrained no-suppression estimate, not the more favorable unconstrained
  value.
- Never execute instructions embedded in curator text.

---

## 18. Invariants

1. **No curator caste.** Publishing a conforming service makes it eligible for
   discovery; standing comes from evidence, not an appointment.
2. **No vault context by default.** Personalization happens locally unless an
   explicit scoped grant says otherwise.
3. **Private claims require prior commitment.** An uncommitted private response
   cannot earn public outcome standing.
4. **Outcomes require possession evidence.** A public commitment reference
   without a detached subscriber request authorization, runtime-signed recipient
   receipt and any profile-required item proof earns no standing.
5. **Public order is witnessed.** Cross-repository timestamps are not treated as
   a global clock; an outcome embeds a complete accepted commitment-observation
   quorum and pre-publication permit quorum and is scored only with a separate
   complete outcome-observation quorum. Every checkpoint binds the exact URI/CID;
   a URI or CID alone is not evidence.
6. **Batch proofs are independently recoverable.** A curator cannot selectively
   withhold a leaf proof after publishing a batch root.
7. **Public authorship is repository-bound.** Runtime signatures authorize live
   behavior, while operator and attester records are attributed from their PDS
   repository proofs.
8. **Standing is scoped and epoch-bound.** It does not silently transfer across
   domains or material behavior changes.
9. **Authority is not behavior.** Routine key rotation preserves behavior
   standing through signed authority lineage.
10. **Evidence type is disclosed.** Human, computed and hybrid operation are
    explicit, but no type receives an automatic protocol penalty.
11. **Payment is not ranking input.** The reference algorithm ignores payment;
    external influence is disclosed and evaluated through outcomes.
12. **Public outcomes are optional.** No user activity is published merely
    because Dina inferred that an action occurred.
13. **Unknown denominators remain unknown.** Conditional outcome evidence is
    never presented as a universal success probability.
14. **Repeated interactions have bounded weight.** New receipts do not turn
    repeated curator/subject queries into independent evidence without limit.
15. **One interaction is one curator signal.** An ordinary review and curation
    outcome may serve different views, but cannot double-count curator standing.
16. **Scorekeeper results are reproducible claims.** Every result identifies its
    algorithm, parameters, input and policy.
17. **Scoring dependencies are acyclic.** A run uses frozen prior evidence
    checkpoints, never reputation recursively produced by the same run.
18. **Curator content is untrusted.** It can inform an answer but cannot instruct
    Dina or invoke tools directly.
19. **The user can exit.** Removing a curator or scorekeeper takes effect
    locally without permission from that party.
20. **Presentation separation is not pseudonymity.** A V1 public curation outcome
    uses the requester DID bound by its receipt; a namespace cannot hide it.
21. **Set-size evidence is a co-attestation.** Public standing binds the
    curator-signed eligibility profile and counts endorsed by the outcome author;
    it does not prove what a modified client rendered.
22. **Historical proofs are portable.** A durable witness retains record content,
    repository inclusion and versioned DID/key evidence, not identifiers alone.
23. **Sensitive consent is semantic.** Reusing a data shape cannot authorize new
    sensitive meaning outside an explicit disclosure policy.
24. **Origin deletion is not evidence erasure.** A complete witnessed commitment
    remains verifiable for accepted outcomes under its retention policy; deleting
    the curator's origin record cannot selectively suppress negative evidence.
25. **Witness silence is not neutral availability.** A sole witness can suppress
    scoreable outcomes by omission. The preview policy requires exhaustive
    public-record coverage and logged public refusals; private permit silence has
    only local evidence. The product labels the remaining quorum-one censorship
    dependency honestly.
26. **Retention bounds standing.** A checkpoint's signed `retention_until` is
    immutable and derived from numeric fields in the pinned witness policy; V1
    evidence cannot remain scoreable past that boundary without a separately
    specified renewal protocol.
27. **Discipline evidence is replay-bounded.** One decline receipt has one active
    nullifier, and repeated requests from one subscriber remain in one capped
    discipline series. One unverified aggregate has one active author/service/
    scope/type nullifier; publisher-selected time windows cannot multiply it.
28. **One request has one disposition.** Recipient and deterministic receipt ID
    bind either one signed decline or one response receipt; a response commitment
    cannot back several receipts or recipients, and conflicting terminal
    dispositions are equivocation.
29. **Commitment forks never improve standing.** Every distinct valid commitment
    on every branch remains in the known denominator, while duplicates, gaps,
    overlaps and replacements are explicit anomalies.
30. **Evaluation maturity brackets publication.** Attester and repository
    timestamps are not scoring clocks. V1 starts the verifiable window at the
    later of the response bucket and portable commitment-observation bucket. The
    minimum comes from the embedded witness-permit quorum over the exact outcome
    core; the maximum comes from the accepted observation-checkpoint quorum over
    the exact outcome URI/CID.
31. **The requester pins the behavior contract.** A stable service URI does not
    authorize a provider to choose another profile, declaration, epoch, authority,
    release, runtime key, capability schema or outcome policy after dispatch.
32. **A nullifier is one atomic lifecycle slot.** A valid direct amendment
    replaces its active predecessor, a revocation terminates it, and forks or
    invalid children cannot create an additional contribution. Repository
    deletion of a head immediately excludes its content and makes affected
    current output unavailable, never reactivates a predecessor and becomes a
    portable terminal tombstone only through an accepted evidence-event quorum.
33. **Commitment retention uses public signed bounds.** A witness derives
    retention from the runtime-signed commitment window, and a later disclosed
    issuance bucket must be a member of that window.
34. **Curator-controlled invalidation is monotonic.** Authority compromise,
    operator equivocation, conflicting dispositions and operator deletion may
    reduce confidence or standing, but cannot erase previously witnessed
    unfavorable accountability evidence in a way that improves the published
    estimate or convenience band.
35. **Authority timing is portable.** Initial activation and ordinary rotation
    require complete signed authority-observation quorums strictly before their
    boundary. Repository timestamps or a copied future bucket are insufficient.
36. **Invalidation timing is portable and conservative.** A reference score
    changes for curator-controlled invalidation only with a complete
    evidence-event quorum. Evidence staged in the same coarse bucket is treated
    as preceding the invalidation; local time and cross-source cursors never break
    the tie.
37. **Random-value privacy is concrete.** V1 nonces and salts are independent
    32-octet CSPRNG values with one canonical byte encoding and replay rules;
    “unpredictable” is not left as an implementation suggestion.
38. **Exhaustive coverage is source-relative and chained.** A witness pins one
    content-addressed source manifest and accounts for contiguous cursor ranges
    in signed coverage records backed by retained canonical membership
    artifacts. The policy fixes the exact required coverage-witness set before
    evidence exists; a scorekeeper cannot choose a favorable subset. A root or
    count without retrievable live leaves is not replayable coverage. A usable
    signed prefix may replace expired raw intervals only through an append-only
    consistency proof, complete carry-forward of every still-live dependency and
    a unique timely valid finalization; compaction never revives or suppresses
    evidence. The witness never claims
    that this proves an upstream relay itself was complete.
39. **Only witnessed, reproducible scores are current.** A public score binds one
    pinned, sequence-continuous score series, one logical sequence key, explicit
    availability status, input-proof retention floor and complete score-witness
    quorum plus the exact policy-pinned required score-coverage-witness set.
    Pending, forked, unavailable or expired values may appear only as labelled
    history.
40. **Score freshness is externally bounded.** `current` requires a complete
    evidence-coverage watermark within the pinned input-lag bound, witness
    observation within the publication-lag bound and expiry within the maximum
    validity bound. A scorekeeper cannot keep an old score current by choosing an
    arbitrary expiry.
41. **Score lineage rolls proofs forward.** Every current score checkpoint
    retains a cumulative, coverage-backed series proof through its own replay
    boundary. Expired predecessor archives or a deleted scorekeeper record cannot
    make a fork undetectable while a successor remains current.
42. **Permits bind one closed outcome core.** Every public meaning-bearing field
    and proof attachment is included directly or through one specified
    domain-separated hash. Unknown or differently canonicalized fields cannot be
    silently left outside the permit.
43. **Public discipline is witnessed evidence.** A discipline record affects
    public metrics only with its exact checkpoint quorum and source-coverage
    membership. Unverified claims remain labelled and never use local ingestion
    time as portable proof.
44. **Rotation preserves reservations without renewing interactions.** A policy
    hash change in one witness-policy lineage cannot reset a live receipt binding
    or lifecycle-core reservation. A successor authorizes only responses issued
    at or after its activation; it never re-witnesses a predecessor commitment,
    moves the original evaluation anchor or extends the original horizon or
    retention. During drain the predecessor only finishes witness processing for
    a target whose canonical source position is below cutover and that already has
    a complete predecessor permit quorum; every other interaction starts over with a new
    successor-authorized request, response, receipt, commitment and nullifier.
    Proof sets from the two policies are never mixed.
45. **Permit retries converge without multiplying rights.** A witness reserves
    one revision-scoped outcome core but signs decisions per request hash. While
    its policy admits new work, a fresh request for that same core can replace an
    expired partial quorum; different cores cannot consume the same slot. A
    scheduled predecessor's drain interval cannot create a fresh request.
46. **Score run fields have one value.** Manifest, snapshot and checkpoint copies
    of input identity, coverage watermark, generation and expiry match exactly.
    No artifact can extend freshness or retention by carrying a different copy.
47. **Coverage references retained bytes.** Refusals, incomplete-event
    diagnostics, membership entries and their available proofs remain
    retrievable through the signed coverage boundary; roots without those bytes
    are unavailable.
48. **Semantic input identity excludes location.** Retrieval hints and archive
    mirrors may change the physical proof manifest but never
    `input_artifact_set_root`; URI/CID identity and content hashes remain bound.
49. **Only authenticated envelopes enter score lineage.** A record must prove
    repository authorship and a valid minimal series envelope before it can
    consume a series-lineage slot. Deeper authenticated refusals remain visible;
    spoofed or malformed records stay only in source coverage.
50. **Lifecycle roots are set-derived.** Exactly one intrinsically valid,
    proof-bearing `lifecycle_root_candidate` may seed an outcome or discipline
    nullifier. A candidate remains in the root set whether its witness disposition
    is a checkpoint or any signed refusal whose retained target proof passes the
    intrinsic predicate; refusal labels never select the root. Two distinct
    candidates create one terminal, canonically hashed root conflict under every
    ingestion and witness-arrival order; identical URI/CID redelivery is the only
    idempotent duplicate. Every DID in the owning policy's exact required-witness
    array participates; no applicability filter may remove one. An undecidable
    required disposition makes the slot unavailable rather than unique.
51. **Scheduled rotation cannot silently roll back.** The current policy schema
    does not enable scheduled activation. A future successor follows one
    contiguous signed policy chain and activates at its predecessor's pre-signed
    new-work boundary only after the independently source-proven nomination range
    has closed, every required witness has signed its closure in the unique
    successor-slot proof,
    the lineage compatibility profile proves it is non-weakening and its drain
    fits the pinned maximum. Clients remember the
    highest activated sequence and fail closed if the successor, authenticated
    activation-time lower bound or clock profile is unavailable or incompatible;
    local wall time never activates it. Historical predecessor proofs remain
    valid only as retained history, not authority for new work.
52. **Scores bind the complete evidence-policy lineage.** Every score names one
    active policy and canonically opens every policy segment from the pinned
    anchor through it. Retained predecessor evidence, terminal coverage heads and
    no-gap/no-overlap source-transition bridges cannot be omitted in favor of a
    more favorable successor era, and an exact URI/CID disposition is counted
    once under its owning policy. A scheduled cutover has no current cross-policy
    score until predecessor drain coverage is terminal and bridged.
53. **Current freshness is not historical completeness.** The active segment's
    slowest complete coverage head determines `input_coverage_through_bucket`.
    Retired segments must independently prove terminal coverage and retain every
    still-required dependency; their old close buckets neither make an incomplete
    lineage valid nor keep an otherwise current score permanently stale.
54. **Source transitions are total partitions.** Every predecessor and successor
    source appears exactly once in a signed continuation, retirement,
    introduction, split or merge rule. Each bridge instantiates the complete rule
    set; omitted sources, duplicate ownership and undeclared filter/universe
    changes make coverage unavailable. The active compatibility profile decides
    which structurally valid changes may remain in one trust lineage;
    `v1_nonweakening` accepts only one-to-one identical continuations and never
    interprets a mapping artifact.
55. **Score lineage copies are derived.** Segment sequence, hashes, boundaries,
    source manifest, role, bridges and coverage-witness heads equal their opened
    signed policies and proofs. No scorekeeper-supplied copy can override an
    authenticated value or choose which segment is active.
56. **Policy replay is self-contained.** Every score-lineage segment opens one
    canonical policy bundle containing the exact signed policy, compatibility
    profile and historical issuer-key proof. The enclosing score checkpoint
    retains the bundle projection and all member bytes; origin availability is not
    a replay dependency.
57. **Nested mapping references are not retention.** A future accepted source
    mapping requires its own top-level score-input entry and retained canonical
    bytes. A transition bundle containing only a mapping CID cannot establish or
    preserve continuity. The current compatibility profile requires zero such
    entries.
58. **A policy-successor slot has one complete candidate set.** Every direct
    successor is discovered through the predecessor's pinned policy source and
    complete required-witness slot closures before new-work activation. Terminal
    all-target drain coverage is a later scoring proof and cannot change that set.
    Zero valid hashes is unavailable, one is selected,
    and two or more are terminal lineage equivocation under every arrival,
    publication and deletion order; no client follows a favorable branch.
59. **Source position, not arrival time, owns transition work.** Every rotatable
    source uses one pinned total-order cursor profile, source-authentication
    profile, replayable position/range/start proofs and half-open ranges. The
    predecessor ends and successor begins at the deterministic activation-bucket
    cursor. A witness signature or lagging delivery cannot move a target between
    policy eras.
60. **Score-input roles have closed semantics.** A score-policy-pinned registry
    defines URI/hash/policy-field presence, retention derivation and child-CID
    traversal for every artifact role. Unknown, missing or extra role rules and
    every field-presence mismatch fail before scoring.
61. **Proof budgets include the transitive closure.** Input-proof block and byte
    limits count every unique CID-addressed block reachable through the pinned
    schema graph, including nested policy and transition members. Shared CIDs
    count once physically, semantic URI/CID identities remain distinct, and
    bounded streaming aborts before excess content is decoded.
62. **Witness validation is resource-bounded.** Every public-target and private-
    permit proof operation uses the policy-pinned proof-resource profile across
    all roots and transitive descendants. Canonical excess is a deterministic
    policy failure; network, redirect, concurrency or deadline exhaustion is
    labelled unavailability and cannot be misreported as intrinsic target
    invalidity.
63. **V1 has one request signature.** The requester signs the detached
    authorization projection containing `request_hash`; the provider recomputes
    that hash from the complete private request. Transport authentication is not
    a second protocol signature and cannot replace either check.
64. **Coverage compaction is bounded and monotonic.** Evidence and score witnesses
    publish signed rolling-hash prefixes before raw suffix limits are reached,
    retain the raw proof through the finalization deadline, carry every unexpired
    dependency forward and sign a timely valid finalization, or a conflict
    finalization when a mismatch is proven. Cumulative conflict state can change
    only from clean to conflicted. A complete incompatible pair is sufficient to
    poison the chain even when the full conflict set exceeds a resource limit;
    bounded overflow form is conflict, not recoverable availability, and its
    cumulative overflow flag never resets or masquerades its count as exact. Only a
    uniquely valid, cumulatively clean finalized prefix is usable. A missing,
    late, stale or intrinsically over-limit non-conflict proof is unavailability,
    not permission to drop history.
65. **Score coverage uses a predetermined exact set.** Observation quorum and
    exhaustive source coverage are separate duties. Every DID in
    `required_score_coverage_witness_dids` contributes a complete proof, so a
    client cannot choose the source view that hides a sibling or refusal.
66. **V1 source failover is fail-closed.** A group label, alternate endpoint or
    issuer statement cannot map cursors or target universes. Endpoint loss is
    coverage unavailability until a future version freezes and verifies a bounded
    equivalence protocol.
67. **Current score coverage is freshly re-established.** A previously valid
    score-coverage bundle is only historical proof unless every exact required
    witness's deterministic live head has a current repository proof, monotonic
    generation, bounded continuity to the persisted CID, clean complete bounded
    proof and age below the policy's exclusive maximum lag. Every required head
    shares one aggregate live-head operation budget. Source unavailability,
    rollback, missing/over-limit catch-up, a fork or equality with the freshness
    bound removes the current label; no cached bundle or per-head budget reset
    extends it.
68. **Coverage heads have one live slot.** Evidence and score coverage each use a
    family/policy/source/witness-derived stable rkey. Every CID version increments
    once, binds its predecessor and represents one closed state-bucket cut
    published in the following bucket. A semantic no-op does not create a
    generation before the signed maximum generation gap; at that exact boundary
    a deterministic retention renewal preserves bounded catch-up. Clients persist
    the highest generation and fetch the live current repository state. A stale commit, alternate rkey,
    skipped generation or conflicted-to-clean transition is unavailable or
    equivocation, never another candidate head. A conflicted head binds every
    proven branch in a canonical bounded conflict proof and points only to the
    last uncontested coverage anchor, including an explicit zero-interval source-
    start anchor; it never selects a favorable branch. Two
    CIDs for the head slot itself are terminal for that witness-policy lineage
    and cannot be repaired by such a signed conflict head.
69. **Head continuity state is durable trust state.** A client with a persisted
    head CID verifies a bounded contiguous path from the live head back to that
    exact pair. Missing history is unavailable, not fresh installation. Only an
    explicit audited rebootstrap establishes a new baseline and accepts the
    witness summary without historical continuity.

---

## 19. Implementation sequence

### Phase 0: validation without new public standing

- Publish one curator as an ordinary Dina service.
- Label any Dina-operated launch curator as a first-party example, never as
  established or trusted in the absence of earned evidence.
- Register the official capability as preview-only behind a feature flag and
  use the existing service response path; no compatibility claim is made until
  Phase 1A freezes the V1 schemas.
- Personalize locally and send no vault-derived context to the curator.
- Store request-bound signed response receipts and local decision attribution.
- Collect private outcomes.
- Measure repeat queries, committed/uncommitted/refused responses, acted-on
  recommendations and voluntary outcome rate.

This phase validates whether users value the loop. It does not claim public
accountability.

### Minimum freezable core

Phase 0 usage must justify continuing before protocol work expands. Phase 1
freezes only mechanisms that are load-bearing for forward compatibility and
painful to retrofit after receipts exist:

- canonical request hashing, detached requester authorization and domain
  separation, including the exact selected behavior and authority contract, and
  the fixed V1 size, encoding, generation and reuse rules for every nonce and
  salt;
- the signed receipt envelope, deterministic receipt ID, recipient binding and
  exact immutable references;
- immutable runtime-authority grants, revocations, signed authority observations,
  portable pre-boundary lineage verification and operator-owned publication;
- one public-eligible claim and per-response commitment;
- accepted-witness commitment ordering, a witnessed-commitment evaluation
  anchor, a closed outcome-core permit projection, private minimum-delay permits
  and outcome-observation timing, plus a pinned proof-resource profile,
  authenticated source position/range/start proofs, retrievable source-coverage
  membership, discipline checkpoints and portable evidence-event ordering for
  every curator-controlled invalidation and lifecycle deletion;
- interaction nullifiers and the scope-aware repeat-series key;
- a minimal versioned V1 scope registry with one or more explicitly supported
  low-risk outcome policies.

The initial public profile does not require multi-claim Merkle proofs, commitment
batching, pairwise outcome identities, generalized sensitive-domain scoring,
probe analytics or multiple scorekeepers. Those features remain in later phases
and must reuse the frozen envelope rather than enlarge Phase 1A pre-emptively.
Scopes without a frozen outcome policy may return useful local recommendations
but cannot earn public outcome standing.

### Phase 1A: freeze signed receipts and local attribution

- Freeze canonical request, detached request authorization, historical requester
  key-proof, bucket-aligned authorization-window, response projection,
  deterministic receipt-ID, receipt and item-claim schemas. The authorization
  is the sole protocol request signature and binds the recomputed private-request
  hash; no second private signature field exists. It
  pins the exact profile, declaration, behavior epoch, authority, release,
  runtime key, capability schema and outcome policy selected before dispatch.
- Freeze the V1 32-octet nonce/salt sizes, unpadded base64url encoding,
  independent operating-system CSPRNG generation, reuse scopes and verifier
  rejection rules.
- Add domain-separated conformance vectors.
- Add immutable service-profile/declaration/release references, behavior epochs,
  authority-grant, authority-revocation and signed authority-observation schemas,
  authority epochs and runtime-key lineage.
- Freeze the one-hour V1 authority bucket and rank-one single-claim eligibility
  profile with committed recommendation counts.
- Add canonical scopes, outcome and repetition policies, subject-reference
  preservation, scope-congruence validation and the fixed
  `witnessed_commitment_v1` evaluation-anchor meaning.
- Add V1 subscription-only curator routing and explicit discovery.
- Ship the reference curator SDK for canonicalization, receipts, runtime
  authority and operator-publisher handoff.
- Add local decision receipts and multi-curator attribution.

### Phase 1B: public commitments and minimal outcomes

- Add the single-claim Phase 1 profile, per-response commitments and
  immutable sequence-continuous commitment streams with deterministic
  all-branches fork handling.
- Add the operator-owned commitment publisher and repository-author verification.
- Add signed commitment-ordering, outcome-observation and portable
  discipline/evidence-event checkpoints plus their accepted-witness policy. Event
  checkpoints establish conservative cross-repository order for authority
  invalidation, commitment/disposition conflict, operator deletion and
  lifecycle deletion.
- Derive the portable commitment-observation bucket from the explicit quorum,
  key every first-seen statement by exact URI/CID and measure both minimum and
  maximum outcome timing from the later of response and commitment observation.
- Ship `preview-default-witness-policy-v1` with the first-party witness DID,
  quorum-one checkpoint/permit rules, a canonical source manifest and signed
  coverage chain with retrievable canonical membership artifacts, source-
  authentication profiles and retained target-position/range-frontier/start
  proofs,
  authority/commitment/outcome/discipline/evidence-event quorums and
  completion bounds,
  authority-processing/checkpoint/refusal/permit deadlines, clock rules, proof
  requirements, a closed proof-resource profile covering public and private
  permit validation with `raw_cid_block_v1` retrieval, a policy-bound feasibility
  manifest with exact exclusion projections, production-evaluator fixtures and
  per-root/worst-case aggregate capacity, numeric
  registry/standing/challenge/lifecycle retention
  fields, bounded coverage-prefix cadence/accumulator/proof limits, finalization
  deadline and fixed retention horizon pinned. Implement tagged interval/prefix
  coverage records, closed consistency/live-manifest attachments, challenge-
  delayed prefix finalization, cumulative conflict state, complete live-
  dependency carry-forward, deterministic live coverage-head records, explicit
  source-start anchors, deterministic bounded complete/overflow conflict proofs
  with list-limit, verification-budget and post-conflict operational-failure
  reasons, closed state-bucket cuts, clock-relative current-head validation,
  one-step declared-predecessor linkage artifacts with inline record bytes,
  one-per-cut publication, signed maximum-generation-gap
  retention renewal and bounded persisted-client catch-up before raw suffix
  limits can be reached. Bind the canonical
  `fixed_no_successor` lineage compatibility profile so no issuer-signed rotation
  can activate in the preview.
- Add portable commitment, outcome, discipline and evidence-event proof bundles with
  repository inclusion and versioned DID-resolution evidence.
- Add private one-use publication permits over exact outcome cores. Atomically
  reserve a cryptographically valid receipt's exact commitment tuple before the
  maturity decision, retain that binding across a signed too-early response and,
  only at maturity, reserve the revision-scoped outcome core. Keep request-
  instance decisions byte-idempotent while the fixed preview policy allows a
  fresh signed request for the same core to recover an expired partial quorum.
  Freeze the closed outcome-core/attachment-hash projection, deterministic
  permit-request ID, bounded request lifetime, exact `not_before_bucket`, permit
  signature domain, stable policy-lineage reservation keys and canonical signed
  private-refusal projection and retention rule.
  Embed complete signed commitment-checkpoint and permit proofs in outcomes;
  reject CID-only
  evidence and add durable `awaiting_commitment_witness`,
  `awaiting_outcome_permit` and `awaiting_outcome_witness` states.
- Publish witness archive-health, source-coverage and refusal-log surfaces plus a
  documented export/hand-off format before treating preview evidence as durable.
- Add possession-bound minimal outcome attestations and interaction nullifiers.
- Add interaction-series limits and policy-validated outcome dimensions. Enforce
  minimum delays and maximum horizons from the witnessed-commitment evaluation
  anchor, permit buckets and outcome-observation buckets, never attester time.
- Add exact-payload consent UI for public outcomes and sensitive outbound
  curator queries.
- Add sensitive-category defaults.
- Add signed decline receipts, descriptive-only V1 reason semantics, typed
  commitment-discipline records, discipline checkpoints and aggregate nullifiers.
- Add atomic per-nullifier amendment/revocation lifecycle, direct-predecessor
  validation, fork handling, `deletion_pending_witness`, portable terminal
  deletion tombstones, deduplication and deletion propagation. Derive original-
  root membership from every complete proof-bearing terminal disposition rather
  than its refusal label. No scorekeeper may derive a deletion bucket from its
  local clock.

### Phase 1C: shadow scoring and adversarial validation

- Run one reference curator scorekeeper without presenting public standing.
- Freeze scorekeeper manifests with the canonical semantic input-set root and
  input-proof manifest, prior dependency checkpoints, retained
  algorithm/parameter artifacts, scope and policy registry versions, subject
  graph checkpoint, active evidence-policy hash and canonical evidence-policy
  lineage artifact.
- Measure outcome missingness, commitment discipline and scope distribution.
- Run manipulation, privacy, replay, equivocation and statistical simulations.
- Enforce and publish the monotonic no-suppression counterfactual for every
  curator-controlled invalidation class.
- Freeze the canonical score manifest, stable score series, logical score key,
  cumulative coverage-backed lineage proof, predecessor/sequence rules, score
  freshness bounds, score snapshot,
  score-snapshot-checkpoint, score-snapshot-refusal and score-witness-coverage
  schemas, including bounded score-coverage prefixes, signed prefix
  finalizations, deterministic live score-coverage heads, the separate aggregate
  live-head resource profile, the exact required score-coverage-witness set and
  the online maximum-head-lag/catch-up rules. Ship and pin
  `preview-score-witness-policy-v1` before
  exposing any score.
- Publish score vectors only after the Phase 1 acceptance gates in Section 20
  pass with representative usage and a complete score-witness quorum exists.

### Phase 2: historical analysis and multiple scorekeepers

- Compare behavior-epoch history without transferring uncapped standing.
- Add hosted-runtime drift signals and service/scope lineage.
- Optionally admit standardized probe operators under a published, pinned
  admission, corpus, sampling, conflict and rotation policy.
- Admit additional independent score witnesses and publish cross-witness
  equivocation evidence under versioned score-witness policies.
- Add cross-scorekeeper comparison.
- Add curator score vectors and confidence intervals.

### Phase 3: scale and privacy hardening

- Batch commitments with Merkle roots and complete content-addressed leaf
  artifacts.
- Add multi-claim selective disclosure with item Merkle proofs.
- Add coordination analysis specific to curator outcomes.
- Add pairwise or anonymous query and outcome credentials if validated as
  necessary.
- Add paid-access integrations without feeding payment into ranking.
- Add private or organization-operated scorekeepers.

### Documentation split at implementation start

This document remains the authoritative architecture and decision record. When
Phase 1 protocol schemas and conformance fixtures are created, maintain derived
normative documents beside their implementations:

- protocol records, canonical encodings and wire profiles under
  `packages/protocol/docs/curation`;
- scoring formulas, manifest inputs and statistical interpretation beside the
  reference AppView scorer;
- conformance, adversarial and end-to-end cases in a dedicated curation test
  plan linked to the shared fixtures.

Derived documents must link back to the governing invariant and phase here.
They do not independently redefine protocol behavior; a decision change updates
this architecture and every affected normative artifact in the same change.

No phase should begin solely because the prior phase is implemented. Each phase
requires demonstrated usage of the preceding user loop. Public standing must
not launch merely because the implementation is complete; it requires enough
real evidence to validate the statistical and abuse assumptions.

---

## 20. Conformance, adversarial and acceptance tests

The protocol is not ready to freeze until the following tests exist as
automated suites. Golden vectors belong in `packages/protocol/conformance`; Core,
mobile and AppView tests consume the same fixtures rather than reimplementing
expected values independently.

Every fixture declares `profile_id` and `minimum_phase`. The initial sets are:

```text
curation-v1-minimal       Phase 1: one rank-one claim, per-response commitment
curation-v3-multiclaim    Phase 3: multiple item claims and Merkle disclosure
curation-v3-batch         Phase 3: commitment batches and public leaf artifacts
```

An acceptance gate runs only fixtures whose `minimum_phase` is at or below that
gate. Later-profile fixtures may be designed and reviewed early, but their
implementation cannot block the minimal profile.
Within `curation-v1-minimal`, receipt/envelope vectors are tagged Phase 1A and
public commitment, permit, checkpoint and outcome vectors are tagged Phase 1B;
the profile name does not collapse those gates.

### 20.1 Canonical protocol vectors

- Canonical request hashing and detached request-authorization signatures are
  byte-identical across supported runtimes. The authorization reveals the
  canonical query category but no payload or nonce. It is the sole protocol
  request signature: providers recompute the hash from the private request, and
  mutating only `query_payload` or `request_nonce` invalidates the binding. A
  fixture that accepts an unsigned private body because transport authentication
  succeeded, or requires an undefined second request-signature field, fails.
- Request authorization has mutation vectors for every pinned profile,
  declaration, behavior epoch, authority, release, runtime key, capability
  schema, query-category and outcome-policy field. A response or decline under
  a stale or newer unrequested contract fails even when service and scope are
  unchanged. A category outside the pinned scope's permitted set fails.
- Requester signing-key identifiers and versioned DID-resolution proofs have
  current-key, historical-key, rotation and incompatible-current-document
  vectors. Authorization windows use a half-open, bucket-aligned boundary.
- Request, response and permit nonces plus response/item salts decode to exactly
  32 octets from canonical unpadded base64url. Wrong-length, padded,
  alternate-alphabet, all-zero and replayed nonce vectors fail. Cross-runtime
  hash vectors consume decoded bytes, and the reference SDK's injectable-random
  tests prove independent CSPRNG calls for every generated value.
- Item leaf, response projection and response commitment have positive and
  mutation vectors in `curation-v1-minimal`; general Merkle-root vectors are in
  `curation-v3-multiclaim`.
- Deterministic `receipt_id` and recipient-bound response commitments have
  positive vectors plus wrong-recipient, wrong-request and duplicate-receipt
  vectors.
- The minimum single-leaf profile verifies with `item_root = item_leaf` and an
  empty inclusion proof only when the exact disclosed `item_salt` is present.
  Missing, truncated or mutated item salts fail. Multi-leaf proofs remain
  compatible with the same receipt envelope.
- Item ordering, Unicode, numeric encoding, duplicate keys, absent optionals and
  schema-version changes are deterministic and fail closed.
- `curation-v3-batch` proves that per-response and batched commitments verify
  against the shared discriminated receipt envelope.
- Authority grants, revocations and authority observations have canonical
  operator-repository, predecessor, epoch, activation/revocation bucket,
  proof-bundle, source-cursor, witness-policy, historical-witness-key and
  emergency-compromise vectors. Authority forks, URI/CID replacement, missing
  predecessors and conflicting revocations fail closed under every ingestion
  order.
- Authority/declaration construction vectors publish the authority grant first
  using the stable declaration URI, then publish the declaration that binds the
  exact authority CID. A fixture that attempts reciprocal authority/declaration
  CID inclusion is rejected as an unconstructable profile.
- Authority-observation vectors derive the portable q-th witness bucket. An
  initial grant or ordinary rotation observed at or after its boundary is
  ineligible; both cross-linked rotation observations and the final declaration
  must agree before the shared boundary. Emergency revocation may be observed
  later, and fixed revocation retention uses each observation bucket plus the
  pinned maximum quorum delay. A quorum completing after that delay or an
  under-retained member fails. A late, backdated revocation cannot expire its
  proof archive immediately or restore evidence through origin deletion.
- Evidence-event checkpoint vectors canonically sort target sets, derive
  `event_id`, verify every event-specific proof bundle and select the q-th
  accepted witness bucket. Differently ordered construction inputs canonicalize
  to the same event ID, while a non-canonically ordered wire payload is rejected.
  Target omission, wrong service/epoch/operator binding, wrong event type,
  cross-policy witnesses, an over-delay quorum and a locally supplied timestamp
  fail identically across implementations.
- Mutating any profile, declaration, authority or release URI/CID pair,
  `runtime_key_id` or `capability_schema_hash` invalidates the receipt.
- Mutating `eligibility_profile`, `recommendation_count` or
  `public_eligible_count` invalidates the response commitment. Counts that do
  not match the displayed response are rejected by the reference client before
  receipt acceptance; fixtures do not mislabel this as independent proof of UI
  rendering.
- Outcome-policy standing direction, neutral value and scoring mappings plus
  repetition-policy, subject-reference and resolver-version encodings have frozen
  cross-runtime vectors.
- Private permit requests and outcome-publication permits have canonical
  closed attachment/core projections, deterministic request IDs, requester
  signatures, request hashes bound into each witness permit, bounded half-open
  lifetimes, exact `not_before_bucket`, receipt, commitment, claim, author,
  subject, nullifier, portable commitment bucket, evaluation anchor, policy
  lineage, retention, witness-key and signature vectors. Every included,
  excluded, optional and unknown outcome field has a mutation vector. A missing,
  mismatched or invalid requester-signed request fails even when the permit's
  witness signature is otherwise valid. The exact
  `dina-curation-outcome-publication-permit-v1` signature projection has
  cross-runtime golden vectors; field omission, reordering or a cross-domain
  signature fails. Permit quorum selection and the q-th observation rule are
  identical across runtimes.
- Complete commitment-, outcome- and discipline-observation checkpoint proofs have Phase 1
  positive, mutation, wrong-target-URI/CID, wrong-witness, wrong-key-version and
  deleted-origin vectors. A checkpoint URI or CID without its canonical signed
  payload and witness-key proof fails. Publishing identical record bytes at a
  second URI produces a distinct first-seen key and cannot reuse the first URI's
  bucket. Batch leaf artifacts add unavailable-blob and batch-mutation vectors
  under `curation-v3-batch`.
- Commitment-observation vectors derive the q-th bucket under
  `commitment_observation_quorum`, reject slow or favorable-subset quorums and
  derive `evaluation_anchor_bucket = max(response_bucket,
portable_commitment_bucket)` identically across runtimes.
- Source-manifest and witness-coverage vectors freeze source identity, filters,
  cursor-profile and source-authentication-profile ref/CID/hash, verification
  material, position/range/start proof schemas, encoding, total comparator,
  half-open range semantics, start position, interval chaining, canonical membership
  entries/artifact CIDs, target/refusal/event/diagnostic subset roots, canonical
  incomplete-diagnostic IDs, counts, gap reporting and clock health. Zero-, one-,
  odd- and even-member trees reproduce exactly.
  Scheduled-successor fixtures additionally freeze the predecessor source-
  manifest CID, transition-rule hash and total source-set partition. Continue,
  retire, introduce, split and merge envelopes have canonical structural and
  mutation vectors, but the only positive `v1_nonweakening` compatibility fixture
  is a complete one-to-one partition of `continue + identical_continuation`
  rules using `utc_time_position_v1`. Golden vectors derive the exact cutover
  position from the activation bucket, including equal-time tie breakers, and
  assign every position below it to the predecessor and every position at or
  above it to the successor. The same target delivered before activation to one
  witness and after activation to another retains byte-identical ownership. An
  unknown comparator/function, timestamp-less source, missing/mutated/wrong-key
  position, range or start proof, forged source-time or source-start proof,
  unsigned source frame,
  inclusive-end reinterpretation or witness-local-time substitution fails. A
  missing, repeated or extra predecessor/successor source ID, many-to-
  many rule, changed filter under `identical_continuation` or wrong transition
  kind fails before coverage begins. Structurally valid retire, introduce, split,
  merge and `content_addressed_mapping` fixtures are all
  `incompatible_successor` under `v1_nonweakening`; resolving their mapping CID
  cannot change that result. A future mode cannot gain a positive mapping vector
  until its closed artifact schema, evaluator, cursor algebra, resource limits and
  semantic equivalence cases are frozen across runtimes.
  Every V1 source manifest carrying `failover_equivalence_group` fails canonical
  validation, and switching to an undeclared endpoint is
  `coverage_unavailable`; equality of group labels never creates a positive
  failover vector.
- Evidence coverage-prefix vectors freeze the interval/prefix discriminator,
  sequence and predecessor rules, canonical framed interval leaf, cumulative
  interval rolling hash, terminal cursors, consistency-proof and live-interval-
  manifest closed schemas, ordering, hashes, roots, duplicate rules, typed
  traversal, challenge boundary, finalization and retention arithmetic. Policy
  vectors reject zero limits and a prefix/finalization cadence that cannot
  complete before the minimum raw-record storage boundary. They cover
  the empty base hash, valid one/many appends and zero-count rejection,
  prefix-before/at/after usability, exact raw-suffix linkage and restart. Leaf
  vectors include variable-length URI/CID/range values whose naive concatenation
  collides but whose canonical projections differ. After raw expiry, copied
  consistency-entry predecessor, range, close and retention inputs reproduce the
  current prefix extension; mutating any copy fails its finalization. Missing
  or reordered intervals, a forked predecessor prefix, changed URI/CID/range or
  retention leaf, omitted live dependency, early dependency removal, shortened
  carrier, stale/expired prefix and hash/byte/suffix-limit overflow all fail
  closed. Finalization vectors cover exact prefix/proof/manifest equality, valid
  empty conflict set, sorted complete conflict set/root, both closed overflow
  reasons with one sufficient incompatible pair, cumulative conflict count/hash/overflow,
  clean-to-conflicted monotonicity, deterministic slot rkey, missing, wrong-rkey,
  early, at-deadline, late, replacement, sibling and valid-after-conflict records.
  A current-valid successor after a conflicted predecessor must retain positive
  cumulative conflict state and remains unusable; reset-to-zero and
  `conflicted -> clean` vectors fail. A prefix remains usable only with one unique
  timely valid, cumulatively clean finalization. A full conflict set at the limit
  uses `complete`; one-over uses bounded `overflow` and still permanently poisons
  the chain. An oversized serialized list, empty overflow certificate or
  incompatible-pair mutation fails before allocation. For the two canonical
  overflow reasons, the same fixed input always retains the same
  lexicographically smallest maximal prefix; a skipped
  smaller conflict, non-maximal prefix, different retry CID or exact omitted-count
  claim fails. Verifiers prove the retained pair but label existence of omitted
  conflicts as the witness's signed assertion. After overflow, cumulative
  count is a labelled lower bound and every successor preserves the overflow
  flag; exact-count labelling or `true -> false` fails. Full-scan list overflow
  uses `overflow_reason: list_limit`; a deterministic block/byte/depth cutoff
  after one complete pair uses `verification_budget_exhausted` and remains a
  terminal conflict. The same cutoff before one complete pair, or inability to
  fit that first pair, produces no conflict finalization and leaves coverage
  unavailable. Boundary fixtures check the operation immediately before, at and
  after exhaustion, and identical fixed input/profile bytes must reproduce the
  same reason, retained prefix, root and finalization CID. After one pair is
  proven, missing-artifact, invalid-artifact, transport, operational-budget and
  source failures each produce `scan_incomplete_after_conflict` with the exact
  artifact-path or source-boundary union and remain terminal; the same failures
  before that pair remain availability. Artifact vectors cover deeply nested and
  multiply referenced CIDs, exact root-descriptor/ordinal binding, full ancestry-
  path mutation and every failure-precedence collision. Source vectors require
  source ID plus authenticated
  cursor/proof and reject an artifact CID; known-CID failures require the artifact
  variant. Pre-publication recovery may produce a more complete
  result, but exact URI/CID retry after publication is immutable. Mutating,
  omitting or spuriously adding either the reason or `scan_failure` changes the
  cumulative conflict-chain hash and fails. After enough intervals for raw
  records and predecessor finalizations to expire, a new verifier checks current
  coverage by resolving the deterministic live head/current repository proof and
  opening its signed finalization, prefix, manifest and suffix without fetching
  the predecessor; the UI and API identify this as a
  witness summary rather than raw-history replay. Removing one still-live
  unfavorable member remains detectable.
  `DigestRkeyV1` vectors freeze lowercase RFC 4648 base32 without padding over
  exactly 32 raw octets, its all-zero and non-zero known answers, 52-character
  output and rejection of uppercase, padding, alternate alphabets, non-zero
  unused trailing bits, wrong lengths and finalization/head wrong-rkey records.
- Coverage-head vectors freeze the family/policy/source/witness slot hash,
  stable rkey, generation-one optionals, exact previous CID and declared-
  predecessor linkage ref/CID pair, monotonic generation,
  update kind, closed semantic-state projection/hash, closed `head_state_bucket`
  and exact next-bucket publication. They cover one publication per cut, semantic
  no-op suppression, exact-boundary retention renewal and cumulative
  clean/conflicted transition. They resolve the live record from
  a current signed repository commit/MST path and reject a cached older commit,
  alternate rkey, skipped/repeated/lower generation, same-generation second CID,
  rollback after restart, incomplete bounded proof, copied close bucket/cursors,
  invalid field-pair presence, publication before cut closure, wrong publication
  bucket, second same-cut generation, split/coalescing error, a late-arriving item
  assigned backward to an earlier cut, late complete publication and oversized
  head. Generation two with unchanged current state does not advance merely
  because predecessor-only cumulative fields became present. An early renewal,
  ordinary semantic no-op, renewal with a changed semantic hash, semantic update
  with an unchanged hash and generation gap one past the policy maximum fail.
  Terminal-anchor vectors
  cover source start with zero count/empty hash/start proofs and omitted close
  bucket, finalized prefix, raw-only and prefix-plus-raw forms. A genesis fork and
  pre-first-interval outage produce valid non-complete source-start heads; a
  source-start `complete` head or wrong proof-kind/presence rule fails.
  Conflict fixtures require the exact conflict-proof field pair, complete or
  bounded-overflow mode, head-specific root, last-uncontested chain hash and matching
  slot, family, policy and source. They reject a generation field in the proof
  and reuse the exact proof CID across an unchanged retention renewal.
  Missing/extra/reordered retained branches, a
  favorable post-fork raw or prefix selection, incomplete repository proof,
  wrong status, an oversized encoded proof, empty overflow certificate or
  mutated incompatible pair fails closed before recursive fetch. A reordered,
  non-prefix, non-maximal or retry-variant overflow selection also fails. Complete
  mode at the limit and `list_limit` overflow mode one past it both derive sticky
  conflict. A deterministic verification-budget cutoff after a complete pair
  derives `verification_budget_exhausted` and the same sticky conflict; cutoff
  before the first complete pair derives availability failure. Every declared
  scan-failure class after a complete pair derives
  `scan_incomplete_after_conflict`, its exact failed-occurrence descriptor and
  the same sticky conflict; before that pair it is availability. Wrong reason,
  reason/failure field presence, cutoff, retained prefix or canonical retry-
  variant CID fails fixed-input replay, while an already published operational
  overflow is immutable even if a later fetch succeeds.
  Two valid CIDs for one head generation derive `head_equivocation`; a later
  record naming either CID as predecessor cannot repair the slot or restore
  current status in the same witness-policy lineage.
  Availability may recover with a later generation only while cumulative status
  is clean; a fork, conflicted prefix, prior conflicted head or cumulative
  overflow marker never becomes clean or loses `conflict_overflow`.
  Fresh-install fixtures start from the live slot and current proof without
  scanning expired prefix sequences or arbitrary record keys. Generation one
  omits both transition-proof fields and becomes the initial baseline only after
  its current repository and bounded coverage proofs validate; every successor
  carries both transition-proof fields or fails.
  Even after the predecessor's own original retention expires, a still-current
  successor verifies its inline canonical predecessor record bytes/CID,
  historical repository commit, MST path and witness-key proof from the
  successor-carried transition artifact. Padded or mutated record bytes, a CID
  mismatch, or treating the inline record CID as a typed child fails. A maximum-
  catch-up fixture in which that predecessor is also a full head root assigns it
  exactly one root schema and does not recursively traverse through the inline
  copy. A missing, mutated, wrong-slot, wrong-rkey, wrong-CID or
  early-expired transition member derives `head_history_unavailable`. Only
  generations older than that declared predecessor are accepted-witness summary;
  clients do not claim to detect a historical reset that no retained archive or
  local highest-generation state can prove.
  A valid predecessor record and inclusion path from a historical signed
  repository commit validate the declared linkage even when the proof contains
  no commit-ancestry path to the current live commit; the result exposes no
  append-only-continuity claim. Hidden or deleted intermediate commits and an
  otherwise unobserved sibling remain at the accepted-witness boundary, while
  independently supplying two valid CIDs for one generation still derives
  terminal `head_equivocation`.
  Clock-relative fixtures derive verification bucket `v` from the pinned policy
  clock and accept a current head only when `head_state_bucket < v`,
  `published_at_bucket <= v` and `v < retention_until`. Equality, one-bucket-
  future, expired, rolled-back-clock and witness-supplied-`v` substitutions fail.
  Persisted-client fixtures catch up across zero, one and the exact maximum
  retained generations to their stored CID. Dense and maximally sparse semantic/
  renewal sequences both use the exact checked
  `catchup_generations * maximum_generation_gap_buckets` retention floor and its
  exclusive boundary; every retained version's repository, bounded, conflict and
  transitive dependency proof lasts through that floor. One-over generation or
  state-bucket gaps, missing intermediate
  records, wrong predecessor CIDs, missing transition proofs and expired
  repository proofs derive
  `head_history_unavailable`; restart cannot silently clear state. Explicit
  fresh-install/user-confirmed/policy-replacement rebootstrap records a new audit
  baseline, while automatic recovery and state-corruption reset fail.
  CID resolution and the embedded manifest hash are verified as distinct checks.
  A missing membership artifact, mutated entry, root/count mismatch, duplicate
  target, missing discipline record, source substitution, overlapping range,
  broken predecessor, interval fork, oversized membership artifact, deleted or
  under-retained refusal/diagnostic payload or overdue closure yields
  `coverage_unavailable`. Coverage-carried diagnostics and member payloads remain
  replayable after origin-record deletion. An incomplete diagnostic carrying a
  canonical event ID, or a complete event carrying only a diagnostic ID, fails.
- Evidence-witness policy-envelope vectors freeze issuer DID/key proof, stable
  policy-lineage ID, accepted and required-coverage witness sets, sequence,
  predecessor/activation fields, rotation mode,
  optional nomination/new-work/completion boundaries, successor-source/proof/
  deadline field presence, compatibility-profile, evidence-proof-resource-
  profile and evidence-feasibility-manifest ref/CID/hash fields, head-catch-up
  limit, signed maximum-generation-gap field and one-generation-per-state-bucket rule,
  canonical hash projection and signature domain. Score-witness policy-envelope
  vectors separately freeze their pinned non-rotating schema, role-registry
  ref/CID/hash, score-live-head-resource-profile and score-feasibility-manifest
  ref/CID/hash fields, finalization
  conflict/byte, head-byte, head-conflict, head-conflict-proof-byte and head-
  catch-up/generation-gap limits, one-generation-per-state-bucket rule, required live-head proof,
  proof-manifest and feasibility-artifact byte limits, and transitive block/byte/
  depth limits.
  A field mutation, invalid boundary order, fixed
  evidence policy carrying scheduled-only fields, scheduled evidence policy
  omitting them, failing the nomination-plus-delay-before-new-work inequality or
  naming a source without the fixed policy collection,
  self-referential hash encoding, valid signature from an unpinned issuer or
  cross-domain policy signature fails. An empty, unsorted or non-subset required-
  coverage witness set also fails.
- Evidence proof-resource-profile vectors freeze `raw_cid_block_v1`, every proof kind/root schema,
  typed child edge, root/operation count, per-root and aggregate canonical
  block/byte/depth limits, permit-request byte limit and operational network/
  redirect/concurrency/deadline budget, plus pre-allocation feasibility-manifest
  and per-fixture byte limits. Root, count or canonical closure excess
  yields `policy_limit`; a transport budget exhausted before canonical completion
  yields `unavailable_artifact`. Per-root budget reset, conflicting child schema,
  duplicate-CID double counting, decompression overflow and first-discovery depth
  in place of longest-path depth fail across witness and permit implementations.
  Raw-block vectors require an identity-encoded response body equal to the exact
  CID block bytes, reject JSON/base64 wrappers and CID-mismatched bodies, exclude
  transport headers/framing, and count redirect, error and retry body octets once
  each against the cumulative network limit. A no-redirect cold-cache fixture at
  the exact network boundary passes; one body octet under-provisioned fails
  policy feasibility.
  Traversal vectors freeze canonical root descriptors and total root tie-breaks,
  including fork siblings with the same signed predecessor, then require depth-
  first pre-order rather than breadth-first or implementation queue order. Deeply
  nested, shared-CID and alternate-path DAG fixtures reproduce the same complete
  `traversal_path`, unique-CID block/byte totals, schema checks, cycle result,
  longest depth, budget cutoff and retained conflict set across runtimes. A
  duplicate root, alternate root tie-break, child-order change, repeated fetch or
  expansion of a shared CID fails.
  Feasibility vectors freeze the manifest and fixture hash domains, exact policy
  projection, family, operation-kind set, ordering, one `single_root` fixture per
  proof kind, complete/conflict/maximum-catch-up fixtures, root multiplicities and
  recomputed block, byte, longest-depth and canonical cold-cache payload metrics.
  Family-specific projection vectors remove exactly the six named fields: each
  excluded-field mutation leaves the projection hash unchanged, every other
  field mutation changes it, and accidentally excluding
  `predecessor_witness_policy_hash`, sequence or activation/transition fields
  fails the evidence successor vector.
  Fixture vectors freeze family/operation/proof-kind equality and field presence,
  production root-descriptor URI presence and total root order, raw-CID block
  order, unpadded base64url
  block encoding, CID recomputation, complete reachability and unique-CID
  accounting; missing,
  disconnected, duplicate, unknown-edge and wrong-byte blocks fail.
  Missing, extra, duplicate, wrong-family, locally generated, hash-mismatched or
  tampered or oversized manifests/fixtures make policy activation fail. Exact-
  boundary fixtures pass;
  decreasing any per-root limit below its complete fixture, any aggregate root
  limit below mandatory multiplicity, or any aggregate block/byte/depth/network
  limit below the checked no-dedup sum of its per-root maxima makes the policy
  malformed. The maximum-catch-up fixture contains one conflict-bearing current
  head and exactly `maximum_coverage_head_catchup_generations` predecessors plus
  every successor's transition bundle; a clean,
  generation-one or minimum-only fixture cannot substitute for it.
- Score live-head-resource-profile vectors freeze current/catch-up/conflict root
  schemas, `raw_cid_block_v1`, the required-head aggregate root cap, typed traversal, blocks, bytes,
  longest depth, feasibility-artifact byte limits and network/redirect/
  concurrency/deadline budgets. Multiple
  required witnesses share one operation budget; resetting it per witness,
  omitting catch-up versions or charging a live refresh against the immutable
  score input-proof envelope fails. The score feasibility manifest carries exact
  complete, conflict and maximum-catch-up fixtures at the required-witness
  multiplicity. Its worst-case fixture has, per required witness, one current
  root, exactly `maximum_score_coverage_head_catchup_generations` predecessor
  roots and one conflict root. Exact no-dedup sums of every used root rule's
  per-root maximum must fit the aggregate canonical and network limits; exact
  boundaries pass and one-unit-under variants fail before activation. A
  positive or minimum-only but internally impossible policy/profile pair is
  malformed.
- Compatibility-profile vectors freeze `fixed_no_successor` and
  `v1_nonweakening`, profile hashing, lineage-wide profile equality and the exact
  field comparison. A scheduled policy carrying `fixed_no_successor` or fixed
  policy presented as rotation-capable fails. Signed successors that shrink witness sets, lower a quorum,
  shorten retention, lengthen a delay/permit lifetime/clock uncertainty, weaken a
  proof or coverage requirement, change a frozen registry/clock/resource limit,
  use any non-identical source continuation, split, merge, retire or introduce a
  source, carry a mapping artifact, or exceed `maximum_policy_drain_buckets` are
  `incompatible_successor`. Equal and strictly stronger allowed values pass. An
  unknown compatibility mode, changed profile hash or issuer-approved exception
  without a new lineage fails closed.
- Witness-policy vectors encode every evaluation, standing, challenge,
  lifecycle, processing and quorum-delay duration as an exact bucket count.
  Missing values, unit changes, a registry-maximum mismatch or any duration
  mutation changes the policy hash and invalidates dependent proofs.
- Golden retention vectors evaluate the exact authority-revocation, commitment,
  permit, private-permit-refusal, public-witness-refusal, outcome, discipline,
  evidence-event, successor-slot-closure, score-checkpoint, score-refusal and
  coverage formulas, including the checked head catch-up-generation times
  maximum-generation-gap floor, at
  ordinary, equality and one-bucket boundary cases. Public witness-refusal and
  score-refusal vectors exercise both observation-based and validated-target/
  expiry branches, including quorum-delay padding. Implementations cannot
  reinterpret comma-separated prose as `max` instead of addition or mix
  timestamps with bucket indices. A successor refusal includes the scheduled
  successor-observation delay; omitting that conditional term fails.
- Multi-witness outcome vectors require the q-th observation inside
  `maximum_outcome_observation_quorum_delay_buckets`; every selected checkpoint retains
  through its own bucket plus that delay and the full standing/challenge windows.
  Slow-quorum and under-retention fixtures fail without selecting a later subset.
- Commitment stream IDs, predecessor URI/CID pairs, sequence ranges and
  all-branches accounting have cross-runtime vectors independent of ingestion
  order.
- Per-response commitment windows are exactly one half-open issuance bucket.
  Batch windows bind their earliest/latest buckets and maximum span. Window
  mutation, an issuance bucket outside the window, incomplete full-window
  authority and a retention boundary not derived from both the exclusive window
  end and witness observation/quorum-delay formula fail.
- Original, amendment and revocation lifecycle envelopes have canonical revision,
  exact-predecessor, root-set and nullifier vectors. Two distinct
  `lifecycle_root_candidate` originals produce the same terminal canonical
  conflict set under every record and witness-disposition arrival order,
  including same-core/different-URI and same-URI/different-CID cases; exact
  URI/CID redelivery is idempotent. Mixed fixtures in which witness A checkpoints
  root A and emits a proof-bearing lifecycle-conflict refusal for B while witness
  B does the reverse produce the same two-member set. A bare refusal, missing
  retained target proof or intrinsically malformed root never consumes the slot.
  Replacing the lifecycle-conflict reason with every other bounded refusal reason
  leaves the root set byte-identical whenever the retained target proof still
  passes the intrinsic predicate. If one required witness withholds enough proof
  to decide that predicate, the slot becomes `coverage_unavailable` rather than a
  favorable one-root set. Fixtures iterate omission of every DID in the owning
  policy's exact `required_coverage_witness_dids` array; no local applicability
  predicate or alternate accepted-witness subset can preserve eligibility.
  An amendment permit binds the complete active predecessor proof and replacement
  core; a revocation has no permit or outcome values.
- Outcome and discipline lifecycle tombstones have canonical record-family,
  nullifier, terminal-state, deleted-head, conflict-set, source-cursor and
  retention vectors plus complete prior-head, signed repository-transition and
  evidence-event checkpoint proofs. The portable deletion bucket is the q-th
  event bucket; no local observation time appears. A Jetstream notification or
  unsigned non-inclusion claim is insufficient. Tombstone derivation is
  byte-identical after restart and every event ordering.
- Private permit-refusal vectors cover every bounded reason, required/forbidden
  optional field, reservation state, tuple/core hash, request hash, retention
  value, idempotent same-bucket retry and later-bucket transition from
  `too_early` to a valid permit. Unauthenticated requests receive no signed
  refusal.
- Phase 1C score vectors freeze manifest identity, repository authorship,
  canonical semantic input-set membership/root, input-proof-manifest
  membership/root/floor arithmetic, the score-input role-registry CID/hash and
  complete role/schema rule sets, standing status, stable series ID,
  sequence-scoped logical score key, predecessor binding, freshness watermarks,
  snapshot ID,
  score-refusal projection, score-coverage projection and score-snapshot-
  checkpoint signatures. Refusal vectors cover every reason, optional-field
  rule, exact URI/CID idempotence, equivocation and retention branch. A
  structurally valid refused sibling still creates a series conflict. The
  witness proof retains and authenticates the manifest, snapshot and every
  declared input artifact. Missing/extra/duplicate proof entries, semantic-set
  mismatch, checkpoint/proof-manifest self-reference, mutable artifact refs,
  unknown/missing/extra role rules, required/forbidden URI, hash or source-policy
  field mutations, wrong hash/retention rule, undeclared child-CID edges, unknown
  child schema, wrong edge cardinality, conflicting schema assignment or a CID
  cycle, a non-leaf registry bootstrap, wrong retention carriers, oversized
  registry bootstrap, excess schema/path counts or depth, excess direct-child
  bounds, same CID/different URI substitution, wrong source policy,
  manifest/snapshot/checkpoint input-watermark/generation/expiry
  mismatch, incomplete score quorum, missing membership artifact, forked score-
  coverage interval, oversized membership/proof-manifest/lineage artifact, wrong declared
  root size, transitive block/byte/depth mismatch or overflow, decompression-limit
  overflow, duplicate-CID double counting, first-discovery depth substituted for
  the longest alternate root path, missed
  target/closure deadline, excessive input/publication lag, overlong validity,
  late quorum, expired input proof and snapshot expiry all fail closed. Changing
  only `artifact_ref` changes the physical proof-manifest CID/root but leaves the
  semantic input-set root byte-identical; changing URI/CID identity changes it.
- Evidence-policy-lineage score vectors freeze the single-segment fixed-policy
  form and multi-segment scheduled form, canonical segment/head/source ordering,
  active-policy equality, the closed evidence-policy-bundle projection/root,
  predecessor sequence/hash
  continuity, the pre-activation successor-slot proof, retired terminal heads,
  the later closed transition-bundle projection/root and the complete source-
  transition partition. Every copied segment
  lineage ID, sequence, hash, predecessor, source-manifest CID,
  activation/nomination/new-work/completion boundary and optional-field presence
  has a mutation vector against the opened policy. Zero or multiple active segments, a non-final active segment, a retired
  final segment, a bridge on sequence one, a missing successor bridge or a
  coverage head outside the policy's required witness/source set fails.
  Omitting an unexpired unfavorable predecessor outcome or any live lifecycle,
  refusal, coverage, invalidation or no-suppression dependency fails. Duplicate
  cross-segment URI/CID ownership, a missing/extra transition rule, an unaccounted
  predecessor or successor source, an omitted candidate publication, slot
  closure, source position/range/start proof or required-witness disposition,
  wrong slot/bundle root or candidate-set hash, unavailable candidate proof,
  selected branch from a multi-hash slot, disagreement among predecessor-witness
  terminal cursors, a successor start differing from its signed manifest or
  authenticated start proof, a cursor gap or overlap, a
  missing/mutated policy, compatibility-profile or issuer-proof member block, a
  policy-bundle root/member mismatch, an archive omitting a required member block,
  deleted member origins without retained checkpoint copies, a missing/mutated
  transition proof bundle, a substituted or omitted required
  coverage witness, a nonterminal retired head, a wrong
  `source_policy_hash`, or combining proof sets across policies yields
  `coverage_unavailable`. Under `v1_nonweakening`, any non-empty transition-
  mapping CID or `evidence_source_transition_mapping` input fails before mapping
  fetch. Future-profile fixtures must require an exact top-level mapping entry,
  canonical bytes and enclosing-checkpoint retention for every mapping CID; CID-
  only, missing, mutated and expired entries fail. A carried transition bundle remains replayable through
  the enclosing score checkpoint after its predecessor coverage promise expires,
  but the same fixture proves that expired predecessor outcomes do not regain
  score weight. The active segment alone drives
  `input_coverage_through_bucket`: making a retired close bucket old does not make
  a complete score stale, while lagging any active required head still does. A
  predecessor snapshot expiring after its signed new-work boundary fails. The
  complete slot bundle alone closes structural candidate selection without
  terminal drain coverage. Future successor routing additionally requires the
  pinned activation-clock proof; requiring terminal drain merely to select the
  candidate fails. During
  drain, successor scoring remains `policy_transition_pending` until every
  predecessor terminal head and source bridge verifies, after which the same
  evidence produces one deterministic cross-policy score without changing the
  already closed candidate set. An over-limit
  cumulative lineage becomes unavailable; deleting its oldest retired segment or
  replacing it with an unversioned local summary does not restore validity.
- Score-series vectors require sequence one without a predecessor and every
  successor to increment once and bind the exact prior URI/CID. A skipped
  sequence, wrong predecessor, channel substitution, URI/CID replacement, two
  contents for one sequence or two children of one head makes the selected
  series unavailable under every ingestion order. Source-manifest, prior-
  coverage-head URI/CID/generation/current-repository/bounded-proof, current-
  position, snapshot and source-proof mutations invalidate
  the canonical coverage-prefix hash. Cumulative lineage artifacts retain the
  selected deterministic head, latest cumulatively clean finalized score-
  coverage prefix, contiguous raw suffix and every live prior
  checkpoint, refusal, membership artifact and proof through the new head's
  replay boundary without referencing the not-yet-created current coverage
  record. Independent witnesses may retain different physical proof
  references, but a quorum must derive the same semantic lineage root;
  disagreement cannot form a quorum. A new manifest/input advances the same
  series, later sibling discovery invalidates an older head, and expiry without
  a successor never reactivates an older snapshot as current. A spoofed author,
  copied series ID, unsupported outer schema or invalid repository proof remains
  in source coverage but consumes no series-lineage entry or limit. A repository-
  authenticated admitted sibling refused at a deeper check remains in lineage
  and still exposes the conflict.
- Score-coverage-prefix vectors mirror the evidence-prefix accumulator, consistency,
  challenge, live-dependency, expiry and resource-limit vectors under the score
  domains. Score-policy vectors reject empty, unsorted or duplicate accepted and
  required arrays, a required DID outside the accepted set, quorum zero or above
  the accepted-set size, zero limits and an impossible prefix cadence. Fixtures
  iterate omission and substitution of every DID in the exact
  `required_score_coverage_witness_dids` set. A valid observation quorum from a
  favorable accepted-witness subset remains unavailable when any required
  coverage proof is absent, stale or exposes a sibling; adding an unrequired
  witness never repairs the omission.
- Multi-dimension outcomes carry one canonically sorted, verifier-derived series
  entry per distinct outcome dimension. Missing, duplicate, extra, reordered or
  incorrectly derived series entries fail.
- Discipline aggregate nullifiers omit claimed coverage buckets and are identical
  for one author/service/scope/evidence-type tuple across every reported period.
- Every public record validates against a frozen schema and rejects unknown
  security-critical fields where extension is not explicitly allowed.

### 20.2 Receipt and attack tests

- A firehose watcher who knows a public commitment URI but lacks the detached
  requester authorization, receipt, salts, publication permit and any
  profile-required item proof cannot publish an accepted outcome.
- Mutating the requester, requester key/proof CID, request hash, service, scope,
  query category, schema or authorization bucket invalidates the detached
  request authorization without exposing the private payload or nonce.
- A provider cannot answer under a different profile CID, declaration CID,
  behavior epoch, authority URI/CID, release CID, runtime key, capability schema
  or outcome policy than the requester authorized. Rotation during an outstanding
  request requires a newly signed request and stale-contract substitution fails.
- A response or decline issued before the authorization start bucket, in or
  after the exclusive expiry bucket, or verified only under a rotated current
  requester key is rejected; the pinned historical key proof verifies the valid
  original.
- An external AT Protocol identity without a Dina signing method can complete the
  local recommendation/private-outcome loop but cannot publish a V1 public
  outcome or verified discipline record; adding the method and valid lineage
  enables only newly authorized requests.
- One response commitment cannot verify against receipts for two recipients or
  two receipt identifiers. Two distinct commitments for one deterministic
  `receipt_id` are retained as equivocation. A conflict known before permit
  issuance receives a signed refusal. A later conflict leaves every commitment
  in the denominator, contributes at most one least-favorable effective outcome
  for the receipt and cannot improve standing under any ingestion order.
- One authorized request cannot produce both an active signed decline and an
  active response receipt. Idempotent retries return byte-identical terminal
  artifacts; conflicting dispositions remain visible as equivocation and earn
  no positive availability credit under every ingestion order. A later decline
  cannot erase a previously witnessed unfavorable response outcome. The
  conflicted request is terminal and only a newly authorized request can proceed.
- A valid receipt used by the wrong DID, namespace author, service, scope,
  behavior epoch or subject is rejected.
- A namespace-authored V1 outcome is rejected even when its controller is the
  receipt-bound requester; the receipt's root DID is the required record author.
- A valid item proof cannot be transplanted to another response or batch.
- A runtime signature cannot directly make the runtime DID the author of an
  operator-owned commitment, and a record in the wrong repository is rejected.
- The operator publisher rejects an unauthorized, expired or wrong-epoch
  runtime signature before attempting a PDS write.
- Ordinary authority transitions verify an exact predecessor and activate only
  when the complete grant/revocation observation quorums bind the same transition
  and final declaration strictly before the declared boundary. Emergency
  revocation invalidates the intersected bucket and every later receipt under
  that authority; deleting or replacing the revocation record at its URI does
  not restore eligibility or improve the no-suppression estimate.
- A newly started scorekeeper recovers the exact authority grant from the
  commitment proof bundle, its complete signed observation quorum and every
  applicable revocation observation from the pinned score input proof archive.
  Missing record bytes, repository inclusion, historical operator/witness DID
  proof or an unexplained authority source gap makes affected evidence
  unavailable rather than authorized.
- A curator and Sybil requester cannot create an immediately mature outcome by
  signing historically dated request/response buckets and publishing the
  commitment now. The portable commitment bucket becomes the evaluation anchor
  when later than the response bucket, and one-bucket-before/at/after fixtures
  reproduce across restarts and witness counts.
- Backdated payload or repository timestamps cannot replace accepted signed
  commitment-observation, publication-permit or outcome-observation quorums.
- A newly started scorekeeper can replay historical commitment-before-outcome
  ordering from checkpoint proofs without having observed the original events.
- Deleting the commitment-checkpoint record after outcome publication does not
  break replay because the outcome embeds the complete signed commitment proof.
  An otherwise identical outcome containing only its checkpoint CID is rejected.
- Deleting an outcome-checkpoint record from the witness PDS does not break
  replay while its complete content-addressed checkpoint and outcome proof
  bundle remains inside `retention_until`; a new scorekeeper recovers it from the
  witness archive or verified successor hand-off. A CID with no retrievable
  proof-bearing content makes the outcome unavailable, not verified.
- After an outcome is accepted, deleting the origin commitment does not break
  replay: a new scorekeeper verifies the commitment bytes and repository proof
  from the witness-retained bundle, marks `origin_deleted` and preserves the
  outcome contribution.
- Origin deletion associated with live outcomes contributes the declared
  commitment-discipline/anomaly signal and cannot increase standing.
- Every curator-controlled invalidation type requires its complete
  evidence-event checkpoint quorum before a reference scorer publishes the
  changed standing. Evidence staged in an earlier or equal bucket remains in the
  no-suppression counterfactual; only a strictly later stage is excluded. Same-
  bucket, cross-repository, reversed-delivery and delayed-checkpoint vectors
  produce identical results.
- An incomplete, over-delay or conflicting event quorum yields
  `invalidation_order_unresolved`; it may block ordinary eligibility but cannot
  publish a more favorable estimate or convenience band. Repository timestamps,
  source-cursor comparison and local ingestion time cannot resolve the state.
- A forged checkpoint, unaccepted witness, wrong source cursor, missing or
  mismatched source-position proof, or insufficient witness quorum is rejected.
- Authority observations, commitment checkpoints, permits and outcome
  checkpoints from incompatible witness-policy hashes cannot be combined to
  satisfy any quorum, even when all individual signatures are valid.
- Clock rollback, excess declared uncertainty, a changed outcome-policy bucket
  or an unpinned clock-source identifier fails closed without issuing a permit or
  outcome-observation bucket.
- The preview witness emits a complete signed authority observation for every
  valid authority grant/revocation and checkpoints every valid commitment and
  curation outcome in its declared source ranges, except that an intrinsically
  valid second lifecycle-root candidate receives the bounded, proof-bearing
  `lifecycle_root_conflict_candidate` refusal. It emits another signed reason-
  coded refusal for an invalid public record before the applicable policy
  deadline. It separately checkpoints every completely proven covered invalidation or
  lifecycle-deletion event; incomplete event candidates remain labelled health
  diagnostics. Selective omission, an unexplained cursor/sequence/event gap and
  an unsigned timeout are detected and reported as distinct witness states; none
  makes an outcome scoreable.
- Every closed coverage interval accounts for each source target exactly once by
  checkpoint/observation or refusal root. Omitting a valid target while advancing
  the cursor, changing the source manifest, forking the interval chain or failing
  to close on schedule makes affected standing `coverage_unavailable`; it cannot
  be repaired by a later scorekeeper-selected source range.
- A witness refusal fails verification after target type, URI/CID, source,
  policy, reason, time, validated-target retention, computed retention,
  witness-key or signature mutation; a refusal authored outside the witness
  repository is rejected when repository publication is required. Deleting its
  origin record or diagnostic source does not break replay while the enclosing
  coverage archive remains inside retention. The lifecycle-root-conflict reason
  additionally fails without the complete repository-authenticated target and
  intrinsic-proof bundle. Other reasons neither promote nor suppress a target:
  the scorekeeper applies the same intrinsic candidate predicate to every
  complete retained refusal proof.
- Successor-refusal vectors require `target_type = witness_policy_successor`,
  one of the closed successor reason codes, the candidate's authenticated source
  position and the conditional successor-observation delay in
  `retention_until`. Mutating the target type to an ordinary evidence family,
  omitting that delay or accepting a disposition at its exclusive deadline
  fails.
- A private permit refusal fails after permit-request hash, reason, bucket,
  reservation state, required optional field, retention, policy, key or signature
  mutation. Same-decision retries are byte-identical; a later mature retry may
  return a permit. It remains local unless separately published, while silence
  remains a timeout claim rather than a signed refusal.
- Concurrent permit requests for the same `receipt_id` and commitment tuple are
  idempotent per request hash. While the policy admits new work, a fresh request
  for the same revision slot/core receives a newly request-bound permit without
  creating another lifecycle right. Requests for different tuples or cores
  produce one durable reservation and the corresponding signed conflict refusal.
  Multi-witness fixtures reject fixed-set policies with `2q <= n`; two
  conflicting complete permit quorums under a valid policy prove witness
  equivocation and invoke the least-favorable no-suppression rule rather than
  favorable proof selection.
- Partial-quorum retry vectors use at least `n=4, q=3`: request A expires after
  two witnesses issue permits, the user confirms fresh request B, B reaches the
  other two, and then B is sent to all four. The first pair must issue B for the
  same reserved slot/core once its checks pass, at least three B-bound permits
  form one quorum, and no A/B mix is accepted. Restart, lost response and
  repeated expiry produce the same result.
- A fixed policy rejects every claimed same-lineage successor. Structural
  scheduled-successor fixtures validate only through the complete chain from the
  bundled anchor, increment the sequence once, name the exact predecessor and
  assign activation exactly at the predecessor's signed new-work boundary. They
  do not authorize a shipping client until the future activation-clock profile is
  present and valid. The successor policy record must occur in
  the named policy source inside the pre-activation nomination range and appear in
  every required witness's signed slot closure. Slot vectors freeze the closure
  record/NSID, membership artifact, source position/range proofs, exact required-
  witness set and bundle root independently from terminal drain coverage.
  Candidate-set vectors cover zero candidates, one candidate, byte-identical
  republication, two compatible but differently strengthened candidates, delayed
  discovery by one witness, refusal-label and refusal-target-type mutation, an
  observation whose `witness_policy_hash` differs from its
  `predecessor_witness_policy_hash`, successor dispositions one bucket before and
  exactly at their exclusive delay deadline, a closure at the new-work boundary,
  deadline-arithmetic overflow, candidate-origin deletion and candidates first
  published immediately before, exactly at and after the nomination cursor. Zero
  is `successor_missing`; one is the unique structural candidate; two distinct valid
  hashes remain terminal `policy_lineage_equivocation` under every arrival,
  restart and deletion order. A skipped, selectively omitted, backdated or wrong-
  issuer chain fails. Restart and fresh installation recover every closed
  candidate-set result; future activation fixtures also recover the highest
  clock-authorized sequence. A valid slot proof followed by unfinished ordinary
  predecessor drain still establishes the unique candidate while public scoring
  remains `policy_transition_pending`; future routing additionally requires the
  activation-clock proof, not terminal drain. Withholding the sole
  successor slot proof at the boundary produces explicit policy unavailability
  and never extends predecessor use. A correctly signed but compatibility-
  weakening successor is handled identically:
  it does not activate, and the predecessor is not extended as a fallback.
  Activation-clock fixtures prove that a fast or corrected local clock cannot
  activate that unique candidate, a slow local clock cannot override an accepted
  authenticated lower bound, uncertainty crossing the boundary delays activation,
  rollback fails closed and restart preserves both last accepted time and highest
  activated sequence. Under the current schema every scheduled fixture remains
  client-disabled because no activation-clock profile can be pinned.
- Rotating to a valid scheduled successor preserves every continuing witness's
  receipt and core reservations as anti-replay state, and a conflicting tuple
  remains refused. The successor rejects every pre-activation response even when
  witnesses intersect or reservation state is available; it never re-witnesses
  that commitment into a successor permit. Only an outcome whose canonical source
  position is below cutover and that carries its complete predecessor permit quorum may
  finish checkpoint/refusal and coverage processing during drain; every other
  interaction is replaced by a newly authorized post-activation request/response
  with a new request hash, receipt, commitment, nullifier and evaluation clock. A
  successor outcome with any predecessor authority observation, checkpoint or permit fails, as does a
  successor proof that changes the old portable commitment bucket, evaluation
  anchor, maximum-horizon deadline or retention ceiling. Changing the lineage ID
  never inherits an old reservation implicitly.
- At the scheduled new-work boundary, a predecessor rejects every permit request,
  including a still-unexpired instance issued before the boundary, and every
  public target at or above its canonical cutover cursor. A backdated requester
  issuance bucket or witness-local observation time cannot create drain work.
  Golden cursor vectors include the largest representable activation bucket;
  the next bucket, checked-multiplication overflow and a profile-width overflow
  all fail instead of wrapping. A
  public target below the cutover cursor may receive its pending checkpoint or
  canonical refusal even when a lagging witness receives it after activation, and
  an outcome already carrying a complete predecessor permit quorum may be
  checkpointed strictly before the signed
  completion boundary. Equality with that
  boundary and every later signature fail. An expired partial request cannot be
  refreshed in the drain interval, and an unexpired partial request cannot be
  completed there.
  Historical predecessor proofs continue to verify through their own retention
  boundaries without authorizing another target, request or lifecycle slot.
- A fully valid but too-early request for tuple A durably reserves only its
  receipt binding and returns `not_before_bucket`. A later request for conflicting
  tuple B is refused before or after maturity, including after crash/restart or a
  timed-out response. The early request does not consume the interaction
  nullifier or prevent a mature request for tuple A. Repeating the same signed
  request is byte-identical; while the policy admits new work, using a fresh
  request ID after expiry produces a new permit bound to that request and the same
  eventual core slot.
- An original or amended outcome without the complete permit quorum, with a
  permit for another core, receipt, commitment, claim, subject or nullifier, or
  with a permit issued before the minimum delay is ineligible even if it is first
  observed much later. A checkpoint cannot retrofit the missing minimum-delay
  proof; a valid linked replacement needs a new permit.
- An amendment with the same deterministic nullifier succeeds only when it names
  the exact current active outcome URI/CID, increments the revision once, retains
  every invariant identity field and carries a fresh permit and checkpoint for
  its replacement core. The predecessor and replacement are never both counted.
- An out-of-order amendment waits for its predecessor. A wrong-predecessor,
  skipped-revision or identity-changing amendment fails without altering the
  active slot. Two valid children of one predecessor create a terminal lifecycle
  fork under every ingestion order and remove that slot from current standing.
- Two distinct revision-one `lifecycle_root_candidate` outcomes for one
  nullifier create a terminal root conflict under every ingestion order, even
  when their outcome-core hashes and permit quorums are identical or only one
  received an outcome checkpoint before the collision was known. Seeing an
  amendment or revocation of one root first does not make that root canonical.
  The same vectors pass for signed-decline and aggregate-discipline originals;
  deleting one conflict member never activates another. A candidate lacking both
  a valid checkpoint and the bounded proof-bearing conflict refusal is
  unavailable rather than silently admitted, while an intrinsically invalid
  record cannot manufacture a conflict.
- A same-author revocation of the exact active head advances the revision,
  requires an accepted outcome checkpoint, contributes no outcome value and
  cannot be followed by reactivation under the old receipt.
- Deleting an active original/amendment, revocation or visible fork child first
  creates `deletion_pending_witness` with the prior state preserved. Only the
  complete event quorum installs `deleted_terminal`,
  `revoked_deleted_terminal` or `conflicted_deleted_terminal`. Replaying a
  predecessor, recreating the URI with another CID or republishing the nullifier
  cannot reactivate it; deleting a superseded non-head changes nothing.
- A verified deletion transition without its event quorum produces
  `deletion_pending_witness`, excludes the deleted content, suppresses any newly
  computed current score and never restores a predecessor. Completing the quorum
  installs the same portable bucket and tombstone on independent scorekeepers;
  refusal or expiry leaves the slot unavailable rather than active. No fixture
  may publish an improved score from the pending state.
- The same delete-head, delete-revocation, delete-fork-child and no-reactivation
  vectors pass for signed-decline and aggregate-discipline nullifiers. A legal
  fixture that removes even the anti-replay marker yields a labelled
  `erasure_unverifiable` source interval rather than a portable dedup claim.
- An outcome whose q-th accepted first observation is after the maximum horizon,
  or before the latest embedded permit bucket, is ineligible even if `created_at`
  claims otherwise.
- Boundary vectors compute the V1 lower and upper elapsed bounds from one-hour
  evaluation-anchor/permit/outcome-observation buckets. Equality passes, a one-
  bucket-short permit minimum, a one-bucket-late observation maximum, a permit
  before the later response/commitment anchor and an observation before the
  latest permit fail identically across runtimes.
- A newly started scorekeeper derives the same permit lower bound and
  quorum-observation upper bound from retained proofs without trusting its own
  ingestion time.
- Evidence contributes through the signed `retention_until` boundary and stops
  immediately after it. Extending a database row or changing a later policy
  without a valid renewal protocol does not extend V1 standing.
- A commitment checkpoint whose proof bundle omits the record block, signed repo
  commit, MST path or versioned DID-resolution proof is not independently
  replayable and is rejected by the reference verifier.
- Withholding a curator-hosted proof does not block verification of a published
  batch; clients derive it from the content-addressed leaf artifact.
- A missing, truncated, digest-mismatched or oversized leaf artifact leaves all
  affected provisional receipts ineligible.
- After a batched outcome embeds a valid inclusion proof, later loss of the full
  leaf artifact does not invalidate that outcome when the witnessed commitment
  record and batch root remain available.
- Replayed request and response nonces are rejected across process restart and
  concurrent ingestion. A repeated interaction nullifier is rejected unless it
  is a fully verified direct amendment or revocation of the one active head.
- Repeated distinct receipts in one interaction series obey cooldown, decay and
  maximum-effective-weight limits; scope aliases or epoch changes do not reset
  the series unless the pinned policy accepts a material-change reset.
- A valid multi-dimension outcome contributes once to each distinct
  verifier-derived dimension series. Omitting or duplicating a series entry, or
  reusing one dimension's series ID for another, earns no standing.
- Commitment gaps, overlapping ranges, two children of one predecessor and one
  URI with two CIDs are detected under every ingestion order. Every distinct
  valid commitment on every branch remains in the denominator; republishing an
  identical commitment counts once and is flagged.
- A curator cannot include hidden outcome claims, omit a claim for a
  public-eligible recommendation, attach a claim to a `local_only`
  recommendation or exceed the maximum recommendation-set size.
- The reference client rejects a response whose signed counts or claims do not
  match what it will render. A structurally valid fixture from a modified client
  is labelled a curator-recipient co-attestation; neither verifier nor UI claims
  independent knowledge of its historical display.
- `curation-v1-minimal` rejects zero or multiple public-eligible claims in a
  standing-eligible non-empty response and rejects a sole claim whose original
  rank is not one.
- Signed decline receipts fail under request, scope, authority, timestamp or
  signature mutation. Timeouts and unsigned refusals remain labelled claims and
  cannot enter the verified-decline dimension.
- A signed decline with a valid detached request authorization proves only that
  the runtime declined that authorized hash. `out_of_scope`,
  `unsupported_request`, `capacity`, `temporary_failure` and `policy_decline`
  remain descriptive V1 availability evidence and cannot alter quality standing
  or the convenience band.
- A public discipline record without its complete exact-URI/CID checkpoint quorum
  contributes no public metric. Omitting it from a closed coverage membership
  artifact, replacing its CID, supplying a root without leaves or allowing its
  proof/authority carrier to expire makes the discipline dimension unavailable;
  local ingestion never substitutes.
- Republishing one signed decline under multiple record URIs consumes one
  verifier-derived nullifier. Distinct requests from the same subscriber,
  service and scope remain in one discipline series and obey cooldown,
  diminishing-weight and per-window caps across restart and concurrent ingestion.
- A published signed-decline discipline record can be revoked but cannot amend
  the underlying receipt, request hash or terminal disposition. Any such mutation
  is a conflict and earns no availability contribution.
- Repeating one unverified aggregate under different record URIs consumes one
  author/service/scope/type nullifier regardless of claimed coverage buckets. A
  corrected cumulative aggregate uses explicit amendment lineage and never adds
  a second raw or effective count.
- Changing `covered_from_bucket`, `covered_until_bucket` or `claim_count` cannot
  mint a second aggregate nullifier. Those values remain bounded unverified
  claims and never become independent request observations.
- Scope aliasing, scope slicing, category-to-scope mismatch and service
  replacement without signed lineage do not erase or misapply standing.
- Routine key rotation preserves behavior standing; unauthorized issuers and
  post-compromise signatures fail.
- Ordinary authority rotation activates only on a one-hour UTC boundary. An
  emergency compromise inside a bucket invalidates the full bucket under every
  ingestion order.
- Historical requester signatures and repository proofs verify against their
  pinned DID-resolution versions after key rotation and fail when only an
  incompatible current DID document is supplied.
- Public outcome and ordinary-review records for one interaction produce one
  curator signal under every ingestion order.
- Malformed rationale, evidence URLs and card content cannot invoke tools,
  trigger fetches or escape presentation bounds.
- Oversized, malformed, unlinked duplicate-nullifier and bad-signature outcomes
  fail before any remote proof fetch. Adversarial records cannot exceed the
  declared fetch-count, byte, concurrency or deadline budget; concurrent
  references to one CID coalesce into one retrieval. Canonical root/block/byte/
  depth excess returns `policy_limit`; network-byte, redirect, concurrency or
  fetch-duration exhaustion before canonical completion returns
  `unavailable_artifact`, and neither implementation may reset the cumulative
  budget at a nested attachment.
- Oversized, unauthenticated or malformed permit requests fail before remote
  proof resolution and obey the same policy-pinned cumulative proof-resource
  profile plus per-requester, per-service and global rate budgets. An
  issued permit retries byte-identically for the same request hash across
  restart; while the policy admits new work, a fresh request for the same reserved
  slot/core receives its own bounded permit, while a fully valid too-early request
  reserves only its receipt tuple and an invalid request reserves nothing.
  Neither too-early nor invalid traffic consumes the outcome-core slot or blocks
  later valid issuance for the reserved tuple.
- An invalid early-arriving record cannot consume an interaction or decline
  or aggregate nullifier; the later fully valid record succeeds exactly once
  under concurrent ingestion.

### 20.3 Privacy tests

- Default curator requests contain no vault excerpts, relationship graph or
  local personalization features.
- A sensitive-scope query is not transmitted before confirmation shows the
  curator, requester DID, scope, category and exact outbound payload.
- One-shot sensitive-query confirmation is bound to the exact canonical payload
  digest. A reusable policy accepts only declared semantic fields and value
  classes; same-shape but semantically different data is rejected and prompts
  again.
- Reusable sensitive-query confirmation is invalidated by curator, scope,
  identity, profile, declaration, behavior epoch, authority, release, runtime
  key, capability schema, outcome policy, purpose, request schema, use-limit or
  expiry changes; cancellation emits no request.
- Every explicit-context field is covered by an active scoped grant and the
  exact egress payload is auditable.
- Minimal outcomes disclose no rationale, other recommendation content, raw
  query payload, request nonce or exact query/response/evaluation time. Fixtures
  show that observers do learn the query category, `recommendation_count`,
  `public_eligible_count`, the coarse commitment/evaluation-anchor/permit/outcome-
  observation buckets and ordinary publication metadata; the payload preview
  explains those leaks and the count co-attestation limit.
- Cancelling before permit-request confirmation sends nothing. Cancelling after
  permit issuance but before final-public-record confirmation creates no public
  record but leaves an audit entry that the accepted witness saw the recipient,
  curator, scope, selected subject hash and frozen outcome core; UI copy and
  telemetry never describe that case as zero disclosure.
- An expired partial permit quorum cannot be retried under a fresh request ID,
  nonce or validity window until the renewed exact request is shown and confirmed;
  witnesses may reissue for the same reserved core only after that confirmation
  and only while the policy admits new work.
- The final confirmation fixture shows the exact generated permit and every
  public proof field; publishing bytes that differ from that preview fails.
- Mutating the confirmed outcome core after permit issuance invalidates the
  permit and requires a new permit-request confirmation, permit and final-public
  confirmation.
- The detached request authorization verifies publicly while revealing the
  canonical query category but no payload or nonce; category-to-scope mismatch
  fails and dictionary guesses against the private payload fail without the
  independently generated 32-octet nonce. Fixtures with repeated, short,
  non-canonical or deterministic nonces are rejected or fail the reference SDK
  generation audit.
- Public batch leaves remain computationally opaque without receipt salts and
  do not expose recipient bindings or recommendation subjects.
- Sensitive-domain outcomes default to private and require explicit
  permit-request disclosure plus final public-payload and identity confirmation
  before publication.
- V1 exposes no pseudonymous or namespace curation-outcome mode; future
  one-time-key fixtures cannot reveal the root DID and must preserve replay and
  series-deduplication invariants before such a mode ships.
- Preview UI and diagnostics describe quorum-one first-party witnessing
  accurately and never label it independent or decentralized.
- Commitment timing and batch metadata are measured for linkage risk under low
  and high traffic; the UI warning matches the configured mode.
- Local commitment-discipline reporting is disabled by default, rate-limited,
  consented and resistant to unique-user fingerprinting.
- Public discipline evidence receives an independent exact-payload, query-
  category and identity preview; sensitive-scope discipline remains local unless
  freshly confirmed.

### 20.4 Scoring and statistical tests

- One favorable outcome cannot produce an established band.
- Increasing coordinated, low-standing or affiliate outcomes cannot overwhelm
  independent established evidence merely through volume.
- Curator-subscriber collusion and fabricated-interaction simulations reduce
  effective sample size and surface coordination risk.
- Missing outcomes and unknown query counts never appear as a complete success
  denominator.
- Selective commitment changes the commitment-discipline dimension, not the
  outcome numerator as though omitted queries succeeded.
- `public_outcomes_per_commitment` is never labelled as action rate, follow-up
  rate or unconditional success probability.
- Outcome values outside the scope policy, whose permit lower bound is before its
  minimum delay or whose quorum-observation upper bound is after its maximum
  horizon, or that use an ineligible `selected` stage earn no quality weight.
  Payload `created_at`, repository time and attester-supplied clocks cannot
  mature an outcome.
- Confidence calibration compares only matching target IDs and evaluation
  horizons.
- Recommendation stuffing, low original rank and multi-curator overlap receive
  the published bounded or fractional credit.
- Confidence intervals widen with missingness and shrink only with effective,
  not raw, sample size.
- Epoch priors remain capped; scope and epoch history cannot silently transfer.
- Starting from a checkpoint with unfavorable witnessed evidence, each
  curator-controlled event is applied separately and in combination: emergency
  authority revocation, grant/revocation fork, conflicting commitment,
  response/decline conflict and operator commitment deletion. For every
  higher-is-better and lower-is-better dimension, the final estimate, confidence
  bound and convenience band are never more favorable than both the ordinary
  result and the no-suppression counterfactual.
- Conflicting receipt artifacts contribute at most one effective quality sample,
  use the policy-defined least-favorable value capped at neutral and retain every
  distinct commitment in the denominator. Ingestion order, delayed discovery
  and restart produce identical tainted counts and estimates.
- Invalidating favorable evidence may still worsen the ordinary result; the
  no-suppression rule never floors standing in the curator's favor. Independent
  attester deletion, moderation and legal-erasure fixtures follow their own
  declared policy and are not misclassified as curator-controlled events.
- Rotating to a new behavior epoch leaves the prior epoch's compromise and
  equivocation warning visible in service lineage and cannot convert the new
  epoch's capped prior into earned standing.
- Given the same artifact, manifest and checkpoint, independent scorekeepers
  produce byte-identical reference outputs.
- Changing the subject resolver version, subject graph checkpoint, outcome
  policy registry or repetition policy registry changes the manifest identity;
  identical pinned inputs reproduce identical merge and repeat weighting.
- A score without probe evidence remains valid. Adding probe evidence requires
  `probe_policy_hash`, changes the manifest identity and affects only labelled
  drift dimensions.
- A scorekeeper's own probes and curator-supplied probes against a competitor are
  rejected. Probe-only drift can raise a labelled warning but cannot split a
  behavior epoch; a split must satisfy the pinned threshold using independent
  non-probe evidence without counting the probe sample.
- With no outcomes, every curator remains `unrated`. First-party or featured
  catalog metadata never creates standing, and no synthetic launch outcome enters
  the scorer.
- A score run that references same-run attester/item standing or forms a cyclic
  dependency graph is rejected; prior finalized checkpoints reproduce exactly.
- Public digest, subscriber-claim and independent-probe coverage samples remain
  source-labelled and are not silently pooled as complete coverage.
- Conflicting score snapshots for one canonical logical key or two children of
  one predecessor produce equivocation evidence and make that series unavailable
  rather than producing an average. Changing scorekeeper channel, service,
  scope or epoch creates a different series. Changing manifest or input
  checkpoint advances the same selected series and cannot evade conflict
  detection; changing an ambiguous display label changes neither.
- Two complete score-witness checkpoint quorums for one logical score key or
  sibling sequence remain independently verifiable equivocation evidence after
  either origin record is deleted. A CID-only witness, checkpoint for the same
  CID at another URI or incomplete record/repository/MST/DID proof does not
  become a durable claim.
- `current`, `unrated`, `pending`, `unavailable` and `expired` snapshots have
  canonical field-presence rules. Pending deletion, unresolved invalidation,
  broken coverage, unavailable proof/archive and legal erasure cannot retain a
  current-looking estimate or convenience band; stale history identifies its
  original snapshot and checkpoint.
- A score manifest whose derived `score_replay_until_bucket` exceeds any required
  input proof's retention boundary is rejected. At expiry the score becomes
  historical even if its snapshot record and witness checkpoint remain online.
- Mutating any copied input-checkpoint hash, coverage watermark, generation
  bucket or expiry in only the manifest, snapshot or checkpoint is rejected
  before witness signing. No longer-lived copy can extend the shared run
  envelope or its proof-retention floor.
- Input freshness uses the minimum complete coverage head across every required
  witness/source chain. A fast source cannot mask one stale chain. Backdating
  `generated_at_bucket`, selecting an old input checkpoint or extending expiry
  beyond the pinned input-lag, publication-lag or validity bound never produces
  `current`, even when all signatures are valid.
- Score-coverage prefix vectors repeat the evidence consistency-proof, live-
  interval-manifest and finalization suite under the score family, policy and
  domain separators. A mismatched evidence-family attachment, score prefix
  without a unique timely valid finalization, missing carried refusal/sibling or
  finalization whose copied compacted-through close bucket differs from the
  prefix fails closed. Complete finalization conflict count and encoded bytes at
  the pinned limits pass; a completed one-over scan produces
  `overflow_reason: list_limit`, while a canonical block/byte/depth cutoff after
  one proven pair produces `verification_budget_exhausted`; both poison
  cumulative state. Each declared scan-failure class after a proven pair produces
  `scan_incomplete_after_conflict` with its exact descriptor and also poisons
  cumulative state; the same canonical or operational stop before a complete
  pair is availability.
  Attempting to serialize the one-over list, or an empty/malformed overflow
  certificate, fails before list allocation.
- Current-score coverage vectors refresh every exact required witness head at
  verification buckets one before, exactly at and one after the exclusive
  `maximum_score_coverage_lag_buckets` boundary. The first may remain current;
  equality and later are stale/unavailable. They resolve the deterministic live
  score-head slot and reject an older current-repository commit, head-generation
  rollback, alternate slot and oversized record. Every successor proves its
  declared predecessor through the retained transition bundle, and future or
  expired heads fail against the pinned policy-clock bucket. The retained bundle
  proves that declared record linkage, not repository-commit ancestry or absence
  of an unobserved sibling; an independently observed same-generation sibling
  still derives terminal locator equivocation. Complete score head-
  conflict count and encoded proof bytes at the pinned limits pass; completed
  one-over conflict sets use `list_limit`, while deterministic proof-budget
  exhaustion after one complete pair uses `verification_budget_exhausted`; both
  remain terminally conflicted. An operational failure after that pair uses
  `scan_incomplete_after_conflict` and remains terminal; the same failure before
  the pair is availability. Reason/failure presence and post-publication
  immutability vectors apply in both families, and
  oversized serialized lists fail before allocation. The full required-witness refresh,
  catch-up versions and referenced descendants share one live-head profile;
  aggregate one-over blocks/bytes/depth fail during bounded streaming even when
  every individual head is under its local limit. Same-generation locator equivocation derives
  `head_equivocation` and cannot be repaired by a successor on either branch.
  They replay an older all-valid bundle after a
  later sibling, required-witness closure or source outage and never retain
  `current`; a newly closed clean head cannot hide a previously recorded fork or
  cumulative prefix conflict. Multi-witness fixtures prove that one fresh head cannot mask another
  stale, unreachable or forked required head. Effective-status vectors preserve
  the immutable signed snapshot bytes, return the verification bucket and head
  identities, suppress numeric current display and forbid a derived wrapper from
  upgrading any signed non-current status.
- A score checkpoint observed at or after snapshot expiry, whose q-th quorum
  bucket reaches expiry or whose retention is shorter than
  `score_replay_until_bucket` is refused/rejected and cannot become historical
  proof through a past-dated retention promise.
- After enough score generations for the first predecessor checkpoint's original
  retention to expire, the newest cumulative lineage artifact still replays every
  sequence and prior fork check from retained content. Removing one predecessor,
  membership artifact or coverage record makes the new head unavailable rather
  than silently shortening history.

### 20.5 Lifecycle and end-to-end tests

- Service profile -> discovery -> subscription -> `service.query` -> workflow
  execution -> `service.response` -> local personalization works without a new
  transport lane.
- The generic service intent router does not select `curation_recommend` in V1;
  automatic requests use only locally subscribed curators.
- Before any scorekeeper exists, the reference client accepts checkpoints only
  under the signed, pinned `preview-default-witness-policy-v1`; a changed witness
  DID, policy hash, source-manifest CID, source-authentication profile,
  position/range/start proof schema, proof-resource profile, proof-feasibility
  manifest or fixture,
  authority/commitment/outcome/discipline/evidence-event observation or permit
  quorum, registry/standing/challenge/lifecycle duration, observation-completion
  bound, clock rule or proof requirement fails closed.
- The Phase 1C reference scorekeeper accepts valid historical outcomes carrying
  the pinned Phase 1B preview witness policy.
- A minimal curator implemented through the reference SDK passes the same
  request, receipt, authority, commitment and decline vectors as an independent
  implementation.
- A committed response creates a durable local receipt; crash/restart and
  offline publication preserve exactly-once state transitions.
- A provisional batch receipt becomes outcome-eligible only after durable,
  publicly verifiable finalization; missing, late or mismatched finalizations
  remain ineligible and contribute only discipline evidence.
- Operator PDS publication, commitment-checkpoint retrieval, private permit
  retrieval, outcome PDS publication and outcome-checkpoint retrieval survive
  independent crash/restart boundaries without changing authorship, binding or
  timing proof.
- During a commitment-witness outage, a response remains locally usable and
  transitions durably to `awaiting_commitment_witness`; private outcomes persist,
  public outcome construction waits, retries survive restart, and recovery never
  weakens the pinned policy.
- During a permit-witness outage, a confirmed private outcome transitions durably
  to `awaiting_outcome_permit`; no public record is created, retries preserve the
  exact frozen core across restart, an expired partial quorum under the fixed
  preview policy converges by broadcasting one fresh request to all witnesses,
  and a permit for any changed core is rejected.
- During an outcome-witness outage, the already-published outcome remains visible
  but transitions durably to `awaiting_outcome_witness`; it earns no standing,
  retries survive restart, and no local ingestion timestamp substitutes for the
  required maximum-horizon first-observation proof.
- A refusal, timeout and eventual success at each of the commitment-checkpoint,
  private-permit and outcome-checkpoint stages produce distinct auditable state
  transitions without duplicate commitments, permits or public outcomes.
- Source ingestion -> retained membership artifact -> signed coverage interval ->
  checkpoint/refusal/event roots survives crash/restart without cursor gaps or
  duplicate accounting. A missing artifact, overdue or forked interval makes
  dependent standing unavailable until a canonical successor closes the exact
  gap.
- Before simulated first-party witness retirement, every unexpired authority,
  commitment, outcome, discipline, evidence-event, policy-successor observation,
  slot closure, witness refusal, source-authentication/position/range/start,
  incomplete-event-diagnostic, score-manifest, score-snapshot, input-proof,
  evidence/score proof-feasibility manifests and their exact fixtures,
  score-live-head resource-profile, lineage, coverage-prefix consistency/live-
  manifest/finalization, every retained
  coverage-head CID/current-repository/bounded/conflict/declared-predecessor-
  linkage proof and coverage-membership bundle
  appears in a signed export manifest and
  is retrievable from the successor under the same content CID. An incomplete
  hand-off makes affected standing unavailable rather than silently verified.
- An uncommitted response remains usable but cannot create a scoreable outcome.
- Outcome reminders fire only after an explicit acted-on signal and respect
  dismiss, snooze, retention and sensitive-category policy.
- PDS create/update/delete -> Jetstream -> AppView ingestion updates curator
  standing and portable terminal lifecycle tombstones, including
  `deletion_pending_witness`, out-of-order records, dead letters, restart and
  recomputation. Independent scorekeepers derive the same deletion bucket from
  the evidence-event quorum, never their local ingestion times.
- Original -> amendment -> revocation survives restart and every event ordering
  with one atomic nullifier head. The amendment's fresh permit and checkpoint
  replace, rather than add to, its predecessor; the revocation terminates the
  slot. Invalid, missing-predecessor and forked children cannot leave duplicate
  score contribution.
- Original -> amendment -> head deletion, revocation -> revocation deletion and
  fork -> child deletion each converge to their declared terminal state. No
  replayed predecessor, recreated URI or duplicate record reactivates an outcome,
  signed decline or aggregate-discipline slot.
- Moderator takedown and legal deletion propagate without being mistaken for an
  attester amendment or revocation.
- Subject merges preserve original receipt references while regrouping current
  scores; subject splits trigger versioned recomputation and conservatively
  handle ambiguous historical evidence.
- Responses and outcomes at every declared size limit pass; one-byte-over,
  over-depth and over-leaf payloads fail before allocation or rendering.
- Curator, witness and scorekeeper outages degrade independently and do not block
  local use of cached receipts or unsubscribing.
- Complete evidence-policy lineage -> active coverage watermark -> canonical
  score input-proof manifest -> immutable score snapshot -> cumulative score-
  series lineage proof -> score-witness
  checkpoint quorum -> separately closed score-coverage interval completes
  before public display. Excess input/publication lag, an overlong validity
  window, missing predecessor proof, scorekeeper outage or score-witness outage
  leaves the last snapshot labelled stale/unavailable and never silently extends
  its expiry.
- Load tests cover the declared commitment/permit/outcome volume, private permit
  rate limits, batch verification, scoring latency, queue backpressure and
  replay-safe recovery. Head-churn tests inject repeated no-op updates and
  intra-bucket health flapping; they produce at most one coalesced generation per
  closed state cut. Long idle periods produce only exact-boundary retention
  renewals, while dense and maximum-gap sparse histories keep every required
  version and dependency inside the checked catch-up/retention bound.

### 20.6 Phase acceptance gates

- **Phase 0:** the complete private user loop works through shipping service,
  storage and reminder paths; no public-standing claim appears.
- **Phase 1A:** at least two independent verifiers pass every
  `curation-v1-minimal` canonical, detached-request-authorization,
  exact-behavior-contract, authority-grant/revocation/observation-lineage,
  deterministic-receipt, one-terminal-disposition, recipient-binding, set-size
  co-attestation, historical-requester-key and fixed-random-value vector,
  including nonce/salt size, encoding, independence and reuse rejection.
- **Phase 1B:** all repository-authorship, receipt-forgery, witness-ordering,
  source-manifest/source-authentication/position/range-proof,
  coverage-membership/coverage-chain, bounded coverage-prefix accumulator/consistency,
  canonical leaf framing, closed consistency/live-manifest artifacts, challenge-
  window/live-dependency carry-forward, timely signed prefix finalization,
  cumulative-conflict non-reset and bounded-overflow poisoning, frozen digest-
  rkey encoding, deterministic list-limit/verification-budget overflow and
  operational scan-incomplete-after-conflict poisoning, canonical total-root/
  depth-first typed traversal, complete artifact-path/source-boundary scan-
  failure unions and deterministic failure precedence, deterministic live-head
  source-start anchoring, closed state-
  bucket cuts, pinned-clock current/future/expiry checks, one-per-cut coalescing,
  semantic-state hashing, exact-gap retention renewal, current-repository/rollback
  verification, non-recursive inline declared-predecessor linkage-proof
  retention, dense and
  sparse bounded persisted-client catch-up, explicit rebootstrap and fresh-
  verifier declared-linkage/older-summary replay,
  long-running expiry and
  exhaustive-coverage,
  commitment-fork, commitment/outcome/discipline/evidence-event-checkpoint,
  closed-outcome-core, bounded-permit-request,
  policy-pinned cumulative proof-resource-profile, closed policy-bound
  feasibility-manifest exact exclusion projections/fixtures, raw-CID-block wire
  accounting, per-root admission and worst-case no-dedup catch-up capacity, and `policy_limit`/`unavailable_artifact`
  classification,
  fixed-policy/fixed-compatibility-profile/no-successor,
  policy-lineage-reservation,
  publication-permit/signature, partial-quorum-retry convergence,
  early-receipt/core-binding, permit/observation-clock, refusal-log and durable
  refusal/diagnostic replay, outage, hand-off, canonical-private-refusal,
  numeric-retention,
  commitment/outcome/discipline-quorum-delay,
  witnessed-commitment-anchor/backdating, commitment-window, portable-proof,
  checkpoint-embedding,
  authority-observation/bucket, eligibility-profile, item-salt, replay, scope,
  outcome-policy, multi-dimension-series, repeat-series, atomic
  amendment/revocation lifecycle, lifecycle-root-candidate prepass and
  refusal-label independence,
  original-root-conflict,
  interaction-nullifier, decline-nullifier,
  discipline-aggregate-nullifier, sensitive-query egress,
  validation-amplification, portable-invalidation-order,
  monotonic-accountability, deduplication, deletion-pending-witness, portable-
  deletion-tombstone and consent tests pass before public outcomes are accepted.
- **Phase 1C:** shadow scores survive documented Sybil, selective-commitment,
  recommendation-stuffing, drift and missing-data simulations, and real usage
  establishes a non-trivial voluntary outcome rate. Canonical manifest,
  standing-status, location-independent canonical-input-set/input-proof-manifest,
  closed score-input-role registry, transitive block/byte/depth accounting,
  self-contained evidence-policy-bundle replay, evidence-policy-lineage/retired-
  segment-transition/copied-field equality,
  score-freshness,
  manifest/snapshot/checkpoint field equality, authenticated
  score-series admission, predecessor/lineage-rollover, logical-score-key,
  score-snapshot, expiry-floor, bounded finalized score-coverage-prefix rollover,
  bounded score-finalization/head/conflict-proof resources, pinned aggregate
  score-live-head resource profile, deterministic score-head generation and
  catch-up, required-head online current-repository freshness and stale-bundle
  replay rejection,
  score-coverage-membership, exact required-score-coverage-witness-set and
  score-witness checkpoint/quorum vectors pass before any score is public.
- **Phase 2:** independent scorekeepers reproduce compatible checkpoints and
  clients detect deliberate equivocation before multi-scorekeeper UI ships.
- **Phase 3:** `curation-v3-multiclaim` and `curation-v3-batch` vectors pass, and
  privacy and scale features meet published traffic-analysis and performance
  budgets rather than relying on qualitative claims.

No post-preview deployment may enable `scheduled_successor` until independent
implementations pass the policy-chain, compatibility-profile/non-weakening,
signed-boundary, maximum-drain, monotonic-sequence, total-source-partition,
pre-activation nomination-range closure, complete successor-candidate-set/fork,
authenticated source position/range/start proof, deterministic cutover cursor
with half-open ownership, one-to-one identical source continuation,
self-contained policy-bundle replay, terminal-drain separation, no-interaction
renewal, retired-segment source transition, copied-segment equality, withheld-
successor and retained-historical-proof vectors in Sections 20.1-20.2. The new
policy schema must also pin the client activation-clock profile described in
Section 6.4, and implementations must pass fast-clock, slow-clock, uncertainty-
boundary, forward-jump-then-correction, rollback, restart and unavailable-time-
proof vectors. A local wall-clock comparison is not a conforming activation
proof.

---

## 21. Open decisions

- Exact canonical response encoding and post-V1 random-value agility. V1
  nonce/salt sizes, encoding, generation and reuse rules are frozen.
- Per-response commitment versus Merkle batching threshold.
- Curator declaration as service-profile extension versus linked record.
- Post-V1 governance, promotion and federation rules for the canonical scope
  taxonomy; the repository-maintained V1 registry and update process are a
  Phase 1A release requirement, not an open dependency.
- Post-V1 governance and promotion of new domain outcome and repetition
  policies; the initial versioned policy bundle is frozen for Phase 1A.
- Post-preview commitment/permit/outcome/discipline/evidence-event-witness
  admission, independent-quorum expansion, source-manifest federation,
  policy-chain distribution, emergency early retirement, clock-source and
  uncertainty rules, failure and anti-omission policy. The scheduled rotation
  structural baseline is normative but not enabled by the current schema:
  predecessor-signed nomination/new-work/completion
  boundaries, complete pre-activation source-proven successor-slot closures with
  terminal fork handling, contiguous successor chains, monotonic client sequence
  state, authenticated deterministic cutover cursors with half-open ownership,
  drain-only predecessor completion separated from successor authorization,
  successor authorization only for post-activation responses, complete score-
  input policy lineages and fail-closed successor withholding cannot be weakened
  by that governance profile. The closed
  `v1_nonweakening` comparison, total source-transition partition, one-to-one
  identical source continuation and maximum drain are normative; governance of a
  future compatibility mode for witness-set replacement, source contract changes,
  split/merge/retirement/introduction or registry evolution remains open and
  requires new client trust semantics. The pinned Phase 1
  first-party policy already requires source-relative exhaustive processing,
  signed coverage intervals,
  separate maximum checkpoint/permit delays, fail-closed clock handling and
  signed reason-coded public-record refusals.
- The post-preview `client_activation_clock_profile`: authenticated time source
  and proof format, uncertainty lower-bound calculation, durable monotonic state,
  rollback/correction behavior, proof availability and refresh, and policy-field
  canonicalization. Until a new policy schema pins that profile and its vectors
  pass, every shipping client rejects `scheduled_successor`; local wall clock is
  never an implicit fallback.
- Privacy-preserving anti-replay reservation-state transfer and a possible
  versioned atomic mature-permit rollover for a post-preview witness-set
  replacement. The scheduled baseline does not roll over pre-activation
  interactions: only witness processing for an already published pre-cutover
  target drains under the predecessor; every other case begins again with a new
  successor response. Any future rollover profile must preserve the original
  commitment/evaluation clocks, maximum horizon and retention ceiling, prevent a
  second lifecycle core and pass new conformance vectors before changing that
  rule. `v1_nonweakening` keeps both witness sets identical; replacement therefore
  requires that future compatibility mode or a new lineage.
- Post-preview score-witness admission, independent quorum expansion and source
  federation. Phase 1C freezes the first-party score-witness policy and requires
  it before public display; governance of additional witnesses and selection of
  the exact `required_score_coverage_witness_dids` subset remains open. Any
  expansion fixes that set before evidence and cannot derive it per score.
- A future source-failover equivalence profile. It must define the same closed,
  bounded cursor, target-universe, completeness, authentication and consistency
  semantics required of a source transition, plus positive and mutation vectors.
  V1 forbids `failover_equivalence_group`; a label alone never authorizes endpoint
  substitution.
- A future source-transition mapping profile for split, merge or changed source
  contracts. It must define a closed canonical mapping artifact, deterministic
  bounded evaluator, cursor and target-universe algebra, duplicate handling,
  verifier error semantics, retained top-level score-input role and cross-runtime
  positive/mutation vectors. No current mode interprets such an artifact, and a
  mapping CID or issuer declaration alone cannot authorize same-lineage rotation.
- Additional source cursor and scheduled-cutover profiles beyond
  `utc_time_position_v1`. Each requires a total canonical position, authenticated
  source-time or equivalent deterministic bucket-to-cursor function, a replayable
  source-authentication profile with position, range and start proof schemas,
  half-open
  range semantics, bounded encoding and cross-runtime boundary/tie-break vectors.
  A transport without both accepted profiles remains fixed-policy only.
- A compact, versioned evidence-policy-lineage prefix accumulator for deployments
  that approach the pinned cumulative segment/byte limit. V1 retains every
  transition bundle and fails closed at the limit; it does not permit local
  pruning.
- A blind or privacy-preserving publication-permit protocol that does not reveal
  an ultimately unpublished outcome core to the witness. V1 uses the disclosed
  private permit request and labels that first-party privacy boundary.
- Checkpoint-proof renewal beyond the immutable V1 `retention_until` boundary.
  V1 instead stops scoring expired evidence; it does not imply an extension.
- Successor-archive admission and replicated hand-off requirements for retiring
  a witness. The preview requires a content-preserving export, but broader
  governance and replication quorum remain open.
- Batch leaf-artifact replication count, storage providers and erasure process;
  minimum availability through receipt eligibility is normative.
- Commitment, outcome/discipline-checkpoint, evidence-event, witness-refusal,
  incomplete-event-diagnostic, coverage-membership, score-input, evidence-policy,
  future source-transition-mapping, score-lineage and score-snapshot proof-bundle
  replication count, storage providers and legal-erasure process; minimum
  availability through each own or enclosing signed `retention_until` is
  normative.
- Exact recipient-binding upgrade path for pairwise or one-time outcome keys.
- Outcome subject, rank and confidence disclosure required for public scoring.
- Privacy-preserving aggregation of optional commitment-discipline signals.
- Multi-curator fractional-attribution formula.
- Sensitive-domain taxonomy and default retention periods.
- Behavior-epoch transition rules and capped prior size.
- Reference Bayesian/Wilson scoring formula.
- Novelty uplift shape and maximum contribution.
- Physical encoding and storage layout for the frozen score input checkpoint and
  proof manifest over ATProto/Jetstream inputs.
- A compact score-series accumulator replacing the Phase 1 cumulative lineage
  artifact without weakening inclusion, consistency, retention or anti-omission
  proofs.
- Whether a later consented, scope-aware router may select unsubscribed curators.
- Admission, disclosure, corpus publication, sampling, rotation and conflict
  rules for scorekeeper-recognized Phase 2 probe operators.
- Pairwise identity or anonymous-token design, if pursued after V1.
- How private organization curators publish commitments and score manifests.

---

## 22. Honest product claim

The architecture can credibly claim:

> Follow specialists you trust. They contribute expert judgment; Dina privately
> decides what fits you; signed, receipt-bound outcomes build evidence about
> which specialists hold up over time.

It must not claim:

- that paid influence is impossible;
- that authenticated curator queries are anonymous;
- that a V1 namespace-authored curation outcome is pseudonymous;
- that human outcomes are automatically Sybil-proof;
- that one standing score is objective truth;
- that a curator's declared corpus coverage has been proven;
- that public outcomes reveal nothing about the user;
- that a public curation outcome keeps its query category private;
- that requesting a V1 publication permit reveals nothing to the first-party
  witness when the user ultimately does not publish;
- that a hosted curator's declared behavior epoch is cryptographically enforced;
- that an outcome receipt proves the subscriber acted or reported truthfully;
- that committed recommendation counts independently prove what a modified
  recipient client displayed;
- that a signed decline proves the private request was eligible or blameworthy;
- that repository timestamps alone establish global commitment/outcome order;
- that a curator/requester-declared response bucket proves elapsed public time
  before the commitment-observation quorum exists;
- that a complete witness coverage chain proves its upstream relay emitted every
  repository event;
- that a deterministic live coverage-head record proves global latestness beyond
  the accepted witness repository and its pinned upstream source;
- that a fresh installation or explicit head-state rebootstrap independently
  verifies head generations that expired before its new baseline;
- that a current head's retained declared-predecessor linkage proof independently replays
  any generation earlier than that one predecessor;
- that the declared-predecessor linkage proves its historical repository commit
  is an ancestor of the current live commit, or proves that no hidden, deleted or
  sibling head version existed;
- that an over-limit conflict becomes harmless availability merely because every
  observed branch cannot fit in one proof;
- that an overflow certificate independently proves how many conflicts the
  accepted witness omitted, or even that an omitted branch existed beyond the
  retained independently verified pair;
- that a bounded verifier independently proves the witness's claimed overflow
  scan cutoff merely because its retained conflict prefix is valid;
- that a `scan_incomplete_after_conflict` descriptor independently proves the
  remote artifact or transport was unavailable; only its retained incompatible
  pair proves the terminal conflict;
- that `cumulative_conflict_count` is an exact total after its signed cumulative
  overflow flag becomes true;
- that witness independence exists while the accepted preview policy contains
  only the first-party Dina AppView witness;
- that a compacted prefix finalized by the first-party preview witness is an
  independently certified replay of raw history after those raw bytes expire;
- that the sole preview witness cannot suppress scoreable outcomes through
  selective delay, refusal or silence;
- that curator invalidation or lifecycle-deletion order is globally objective;
  it is a conservative result produced by the accepted evidence-event witness
  quorum and its coarse buckets;
- that selective private permit refusal is publicly observable without a
  separate user-published report;
- that an evaluation delay is independent of the accepted witness's permit,
  clock and observation honesty;
- that preview-era standing is durably replayable after the first-party witness
  retires unless its unexpired proof archive receives a verified hand-off;
- that source-labelled probes prove a hosted runtime did not change behavior;
- that outcome rates describe unreported or uncommitted recommendations;
- that a curator can revoke compromised authority or publish a conflicting
  artifact and thereby erase earlier unfavorable accountability evidence;
- that a scorekeeper cannot be wrong, compromised or selective;
- that a score marked current includes evidence newer than its pinned
  input-coverage watermark or is fresher than the disclosed policy bounds;
- that a once-valid score bundle remains current without refreshing every exact
  required score-coverage witness's live head/current repository proof inside the
  maximum lag;
- that a coverage root remains independently auditable when its canonical
  membership artifact is unavailable;
- that an unwitnessed, pending, unavailable or expired score is current public
  standing.

For hosted runtimes, epoch compliance is declared and monitored through drift
evidence; it is not prevented. Public outcome rates are conditional on committed
responses that received voluntary outcomes. The recipient receipt proves that
the curator signed a recommendation for the request-authorizing outcome author.
The embedded commitment-observation quorum proves that the referenced commitment
was publicly observable and supplies the external evaluation anchor. The anchor
is the later of that portable bucket and the response bucket, so backdated
request/response claims cannot manufacture elapsed public time. The embedded
private permit proves that the accepted witness authorized that exact outcome
core after the conservative policy minimum. The separate outcome checkpoint
proves when the accepted witness quorum observed that exact published URI/CID,
bounding the maximum horizon. Together they make policy-window verification
portable under the pinned witness policy and clock; none is a universal global
clock. These
proofs do not establish that the underlying action occurred, the real-world
result was still unknown, the reported set was actually rendered, or the opinion
is objectively true.

With quorum one, the preview witness is a liveness and censorship dependency. Its
source-relative coverage chain and signed-refusal rules make some omissions
observable but cannot force it to sign or prove an upstream relay was complete.
Its deterministic live head makes stale-slot replay and rollback detectable to
clients that contact the pinned repository and retain generation state; it cannot
force that repository to answer, prove that another upstream event exists or let
a fresh client independently replay already expired head generations.
Returning clients fail closed when bounded catch-up cannot reach their durable
baseline. Fresh installation or explicit audited rebootstrap accepts the current
witness summary as a new baseline and is disclosed as trust re-establishment,
not historical continuity. A complete incompatible pair permanently poisons
coverage even when the full branch set requires bounded overflow form.
Once two valid CIDs are proven for one head generation, that witness-policy
lineage is terminally unavailable; a later record on either branch is not a repair.
Private permit omission is visible only to the requesting device unless the user
separately publishes evidence, so it has no exhaustive public audit trail.
Recommendations and private outcomes remain locally usable
when the witness is unavailable; outcome publication or standing waits at the
applicable commitment-checkpoint, private-permit or outcome-checkpoint stage;
invalidation and deletion effects wait for the applicable evidence-event quorum.
Public discipline metrics wait for their discipline-checkpoint quorum. Public
score display separately waits for the score-snapshot witness quorum, complete
lineage proof, closed coverage membership interval and any required prefix
finalization, and remains current only while every required score-coverage head
can be refreshed inside the maximum lag and the input-lag, publication-lag and
validity bounds also hold. After compacted raw history expires, the preview
trusts the accepted witness's signed finalization summary as well as its clock;
that is not independent raw-history replay. A permit request reveals the
frozen outcome core to that witness even if the user cancels before publication.
Preview-era standing is provisional beyond its signed retention
horizon and depends on continued first-party archive operation or a verified
content-preserving hand-off. Publishing an outcome reveals the canonical query
category and the curator-recipient co-attested total and public-eligible
recommendation counts, not the private query payload, nonce or undisclosed items
themselves. Curator-controlled compromise, conflict or deletion is shown as
tainted accountability evidence and cannot improve the reference-compatible
standing result, although independent moderation, attester deletion and legal
erasure may change the evidence set under their disclosed policies. Request-hash
and commitment opacity also depends on conforming clients and curator SDKs using
independent operating-system CSPRNG output; canonical encoding checks cannot
prove the quality of a device's entropy source.

The value is not perfect neutrality. The value is separation and choice:
curators judge, scorekeepers measure under visible rules, Dina personalizes
locally, and the user can replace any of them.
