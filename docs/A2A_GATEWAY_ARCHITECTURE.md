# A2A Gateway Architecture

**Status:** Design — not yet implemented. There is no A2A code in the repo today.
**Review:** hardened through 7 rounds of adversarial dual review (Claude + Codex continuity reviewers, 2026-07-30). The owner capped the cycle after round 7 with every raised finding addressed; the reviewers had not yet returned a joint PASS and no cold audit ran. Treat contested seams (guard lifecycle, credential model, provenance log, PEP bindings) as review-shaped but not review-exhausted. The AppView directory (§8, §12 M5) was then dual-reviewed in a second, owner-budgeted cycle (rounds 8–12) plus a three-round Codex-only extension (rounds 13–14 and a final Claude revalidation, 2026-07-31): ~60 further findings raised and fixed. **Convergence: both continuity reviewers returned PASS with zero actionable findings on this exact version** — the strongest review state this document has held. No fresh-context cold audit was run; the reviewers were 14-round continuity threads.
**Implements:** `docs/AGENT_CONTROL_PLANE.md` §18 (A2A composition) and §31 Phase 8 (A2A gateway), plus the Dina-native discovery plane (§8). (ARD — control-plane §19 / Phase 10 item 4 — is *not* covered here; §13 Q10.)
**Spec pin:** A2A Protocol **v1.0** (Linux Foundation). Card at `/.well-known/agent-card`. The normative artifact is `spec/a2a.proto`; exact JSON-RPC method strings and error shapes MUST be re-pinned at M0 before any wire code is written.
**Related:** `docs/CONTACT_SERVICES_ARCHITECTURE.md`, `docs/PUBLIC_SERVICES_TAXONOMY.md`, `docs/PLUGIN_ARCHITECTURE.md` (runner lanes, effectful-task discipline, consent-card doctrine), `docs/APPVIEW_ARCHTECTURE.md`, `docs/DINA_SERVICES_PROVIDER_GUIDE.md`.

---

## 1. Why and what

### 1.1 Position

Dina D2D over MsgBox stays the native Dina-to-Dina path. A2A is the broad external compatibility path: any agent speaking the open standard can find Dina's public services and invoke them, and Dina can delegate work to remote agents publishing an Agent Card — without either side learning the other's private protocol.

The control plane has settled the frame (`docs/AGENT_CONTROL_PLANE.md`): §2.2 "Gateway and mapping; do not replace the external standard"; §18.1 "Dina SHOULD expose an A2A gateway"; §30.4 rejects replacing the workflow repository with A2A task storage or replacing D2D internally; §24.8 defines the `a2a_gateway` profile ("No internal-tool claim; authority is per exposed task capability"). This document turns those constraints into an implementable design.

**The strategic endgame this plumbing exists for:** A2A plus OAuth tells the world *who* an agent is; nothing in the standard tells anyone whether to *trust* it. Dina already has the missing layer — PeerLens attestations, outcome history, trust scoring. Lane 3 (§8) is therefore part of this design, not an afterthought: an **AppView-served, trust-ranked A2A directory** — searchable Agent Cards for every public Dina gateway, ranked by verified peer evidence rather than self-description. Trust-ranked agent discovery is the thing neither A2A nor any registry provides; it is Verified Truth applied to agents.

### 1.2 What ships — three lanes, in order

| Lane | Direction | What it is | Ships |
|---|---|---|---|
| **Lane 1 — outbound client** | Dina → remote agent | A delegation runner executing owner-approved, Core-permitted tasks against a remote A2A endpoint | First (M1) |
| **Lane 2 — inbound gateway** | remote client → Dina | A public HTTPS listener serving the Agent Card and mapping A2A tasks onto the provider service pipeline | Second (M2–M3) |
| **Lane 3 — trust-ranked directory** | discovery plane | Home Nodes publish their signed cards to their PDS; AppView indexes and serves trust-ranked search over them | Third (M5) |

Outbound first: no public endpoint needed, reuses the delegation/approval machinery, delivers value before the inbound attack surface. The directory last: it needs cards to exist (Lane 2) and the authority model to lean on (both lanes) before discovery multiplies their value.

### 1.3 Non-goals

- **No A2A inside Dina.** A2A exists only at the adapters.
- **No card-as-authority** (§18.3, conformance test 15) — and **no directory-as-authority**: a Lane 3 search result is a candidate, never a grant (§8.1).
- **No payment actions over A2A — with an honest asymmetry.** *Inbound*: the action registry (§5.4) denies `payment`-class capabilities at projection and invocation, no override. *Outbound*: `payment` is unassignable as a binding (§5.5) and every delegation is owner-approved against the exact consent payload (§6.2) — but a remote skill's class is a **consent label, not proof of remote behavior**; a mislabeled skill could misuse its credential. The residual is bounded by the credential: §5.3 requires least-scope credentials and registration warns that the credential's full scope is delegated. Dina never mints payment instruments for remote agents.
- **No auto-permitted outbound dispatch in v1.** Every outbound delegation raises an owner approval card; a live Brain session proves nothing (§13 Q6 for the future auto lane).
- **No contact/relationship services over A2A.** Grant issuance, projection, and resolution all require `surface: 'services'` (§5.2, §7.2); Talk listings are structurally unreachable — and never published to Lane 3 (§8.2).
- **No gRPC in v1.** JSON-RPC 2.0 first; REST second; gRPC on demand.
- **No inbound gateway on mobile.** Lane 1 only; a MsgBox-fronted bridge is §13 Q1.
- **No custom Dina capabilities inbound in v1** (§5.4); **no capability without a pinned schema pair** (§7.1, §7.2 step 9).
- **No outbound multi-turn through M4.** Remote `INPUT_REQUIRED` → fail `remote_needs_input` (§6.4, §13 Q9). §7.7's continuation work is inbound only, and never after an effect began.
- **No interrupt-resume for external effectful executions** (§7.7).
- **No ARD in this design.** ARD (publishing or consuming web-wide catalogs) is a separate adapter design (§13 Q10); Lane 3 is Dina's own AT-Protocol-native directory, which ARD could later syndicate.
- **No bespoke universal agent protocol** (§29.4).

---

## 2. A2A v1.0 — the facts an implementer needs

Pinned from the v1.0 specification; re-verify against `spec/a2a.proto` at M0.

1. **Transports:** JSON-RPC 2.0, gRPC, HTTP+JSON/REST; none mandatory; `agentInterfaces` declares support. JSON-RPC first.
2. **Operations:** `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig`, `GetExtendedAgentCard`.
3. **Task states:** `SUBMITTED`, `WORKING`, `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` (terminal), `INPUT_REQUIRED`, `AUTH_REQUIRED` (interrupted), `UNSPECIFIED`.
4. **Agent Card** at `/.well-known/agent-card`: `agentId`, `displayName`, `description`, `protocolVersion`, `capabilities {streaming, pushNotifications, extendedAgentCard}`, `skills[]` (`{name, description, inputSchema}`), `securitySchemes[]`, `security[]`, `agentInterfaces[]`, `extensions[]`, `signature` (JWS).
5. **Message:** `{messageId, contextId?, taskId?, role, parts[], metadata?, extensions?, referenceTaskIds?}`; **Part** oneof `text | raw | url | data`; **Artifact** = named part group.
6. **Ids:** `taskId` server-generated; `contextId` groups; both-present must match; continuation = message carrying `taskId`.
7. **Extensions:** `{uri, required, version?}`; declared via `A2A-Extensions`; required-undeclared → `ExtensionSupportRequiredError`.
8. **Push:** per-task webhook `{url, token?, authentication?}`.
9. **Service parameters:** `A2A-Version` / `A2A-Extensions` as `a2a-*` headers.
10. **Case boundary:** A2A camelCase ↔ Dina snake_case, translated only in the adapters.

The `Message` has no skill field; Dina defines a normative envelope (§7.2a).

---

## 3. Invariants

