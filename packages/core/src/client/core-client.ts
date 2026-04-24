/**
 * `CoreClient` — transport-agnostic interface Brain (and any other
 * Core consumer) uses to reach Core.
 *
 * **Why this interface exists.** Dina has two build targets:
 *
 *   - Server (`apps/home-node-lite/`) — Core + Brain run as two
 *     separate Node processes. Brain reaches Core via signed HTTP
 *     (`HttpCoreTransport`), preserving the "Brain is an untrusted
 *     tenant" security boundary.
 *   - Mobile (`apps/mobile/`) — Core + Brain share one RN JS VM.
 *     Brain reaches Core via a direct in-process router dispatch
 *     (`InProcessTransport`) — no HTTP hop, no server required.
 *
 * Brain imports `CoreClient` (this interface) at compile time and
 * receives one of the two concrete transports at runtime via
 * dependency injection. Neither Brain source nor Brain tests ever
 * import `fetch`, `undici`, `ws`, `@fastify/*`, or any HTTP binding
 * directly — the CI gate in Phase 2 will enforce this.
 *
 * **Method shape.** Every method returns `Promise<T>` so the same
 * contract holds on mobile (where some adapters may be sync) and on
 * the server (where every call is an HTTP round-trip). Per the
 * async-everywhere port rule (Phase 2 task 2.8).
 *
 * This file is a scaffold — concrete methods enumerated progressively
 * per task 1.29. Implementations (`InProcessTransport`,
 * `HttpCoreTransport`) land in tasks 1.30 + 1.31 respectively; the
 * scaffold exists first so the Phase 1c lint/CI gate has a target.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.28.
 */

/**
 * Transport-agnostic Core client. Brain uses this as its only means of
 * reaching Core; concrete transports (`InProcessTransport`,
 * `HttpCoreTransport`) implement it and are injected at app assembly
 * time.
 *
 * Method surface grows per task 1.29 — intentionally sparse here to
 * validate the interface-injection pattern before expanding coverage.
 */
export interface CoreClient {
  /**
   * Sanity probe — returns Core's liveness + DID identity snapshot.
   * Used by Brain's startup retry loop to wait until Core is reachable
   * before declaring itself ready.
   */
  healthz(): Promise<CoreHealth>;

  // ─── Vault CRUD (task 1.29a) ──────────────────────────────────────────

  /**
   * Semantic + keyword-hybrid search across a persona's vault. `persona`
   * must be currently open for the caller (Brain's service-key is
   * authorised for standard-tier personas only unless a session grant
   * escalates it).
   */
  vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult>;

  /** Insert or upsert a vault item into the named persona's DB. */
  vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult>;

  /** Paginate a persona's vault. Omit filters for "everything newest first." */
  vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult>;

  /** Remove a vault item by id. No-op if the id doesn't exist. */
  vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult>;

  // ─── DID signing (task 1.29b) ─────────────────────────────────────────

  /**
   * Sign arbitrary bytes with Core's configured signing key. Used by
   * Brain when it needs an Ed25519 signature over a payload whose
   * canonical form Brain itself built (e.g., a PLC update).
   */
  didSign(payload: Uint8Array): Promise<SignResult>;

  /**
   * Sign a canonical HTTP-request string. Returns the 4-tuple of
   * `X-DID` / `X-Timestamp` / `X-Nonce` / `X-Signature` headers so
   * Brain can attach them verbatim to its outbound request. Core
   * builds the canonical string from the inputs per the
   * `@dina/protocol/canonical_sign` contract.
   */
  didSignCanonical(req: CanonicalSignRequest): Promise<SignedHeaders>;

  // ─── PII scrub / rehydrate (task 1.29c) ───────────────────────────────

  /**
   * Redact PII from user-visible text before it crosses the cloud LLM
   * boundary. Returns scrubbed text + a session token Brain can pass
   * back to `piiRehydrate` to restore the original entities.
   */
  piiScrub(text: string): Promise<PIIScrubResult>;

  /**
   * Reverse a prior `piiScrub` — replaces `{{ENTITY:n}}` placeholders
   * with the original values using the session token. Safe against
   * unknown/stale sessions (returns text unchanged).
   */
  piiRehydrate(sessionId: string, text: string): Promise<PIIRehydrateResult>;

  // ─── Notify (task 1.29d) ──────────────────────────────────────────────

