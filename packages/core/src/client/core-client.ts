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
   * Initiate a typed service query to a remote Dina. Creates a
   * workflow task, signs + sends the D2D envelope, returns the task
   * handle so Brain can correlate the response later.
   *
   * Idempotent by `(to_did, capability, canonical(params), schema_hash)` —
   * an in-flight duplicate returns `{deduped: true}` with the existing
   * task id instead of minting a new one.
   */
  serviceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult>;

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