- **A2A-I1 — the card is not authority.**
- **A2A-I2 — Core authenticates the original credential and dispatches from the signed material.** The gateway forwards credential evidence in distinct envelope fields; Core verifies it independently, and for signed callers Core binds the verified signature to the operation it executes (§5.1's dispatch-binding rule). Nothing gateway-selected is authority.
- **A2A-I3 — one authorization model.** Same visibility gate, `service_grants`, workflow tasks, Response Bridge, approval cards as D2D. Ingress normalization runs in Core as a shared library.
- **A2A-I4 — asymmetric visibility.** External vocabulary only; every refusal collapses to one `REJECTED` shape, one reason code, one timing class.
- **A2A-I5 — internal ids never leak.** Fresh UUID external ids; disclosure handles replace vault ids.
- **A2A-I6 — extension discipline.** Public schemas carry only `{skill, params}`; the extension carries exactly §7.6's fields; the grant selector is an envelope field documented in grant delivery and the extended card.
- **A2A-I7 — Silence First.** Owner contact only through approval cards; outbound results land in the asking conversation.
- **A2A-I8 — honest outcomes.** Failure at or after an effect boundary resolves to `outcome_unknown`-class handling, never automatic re-execution — and a consumed effectful permit can never be followed by an interrupt-resume (§7.7).
- **A2A-I9 — Core owns the PII boundary; persona compartments survive it.** Core runs the deterministic scrub; originals are retained only for single-provable-source spans, each wrapped under its source persona's DEK (`user_request` under the identity key); derived/multi-source originals are never retained. Inbound-owner-facing content is quarantined until a digest-bound guard receipt promotes it (§6.5).
- **A2A-I10 — consent-payload-bound approval, rendered in full.** Approval, one-time egress authorization, and permit bind `sha256(canonicalJson(consentPayload))` where consentPayload = `{remote_agent_id, card_hash, endpoint, skill, action_class, credential_ref, credential_revision, labels, projection}`. The card **renders the exact projection and parameters** (expandable), the recipient and endpoint, the credential's scope, and effect/retry uncertainty — a readable summary may accompany, never substitute. What the owner saw hashed is what executes, against exactly whom, with exactly which credential.
- **A2A-I11 — Brain proposes; the owner decides; Core enforces; permits are consumed at the effect boundary by the bound PEP.** Outbound: the atomic dispatch transaction (§6.3). Inbound: the executor identity is pinned in the snapshot, and consumption happens at claim (external) or adjacent to the effect (in-process) — by that identity only (§7.3).
- **A2A-I12 — provenance is proved, inherited, or flagged unverified.** Proved-verbatim (digest-matched disclosure handle), proved-user-request (digest-matched utterance), derived (session read-set taint **and always `unverified`**). Unverified or restricted-tainted content needs explicit egress authority; the card marks it. Residual (laundering past the owner's own reading of the full projection) stated, not hidden.
- **A2A-I13 — the directory relays; it never authors.** AppView serves the owner-signed card bytes it ingested, verbatim; index metadata (trust, freshness) travels in separate response fields, never inside the card object. A directory row confers discovery, never invocation authority; every consumer still authenticates the live endpoint, and Dina-side consumption still runs the full §6.1 registration ceremony (§8.1).

---

## 4. Topology and code layout

### 4.1 Where the pieces run

```
 remote A2A client ──HTTPS──► a2a-gateway (:8300, public, NO KEYS, NO PRINCIPAL RESOLUTION)
                                  │ signed HTTP (service key m/9999'/3'/2')
                                  ▼
                             core-server (:8100) ◄── signed HTTP ── brain-server (:8200)
                                  │  verify, dispatch-bind, registries, bindings, normalization,
                                  │  snapshots, permits, grants, receipts, disclosures, entities,
                                  │  guard jobs, push outbox
                                  ▼
                             A2ADelegationRunner (host composition, a2a:* lanes, ALL outbound I/O)
                                  └──HTTPS──► remote A2A agent endpoint

 Lane 3:  Home Node ──putRecord──► owner's PDS ──Jetstream──► AppView (index + trust-ranked xRPC)
```

- **Inbound gateway**: third process, only public listener; terminates TLS/A2A framing; forwards through signed Core routes with credential evidence in distinct envelope fields. No vault keys, no principal resolution, no durable state beyond live SSE.
  **Honest compromise model:** a compromised gateway can (a) tamper with live sessions, (b) replay captured bearers until rotation/expiry, (c) see the inbound delivery stream (transitions, artifact availability, webhook URLs + per-delivery secrets at claim). It cannot mint unseen principals, read vault content, pair a valid DID signature with a tampered body **or a different operation** (§5.1 dispatch binding), or leave its route allowlist. M2 gateway-compromise tests.
- **Gateway service key**: `m/9999'/3'/2'`, load-only; allowlist = `/v1/a2a/ingress/*`, `/v1/a2a/card`, health; every client-facing route lives under `/v1/a2a/ingress/`.
- **Rate-limit architecture (production defaults, not just test knobs):** the gateway process applies per-IP limits at its own edge; Core exempts gateway traffic from **both** of its shared outer limiters — the pre-authentication per-IP limiter (all gateway requests arrive from one host IP, so the default 60/min IP bucket would throttle every A2A client collectively; the exemption is scoped to the gateway's allowlisted routes, with the gateway's own edge limiter taking over that duty) and the generic per-DID bucket for the gateway service key — and instead enforces **per-A2A-principal** budgets inside the ingress routes, receipt-aware (§7.2): replay hits are answered from the receipt under a separate, generous replay ceiling (10× the normal budget; transient rate error beyond), misses consume the normal budget. M2 tests run at production defaults, not `DINA_RATE_LIMIT=100000`, including >60 aggregate requests from distinct principals.
- **Outbound runner** in the trusted host composition performs all outbound I/O (calls, card fetches, DID resolution, OAuth exchanges); the gateway performs webhook POSTs. Core never opens an outbound connection.
- **Lane 3 has no new always-on process:** the card publisher is a **trusted-host outbound adapter** in the core-server's existing publication wiring (`core-server/src/appview/`, §8.2) — Brain is never involved and never holds signed-card or PDS-write authority (only a PDS client *library* is reused, not the Brain process). AppView's existing Jetstream ingester, scorer, and xRPC server gain one record type and two methods (§8). The runner's "all outbound I/O" claim above is scoped to **remote-agent traffic** (calls, card fetches, DID resolution, OAuth); PDS publication is this separate host adapter.
- **Mobile**: Lane 1 only.

### 4.2 New code map

```
packages/a2a/                      @dina/a2a — pure, zero-runtime-dep
  types / validate / envelope / state_map / card_projection / card_pin / errors + golden vectors
  directory_envelope.ts            Lane 3: canonicalize + hash + sign/verify the directory envelope
                                   and fence records (injected callbacks; byte-shared to AppView; §8.2)

packages/core/src/a2a/
  action_registry.ts               inbound capability → action class; payment always-deny
  skill_bindings.ts                outbound bindings: class, pinned result schema, credential_ref
  remote_agents.ts                 registry + pinned invocation/auth endpoints
  remote_credentials.ts            versioned credential records (§5.3)
  runner_bindings.ts               inbound executor bindings: runner lane → paired device DID (§7.3)
  clients.ts                       clients, credential bindings, scope, expiry, DID auth
  grants.ts                        grant issuance/revocation for a2a:* principals
  proposal.ts                      /v1/a2a/delegate (§6.2)
  disclosures.ts                   release-context disclosure log + handles (§6.2)
  utterances.ts                    per-session owner-utterance digests
  snapshots.ts                     frozen execution snapshots incl. executor PEP DID
  permits.ts                       durable permits (direction-discriminated) + snapshots + transactions
  normalize.ts                     deterministic ingress normalization
  dispatch_binding.ts              signed-request ↔ executed-operation binding table (§5.1)
  task_map.ts                      operation map + phases
  receipts.ts                      idempotency receipts
  egress.ts                        evaluateA2AEgress (§6.2 step 4)
  entity_store.ts                  per-span persona-wrapped originals
  result_ingest.ts                 sanitize → validate → quarantine (§6.5)
  guard_jobs.ts                    durable guard jobs + digest-bound receipts (§6.5)
  cancel.ts                        durable cancellation lifecycle
  push_outbox.ts                   delivery outbox + revalidation + ack CAS

packages/core/src/server/routes/a2a.ts
packages/home-node/src/a2a_runner.ts
packages/brain/src/reasoning/a2a_delegate_tool.ts
packages/brain/src/a2a/guard_worker.ts    claims guard jobs, runs the scan, posts verdicts (§6.5)
packages/brain/src/reasoning/a2a_search_tool.ts   Lane 3: search_a2a_agents via AppView (§8.4)
apps/home-node-lite/a2a-gateway/          Fastify host
apps/home-node-lite/core-server/src/appview/a2a_card_publisher.ts
                                          Lane 3: trusted-host card publisher beside the existing
                                          publication wiring; consumes Core-signed cards + revision
                                          events; durable a2a_card_publication state (§8.2)

appview/  (Lane 3, §8)
  src/config/lexicons.ts                   + com.dinakernel.a2a.card
  src/ingester/…                           card validation at ingest (JWS, DID match, size)
  src/db/schema (Drizzle)                  + a2a_cards table
  src/api/xrpc/a2a-search-agents.ts        com.dinakernel.a2a.searchAgents
  src/api/xrpc/a2a-get-card.ts             com.dinakernel.a2a.getCard
```

`@dina/a2a` follows the `@dina/protocol` rules. The deterministic PII pattern set is a pure shared module Core and Brain both import, parity-tested.

**Required integration points.** (a) The ask runtime records owner-utterance digests in Core at turn start. (b) **Disclosure recording happens at Core's vault-read dispatch layer with an explicit release context** `{session_id, audience}` — the seam where session identity is known — covering every read surface Brain can reach (search, get, browse/recent, list, subject recall) on both boots (in-process included). Over-inclusion is accepted by design (conservative taint fails safe). Negative tests prove non-session reads never enter a session's read set; parity tests prove both boots log identically.

### 4.3 New Core routes

| Route | Caller | Purpose |
|---|---|---|
| `POST /v1/a2a/ingress/message` | gateway | Inbound message + credential evidence → verify, dispatch-bind, receipt, gate, normalize, commit |
| `GET /v1/a2a/ingress/tasks` | gateway | Principal-scoped `ListTasks`: capped page size, opaque cursor, deterministic `(created_at DESC, id)` ordering; tie/restart pagination tests at M2 |
| `GET /v1/a2a/ingress/tasks/:extId` | gateway | Principal-scoped `GetTask` |
| `POST /v1/a2a/ingress/tasks/:extId/cancel` | gateway | Honest cancellation |
| `GET /v1/a2a/ingress/extended-card` | gateway | `GetExtendedAgentCard`: authenticated principal → (public ∩ scope) ∪ granted projection (§7.1) |
| `POST/GET/DELETE /v1/a2a/ingress/push-configs*` | gateway | Push config CRUD |
| `GET /v1/a2a/ingress/events` + `POST .../events/ack` | gateway | Delivery claim/ack |
| `POST /v1/a2a/ingress/did/complete`, `POST /v1/a2a/ingress/did/nonce` | gateway | DID upgrade + optional server nonce |
| `GET /v1/a2a/card` | gateway | Public card |
| `POST /v1/a2a/delegate` | brain | Outbound proposal |
| `GET /v1/a2a/guard/next`, `POST /v1/a2a/guard/verdict` | brain | Guard worker: claim a guard job (returns quarantined content + digest), post the digest-bound verdict (§6.5). The **sole** readers of quarantined content. |
| `POST /v1/a2a/clients` (+ rotate/revoke/list) | owner | Client lifecycle |
| `POST /v1/a2a/clients/:id/grants` (+ revoke/list) | owner | Grants — `surface:'services'` only |
| `POST /v1/a2a/clients/:id/did-challenge` | owner | Initiate DID upgrade |
| `POST /v1/a2a/remote-agents` (+ verify/revoke/list) | owner | Remote agent + bindings + credentials |
| `POST /v1/a2a/directory-listing` | owner | Lane 3 listing toggle → durable `a2a_card_publication` intent (§8.2) |
| `POST /v1/a2a/publisher/activate` (+ deactivate) | owner | Lane 3 fencing ceremony: read/verify the remote fence, claim a strictly greater epoch, set `publication_active` (§8.2); the only exit from `stood_down` |

For inbound effectful children, the existing `POST /v1/workflow/tasks/claim` transition performs permit consumption **and PEP enforcement** (§7.3).

---

## 5. Identity, authentication, authority

### 5.1 Inbound clients (Lane 2)

**Registration:** owner creates the client (display name, **public-skill scope** — empty = all public; optional **expected DID**); Core mints a bearer (hash-stored, 90-day expiry) and the stable principal `a2a:<client_id>`; token delivered out of band.

**Bearer auth:** the gateway forwards the `Authorization` value in a distinct envelope field; Core verifies (constant-time, expiry, status), resolves the principal, stamps `last_used_at`.

**Scope composes with grants:** scope constrains public skills only; a grant independently authorizes its known_only skill; unlisted-by-exact-reference follows §7.2 step 7 (all active unlisted listings addressable by reference; `accessPolicyHint` is informational). Extended card = (public ∩ scope) ∪ granted.

**Credential lifecycle:** expiry, one-tap rotation, `last_used_at`, revocation cascading to grants, append-only `a2a_credential_bindings` history. Residual: a compromised gateway can replay bearers until rotation/expiry.

**DID credential upgrade (M4)** — owner-initiated single-use challenge; completion via `POST /v1/a2a/ingress/did/complete`; host adapter resolves the DID document, Core verifies signature + nonce single-use + expected-DID + one-active-client-per-DID; transactional binding swap; principal unchanged.

**Per-request DID auth — forwarding and dispatch binding.** The client signs Dina's canonical string over **its own gateway-facing request**: `{METHOD}\n{EXTERNAL_PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(RAW_A2A_BODY)}`. The gateway embeds `{did, timestamp, nonce, signature, method, external_path, query, body_sha256}` as a `client_auth` object plus the raw payload (never as its own auth headers). Core: rebuilds the canonical string from the forwarded components; **recomputes the body hash from the forwarded raw payload**; verifies the signature, ±5-minute window, per-DID nonce replay cache. **Dispatch binding:** Core does not trust the gateway's route selection — it parses the JSON-RPC operation and its identifiers **from the signed raw body** and enforces a total mapping (`dispatch_binding.ts`): signed external method/path ↔ internal route, signed operation ↔ executed operation, signed task id ↔ route `:extId`. Mismatch → refused. Cross-operation and cross-task substitution tests at M4. The optional server-nonce route supplies a NONCE component; the timestamp window still applies.

Unauthenticated requests: `GET /.well-known/agent-card` only.

### 5.2 Grants

`service_grants.grantee_did` holds `a2a:<client_id>`; check/table/revocation unchanged. Issuance via `POST /v1/a2a/clients/:id/grants` (refuses `surface != 'services'`); contract delivered out of band or via the extended card. `contextId` is never a grant.

### 5.3 Outbound credentials

Secrets live in the provider-key store; `a2a_remote_credentials` records **versioned, immutable credential references**: `credential_ref` (PK), remote agent, kind, audience, **canonical scope metadata plus its hash** (`scope_json` + `scope_hash` — the card must render the actual scope, and a hash cannot be rendered; the pair is immutable per ref, so restart and rotation keep consent rendering exact), revision, status. **A credential-less remote agent is a first-class case:** `kind = 'none'` records a real, versioned "no credential" ref, so consent binding, snapshots, and revocation semantics stay uniform (the a2a-sdk reference agents are unauthenticated — M1 depends on this lane). **Rotation creates a new `credential_ref`** (new secret version) and then atomically activates it — refs are never mutated. **Selection is explicit:** every skill binding names the `credential_ref` it uses (`NOT NULL`; for open agents that is the `'none'` ref); the consent payload, approval, permit snapshot, and runner request all carry it (A2A-I10). OAuth token/discovery endpoints are pinned at registration; exchanges run under §6.6. Registration requires least-scope credentials and warns that the credential's full capability is delegated (§1.3).

### 5.4 Inbound action registry

Canonical capability → catalog class (`read | quote | write | booking | payment | agentic`). `payment` denied unconditionally at projection and invocation (aliases resolved first); no entry → deny; no LLM.

### 5.5 Outbound skill bindings

Owner assigns each usable remote skill: an action class (`read | quote | write | booking | agentic`; `payment` unassignable), an optional pinned result schema (else the default envelope), and the `credential_ref` it uses (§5.3). Keyed `(remote_agent_id, card_hash, skill)`; unbound → unusable; card change voids; binding revision + credential_ref ride the snapshot. Classes are consent labels (§1.3).

---

## 6. Lane 1 — outbound

### 6.1 Registering a remote agent

Discover (candidate, not grant; owner-pasted card URL or a Lane 3 directory result — §8.4) → host-side fetch + pin under §6.6 (live card, not the directory copy) → owner review (identity, signature state, credential scheme + scope warning, per-skill bindings + credential selection) → active. Card change → `changed`, bindings void, re-approval. Trust starts Unverified for unknown agents; a Lane 3 candidate arrives with its PeerLens evidence attached, which informs the owner's review — and still grants nothing (A2A-I13).

### 6.2 Proposal → staging → provenance → approval

`delegate_to_a2a_agent` is a proposal-only client of `POST /v1/a2a/delegate`:

0. **Session-bound proposal** — validated live owner session; scopes/rate-bounds; authorizes nothing.
1. **Stage the operation** (`pending_decision`) before anything references it; refusal/expiry terminalizes and purges staged rows.
2. **Provenance, resolved by Core (A2A-I12):** `disclosure:<handle>` must hash-match the release-context log (§4.2); `user_request` must hash-match a stored utterance digest; `derived` inherits the session read-set taint and is always `unverified`; anything else refused.
3. **Core scrubs, authoritatively.** Originals retained only for single-provable-source spans (persona-DEK / identity-key wrapped); derived/multi-source originals never retained.
4. **Egress authority.** Restricted-tainted (`{health, financial, medical_record}`) or `unverified` content requires a standing sharing grant or the one-time egress authorization the approval mints. **The one-time authorization is not a separate artifact:** it is the approved workflow task itself (its payload carries the consent hash and the labeled categories) together with the permit whose snapshot records it — durable because both rows are durable, single-use because the permit is, voided with the permit. No third abstraction exists to drift.
5. **Consent payload → owner approval, always.** Core assembles the final egress projection and the canonical consent payload `{remote_agent_id, card_hash, endpoint, skill, action_class, credential_ref, credential_revision, labels, projection}`; its hash keys everything (A2A-I10). The card **renders the exact projection and parameters** (expandable), destination + endpoint, the credential's scope, category labels, unverified markings, and effect/retry uncertainty; a summary may accompany, never substitute. Approval mints the one-time egress authorization; refusal terminalizes.
6. **Task + durable permit** (direction `outbound`, consent hash, snapshot incl. credential_ref/revision).

### 6.3 The `a2a:` lane and the dispatch transaction

`a2a:<remote_agent_id>` is reserved like `plugin:`/`dina.local` (403 for external claimants; exact-match for the in-process runner; excluded from the catch-all filter).

**Permits are durable rows**: direction-discriminated, consent hash, action class, expiry, state (`minted → consumed → void`), `execution_child_id NOT NULL DEFAULT ''` (`''` = outbound dispatch permit — non-null so the unique index dedupes; SQLite treats NULLs as distinct), one live permit per `(operation_ref, execution_child_id)`, and the authority snapshot: card hash, binding revision, **credential_ref + revision**, grant ids or one-time authorization, registry/policy revision, approval id.

**Dispatch is one Core transaction, adjacent to the send:** re-verify every snapshot field (agent active, card hash, binding revision, credential_ref active + revision, grants/authorization unrevoked, registry/policy revision, approval intact, consent hash) + CAS consume + phase `built → transmitting`. Drift → void + `stale_authority`. Recovery: `built`+`minted` → requeue; `transmitting`+ → `outcome_unknown`; consumed-but-built unrepresentable. Then send under §6.6 (persisted fresh `messageId`), track, report through §6.5.

### 6.4 Recovery, cancellation, state mapping

Phases `built → transmitting → acknowledged → terminal`, written before the actions they describe. Lease recovery is envelope-aware (`built` → requeue; `transmitting`+ → `outcome_unknown`). Cancellation: one durable claim-independent request per operation (PK `operation_ref`, nullable `resolving_claim_id`, survives re-claim); pre-dispatch → void permit + `cancelled`; post-dispatch → remote `CancelTask` attempt, claim-bound CAS resolution (confirmed stop → `cancelled`; refusal/timeout/race → true terminal or `outcome_unknown`).

**Remote state → workflow outcome (total):** `SUBMITTED`/`WORKING` → running; `INPUT_REQUIRED` → fail `remote_needs_input`; `AUTH_REQUIRED` → fail `remote_needs_auth` (owner notified); `COMPLETED` → §6.5; `FAILED`/`REJECTED` → fail sanitized; `CANCELED` → cancelled; `UNSPECIFIED` → re-poll then `outcome_unknown` at deadline; transport loss/lease expiry at `transmitting`+ → `outcome_unknown`.

### 6.5 Results: sanitize → validate → quarantine → guard job → receipt → release

1. **Deterministic ingest, in this order:** size caps (256 KB) → **sanitation first** (control/bidi stripping, structured-only enforcement, truncation) → **schema validation of the final transformed bytes** against the frozen `expected_result_schema` (validating before sanitation could release bytes the transformation pushed out of contract; M0 pins vectors where stripping/truncation flips `const`/length/pattern validity) → provenance tag. The default result envelope (used when no schema is pinned):
   ```json
   { "$id": "dina:a2a:default-result:v1",
     "type": "object", "required": ["version", "parts"], "additionalProperties": false,
     "properties": {
       "version": { "const": 1 },
       "parts": { "type": "array", "minItems": 1, "maxItems": 16, "items": { "oneOf": [
         { "type": "object", "required": ["text"], "additionalProperties": false,
           "properties": { "text": { "type": "string", "maxLength": 65536 } } },
         { "type": "object", "required": ["data"], "additionalProperties": false,
           "properties": { "data": { "type": "object" } } } ] } } } }
   ```
   Artifact-part mapping: `text`→`text`, `data`→`data`; `raw`/`url` rejected. Canonical schema hash pinned at M0.
2. **Quarantine + guard job.** The artifact lands in `result_quarantine` with its digest; Core mints a durable guard job (`a2a_guard_jobs`: operation, quarantine digest, scanner/policy version, state `pending → claimed → passed | blocked`, claim id/lease, verdict, timestamps). **The operation's completion emits no owner-facing delivery event** — the only owner-delivery event is the one the guard-pass promotion emits, exactly once.
3. **Guard worker (Brain) + receipt.** `guard_worker.ts` claims jobs via `GET /v1/a2a/guard/next` (the guard routes are the sole quarantine readers), runs the semantic guard scan, posts `POST /v1/a2a/guard/verdict` with the digest it scanned. Core accepts the verdict only on digest match (claim-bound CAS): `passed` → atomic promotion to `result_json` + `guard_receipt_id` + the single delivery event; `blocked` → retained quarantined, neutral owner notification. Worker outage → jobs stay `pending`, delivery held — fail-closed. Lapsed claims re-claim.

Rehydration of scrubbed spans: only after release, on owner surfaces, per-span, persona unlocked.

### 6.6 Outbound connection policy (SSRF + TLS)

One policy for every connection (card, invocation, OAuth, DID resolution, webhooks): HTTPS only; no literal IPs; resolve → deny private/link-local/loopback → connect to the vetted IP with original-hostname TLS validation, SNI, and Host; no redirects; size caps (card ≤ 128 KB, responses ≤ 256 KB); timeouts; webhook responses discarded; unpinned hosts refused.

---

## 7. Lane 2 — inbound

### 7.1 The Agent Card projection

Included: `active` + `public` + `surface:'services'` listings; per capability: `isPublicExposureAllowed`, non-`payment` action class, configured `capabilitySchemas`, **and a live executor** — `dina.local`, or an unrevoked `runner_bindings` entry for the capability's lane (§7.3 declares unbound lanes non-executable, so projecting them would advertise skills every invocation must reject). Cards regenerate on binding changes; unbound/revoked-binding projection tests at M2. Excluded absolutely: unlisted, known_only, contact/Talk, personas, plugins, owner-local. Skills: rkey-qualified names, envelope `inputSchema`. `agentId` = `did:plc`; JWS with `dina_signing`. Flags reflect implemented features (false at M2, true at M3). Regenerated on config change — and republished to Lane 3 when publishing is enabled (§8.2).

**Extended card** (M3): served by `GET /v1/a2a/ingress/extended-card` — authenticated like any ingress request; Core resolves the principal, revalidates scope and each grant at read time, projects (public ∩ scope) ∪ granted (`surface:'services'` only) with full envelope schemas incl. `grant_id`/`schema_hash`. Revoked grant → skill absent (M3 test). Discovery convenience; grant-holders can invoke from M2 with the contract delivered at issuance.

### 7.2a The invocation envelope (normative)

Exactly one `data` part: `{ "skill", "params", "grant_id"?, "schema_hash"? }`; `text` parts ignored for dispatch; `raw`/`url` rejected; zero/multiple `data` → malformed (protocol error). **Resolution is against Core's live listing registry, never any card:** public by name; unlisted by fully qualified `capability@rkey`; known_only for grant presenters; `surface:'services'` everywhere. Params validate in Core.

### 7.2 Ingress pipeline

1. **Forward + authenticate** — Core verifies the forwarded credential evidence (§5.1); for DID callers, dispatch binding applies. Failure → 401.
2. **Version/extension params.**
3. **Size caps** — ≤ 256 KB, bounded part count.
4. **Structural validation + envelope parse** — malformed → protocol error, no durable state.
5. **Idempotency receipt — before rate limiting and gates.** Hit + same hash → return the mapped task under the replay ceiling (§4.1). Hit + different hash → conflict, zero mutation. Miss → continue.
6. **Rate limit** — per-principal budget charged to misses.
7. **Skill resolution + action registry + access mode (total):** resolve per §7.2a; non-`payment` class; public → in the client's scope; unlisted by exact reference → passes (the shipped D2D rule; no scope check); known_only → matching grant; `surface:'services'` in every mode.
8. **Visibility/grant gate** (`bypass.ts` three-mode logic; known_only → `grant_id` + `isGrantAuthorized`). **Refusals (steps 7–9, incl. step-9 normalization failures)** → receipt + terminal `REJECTED` (`internal_id NULL`, one reason code, uniform timing) in one transaction; replays return the same task; only steps 1–4 failures are protocol errors.
9. **Core normalization + frozen snapshot + atomic commit.** Normalize (schema-hash, params, stripping, post-hash); freeze the execution snapshot — schemas + `schema_hash`, `responsePolicy`, runner binding **and its executor PEP DID** (§7.3), vault pin, action id + class, **the action-registry/policy revision** (the same fields §6.3 revalidates outbound), and the **listing config revision** — a monotonic `revision` column added to `service_configs` by this design's migration (§9), incremented atomically with every config or runner-binding write, because the existing table carries only timestamps and a timestamp is not a revision. Commit receipt (pre+post hashes) + operation row + snapshot + the initial child (`auto` → execution; `review` → approval). Claim/effect-time drift in any pinned field — including a capability reclassified from `read` to an effectful or denied class — → `stale_authority`; M2 tests config drift and read→effectful reclassification between acceptance and claim. Brain performs no validation, hashing, branching, or child minting here.

### 7.3 Execution, PEP-bound permits, revalidation, response routing

- **Executor bindings.** When a listing's capability binds an external runner (`mcpServer` lane), Core resolves the lane to its **paired device DID** at snapshot time via `runner_bindings` (a durable lane → device-DID record maintained with the listing config; a lane with no bound device is not executable over A2A). The snapshot pins that DID as the operation's PEP.
- **Inbound permits are minted, not just consumed.** For effectful classes (`write`, `booking`, `agentic`), the approval→execution-child transition **atomically mints** the inbound permit: direction `inbound`, the **normalized payload hash** (the direction discriminator selects which hash contract applies), principal, operation + child id, snapshot revision, grant/approval reference, **PEP DID**, expiry.
- **Consumption at the effect boundary, by the PEP only — and PEP identity on every A2A claim:**
  - *External claimants:* **every** A2A-origin child claimed by an external runner — effectful or not — is claimable only by the snapshot's PEP DID (the lane is derived server-side; a paired agent naming another's lane gets 403). A read-class child carries the remote caller's normalized params and produces the result served externally, so identity binding applies to it exactly as to effectful children. For effectful children the claim transition additionally revalidates authority, CAS-consumes the permit, and sets `effect_phase = effect_started`; lease loss after an effectful claim → `outcome_unknown`-class, never requeue.
  - *Claim-token discipline:* every post-claim executor verb on an A2A-origin child — heartbeat, progress, completion, failure, `input_required` — carries the current `claim_id`, CAS-checked against `(task_id, claim_id, running, pep_did)`. A stale report after lease reassignment is rejected and retained as evidence. Lease-reassignment stale-report tests at M2.
  - *In-process (`dina.local`):* authorize-effect immediately before the capability runs; `pre_effect` crash → safe requeue.
- **Revalidation at every data egress:** before result attachment, at grant-authorized task reads, and at outbox claim (client active, grant unrevoked, listing not withdrawn). Revocation mid-flight → result retained owner-private, neutral external terminal, pending outbox rows `suppressed`.
- **Response routing:** the direction-aware Response Bridge resolves by operation id, revalidates, attaches the schema-validated result durably, marks terminal, enqueues outbox rows. Inbound results to the remote caller are the schema-validated declared result (the §6.5 quarantine protects owner-facing surfaces).

### 7.4 Workflow state → A2A state (total)

| Internal | A2A | Note |
|---|---|---|
| `created`, `pending`, `queued`, `scheduled` | `SUBMITTED` | |
| `claimed`, `running`, `awaiting` | `WORKING` | `awaiting`→`WORKING` until §7.7 ships |
| `pending_approval` | `WORKING` | approval invisible; expired → neutral `FAILED` |
| `completed` | `COMPLETED` | one `data` part |
| `failed` | `FAILED` | collapsed reasons |
| `cancelled` | `CANCELED` | |
| `outcome_unknown` | `FAILED` + `outcome:"unknown"` | incl. `effect_started` ambiguity |
| `recorded` | `FAILED` (fail-closed) + audit anomaly | unreachable; map total |
| gate refusal | `REJECTED` | one collapsed shape |

Total both directions (`UNSPECIFIED` in §6.4); M0 enumerates exhaustively. Inbound `CancelTask` succeeds only pre-effect (`pre_effect`); otherwise the binding's task-not-cancelable error.

### 7.5 Events, streaming, push

Outbox rows per (transition × target): `source_event_id`, `target_kind ∈ {sse, webhook}`, `target_id` NOT NULL (`''` = SSE — non-null so UNIQUE dedupes), `UNIQUE(source_event_id, target_kind, target_id)`; claim id/claimant/lease/attempts/status; populated by the a2a completion path, not the Brain event queue. Claim via `GET /v1/a2a/ingress/events` (revalidated per §7.3; per-delivery webhook auth returned only at claim), ack via CAS `POST .../events/ack`; lapsed leases re-claim; state survives gateway restarts; SSE recovers via `GetTask`. Webhook configs policy-checked, FK'd, capped.

### 7.6 The Dina extension

`https://dinakernel.com/a2a/ext/v1` (host = deploy decision), `required:false`: `schemaHash`, `outcome`, `receiptId`, `did`, plus the §5.1 signed-request security-scheme description. The grant selector stays an envelope field (A2A-I6). Directory lifecycle metadata (freshness/publisher epochs) is **not** card content — it lives in the Lane 3 record's separately signed `directory_envelope` (§8.2), precisely so the live card stays byte-stable.

### 7.7 Inbound multi-turn continuation (M4, normative sketch)

- **Entering `INPUT_REQUIRED` — never after an effect, never leaving a live permit behind.** Interruption is representable only when no effectful permit has been consumed for the current generation: non-effectful work, or a provably `pre_effect` in-process execution. An executor in that state posts a structured `input_required` report (prompt + expected-input schema, stored on the operation; claim-id-bound per §7.3) through a Core transition that — atomically — releases the claim, parks the child `awaiting`, **and voids the generation's still-`minted` permit**, so no stale effect authority survives into the interruption. **An external effectful claimant cannot interrupt** — its claim consumed the permit, so its only exits are terminal: complete, fail, or `outcome_unknown` (§1.3). Core rejects an `input_required` report for any generation whose permit is `consumed` or whose `effect_phase` is `effect_started`.
- **Continuing:** a `taskId`-bearing message must authenticate as the operation's principal; find `INPUT_REQUIRED`; satisfy `contextId` consistency; pass the receipt discipline on the new `messageId`; validate its `data` part against the stored expected-input schema; CAS-increment the continuation generation (concurrent → conflict); produce the next child deterministically from (operation, generation) through frozen-snapshot normalization, with a fresh permit for effectful classes — mintable only when **no live (`minted` or `consumed`) permit exists for any prior generation** (the interruption transition voided it; the mint checks anyway). Stale-permit consumption and replay/concurrency tests gate M4.

---

## 8. Lane 3 — the AppView trust-ranked A2A directory (M5)

### 8.1 What it is, and the one rule that governs it

A public, searchable index of Dina A2A gateways: every Home Node that opts in publishes its signed public Agent Card as an AT Protocol record; AppView ingests, validates, and serves trust-ranked search over the result. This is the strategic layer — A2A gives agents identity, Lane 3 gives them *verified reputation* — and it is Verified Truth (Law 2) applied to agent discovery: rank by PeerLens evidence, never by self-description or spend.

The governing rule (A2A-I13, control-plane §19): **the directory relays; it never authors, and it never authorizes.** Every consumer — external agent or another Dina — treats a directory row as a *candidate*: it must still fetch the live `/.well-known/agent-card`, authenticate the endpoint, and (Dina-side) run the full §6.1 owner-approval ceremony. AppView never signs cards, never mutates card content, and its trust metadata rides outside the card object. A directory listing, ranking, or trust score is never an invocation grant.

### 8.2 Publishing (Home Node → PDS)

- **Record:** `com.dinakernel.a2a.card`, with the lexicon pinning **`key: literal:self`**. Two authoritative parts:
  - `card` — the canonical JSON of the JWS-signed public card, **byte-identical to what `/.well-known/agent-card` serves, and byte-stable between genuine card changes**. Directory lifecycle metadata never enters the card: if it did, every freshness bump would change the live card's hash and churn every downstream Dina's §6.1 pin, §5.5 bindings, and §6.3 drift checks. A consuming Dina sees a card-hash change only when the card *materially* changed.
  - `directory_envelope` — a separately signed structure with a **byte-exact wire contract** (a cross-codebase cryptographic seam, pinned the way this project pins every such seam): fields `{v: 1, domain: "dina:a2a:directory-envelope:v1", did, collection, rkey, card_hash, freshness_epoch, publisher_epoch, publisher_instance, sig}` — `did`/`collection`/`rkey` bind the signature to this record's identity (no cross-record or cross-protocol replay), `card_hash` is lowercase SHA-256 hex over the exact `card` string bytes, the epochs are bounded safe integers, `publisher_instance` is a UUID string, and `sig` is base64 Ed25519 (`dina_signing`) over the project's canonical JSON of every field except `sig`. **`card` itself is a string field** — Jetstream hands consumers deserialized JSON, so only a string carries the live card's exact bytes through to A2A-I13's relay guarantee. A `directory_envelope` module in `@dina/a2a` (beside `card_pin.ts`; canonicalize + hash + sign/verify via injected callbacks) is byte-shared to AppView like the registry copy; **M0 ships cross-runtime golden vectors** (canonical bytes, signature, hash binding, noncanonical rejection, cross-record replay rejection) that feed the M5 ingest tests. Verified at ingest: signature against the publisher's DID document, `card_hash` equal to AppView's own computation, identity fields equal to the event's repo/collection/rkey. The cadence bump changes **only the envelope**, so the record still gets a new CID and a real commit while the card stays stable.
  Denormalized convenience siblings (`endpoint`, `protocol_version`, `skills`) remain cross-checked against the verified card, never trusted. M1/M5 cross-test: a remote publisher's cadence refresh does **not** flip a Lane 1 registration to `changed` or void bindings; any genuine card change still does.
- **Publisher placement — trusted host, not Brain.** The card publisher lives in the server host composition beside the existing publication machinery (`apps/home-node-lite/core-server/src/appview/`), NOT in Brain: Brain cannot construct the JWS and must not be handed signed-card or PDS-write authority. The publisher consumes the Core-computed signed card and its regeneration signal in-process and performs the fixed-rkey write with the PDS session DID verified before every write. A two-process test proves Brain can neither alter nor independently publish the card. Publishing is server-only by construction.
- **One aggregate revision, not per-listing revisions.** The card projects *all* public listings, so a single per-rkey `service_configs.revision` cannot key its desired state. Core maintains a **node-global monotonic `card_projection_revision`**, incremented transactionally by every projection-affecting write — listing config, runner binding, the owner toggle, and signing-key changes — and the publisher regenerates from a consistent snapshot at that revision. Concurrent-edit, listing-deletion, and restart-convergence tests at M5.
- **Durable node-scoped publication state.** A single-row `a2a_card_publication` record (§9): desired card hash + `card_projection_revision`, state (`pending | published | failed | not_published`), **durable unpublish intent** (a failed tombstone retries after restart), **publisher epoch** (below), last published URI/CID, attempts, next-retry deadline. The owner toggle is a real route (`POST /v1/a2a/directory-listing`); restart tests cover failed publish and failed unpublish.
- **Consent default: off, node-wide, explicit.** Directory listing requires the owner route — fresh installs and upgrades default `listing_enabled = 0`, and per-listing `isDiscoverable` **never** implies directory publication (the per-listing flags are neither necessary nor sufficient; multi-listing nodes have no deterministic aggregate default, so none is inferred). Fresh-install and mixed-listing upgrade tests at M5.
- **The publication predicate, normative and total:** `listing_enabled && gateway_live && projectable_skill_count > 0 && publication_active && state NOT IN ('stood_down','deactivating')` — a `deactivating` row is never publish-eligible; a separate transition guard grants that state exactly one authority, the fence-bound conditional delete (below), and an M5 test proves no publish can start or resume while deactivating. Consent is one input; *ongoing eligibility* and *fencing state* are the rest — a restored node that satisfies every content condition but has not completed activation still publishes nothing, and a stood-down node publishes nothing regardless of anything else. Every predicate input (toggle, gateway enablement, listing configs, runner bindings, signing key, activation state) transactionally bumps `card_projection_revision` and updates publication intent, so predicate-false always drives an unpublish. **Deactivation or stand-down atomically voids every outstanding publication attempt** (the attempt CAS binds the fencing generation, below), so a late completion from before the transition cannot persist. M5 vectors: gateway disable, final-skill removal, runner-binding revocation, restoration of each, restore-with-eligible-card (must not publish before activation), stand-down during in-flight I/O, late completion after deactivation.
- **Refresh — three triggers, all content-changing.** (a) *Projection change:* any `card_projection_revision` bump. (b) *Freshness cadence:* every 14 days the publisher bumps **the envelope's** signed freshness epoch and republishes — the record bytes change (the card bytes do not), so the record gets a **new CID and a real commit** (a byte-identical re-put is explicitly insufficient: the reference PDS no-ops a `putRecord` whose CID matches the current record and sequences no commit, so an "unchanged re-put" would never reach Jetstream and every stable publisher would silently go stale). (c) *Key rotation:* a `dina_signing` rotation or DID-document change immediately re-signs and republishes (§8.3 handles the index side). M5 includes a reference-PDS-to-Jetstream test proving the cadence bump advances `indexed_at`, and an assertion that the `card` field carries **no** directory-lifecycle fields.
- **Single active publisher — a fencing ceremony, not just a precondition.** A restored backup or migrated server holds the same seed, the same recoverable PDS credential, and — critically — a *copy of the same epoch*, so a bare epoch column cannot fence. The full protocol:
  - **Identity:** each install/restore mints a fresh random `publisher_instance` id; it and `publisher_epoch` ride the signed `directory_envelope`.
  - **The fence outlives the card — with the same pinned wire contract as the envelope.** The epoch proof cannot live only in the card record — unpublish deletes that record. A second, minimal record — `com.dinakernel.a2a.fence`, `key: literal:self` — is written at every activation and **never deleted, only updated**. Its contract mirrors the directory envelope exactly: `{v: 1, domain: "dina:a2a:fence:v1", did, publisher_epoch, publisher_instance, sig}` with `did` **required to equal the repository DID it is read from** (a self-consistent fence signed for another DID is invalid), bounded safe-integer epoch, UUID instance, `sig` = base64 Ed25519 (`dina_signing`) over the project-canonical JSON of all fields except `sig` — implemented by the same `directory_envelope.ts` module, with M0 golden vectors (wrong-repo-DID, wrong-domain, malformed-epoch, noncanonical, replay). **Key rotation re-signs the fence:** §8.2 trigger (c) conditionally rewrites the fence under the new key, preserving epoch and instance; if rotation happened without the refresh (missed trigger), a later activation that cannot verify the fence against the current DID document treats it as *unverifiable, not absent* — it requires an explicit owner re-fence ceremony (which allocates a strictly greater epoch) rather than silently restarting from epoch 0, so rollback via "lost" fences is impossible. Rotation-before-refresh, activation-after-rotation, and rollback-attempt vectors at M5. AppView does not index fence records.
  - **Fence and card bind atomically at write time — with the exact read sequence.** The fence and card are separate records, so a naive read-fence-then-write-card sequence races a handoff. Every card put/delete therefore carries a **repository-commit precondition (`swapCommit`)**. The commit CID does not come from `getRecord` (which returns only URI, record CID, and value) — the pinned sequence is: (1) `com.atproto.sync.getLatestCommit` → repo head `C`; (2) `getRecord` the fence and verify it; (3) `getLatestCommit` again — if the head moved from `C`, restart (something wrote between the reads); (4) perform the card mutation with `swapCommit = C`. Any fence write interleaved after step 3 moves the head and fails step 4, making fence-check-plus-card-write effectively atomic; an unrelated-record write in the same repo also fails the swap and simply retries the sequence (bounded, since same-repo writes are rare and owner-driven). The durable attempt tuple stores **`expected_repo_commit_cid`** alongside `expected_prior_cid`, and the host PDS client gains `getLatestCommit` + `swapCommit` parameters on put/delete (today it exposes neither). Race vectors: fence write between steps 3 and 4 for publish, for delete, and with the card absent; unrelated-repo-write retry.
  - **Boot-inactive:** a restored or imported node starts with publication **inactive** (`publication_active = 0` is part of what restore resets), regardless of the restored flag state. Nothing — publish or unpublish — writes before activation.
  - **Activation = an owner route, with a full state machine — including two-phase deactivation.** `POST /v1/a2a/publisher/activate` (owner caller; §4.3) performs the ceremony: read the current **fence** record (absent → epoch 0; unverifiable → owner re-fence, above), verify it, allocate a strictly greater epoch under this node's instance id, conditionally write the new fence, then set `publication_active = 1`. States: *fresh* → activate; *inactive* (post-restore) → activate; *active* → deactivate or stand-down; **`stood_down` clears only through this same activation route** (no *automatic* recovery — after handoff to server B, the owner can re-activate server A, which claims a greater epoch and stands B down: migration round-trips, user story 08). **Deactivation is two-phase**, because "inactive nodes never write" and "predicate-false drives unpublish" would otherwise deadlock: deactivation durably enters `deactivating` — a state that retains exactly one narrow authority, conditionally deleting the currently fenced card — completes the delete (or confirms absence), then sets inactive and bumps the fencing generation. A crash mid-deactivation resumes in `deactivating` with only that authority; a concurrent activation elsewhere stands the deactivating node down (its conditional delete fails), which also satisfies the owner's intent. Crash-before/after-delete and concurrent-activation vectors at M5. Two restores of one backup cannot both win: the second's conditional fence write fails.
  - **Foreign fence = stand-down:** a writer observing a fence with a higher epoch, or an equal epoch under a different instance id, transitions to `stood_down` with an owner-visible "another server is publishing" notice — it never retargets a stale operation.
  - **Precondition-failure recovery — evidence, not inference.** The attempt record (below) stores the **operation kind and the exact attempted record digest**. On a conditional-write failure, read the current record and judge against that evidence: *publish attempt* → adopt success **only** when the fetched, verified record byte-matches the attempted digest AND the local desired tuple still CAS-matches (an own-instance record with a *different* digest is some other write of ours — refresh the precondition and re-run the current desired state); *unpublish attempt* → success **only** when the record is absent; a present own-instance record means the delete did not land — conditionally delete again. Foreign fence at any point → stand down. Restore-from-backup resumes through activation, never through this rule.
  - M5 vectors: fresh activation, overlapping old/new servers, delayed old-node retry, old-node unpublish after handoff, two-restores-from-one-backup, boot-before-handoff, absent-card handoff (fence present, card unpublished), predicate-false handoff, stood-down re-activation round-trip (A→B→A), ambiguous-timeout with same-instance-old-record, newer-cadence-record during recovery, ambiguous delete.
- **Durable publication-attempt CAS.** The existing wiring guards racing publishes with an in-memory slot version, which does not survive restart; here the guard is durable: each attempt **claims** `{operation_kind: publish|unpublish, card_projection_revision, freshness_epoch, publisher_epoch, publisher_instance, fencing_generation, desired_card_hash, attempted_record_digest, expected_prior_cid}` in `a2a_card_publication`; completion persists success only through a CAS against that claimed tuple — desired-state drift, an `InvalidSwap`, a deactivation/stand-down (which voids the fencing generation), or a late/crashed completion discards the attempt and recomputes instead of recording an obsolete CID as published or resurrecting a conditionally deleted record. The `attempted_record_digest` is what makes recovery evidence-based (above), and it has a byte-exact contract: **lowercase SHA-256 hex over the project-canonical JSON of the complete attempted record value** (the same canonicalization the envelope uses); a fetched record — which the read API returns as a deserialized object — is re-canonicalized identically before comparison. M0 cross-runtime vectors: field order, envelope-only cadence change, sibling-field change, two different same-instance records. M5 vectors: cadence-vs-config race, cadence-vs-toggle-off, late success, late failure, crash between PDS success and local CAS.
- **Unpublish:** owner toggle off (or the publication predicate turning false) deletes the record — conditionally, like every write — tombstoning the index via the normal Jetstream delete event; the durable unpublish intent guarantees the delete eventually lands.

### 8.3 Ingestion and serving (AppView)

- **Ingester:** `com.dinakernel.a2a.card` joins the indexed collections — gated by the dedicated a2a flag, routed **around** the unrelated `trust_v1_enabled` gate (an a2a card is not a trust record; coupling them would let a trust-pipeline rollback silently freeze the directory). Validation at ingest, all fail-closed: **`commit.rkey` must equal `self`** on create, update, *and* delete, enforced independently of the lexicon pin (arbitrary rkeys from the same repo must never touch the one-card-per-DID row); structural card validation (`@dina/a2a` validators, byte-shared); **JWS verification** against the publisher's DID document `dina_signing` key; **`card.agentId` = repo DID**; size caps (≤ 128 KB). **The verified card and the verified envelope are the sole sources:** AppView computes `card_hash` itself over the exact `card` bytes and derives `endpoint`, `protocol_version`, and `skills` by parsing the verified card; the freshness/publisher epochs and instance id come from the **separately verified `directory_envelope`** (its own Ed25519 signature checked against the same DID document, and its `card_hash` must equal the computed one). Sibling mismatch anywhere rejects the record (per-field vectors at M5). Every derived skill's capability component must pass the shared public-exposure predicate.
- **Qualified skill names, parsed strictly.** Card skills are `capability` or `capability@rkey` (§7.1). A strict parser in `@dina/a2a` (byte-shared) validates the rkey against the protocol's listing-rkey grammar and resolves the capability through the shared registry's canonical/alias lookup — unresolvable or malformed → reject. The index stores the **exact skill identifier** and its **canonical search key**; `searchAgents.skill` accepts either; multi-rkey vectors at M5.
- **Ordering and replay safety — `commit.rev` is the token, with a total equal-rev rule.** Jetstream's `time_us` is informal and deletes carry no record CID, so neither can order transitions. Every event's **repository revision (`commit.rev`)** is plumbed through the handler signature (a required change: today's handlers drop it) and persisted; **every state transition — upsert, tombstone, and invalidation — is CAS-conditioned on it**. Equal-rev conflicts have a total rule: an event whose (rev, operation, canonical event hash) matches the applied one is a **no-op replay**; an event at the *same* rev with a *different* operation or payload is a conflict — the row goes fail-closed `unavailable` with both events retained as evidence (arrival order must never pick a winner). CID is stored for content identity and audit only. M5 vectors: delayed old update, equal-rev identical replay, equal-rev conflicting update/delete in **both arrival orders** (live and spooled), CID-less delete, delete racing create, reconnect replay, tombstone resurrection.
- **Newer-invalid suppresses older-valid.** "Invalid → not indexed" is not only an admission rule: if a *newer* operation (by `commit.rev`) replaces a previously valid card with one that fails validation, the existing row is CAS-marked **unavailable** (rejection evidence retained) rather than left serving a card that is no longer the repo's current valid record. M5 vectors: valid→invalid→valid, replayed-old-invalid (must not suppress a newer valid row).
- **Three independent gates, separately stored.** Mirroring the existing service-moderation split: (1) **repository presence** — rev-ordered create/update/delete state from the ingester; (2) **moderator takedown** — its own state with reason and audited mutations (the `tombstonedAt`/`tombstoneReason` + moderation-CLI discipline), restored only by a moderator action — **an owner re-put never clears a takedown**, and a moderator restore never resurrects a repo-deleted card; (3) **DID redaction**. Serving requires all three clear. M5 vectors: owner re-put during takedown, independent delete/restore orderings.
- **Storage:** one Drizzle table `a2a_cards`: `did` (PK), `card_json` (verbatim), `card_hash` (AppView-computed), `signature_state`, `endpoint`, `skills` + canonical keys (derived), `protocol_version`, `freshness_epoch` (from the verified `directory_envelope`), `indexed_at`, `repo_rev`, `cid`, repository-presence state, takedown state + reason, `unavailable` (newer-invalid), `presence_unproved` (§8.3 gap recovery). **Staleness is a query-time expression with a pinned constant:** `A2A_CARD_STALE_AFTER = 30 days`; a card is stale when `now - indexed_at >= A2A_CARD_STALE_AFTER`, evaluated against AppView's clock (inclusive at the boundary). No scheduled updater; the M5 clock-advanced vector tests exactly this comparison at, just under, and just over the boundary. §8.2's epoch-bumping cadence keeps healthy publishers inside the window with real commits.
- **Key rotation revalidates the index.** AppView already refreshes DID documents; for a2a cards it must act on them: an identity event for an indexed DID (or the periodic revalidation fallback for missed events) re-verifies the stored card's JWS against the *current* DID document — failure flips `signature_state` and suppresses serving until the publisher's rotation-triggered republish (§8.2 trigger c) lands. `signature_state='verified'` is never allowed to outlive the key that justified it. M5 vectors: rotation-before-republish (card suppressed), successful republish (restored), missed-identity-event (caught by periodic revalidation).
- **Serving — two xRPC methods**, both behind the full gate set — repository presence, moderator takedown, `did_redactions`, `unavailable`, and signature validity: a deleted, redacted, taken-down, superseded-invalid, or stale-key card is absent from search and **not-found** from `getCard`. Delete/redact/restore tests at M5.
  - `com.dinakernel.a2a.searchAgents` — params `{skill?, q?, limit, cursor}`. **Relevance filters; trust orders.** Skill/text matching decides *whether* a card is a candidate (a relevance threshold, not a score component); candidates then order by `(trustScore DESC, textRelevance DESC, did)` — deterministic tie-break, versioned cursors — with stale cards demoted below all fresh ones. The naive `text*0.5 + trust*0.5` composite is explicitly rejected here: it lets a zero-trust card with matching self-authored text outrank a high-trust card, which would invert the directory's whole point (M5 pins an adversarial text-vs-trust vector: keyword-stuffed zero-trust publisher must rank below a relevant high-trust one). Trust = `COALESCE(didProfiles.overallTrustScore, 0)` — the PeerLens scorer pipeline reused as the *ordering* dimension. Each result: `{did, displayName, endpoint, skills, trustScore, recommendation, indexedAt, stale, cardHash}` — index metadata only, never a mutated card.
  - `com.dinakernel.a2a.getCard` — param `{did}`. Returns `{card, cardHash, signatureState, indexedAt, stale, trust: {...}}` where `card` is the **verbatim published bytes** (relay-not-author: served bytes hash-equal the AppView-computed `card_hash`, tested) and everything else is clearly separated index metadata.
- **Feature flag, rollback, and the off-window: spool, don't skip — with a real data model.** A dedicated `a2a_directory_enabled` flag gates **serving** and **processing**, never *recording*. Because the API and ingester are **separate processes**, serving is not gated on the boolean flag but on a durable **readiness row** (PostgreSQL: `a2a_directory_state.generation` + `phase ∈ {disabled, draining, ready}`): the xRPC methods serve only in `ready`, so re-enabling the flag cannot reopen reads before the drain completes. The spool itself is a PostgreSQL table (not the ingester's capped, lossy file spool): one row per event keyed (did, collection, rkey, `repo_rev`, operation, canonical event hash) — operation and hash in the identity so equal-rev conflicts are *detected*, never silently deduplicated — with the full event payload, `time_us`, status, and claim lease; **the spool insert commits before the consumer acknowledges the event** — persist-before-ack, so a crash between receipt and processing loses nothing. **A2A events are exempt from the consumer's dead-letter and capped-file-spool paths** (those drop after bounded retries; an a2a event that cannot be spooled or processed pins the shared cursor instead — backpressure over loss — and the required Drizzle models for the spool and directory-state tables ship with M5, §9). While the flag is off (or a flag *read* fails — treated identically, marked reconciliation-required), every a2a event spools. On re-enable: phase → `draining`; the spool drains per-repository in `repo_rev` order through the normal CAS pipeline; the high-watermark (the cursor at re-enable) fences drained history from resumed live processing; phase → `ready` only when the drain is durably complete. Capacity: the spool is unbounded-by-policy (rows, not files); if insertion fails the consumer **stops acknowledging** a2a events rather than dropping them (backpressure over loss). M5 vectors: first-ever create while off; update/delete while off; concurrent live event during drain; crash between spool-insert and ack; crash mid-drain; premature-reopen attempt (API must refuse while `draining`); spool-insert failure backpressure; transient flag-read failure.
- **Gap recovery beyond the flag window — presence must be re-proved, per gap generation.** The spool covers deliberate off-windows; a cold AppView deploy or an outage longer than Jetstream retention loses events irrecoverably, and a snapshot backfill can neither supply `commit.rev` nor discover deletes. The design fails closed, **generation-bound**: on detecting an unreplayable gap (cursor older than retention, or first boot against an existing index), the directory state atomically increments a **`gap_generation`** *before* ingestion resumes, and every a2a row's `proved_generation` now lags it — lagging rows are suppressed from serving (both xRPC methods gate on generation). **Every event is durably stamped at receipt with the generation it was observed under (`observed_gap_generation`, a spool column)** — "processed within the current generation" means the *receipt* stamp, not processing time, so an event received before the gap was declared but processed after it still applies its state transition **without granting proof**. Re-proof requires a strictly newer (by `commit.rev`) valid `com.dinakernel.a2a.card/self` transition whose receipt stamp equals the current generation — neither a replayed pre-gap event nor a queued pre-gap event can clear the suppression, so a delete missed inside the gap stays safe. §8.2's 14-day cadence guarantees every live publisher emits a qualifying event within the staleness window; deleted cards never re-prove and sweep. (Optional accelerated re-proof via direct repository reads uses the outbound policy below.) M5 vectors: cold start over an existing index; beyond-retention outage covering a missed create, update, and delete; late pre-gap replay (must not clear); concurrent gap-marking vs live ingestion.
- **AppView outbound connections** (DID-document/identity resolution; optional accelerated re-proof) follow §6.6's rule set by reference: HTTPS only, resolve-then-connect with private/link-local/loopback denial, no redirects, response caps, timeouts, bounded concurrency. SSRF vectors at M5.
- **Trust semantics:** the score and recommendation band (`proceed / caution / verify / avoid`) reuse `com.dinakernel.peerlens.resolve` semantics. They rank and inform; they never authorize (A2A-I13). Score gaming is the existing PeerLens scoring problem, inherited, not new here.

### 8.4 Consumption

- **External agents** (any A2A client): call the public xRPC (plain HTTP+JSON), pick a candidate, fetch its live `/.well-known/agent-card`, authenticate the endpoint per their own rules. The directory's value to them is the trust ranking they can get nowhere else.
- **Dina-side (Lane 1 discovery):** a new Brain tool `search_a2a_agents` (the `search_provider_services` pattern: AppView client call + client-side defense-in-depth re-filtering) surfaces candidates with trust evidence into the registration flow. Selecting a candidate feeds §6.1 unchanged: host-side fetch of the **live** card (never the directory copy — the directory copy is a hint; the pin is against the endpoint), owner review with PeerLens evidence displayed, per-skill bindings, activation. Candidates, not grants.
- **Drift between directory copy and live card** is expected and harmless: §6.1 pins the live card; a hash mismatch against the directory copy simply means the directory is behind (staleness), never an error on the consumer.

### 8.5 What Lane 3 does not do

No crawling (AppView indexes only what owners publish to their own PDS — the existing ingestion trust model); no card signing or augmentation; no indexing of unlisted/known_only/Talk listings (they never enter the public card, §7.1, and ingest re-filters anyway); no invocation, proxying, or relaying of A2A traffic (discovery only); no new AppView write path from Dina (publish goes through the owner's PDS like every other record). ARD syndication of this directory is future work (§13 Q10).

---

## 9. Storage and migration

```sql
CREATE TABLE a2a_remote_agents (
  agent_id TEXT PRIMARY KEY, card_url TEXT NOT NULL, card_json TEXT NOT NULL, card_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL, auth_endpoints_json TEXT, schemes_json TEXT NOT NULL,
  signature_state TEXT NOT NULL CHECK(signature_state IN ('verified','unsigned','invalid')),
  status TEXT NOT NULL CHECK(status IN ('candidate','active','changed','revoked')),
  approved_at INTEGER, last_verified_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE a2a_skill_bindings (
  remote_agent_id TEXT NOT NULL, card_hash TEXT NOT NULL, skill TEXT NOT NULL,
  action_class TEXT NOT NULL CHECK(action_class IN ('read','quote','write','booking','agentic')),
  result_schema_json TEXT,
  credential_ref TEXT NOT NULL,           -- §5.3/§5.5: explicit credential selection ('none' ref for open agents)
  revision INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (remote_agent_id, card_hash, skill)
);

CREATE TABLE a2a_remote_credentials (      -- immutable versioned refs; rotation = new ref (§5.3)
  credential_ref TEXT PRIMARY KEY, remote_agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('none','api_key','bearer','oauth2_client')),
  audience TEXT,
  scope_json TEXT NOT NULL,                -- canonical scope metadata the consent card renders (§5.3)
  scope_hash TEXT NOT NULL, revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE a2a_runner_bindings (         -- §7.3: inbound executor lane → paired device DID
  lane TEXT PRIMARY KEY, device_did TEXT NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE a2a_clients (
  client_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  token_hash TEXT, token_expires_at INTEGER, bound_did TEXT, expected_did TEXT,
  scope_json TEXT, last_used_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE UNIQUE INDEX idx_a2a_clients_bound_did ON a2a_clients(bound_did)
  WHERE bound_did IS NOT NULL AND status = 'active';

CREATE TABLE a2a_credential_bindings (
  id INTEGER PRIMARY KEY, client_id TEXT NOT NULL,
  binding_type TEXT NOT NULL CHECK(binding_type IN ('bearer','did')),
  value_hash TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE a2a_did_challenges (
  challenge_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, nonce_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE a2a_utterances (
  session_id TEXT NOT NULL, turn INTEGER NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);

CREATE TABLE a2a_disclosures (             -- written at the vault-read dispatch layer with release
  handle TEXT PRIMARY KEY,                 -- context {session, audience}; covers search/get/browse/
  session_id TEXT NOT NULL,                -- list/subject-recall on both boots (§4.2)
  audience TEXT NOT NULL,                  -- canonical release audience; proposal resolution rejects a
                                           -- handle whose audience does not match the proposing lane
                                           -- (cross-audience rejection tests, both boots)
  persona TEXT NOT NULL, categories_json TEXT NOT NULL, span_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX idx_a2a_disclosures_session ON a2a_disclosures(session_id);

CREATE TABLE a2a_tasks (
  id INTEGER PRIMARY KEY, external_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  principal TEXT NOT NULL, internal_id TEXT, context_id TEXT,
  state TEXT NOT NULL, reason_code TEXT,
  result_json TEXT,                        -- released (post-guard for owner-facing content)
  result_quarantine TEXT, quarantine_digest TEXT, guard_receipt_id TEXT,
  message_id TEXT, request_hash TEXT, card_hash TEXT,
  submission_phase TEXT CHECK(submission_phase IN ('built','transmitting','acknowledged','terminal')),
  effect_phase TEXT CHECK(effect_phase IN ('pre_effect','effect_started','done')),
  continuation_generation INTEGER NOT NULL DEFAULT 0,
  input_required_json TEXT, snapshot_json TEXT,
  remote_agent_id TEXT, remote_task_id TEXT, remote_context_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_a2a_tasks_ext ON a2a_tasks(direction, principal, external_id);
CREATE INDEX idx_a2a_tasks_internal ON a2a_tasks(internal_id);
CREATE INDEX idx_a2a_tasks_principal ON a2a_tasks(principal, created_at);

CREATE TABLE a2a_permits (
  permit_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK(direction IN ('outbound','inbound')),
  operation_ref INTEGER NOT NULL REFERENCES a2a_tasks(id),
  execution_child_id TEXT NOT NULL DEFAULT '',  -- '' = outbound dispatch permit (non-null so the
                                                -- unique index dedupes; SQLite NULLs never conflict)
  payload_hash TEXT NOT NULL,              -- outbound: consent hash (A2A-I10); inbound: normalized
                                           -- payload hash — the direction column selects the contract
  action_class TEXT NOT NULL,
  pep_did TEXT,                            -- inbound: executor DID pinned from runner_bindings (§7.3)
  authority_snapshot_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('minted','consumed','void')),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE UNIQUE INDEX idx_a2a_permits_execution ON a2a_permits(operation_ref, execution_child_id)
  WHERE state != 'void';

CREATE TABLE a2a_guard_jobs (              -- §6.5: durable guard lifecycle
  job_id TEXT PRIMARY KEY,
  operation_ref INTEGER NOT NULL REFERENCES a2a_tasks(id),
  quarantine_digest TEXT NOT NULL,
  scanner_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','passed','blocked')),
  claim_id TEXT, claimed_until INTEGER, verdict_json TEXT,
  created_at INTEGER NOT NULL, resolved_at INTEGER
);

CREATE TABLE a2a_sharing_grants (
  grant_id TEXT PRIMARY KEY, remote_agent_id TEXT NOT NULL, categories_json TEXT NOT NULL,
  purpose TEXT, expires_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE a2a_entities (                -- single-provable-source spans only; derived/multi-source
  entity_ref TEXT PRIMARY KEY,             --  originals are never retained (A2A-I9)
  operation_ref INTEGER NOT NULL REFERENCES a2a_tasks(id),
  wrap_persona TEXT,                       -- source persona; NULL = identity-key wrap (user_request span)
  ciphertext BLOB NOT NULL,                -- AES-256-GCM under HKDF('dina:a2a:entities:v1') of the wrap
                                           -- persona's DEK (identity key when NULL). Persona locked →
                                           -- not rehydratable now; persona shredded → unrecoverable.
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE a2a_idempotency_receipts (
  principal TEXT NOT NULL, operation TEXT NOT NULL, message_id TEXT NOT NULL,
  request_hash_pre TEXT NOT NULL, request_hash_post TEXT,
  mapped_external_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (principal, operation, message_id)
);

CREATE TABLE a2a_cancel_requests (
  operation_ref INTEGER PRIMARY KEY REFERENCES a2a_tasks(id),
  state TEXT NOT NULL CHECK(state IN ('requested','attempting','confirmed','refused')),
  resolving_claim_id TEXT, requested_at INTEGER NOT NULL, resolved_at INTEGER
);

CREATE TABLE a2a_push_configs (
  id TEXT PRIMARY KEY, operation_ref INTEGER NOT NULL REFERENCES a2a_tasks(id),
  url TEXT NOT NULL, token TEXT, auth_json TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE a2a_push_outbox (
  id INTEGER PRIMARY KEY, operation_ref INTEGER NOT NULL REFERENCES a2a_tasks(id),
  source_event_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('sse','webhook')),
  target_id TEXT NOT NULL DEFAULT '',      -- '' = SSE stream; non-null so UNIQUE dedupes
  event_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','delivered','failed','suppressed')),
  claim_id TEXT, claimed_by TEXT, claimed_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (source_event_id, target_kind, target_id)
);
```

**Lane 3, Dina side:** one node-scoped single-row table in `identity.sqlite`:

```sql
CREATE TABLE a2a_card_publication (        -- §8.2: durable node-scoped publication lifecycle
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- single row
  listing_enabled INTEGER NOT NULL DEFAULT 0,      -- default OFF; only the owner route sets it (§8.2)
  publication_active INTEGER NOT NULL DEFAULT 0,   -- fencing ceremony: restore/import resets to 0;
                                                   -- only owner-authenticated activation sets it (§8.2)
  card_projection_revision INTEGER NOT NULL DEFAULT 0,  -- node-global monotonic; bumped transactionally
                                                        -- by every projection-affecting write (§8.2)
  desired_card_hash TEXT,
  freshness_epoch INTEGER NOT NULL DEFAULT 0,      -- signed into the directory_envelope (NOT the card);
                                                   -- bumped on the 14-day cadence
  publisher_epoch INTEGER NOT NULL DEFAULT 0,      -- split-brain fence; in the signed envelope
  publisher_instance TEXT NOT NULL,                -- random id minted at install/restore; in the envelope
  fencing_generation INTEGER NOT NULL DEFAULT 0,   -- bumped on activate/deactivate/stand-down; bound
                                                   -- into every attempt so late completions void (§8.2)
  state TEXT NOT NULL CHECK(state IN ('pending','published','failed','not_published','stood_down','deactivating')),
  unpublish_intent INTEGER NOT NULL DEFAULT 0,     -- durable: a failed tombstone retries after restart
  attempt_tuple_json TEXT,                         -- §8.2 durable attempt CAS: {operation_kind, revisions,
                                                   --  epochs, instance, fencing_generation, desired hash,
                                                   --  attempted_record_digest}
  attempt_expected_cid TEXT,                       --   + expected prior RECORD CID for the in-flight attempt
  attempt_expected_repo_commit_cid TEXT,           --   + the repo head captured by the §8.2 read sequence
                                                   --     (swapCommit precondition; distinct from record CID)
  last_published_uri TEXT, last_published_cid TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
  last_published_at INTEGER, updated_at INTEGER NOT NULL
);
```

**Lane 3 (AppView, PostgreSQL/Drizzle) — three tables, a separate deploy:** `a2a_cards` per §8.3 (the `repo_rev` ordering token, `cid`, the three separately stored gates, `unavailable`, `presence_unproved` + `proved_generation`); `a2a_event_spool` (identity = did/collection/rkey/`repo_rev`/operation/canonical event hash; full payload; `time_us`; status; claim lease — persist-before-ack, exempt from dead-letter/file-spool paths); `a2a_directory_state` (single row: `generation`, `phase ∈ {disabled, draining, ready}`, drain high-watermark, `gap_generation`). All transitions CAS; the concrete Drizzle models ship with M5.

**Lifecycle.** Terminal rows sweep on the workflow cadence; entities at operation-terminal + 7 days and `expires_at`; persona shred kills that persona's spans; quarantined content (`result_quarantine`) is excluded from every export and every projection except the guard routes, and purges with the operation; guard jobs sweep with their operations. Entity rows export/restore only alongside their wrap persona.

**Migration.** Versioned (app is live): new tables via `CREATE TABLE IF NOT EXISTS`; `origin:'a2a'` widens the `workflow_tasks.origin` CHECK via table rebuild preserving rows/indexes/events; `AllowedOrigins` gains `'a2a'`; **`service_configs` gains a monotonic `revision INTEGER NOT NULL DEFAULT 0` column** (incremented atomically with every config or runner-binding write — the snapshot's drift detection, §7.2 step 9, needs a revision, and the existing timestamps are not one; it also triggers Lane 3 republish, §8.2). Fresh + upgrade tests, both adapters.

---

## 10. Threat model

| Attack | Mitigation |
|---|---|
| Spoofed/tampered card (Lane 1) | §6.6 fetch, hash pin, JWS verify, endpoint pinning, re-approval on change |
| Spoofed card in the directory | Ingest-time JWS verification + `agentId` = repo DID or not indexed (§8.3); consumers pin the live card regardless (§8.4) |
| Directory as authority | A2A-I13: relay-not-author (served bytes hash-equal published bytes, tested), trust ranks but never authorizes, §6.1 ceremony unchanged for directory candidates |
| Card claims authority | Projection only; registry resolution; per-call grants |
| Compromised gateway | Core verifies credentials + dispatch binding (§5.1); honest residual in §4.1; M2 replay + tampered-body + cross-operation substitution tests |
| Compromised Brain dispatches | Approval-always over the fully rendered consent payload; Core provenance; §6.3 transaction |
| Compromised Brain launders remembered content | `derived` always `unverified` → explicit authority + card marking; residual stated |
| Compromised Brain corrupts inbound execution | Core normalizes, freezes snapshots, materializes children |
| Rogue paired agent claims another's task | Snapshot-pinned PEP DID enforced on **every** A2A external claim; claim-token CAS on every post-claim verb (§7.3) |
| Cross-recipient / cross-credential approval reuse | Consent payload binds recipient, card, endpoint, skill, class, `credential_ref` + revision (A2A-I10) |
| Bait-and-switch after approval | Consent-hash-bound permits; §6.3/§7.3 re-verify every snapshot field |
| Revocation raced | Effect-boundary consumption + revalidation at attachment/reads/outbox claim; `suppressed` rows |
| Config/credential drift | Frozen snapshot (incl. registry/policy + config revision) + immutable `credential_ref` → `stale_authority` |
| Duplicate effects after crash | Outbound: atomic consume+phase. Inbound: PEP claim-consume, effectful lease loss → `outcome_unknown`; interrupt-resume forbidden after consumption, interruption voids the minted permit (§7.7); unique live permit per execution |
| Prompt injection through artifacts | Sanitize → validate-final → quarantine → digest-bound guard job/receipt; completion emits no owner event; guard routes are the sole quarantine readers (§6.5) |
| PII leakage / persona bypass | Core scrub; single-source spans persona-wrapped; derived originals never stored |
| Contact-service reach | `surface:'services'` at issuance, projection, resolution — and Talk listings never published to Lane 3 |
| Existence probing / replay floods | Uniform `REJECTED`; receipt-stable replays under a bounded ceiling; per-principal budgets inside ingress; gateway exempt from shared outer limiters (§4.1) |
| Internal id / vault-id leakage | UUID externals; disclosure handles; collapsed reasons; metadata-only logs |
| SSRF | One §6.6 policy; pinned endpoints only |
| Message mutation | Receipts first; conflict on hash mismatch, zero mutation |
| False "canceled" | Durable claim-independent record; CAS resolution; verified stop or `outcome_unknown` |
| Exfiltration outbound | Proved/tainted/unverified labels + grants or one-time authorization + full-projection card |
| Cross-principal access | Principal-filtered reads; FK'd outbox; claim/ack CAS; non-null exactly-once keys |
| Stolen bearer | Expiry, rotation, last-use, history, revoke-cascades; DID upgrade |
| Lane hijack | `a2a:%` reserved + PEP DID check |
| Trust-score gaming (Lane 3) | Inherited PeerLens scoring problem; score ranks, never authorizes; not new surface here |
| Payment | Inbound registry deny; outbound unassignable + approval-always + least-scope + disclosed residual |

---

## 11. Four Laws check

1. **Silence First** — approval cards only; results to the asking conversation; Lane 3 publishing is owner-opted, never pushed.
2. **Verified Truth** — remote agents rank by pinned identity, signature state, PeerLens evidence, outcome history; Lane 3 makes this the public discovery experience — rank by verified trust, not self-description.
3. **Absolute Loyalty** — no keys in the gateway; scrub/provenance/egress in Core; every delegation approved against the full rendered projection; persona compartments survive; revocation reaches in-flight work and queued deliveries; the directory carries only what the owner already published.
4. **Never Replace a Human** — machine-to-machine only; digest-bound guard before any human sees remote content.

---

## 12. Milestones

**M0 — spec pin + pure package.** Re-pin wire specifics. `@dina/a2a` (incl. **`directory_envelope.ts`** — the Lane 3 envelope, fence, and attempted-record-digest contracts), action registry, binding validator, normalization module, dispatch-binding table, shared PII patterns, default-envelope schema (hash pinned). *Done when: dep-hygiene passes; state maps enumerate both enums; envelope vectors (valid/multi/none/raw/unknown-skill); projection vectors (no non-public/payment/custom/schema-less/non-services/Dina-field leakage); `payment` unassignable; normalization-failure vectors → REJECTED class; sanitize-before-validate vectors; default-envelope accept/reject; **directory-envelope + fence cross-runtime golden vectors** (canonical bytes, signature, hash/identity binding, wrong-repo-DID, wrong-domain, malformed fields, noncanonical, replay) and attempted-record-digest vectors (field order, envelope-only change, sibling change, distinct same-instance records).*

**M1 — Lane 1.** Registration + bindings (result schema + `credential_ref` selection incl. the `'none'` lane) + versioned credentials with rendered scope; proposal route (staging, four-label provenance with the release-context disclosure log + both-boots parity + negative tests, per-span entities, egress authority); consent-payload approval with full-projection rendering; direction-discriminated durable permits + atomic dispatch incl. credential checks; lane guards; runner; envelope-aware recovery; claim-independent cancellation; sanitize→validate→quarantine→guard pipeline with digest-bound receipts and single-event delivery. *Done when: E2E against the a2a-sdk reference agent (via the `'none'` credential lane); contract tests: unbound skill; every snapshot-drift class voiding dispatch in-transaction; fabricated-handle/utterance-mismatch; unverified-derived authority; cross-recipient AND cross-credential approval-reuse refusal; staged-restart survival; permit crash-consistency + concurrent mint (both directions); pre-claim + cross-reclaim cancellation; guard flow (block retention, outage hold, digest mismatch, exactly-one delivery event, quarantine invisibility); lane hijack; Brain-compromise suite.*

**M2 — Lane 2 core.** Gateway + key; origin migration (incl. the `service_configs` revision column); public card (schema-less, non-services, and executor-less capabilities excluded); client registration + bearer verification; grant issuance (`surface:'services'`); JSON-RPC `SendMessage`/`GetTask`/`ListTasks`/`CancelTask`; ingress (receipt-before-rate-limit with the bounded replay ceiling, production-default rate tests, Core normalization + snapshots incl. PEP DID + revisions, atomic commits, total access-mode rule); runner-binding records; PEP-enforced claims on every A2A child + claim-token CAS on every executor verb; in-process authorize-effect; revalidation at attachment/reads/outbox claim; direction-aware Response Bridge. *Done when: E2E public + unlisted-by-reference + known_only through both policies; TCK for implemented operations; adversarial tests per §10 incl. bearer replay, tampered-body and cross-operation/cross-task substitution, rogue-claimant 403 (read-class and effectful), stale-report rejection after lease reassignment, scope/grant/unlisted composition, talk-surface unreachability, replay-flood bounds at production defaults, mutation conflict, refusal indistinguishability, revocation during read/effect/poll/delivery, config drift and read→effectful reclassification → `stale_authority`, effectful lease loss → `outcome_unknown`.*

**M3 — delivery spine + extended card.** Outbox claim/ack CAS + claim-time revalidation + suppression; SSE; webhook delivery under §6.6; `GET /v1/a2a/ingress/extended-card` (authenticated projection + grant-revocation test); flags true. *Done when: streamed = polled truth; restart-survival mid-claim; exactly-once per (transition, target_kind, target_id) incl. repeated SSE insertion; suppression on revocation; SSRF vectors refuse; extended card hides revoked grants.*

**M4 — maturity.** DID auth per §5.1 (upgrade + per-request contract + dispatch binding + replay/expiry/reuse/concurrency/tampered-body/substitution tests); inbound multi-turn per §7.7 (interruption only pre-effect with permit voiding, continuation generations, per-generation permits, stale-permit + replay/concurrency tests); REST binding on demand.

**M5 — Lane 3, the trust-ranked directory (§8).** Trigger: Lane 2 live with real public cards. Dina side: `com.dinakernel.a2a.card` + `com.dinakernel.a2a.fence` lexicons (`key: literal:self`; byte-stable `card` string + signed `directory_envelope` per the §8.2 wire contract) + the trusted-host card publisher (durable `a2a_card_publication` incl. projection revision, epochs, instance id, fencing generation, activation state, evidence-based attempt CAS; three refresh triggers; the total publication predicate incl. fencing state; conditional PDS writes with the full ceremony; durable unpublish intent; node-wide default-off consent) + the owner listing-toggle and activate/deactivate routes + `search_a2a_agents` + the `@dina/a2a` `directory_envelope` module with M0 cross-runtime golden vectors. AppView side: lexicon registration, dedicated flag routed around `trust_v1_enabled`, the durable PostgreSQL spool + readiness-generation gating (persist-before-ack, per-repo rev-order drain, backpressure), `presence_unproved` gap recovery, ingest validation (rkey=self, card JWS, envelope signature + identity + hash binding, DID match, card-derived fields, qualified-skill parsing, registry re-filter, caps), `a2a_cards` with `repo_rev` CAS on every transition, newer-invalid suppression, three separately stored gates, key-rotation revalidation, query-time staleness, `searchAgents` + `getCard`, the §6.6-referenced outbound policy. *Done when — **the in-section "M5 vectors:" lists throughout §8.2 and §8.3 are the single normative test inventory; every listed vector passes**, plus the cross-cutting proofs: publish→ingest→search→getCard E2E against the test AppView; the 14-day **envelope** bump produces a real commit on a reference PDS and advances `indexed_at` without changing `card_hash` — a Lane 1 registration pinned to the same publisher survives the bump with bindings intact, while a genuine card change still re-gates; two-process Brain-cannot-publish; `getCard` bytes hash-equal the AppView-computed hash; a directory-sourced Lane 1 registration still walks the full §6.1 ceremony pinning the live card; unlisted/known_only/Talk absent from every indexed card; the M0 golden vectors (envelope, fence, digest) all feed the corresponding ingest/recovery tests.*

**Throughout:** contract tests per route; two-node E2E harness with a real remote agent; no PII in gateway/runner logs.

---

## 13. Open questions

1. **NAT'd inbound** — MsgBox-fronted A2A front door; deferred until Lane 2 proves demand.
2. **Card in the DID document** — `#a2a` service endpoint cross-linking A2A and AT Protocol discovery; decide at M2 (Lane 3 partially covers this: the PDS record already anchors card-to-DID).
3. **Retention windows** — revisit with traffic.
4. **Per-skill pricing/credits** — refusal shape stays collapsed; post-credits-Phase-2.
5. **Sharing-grant UX** — owner surface at M1.
6. **Restoring auto-permit** — needs a durable owner-ask authorization object; only if approval fatigue is demonstrated.
7. **Payment-capable credential detection** — tighten if providers expose scope introspection.
8. **Isolated derivation** — a Core-receipted derivation sandbox could upgrade `derived` to proved lineage.
9. **Outbound multi-turn** — forwarding owner responses to remote `INPUT_REQUIRED`; out of scope through M4.
10. **ARD (publish + consume)** — control-plane §19 / Phase 10 item 4: a separate adapter design (SSRF-safe catalog retrieval, publisher verification, candidates-not-grants). Natural sequencing: ARD syndicates the Lane 3 directory outward once M5 exists.