  /**
   * Push a notification to the user via Core's WebSocket hub. Priority
   * controls routing per the Four Laws: fiduciary interrupts, solicited
   * respects quiet hours, engagement gets batched into the daily
   * briefing. Payload shape is caller-defined — Core forwards opaquely.
   */
  notify(notification: NotifyRequest): Promise<NotifyResult>;

  // ─── Persona gatekeeper (task 1.29e) ──────────────────────────────────

  /**
   * Report current state of a persona — which tier it's in, whether
   * it's currently open for the caller, and the live DEK hash fingerprint
   * Brain uses to detect re-unlock events. Never leaks the DEK itself.
   */
  personaStatus(persona: string): Promise<PersonaStatusResult>;

  /**
   * Unlock a sensitive/locked persona with the user's passphrase.
   * Runs Argon2id KDF inside Core and loads the DEK into memory until
   * the persona auto-locks (per tier config) or is explicitly closed.
   * Brain never sees the passphrase after this call returns.
   */
  personaUnlock(persona: string, passphrase: string): Promise<PersonaUnlockResult>;

  // ─── Service config + query (task 1.29f) ──────────────────────────────

  /**
   * Read the current local service configuration — capabilities this
   * node publishes, their schemas + schema-hashes, response policy.
   * Brain reloads this periodically (see CLAUDE.md "Provider-side
   * Brain reloads `service_config` periodically") and reads it at
   * ingest time to know which capabilities to validate against.
   *
   * Returns `null` when no config is set (Core responds 404). Callers
   * can treat that as "this node publishes no services yet" rather
   * than an error.
   */
  serviceConfig(): Promise<ServiceConfig | null>;

  /**
   * Upsert the local service configuration. Core validates the full
   * payload server-side + notifies subscribers via the
   * `config_changed` event channel on success. Throws on validation
   * failure so the UI can surface the exact error string.
   */
  putServiceConfig(config: ServiceConfig): Promise<void>;

  /**
   * Initiate a typed service query to a remote Dina. Creates a
   * workflow task, signs + sends the D2D envelope, returns the task
   * handle so Brain can correlate the response later.
   *
   * Idempotent by `(to_did, capability, canonical(params), schema_hash)` —
   * an in-flight duplicate returns `{deduped: true}` with the existing
   * task id instead of minting a new one.
   *
   * Pairs symmetrically with `sendServiceRespond(taskId, body)` — the
   * provider-side completion of the same workflow. Both names share
   * the `send…` prefix so the request/response pair reads naturally
   * at the callsite.
   */
  sendServiceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult>;

  // ─── Working-memory ToC (task 1.29g) ──────────────────────────────────

  /**
   * Read the current working-memory Table of Contents across one or
   * more unlocked personas. Brain's intent classifier reads this to
   * prime the LLM context ("what has this user been thinking about
   * lately") without scanning the full vault.
   *
   * Scope: omit `personas` to include every currently-open persona;
   * pass a subset to restrict (Core skips locked personas silently).
   * `limit` is clamped server-side at 200.
   */
  memoryToC(opts?: MemoryToCOptions): Promise<MemoryToCResult>;

  // ─── Staging inbox (task 1.29h / 1.32 preamble) ──────────────────────
  //
  // Brain's drain loop moves items received/classifying/stored through
  // Core's persistent inbox. These four methods are the wire between
  // the drain scheduler and Core's staging service. Legacy callers
  // (`BrainCoreClient.claim/resolve/fail/extendStagingLease`) migrate
  // to these during the task 1.32 refactor.

  /**
   * Atomically move up to `limit` `received` items to `classifying`
   * with a fresh lease. Returns the claimed payload envelope so Brain
   * can enrich + resolve without a second read round-trip.
   *
   * Re-claim of the SAME item before lease expiry is impossible by
   * design — the server skips leased rows.
   */
  stagingClaim(limit: number): Promise<StagingClaimResult>;

  /**
   * Store a staging item under one persona (legacy single-target path)
   * or fan out to every persona whose classifier score crossed the
   * threshold (GAP-MULTI-01: pass an array). On multi-target, Core
   * writes one vault row per persona; on single-target, one row.
   *
   * `personaOpen: false` routes the item to `pending_unlock` instead —
   * Brain uses this when a sensitive persona hasn't been unlocked yet.
   */
  stagingResolve(req: StagingResolveRequest): Promise<StagingResolveResult>;

  /**
   * Record a per-item processing failure. Increments retry counter;
   * Core decides whether to requeue or expire based on retry policy.
   * `reason` is free-form (logged for ops triage).
   */
  stagingFail(itemId: string, reason: string): Promise<StagingFailResult>;

  /**
   * Push the lease expiry out by `seconds` so a long-running classifier
   * doesn't lose its claim mid-enrichment. Idempotent — callers call
   * this on a timer.
   */
  stagingExtendLease(itemId: string, seconds: number): Promise<StagingExtendLeaseResult>;

  // ─── D2D messaging (task 1.29h / 1.32 preamble) ──────────────────────

  /**
   * Send a raw D2D (`Dina-to-Dina`) message through Core. Thin
   * authenticated wrapper over the shared `sendD2D` path used by the
   * Response Bridge — one signed egress path for every outbound
   * envelope. Low-level callers only; typed service queries go through
   * `serviceQuery()` instead.
   *
   * Core returns 503 when no sender is wired at startup (e.g. test
   * nodes without a relay); the transport surfaces that as a thrown
   * error so callers fail loudly rather than queueing into the void.
   */
  msgSend(req: MsgSendRequest): Promise<MsgSendResult>;

  // ─── Scratchpad (task 1.32 preamble) ──────────────────────────────────
  //
  // Multi-step reasoning checkpoints — Brain writes progress after
  // each LLM tool call so a crashed/backgrounded process can resume
  // without replaying work. Core persists the rows with TTL-driven
  // cleanup (24h stale window in-service). `step=0` is the delete
  // sentinel for Python parity.

  /**
   * Upsert a checkpoint for `taskId` at the given `step`. Overwrites
   * any prior row; preserves `createdAt` on update. `step=0` with a
   * sentinel `{__deleted:true}` context triggers a delete (legacy
   * Python compatibility — modern callers prefer `scratchpadClear`).
   */
  scratchpadCheckpoint(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
  ): Promise<ScratchpadCheckpointResult>;

  /**
   * Read the latest checkpoint for `taskId`, or `null` on missing /
   * stale / TTL-expired row. The read is lazy-evictive: a stale row
   * is returned as `null` AND deleted from the store in one hop.
   */
  scratchpadResume(taskId: string): Promise<ScratchpadEntry | null>;

  /**
   * Delete the checkpoint row for `taskId`. Idempotent — deleting an
   * unknown or already-deleted row is a no-op that still returns 2xx.
   */
  scratchpadClear(taskId: string): Promise<ScratchpadClearResult>;

  // ─── Service respond (task 1.32 slice A) ──────────────────────────────
  //
  // Requester side uses `serviceQuery()` above to kick off a D2D query.
  // Provider side uses `sendServiceRespond()` to tell Core: "an approval
  // task is done — atomically claim it, send the service.response D2D,
  // and mark the task complete in one round-trip." The provider Brain
  // never touches the workflow repo directly on this path — Core owns
  // the claim/rollback dance so concurrent dispatches don't double-send.
  //
  // Returns `alreadyProcessed: true` when the task was already
  // terminated on a retry (post-crash resume) so callers can skip UI
  // updates without inspecting HTTP status codes.
  sendServiceRespond(
    taskId: string,
    responseBody: ServiceRespondRequestBody,
  ): Promise<ServiceRespondResult>;

  // ─── Workflow events (task 1.32 slice B) ──────────────────────────────
  //
  // `WorkflowEventConsumer` in Brain polls `listWorkflowEvents(needsDeliveryOnly: true)`
  // on a cadence to fan completed workflow tasks into chat threads.
  // On successful delivery: `acknowledgeWorkflowEvent(id)`.
  // On failed delivery (e.g. UI thread unavailable): `failWorkflowEventDelivery(id)`
  // which pushes `next_delivery_at` forward so the consumer doesn't
  // hot-loop on the same failing event.

  /**
   * Read workflow events the delivery scheduler hasn't retired yet.
   * `needsDeliveryOnly: true` is the consumer's hot path — hides
   * acknowledged + not-yet-due events. `limit` is clamped server-side.
   * `since` filters by event id (strictly greater than).
   */
  listWorkflowEvents(opts?: ListWorkflowEventsOptions): Promise<WorkflowEvent[]>;

  /**
   * Mark an event as acknowledged so the delivery scheduler retires
   * it. Returns `true` on 200 success, `false` on 404 (unknown / already
   * acked) — non-exceptional so callers can retry idempotently without
   * try/catch noise.
   */
  acknowledgeWorkflowEvent(eventId: number): Promise<boolean>;

  /**
   * Consumer negative-ack — delivery attempt failed (UI unavailable,
   * thread-resolver rejected, etc). Core pushes `next_delivery_at` out
   * so subsequent `needs_delivery=true` reads honour backoff. Returns
   * `true` on 200, `false` on 404 (unknown event).
   */
  failWorkflowEventDelivery(
    eventId: number,
    opts?: FailWorkflowEventOptions,
  ): Promise<boolean>;

  // ─── Workflow tasks — reads + create (task 1.32 slice C) ──────────────

  /**
   * List workflow tasks filtered by kind + state. Both are required
   * (route rejects empty). `limit` defaults server-side to 100, caps
   * at 500. Returns `[]` for an empty match set rather than throwing.
   */
  listWorkflowTasks(filter: ListWorkflowTasksFilter): Promise<WorkflowTask[]>;

  /**
   * Fetch a single workflow task by id. Returns `null` on 404 (unknown
   * id) rather than throwing — matches the `serviceConfig` /
   * `scratchpadResume` / `acknowledgeWorkflowEvent` non-exceptional
   * null/false convention for "not found".
   */
  getWorkflowTask(id: string): Promise<WorkflowTask | null>;

  /**
   * Create a workflow task of any kind. On 201 returns the fresh task
   * with `deduped: false`; on 200 with a matching `idempotency_key`
   * returns the existing active task with `deduped: true`.
   *
   * On 409 (duplicate task id OR duplicate idempotency-key without an
   * active match) throws a typed `WorkflowConflictError` so callers
   * can pattern-match on `.code` without parsing the error string.
   */
  createWorkflowTask(input: CreateWorkflowTaskInput): Promise<CreateWorkflowTaskResult>;

  // ─── Workflow task state transitions (task 1.32 slice D) ──────────────

  /** POST /v1/workflow/tasks/:id/approve — pending_approval → queued. */
  approveWorkflowTask(id: string): Promise<WorkflowTask>;

  /** POST /v1/workflow/tasks/:id/cancel — any active state → cancelled. */
  cancelWorkflowTask(id: string, reason?: string): Promise<WorkflowTask>;

  /**
   * POST /v1/workflow/tasks/:id/complete — running → completed, stores
   * `result` JSON (the Response Bridge reads this to build service.response)
   * + `result_summary` for UI rendering.
   */
  completeWorkflowTask(
    id: string,
    result: string,
    resultSummary: string,
    agentDID?: string,
  ): Promise<WorkflowTask>;

  /** POST /v1/workflow/tasks/:id/fail — any state → failed with error message. */
  failWorkflowTask(id: string, errorMsg: string, agentDID?: string): Promise<WorkflowTask>;

  // ─── Working-memory + contacts (task 1.32 slice E) ────────────────────
  //
  // `memoryTouch` is WM-BRAIN-08's write-path — staging enrichment calls
  // it per extracted topic so the ToC salience formulas accumulate.
  // `updateContact` is PC-BRAIN-13's preference-binding write-path —
  // when the topic extractor surfaces a role hint like "my dentist
  // Dr Carl", the staging enrichment stamps `preferred_for: ['dental']`
  // on Dr Carl's contact row. Both are the last Brain-owned mutations
  // that still lived on `BrainCoreClient`; moving them onto `CoreClient`
  // closes the ingest-side Core surface for task 1.32.

  /**
   * Touch a topic in persona's working-memory Table of Contents.
   * Accumulates salience + records sample items so the ToC reflects
   * what the user has been thinking about. `sampleItemId` is optional —
   * omit to touch without linking a specific vault row.
   *
   * Returns `{status, canonical?, reason?}` — `status === 'skipped'`
   * when the persona is locked (server silently drops + reports the
   * reason); `status === 'ok'` on a successful touch. `canonical`
   * echoes the normalised topic name for cross-reference in logs.
   */
  memoryTouch(params: MemoryTouchParams): Promise<MemoryTouchResult>;

  /**
   * Mutate a contact's metadata. Currently exposes `preferredFor` only
   * — the preference list the resolver uses to match roles ("my dentist",
   * "my lawyer") to known contacts. Tri-state on the wire:
   *   - `undefined` → field omitted from body → server leaves it alone.
   *   - `[]` → field sent as `[]` → server clears it.
   *   - non-empty array → field sent verbatim → server normalises +
   *     writes.
   *
   * Throws on 404 (unknown contact) — callers that want non-exceptional
   * behaviour should pre-check with the contact directory.
   */
  updateContact(did: string, updates: UpdateContactParams): Promise<void>;

  /**
   * List contacts whose `preferred_for` list contains `category`.
   * Drives the `find_preferred_provider` tool + chat-thread resolver
   * for role mentions ("my dentist", "my lawyer"). Server normalises
   * category (trim + lowercase) so callers can pass raw user input.
   *
   * Returns `[]` on: empty / whitespace-only `category` (client-side
   * short-circuit), no match, transport failure (fail-soft so the
   * reasoning agent falls back to `search_provider_services`).
   */
  findContactsByPreference(category: string): Promise<Contact[]>;
}

/** Minimal identity snapshot Core reveals to a live-probe caller. */
export interface CoreHealth {
  /** Always `"ok"` on a healthy Core. Missing field signals malformed response. */
  status: 'ok';
  /** Core's did:plc or did:key identifier. */
  did: string;
  /** Core build version string (git SHA prefix or semver tag). */
  version: string;
}

// ─── Vault method types (task 1.29a) ─────────────────────────────────────
//
// Shapes deliberately narrow for now — future widening (task 1.29h)
// tightens them as Brain integration exercises real call-sites. The
// `unknown`-typed result payloads preserve router-level flexibility
// while forcing Brain to narrow explicitly at each callsite.

export interface VaultQuery {
  /** Free-text search term. */
  q?: string;
  /** Semantic-search vector (768-dim, embedding-model-specific). */
  embedding?: number[];
  /** Result limit; Core clamps to its own max. */
  limit?: number;
  /** Filter: vault-item type (e.g. `note`, `contact`, `relationship_note`). */
  type?: string;
}

export interface VaultQueryResult {
  /** Result rows — `unknown` until Phase 2 narrows to a typed VaultItem. */
  items: unknown[];
  /** Number of rows returned (mirrors `items.length`, distinct for UX). */
  count: number;
}

export interface VaultItemInput {
  type: string;
  /** Free-form JSON content — Core serialises on store. */
  content: unknown;
  /** Optional pre-computed embedding; Core embeds server-side if absent. */
  embedding?: number[];
  /** Source/ingest provenance for the audit trail. */
  source?: string;
}

export interface VaultStoreResult {
  id: string;
  storedAt: string;
}

export interface VaultListOptions {
  limit?: number;
  offset?: number;
  type?: string;
}

export interface VaultListResult {
  items: unknown[];
  count: number;
  total?: number;
}

export interface VaultDeleteResult {
  deleted: boolean;
}

// ─── DID-sign method types (task 1.29b) ──────────────────────────────────

export interface SignResult {
  /** Hex-encoded Ed25519 signature. */
  signature: string;
  /** DID Core signed with (matches Core's configured signing identity). */
  did: string;
}

export interface CanonicalSignRequest {
  method: string;
  path: string;
  query: string;
  /** Raw body bytes — hashed inside Core to produce the canonical string. */
  body: Uint8Array;
}

export interface SignedHeaders {
  /** `X-DID` header — Core's DID. */
  did: string;
  /** `X-Timestamp` header — RFC3339 timestamp. */
  timestamp: string;
  /** `X-Nonce` header — random hex. */
  nonce: string;
  /** `X-Signature` header — hex Ed25519 signature over the canonical string. */
  signature: string;
}

// ─── PII scrub / rehydrate types (task 1.29c) ───────────────────────────

export interface PIIScrubResult {
  /** Input text with PII replaced by `{{ENTITY:n}}` placeholders. */
  scrubbed: string;
  /** Session id Brain hands back to `piiRehydrate` to restore originals. */
  sessionId: string;
  /**
   * Number of entities scrubbed — lets callers log/observe without
   * accessing the raw entity list (which stays in Core's memory).
   */
  entityCount: number;
}

export interface PIIRehydrateResult {
  /** Text with `{{ENTITY:n}}` placeholders expanded to original values. */
  rehydrated: string;
  /**
   * Whether the session was found — `false` means placeholders were
   * left intact (stale/unknown session). Callers can warn + fall back.
   */
  sessionFound: boolean;
}

// ─── Notify method types (task 1.29d) ────────────────────────────────────

import type { NotifyPriority } from '@dina/protocol';
export type { NotifyPriority };

export interface NotifyRequest {
  /** Four-Laws priority level — drives routing + quiet-hours handling. */
  priority: NotifyPriority;
  /** Human-visible title. */
  title: string;
  /** Body text. Plain string; Core + clients own rendering. */
  body: string;
  /** Optional deep-link target — clients navigate here on tap. */
  deepLink?: string;
  /** Caller-defined metadata for client-side rendering / threading. */
  meta?: Record<string, unknown>;
}

export interface NotifyResult {
  /** Whether Core accepted the notification for delivery. */
  accepted: boolean;
  /** Server-assigned id Brain can use for later reference / dedup. */
  notificationId: string;
  /**
   * Number of currently-subscribed clients Core pushed to. Zero
   * means no paired device was listening — the notification was
   * accepted but won't surface until a client reconnects. For
   * `fiduciary` priority, callers should log this.
   */
  subscribers: number;
}

// ─── Persona method types (task 1.29e) ───────────────────────────────────

/** Four-tier gating level from the security model. */
export type PersonaTier = 'default' | 'standard' | 'sensitive' | 'locked';

export interface PersonaStatusResult {
  persona: string;
  tier: PersonaTier;
  /** `true` if the persona's DEK is currently in RAM. */
  open: boolean;
  /**
   * Short fingerprint of the currently-loaded DEK (e.g. first 8 hex
   * chars of `HKDF(DEK, "brain_ref")`). Stable across a single unlock
   * session; changes on re-unlock. Brain diffs this to detect
   * re-unlock events without seeing the DEK itself. `null` when the
   * persona is closed.
   */
  dekFingerprint: string | null;
  /** Unix seconds the persona was last opened. `null` if closed. */
  openedAt: number | null;
}

export interface PersonaUnlockResult {
  persona: string;
  /** `true` when the unlock succeeded. `false` = wrong passphrase etc. */
  unlocked: boolean;
  /** Same fingerprint shape as PersonaStatusResult. `null` on failure. */
  dekFingerprint: string | null;
  /** Reason code for failures — `null` on success. */
  error?: 'wrong_passphrase' | 'unknown_persona' | 'already_open' | 'rate_limited';
}

// ─── Service config + query method types (task 1.29f) ────────────────────

import type { ServiceConfig } from '@dina/protocol';
export type { ServiceConfig };

/**
 * Outbound service-query request shape Brain hands to Core's
 * `/v1/service/query`. Mirrors the route validator's expected body
 * (see `packages/core/src/server/routes/service_query.ts`).
 */
export interface ServiceQueryClientRequest {
  /** Recipient DID (`did:plc:…` / `did:key:…`). */
  toDID: string;
  /** Capability name the recipient publishes (e.g. `eta_query`). */
  capability: string;
  /** Query id Brain mints — used for correlation when the response lands. */
  queryId: string;
  /** Capability params (JSON object — validator rejects arrays / primitives). */
  params: Record<string, unknown>;
  /** Lifetime on the wire + reservation window, seconds. Clamped server-side. */
  ttlSeconds: number;
  /** Optional human-readable name for the target service (logging only). */
  serviceName?: string;
  /** Optional origin-channel tag for request provenance (logging only). */
  originChannel?: string;
  /**
   * Optional schema-hash pin. When set, the provider rejects the
   * query if its current schema has drifted — lets Brain refresh its
   * capability cache before retrying.
   */
  schemaHash?: string;
}

export interface ServiceQueryResult {
  /** Workflow task id Core created for this query. */
  taskId: string;
  /** Echo of the requester's query id — handy for log correlation. */
  queryId: string;
  /**
   * `true` when an already-in-flight query with matching idempotency
   * key was returned; `false` / `undefined` when a fresh task was
   * created. Brain uses this to avoid double-counting in UX.
   */
  deduped?: boolean;
}

// ─── Memory ToC method types (task 1.29g) ───────────────────────────────

/** Import via relative path — TocEntry lives in core's memory domain. */
import type { TocEntry } from '../memory/domain';
export type { TocEntry };

export interface MemoryToCOptions {
  /**
   * Restrict to these personas. Omit (or pass empty) to walk every
   * currently-unlocked persona. Locked personas are silently skipped.
   */
  personas?: string[];
  /** Row count cap; server clamps to 200. Default 50. */
  limit?: number;
}

export interface MemoryToCResult {
  /**
   * Ranked topic rows with salience decayed to the moment Core read
   * them. Sorted by salience descending. Cross-persona — row.persona
   * distinguishes the origin.
   */
  entries: TocEntry[];
  /** Echoes the effective server-side limit after clamping. */
  limit: number;
}

// ─── Staging method types (task 1.29h / 1.32 preamble) ───────────────────
//
// Item payloads stay `unknown[]` rather than re-exporting the full
// `StagingItem` shape. Drain callers already narrow each row at runtime
// (pulling fields out of `item.data` via `pickString`); widening the
// client contract later is cheaper than tightening it.

export interface StagingClaimResult {
  /** Claimed item envelopes — opaque rows; callers narrow per row. */
  items: unknown[];
  /** Mirrors `items.length` — server emits both for UX. */
  count: number;
}

export interface StagingResolveRequest {
  /** Staging inbox row id (Core's `id` field on the envelope). */
  itemId: string;
  /**
   * Target persona(s). A string is the legacy single-persona resolve
   * path; an array opts into GAP-MULTI-01 fan-out (Core writes one
   * vault row per persona). Empty array or empty string triggers Core's
   * 400 — callers must pre-filter.
   */
  persona: string | string[];
  /** Vault row payload to persist (usually the enriched item). */
  data: Record<string, unknown>;
  /**
   * Whether the target persona(s) are unlocked. Defaults `true` on the
   * wire; pass `false` to route the item to `pending_unlock`.
   */
  personaOpen?: boolean;
}

export interface StagingResolveResult {
  /** Echoes the resolved item id. */
  itemId: string;
  /** New staging status (`stored`, `pending_unlock`, etc). */
  status: string;
  /**
   * Populated when resolve fanned out. Omitted on legacy single-persona
   * resolve so callers can distinguish the two paths without re-sending
   * their input.
   */
  personas?: string[];
}

export interface StagingFailResult {
  /** Echoes the failed item id. */
  itemId: string;
  /** New retry counter — callers compare to policy to log exhaustion. */
  retryCount: number;
}

export interface StagingExtendLeaseResult {
  /** Echoes the item id whose lease was extended. */
  itemId: string;
  /** Seconds the lease was pushed forward (echoes the request). */
  extendedBySeconds: number;
}

// ─── D2D messaging types (task 1.29h / 1.32 preamble) ───────────────────

export interface MsgSendRequest {
  /** Recipient Dina DID (`did:plc:…` / `did:key:…`). */
  recipientDID: string;
  /**
   * Dina message type string (`service.query`, `service.response`,
   * plain `text`, …). Caller-defined; Core doesn't interpret.
   */
  messageType: string;
  /** JSON payload — Core signs + seals, never peeks inside. */
  body: Record<string, unknown>;
}

export interface MsgSendResult {
  /** Always `true` on a 2xx (success is binary here — throw on failure). */
  ok: true;
}

// ─── Scratchpad types (task 1.32 preamble) ──────────────────────────────

/**
 * A single checkpoint row persisted under `taskId`. Matches Python's
 * scratchpad semantics: `step=0` on write deletes; read never returns
 * `step=0` (would be a non-existent delete sentinel).
 */
export interface ScratchpadEntry {
  taskId: string;
  /** Logical step number — monotonic per task, caller-defined. */
  step: number;
  /** Caller-defined JSON context — Core stores opaquely. */
  context: Record<string, unknown>;
  /** Unix milliseconds the row was first written. Stable across updates. */
  createdAt: number;
  /** Unix milliseconds the row was most-recently written. */
  updatedAt: number;
}

export interface ScratchpadCheckpointResult {
  /** Echoes the taskId so callers confirm what was persisted. */
  taskId: string;
  /** Echoes the step. `0` indicates the delete-sentinel path fired. */
  step: number;
}

export interface ScratchpadClearResult {
  /** Echoes the cleared taskId — confirmation the clear reached Core. */
  taskId: string;
}

// ─── Service-respond types (task 1.32 slice A) ─────────────────────────

/** Response-body wire shape — matches the `/v1/service/respond` route
 *  validator in `server/routes/service_respond.ts`. */
export interface ServiceRespondRequestBody {
  status: 'success' | 'unavailable' | 'error';
  /** Populated on `status === 'success'`. Opaque JSON — Core forwards. */
  result?: unknown;
  /** Populated on non-success to explain the failure. */
  error?: string;
}

export interface ServiceRespondResult {
  /** `'sent'` on fresh send; `current.status` when the task had already
   *  terminated (e.g. `completed`, `failed`, `'recovered'` on the
   *  post-crash bridge-pending path). */
  status: string;
  /** Echoes the taskId so callers confirm what was responded. */
  taskId: string;
  /** `true` when Core detected a retry against an already-terminal task.
   *  Callers use this to skip UI "sent!" toasts on the retry. */
  alreadyProcessed: boolean;
}

// ─── Workflow-event types (task 1.32 slice B) ──────────────────────────

/** Re-export from core's workflow domain — the event shape is already
 *  authoritative there; Brain consumers just need the type name. */
import type { WorkflowEvent } from '../workflow/domain';
export type { WorkflowEvent };

export interface ListWorkflowEventsOptions {
  /** Filter: return only events with id strictly greater than this. */
  since?: number;
  /** Cap on row count; server clamps. */
  limit?: number;
  /**
   * When `true`, restrict to events the consumer hasn't acked and that
   * are past their `next_delivery_at` backoff. Default `false` returns
   * the full audit/diagnostics stream.
   */
  needsDeliveryOnly?: boolean;
}

export interface FailWorkflowEventOptions {
  /**
   * Floor for the next delivery attempt, Unix ms. Core default is
   * `now + 30s` when omitted; passing a larger value lets the consumer
   * suggest a longer back-off (e.g. for a terminally-failing thread).
   */
  nextDeliveryAt?: number;
  /** Optional human-readable reason — logged for operator triage. */
  error?: string;
}

// ─── Workflow-task types (task 1.32 slices C + D) ──────────────────────

/** Re-export the workflow domain types + typed errors so Brain consumers
 *  can keep all their CoreClient-adjacent imports on `@dina/core` without
 *  deep-importing into `workflow/service` or `workflow/repository`. */
import type { WorkflowTask } from '../workflow/domain';
import type { CreateWorkflowTaskInput } from '../workflow/service';
import {
  WorkflowConflictError,
  WorkflowValidationError,
  WorkflowTransitionError,
} from '../workflow/service';
export type { WorkflowTask, CreateWorkflowTaskInput };
export { WorkflowConflictError, WorkflowValidationError, WorkflowTransitionError };

export interface ListWorkflowTasksFilter {
  /** Required — one of the `WorkflowTaskKind` values (e.g. `service_query`). */
  kind: string;
  /** Required — one of the `WorkflowTaskState` values (e.g. `pending_approval`). */
  state: string;
  /** Row cap; server defaults 100 / clamps 500. */
  limit?: number;
}

export interface CreateWorkflowTaskResult {
  /** The stored task — authoritative shape comes back from the server. */
  task: WorkflowTask;
  /**
   * `true` when the server returned an existing task matching the
   * caller's `idempotency_key`. `false` on a freshly-created row.
   * Callers use this to suppress duplicate "created!" toasts on retry.
   */
  deduped: boolean;
}

// ─── Memory + contact types (task 1.32 slice E) ─────────────────────────

/** Re-export TopicKind so Brain consumers import memory-touch params
 *  from `@dina/core` without a second deep-import. */
import type { TopicKind } from '../memory/domain';
export type { TopicKind };

export interface MemoryTouchParams {
  /** Persona whose ToC we're mutating. Locked persona → server skips. */
  persona: string;
  /** Topic label — server canonicalises (lowercased, trimmed, alias-merged). */
  topic: string;
  /** `entity` (named thing) or `theme` (abstract subject). */
  kind: TopicKind;
  /** Optional vault item id to link as a sample. Omit to touch without
   *  attaching a sample (WM-BRAIN-08 acceptance path for bulk topic
   *  extraction that doesn't pin specific rows). */
  sampleItemId?: string;
}

export interface MemoryTouchResult {
  /** `'ok'` on a successful touch; `'skipped'` when the persona is
   *  locked (server drops silently + emits the reason). */
  status: 'ok' | 'skipped';
  /** Server's canonicalised topic name — useful for cross-referencing
   *  in ingest audit logs. */
  canonical?: string;
  /** Diagnostic reason populated when `status === 'skipped'`. */
  reason?: string;
}

/** Re-export `Contact` so consumers find it on `@dina/core`'s public
 *  barrel without deep-importing from `contacts/directory`. */
import type { Contact } from '../contacts/directory';
export type { Contact };

export interface UpdateContactParams {
  /**
   * Preferred-for categories (the contact resolver uses these to match
   * role mentions). Tri-state: `undefined` = no-op on server, `[]` =
   * clear, non-empty array = replace. Server normalises (lowercased +
   * trimmed + deduped) so callers can pass raw strings.
   */
  preferredFor?: string[];
}
