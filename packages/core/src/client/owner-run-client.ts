/**
 * Owner-only interactive-run control client (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §12.5). This is the net-new OWNER dispatch — a REAL boundary, not
 * `trustedInProcess`. It is deliberately a SEPARATE client from the
 * Brain-shared `CoreClient`/`InProcessTransport`: the owner UI holds an
 * `InProcessOwnerRunClient`, Brain does not, so Brain literally has no reference
 * to a dispatch that stamps `callerType: 'owner'`. Every request it emits is
 * marked owner; the `/v1/run/*` handlers reject any other caller.
 */

import type { ReasoningSubmission } from '../reasoning/broker';
import type {
  ReasoningAvailability,
  ReasoningBackendKind,
  ReasoningSensitivity,
  ReasoningTaskKind,
} from '../reasoning/domain';
import type { OwnerReasoningJobView } from '../reasoning/job_projection';
import type { RunListItem } from '../run/list';
import type { CoreRequest, CoreResponse, CoreRouter } from '../server/router';
import type { WatchListItem } from '../watch/list';

export interface RunStartRequest {
  service_uri: string;
  provider_did: string;
  persona: string;
  idempotency_key: string;
  ttl_seconds?: number;
  expires_at?: number;
  transport?: string;
  provider_grant_id?: string;
  /** The bound grant's expiry (unix seconds) — persisted so the pacer can
   *  fetch-pause a lapsed grant (§10). `null`/omitted = non-expiring. */
  provider_grant_expires_at_sec?: number | null;
  interval_ms?: number;
  queue_cap?: number;
  action_risk_ceiling?: string;
  priority_ceiling?: string;
  classify_timeout_ms?: number;
  muted?: boolean;
  on_stop?: string;
  max_count?: number;
  max_count_basis?: string;
  stop_on_exhaustion?: boolean;
  drain_deadline_ms?: number;
}

export interface RunStartResult {
  run_id: string;
  config_version: number;
  transport: string;
  erasure_mode: string;
  effective_erasure_mode: string;
}

/** #7 — owner-initiated poll-mode watch creation. `subscription_id` is the stable
 *  idempotency key (a replayed create returns the existing watch). */
export interface WatchCreateRequest {
  subscription_id: string;
  persona: string;
  service_uri: string;
  provider_did: string;
  capability: string;
  poll_interval_sec: number;
  query?: Record<string, unknown>;
  /** The provider's published schema hash, pinned from discovery. Forwarded on
   *  every poll so a schema-publishing provider accepts it (GAP-SH-01). Omit
   *  when the provider advertises no schema. */
  schema_hash?: string;
  /** The provider's declared freshness (`defaultTtlSeconds`), pinned from
   *  discovery. Floors the poll interval so it never polls faster than the data
   *  changes. Omit when unknown. */
  freshness_sec?: number;
  condition?: string;
  /** R2-04 — optional executable wake filter: only notify when a poll result
   *  contains this (case-insensitive) substring (else the watch stays silent). */
  filter?: { contains: string };
}

export interface WatchCreateResult {
  watch_id: string;
  subscription_id: string;
  watch?: WatchListItem;
}

export interface RunUpdateRequest {
  config_version: number;
  interval_ms?: number;
  queue_cap?: number;
  muted?: boolean;
  priority_ceiling?: string;
  provider_grant_id?: string | null;
  /** The REPLACEMENT grant's expiry (unix seconds) on a rebind (§10) — carried
   *  with the id so Core revalidates against the new binding, not a stale one.
   *  Explicit `null` = intentionally non-expiring; omitting it while rebinding a
   *  real grant is rejected (must be explicit). */
  provider_grant_expires_at_sec?: number | null;
  /** Optional durable-idempotency token (§12.5): a replayed update with the same
   *  key returns the stored response instead of a spurious config_version 409. */
  idempotency_key?: string;
}

export interface RunDecideRequest {
  message_id: string;
  decision: 'approve' | 'deny' | 'acknowledge';
  /** REQUIRED optimistic-concurrency token (§12.5): the `decision_revision` the
   *  owner UI rendered (carried in the `/status` pending card). A stale card whose
   *  revision moved on is rejected, so an obsolete decision can never authorize a
   *  message. */
  decision_revision: number;
}

export interface OwnerReasoningSubmitRequest {
  task_kind: ReasoningTaskKind;
  input: unknown;
  idempotency_key: string;
  purpose?: string;
  backend_id?: string | null;
  personas?: string[];
  limit?: number;
  public_evidence_sources?: ('review' | 'service')[];
}

export interface OwnerReasoningSubmitResult {
  submission: ReasoningSubmission;
  job: OwnerReasoningJobView | null;
  restricted_personas: {
    persona: string;
    status: 'pending_approval' | 'denied' | 'locked' | 'unavailable';
    taskId?: string;
  }[];
  unavailable_sources: ('review' | 'service')[];
}

/**
 * Owner-safe projection of a configured reasoning backend.
 *
 * This mirrors the owner route's snake-case wire contract and deliberately
 * excludes worker credentials, sessions, claims, and context tickets.
 */
export interface OwnerReasoningBackendView {
  backend_id: string;
  kind: ReasoningBackendKind;
  principal_did: string;
  allowed_task_kinds: ReasoningTaskKind[];
  max_sensitivity: ReasoningSensitivity;
  availability: ReasoningAvailability;
  model_class: string | null;
  policy_version: number;
  selected_by_owner_did: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface OwnerReasoningBackendRegisterRequest {
  backend_id: string;
  kind: ReasoningBackendKind;
  principal_did: string;
  allowed_task_kinds: ReasoningTaskKind[];
  max_sensitivity: ReasoningSensitivity;
  availability: ReasoningAvailability;
  model_class?: string | null;
  expires_at: number | null;
  expected_version: number | null;
}

export interface OwnerReasoningClient {
  reasoningBackends(): Promise<{ backends: OwnerReasoningBackendView[] }>;
  reasoningRegisterBackend(
    req: OwnerReasoningBackendRegisterRequest,
  ): Promise<OwnerReasoningBackendView>;
  reasoningRevokeBackend(backendId: string, expectedVersion: number): Promise<{ ok: true }>;
  reasoningSubmit(req: OwnerReasoningSubmitRequest): Promise<OwnerReasoningSubmitResult>;
  reasoningList(limit?: number): Promise<{ jobs: OwnerReasoningJobView[] }>;
  reasoningGet(taskId: string): Promise<{ job: OwnerReasoningJobView }>;
  reasoningCancel(taskId: string, reason?: string): Promise<{ ok: boolean }>;
}

/** The owner-only run-control surface. */
export interface OwnerRunClient {
  runList(): Promise<{ runs: RunListItem[] }>;
  runStart(req: RunStartRequest): Promise<RunStartResult>;
  runPause(runId: string): Promise<{ state: string }>;
  runResume(runId: string): Promise<{ state: string }>;
  runStop(runId: string, onStop?: string): Promise<{ state: string }>;
  runUpdate(runId: string, req: RunUpdateRequest): Promise<{ config_version: number }>;
  runDecide(
    runId: string,
    req: RunDecideRequest,
  ): Promise<{ state: string; decision_revision: number }>;
  /** Owner confirm of a MODERATE/HIGH action: `risk_pending → risk_authorized` (E76-08). */
  confirmRisk(runId: string, messageId: string): Promise<{ state: string; authorized: boolean }>;
  /** R5-01/§7 — give up on a `response_lost` slot (terminal `skipped`; fetch
   *  resumes once no lost slot remains). */
  skipLost(
    runId: string,
    reservationId: string,
  ): Promise<{ reservation_id: string; state: string; fetch_resumed: boolean }>;
  runStatus(runId: string): Promise<Record<string, unknown>>;
  // Poll-mode watch management (PSVC-4) — same owner boundary.
  watchCreate(req: WatchCreateRequest): Promise<WatchCreateResult>;
  watchList(): Promise<{ watches: WatchListItem[] }>;
  watchPause(watchId: string): Promise<{ ok: boolean }>;
  watchResume(watchId: string): Promise<{ ok: boolean }>;
  watchCancel(watchId: string): Promise<{ ok: boolean }>;
}

export class OwnerRunHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'OwnerRunHttpError';
  }
}

function buildOwnerReq(overrides: Partial<CoreRequest>): CoreRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    // The owner marker — set ONLY by this dedicated dispatch. Combined with
    // trustedInProcess (so the auth pipeline is skipped in-process), the
    // /v1/run/* handlers admit it. The unforgeable `ownerCapability` (stamped by
    // the client's `stampReq`) is what the route guard actually verifies (§12.5,
    // F15) — `callerType:'owner'` alone is forgeable by co-resident code.
    trustedInProcess: true,
    callerType: 'owner',
    ...overrides,
  };
}

function expectOk<T>(res: CoreResponse, ctx: string): T {
  if (res.status < 200 || res.status >= 300) {
    const err = (res.body as { error?: string; reason?: string } | undefined)?.error ?? 'error';
    throw new OwnerRunHttpError(`OwnerRunClient: ${ctx} failed ${res.status} — ${err}`, res.status);
  }
  return res.body as T;
}

/** In-process implementation — dispatches owner-marked requests through the
 *  CoreRouter. Wired only to the owner UI. */
export class InProcessOwnerRunClient implements OwnerRunClient, OwnerReasoningClient {
  private seq = 0;
  private readonly boot: string;
  /**
   * @param router  the Core router (shared with Brain's in-process transport)
   * @param ownerCapability  the boot-minted owner secret (F15). The app mints it,
   *   passes the SAME value to `createCoreRouter({ ownerCapability })`, and holds it
   *   only here + in that closure. Brain, lacking the secret, cannot forge an owner
   *   call even though it can construct this class. A missing/empty capability makes
   *   every request fail the (fail-closed) route guard.
   */
  constructor(
    private readonly router: CoreRouter,
    private readonly ownerCapability: string,
  ) {
    // A per-instance prefix so keys are unique across app launches; the monotonic
    // counter makes each command's key distinct. Every owner MUTATION carries one
    // so it is durably receipted (§12.5) — the route rejects a keyless mutation.
    this.boot = Date.now().toString(36);
  }
  private nextKey(): string {
    return `owner-${this.boot}-${(++this.seq).toString(36)}`;
  }
  /** Build an owner request with the unforgeable capability stamped on (F15). */
  private stampReq(overrides: Partial<CoreRequest>): CoreRequest {
    return buildOwnerReq({ ...overrides, ownerCapability: this.ownerCapability });
  }

  async runList(): Promise<{ runs: RunListItem[] }> {
    const res = await this.router.handle(this.stampReq({ method: 'GET', path: '/v1/run/list' }));
    return expectOk<{ runs: RunListItem[] }>(res, 'runList');
  }

  async reasoningBackends(): Promise<{ backends: OwnerReasoningBackendView[] }> {
    const res = await this.router.handle(
      this.stampReq({ method: 'GET', path: '/v1/reasoning/backends' }),
    );
    return expectOk<{ backends: OwnerReasoningBackendView[] }>(res, 'reasoningBackends');
  }

  async reasoningRegisterBackend(
    req: OwnerReasoningBackendRegisterRequest,
  ): Promise<OwnerReasoningBackendView> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: '/v1/reasoning/backends/register',
        body: req,
      }),
    );
    return expectOk<OwnerReasoningBackendView>(res, 'reasoningRegisterBackend');
  }

  async reasoningRevokeBackend(backendId: string, expectedVersion: number): Promise<{ ok: true }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/reasoning/backends/${encodeURIComponent(backendId)}/revoke`,
        body: { expected_version: expectedVersion },
      }),
    );
    expectOk<null>(res, 'reasoningRevokeBackend');
    return { ok: true };
  }

  async reasoningSubmit(req: OwnerReasoningSubmitRequest): Promise<OwnerReasoningSubmitResult> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: '/v1/owner/reasoning/jobs',
        body: req,
      }),
    );
    return expectOk<OwnerReasoningSubmitResult>(res, 'reasoningSubmit');
  }

  async reasoningList(limit?: number): Promise<{ jobs: OwnerReasoningJobView[] }> {
    const query: Record<string, string> = limit === undefined ? {} : { limit: String(limit) };
    const res = await this.router.handle(
      this.stampReq({
        method: 'GET',
        path: '/v1/owner/reasoning/jobs',
        query,
      }),
    );
    return expectOk<{ jobs: OwnerReasoningJobView[] }>(res, 'reasoningList');
  }

  async reasoningGet(taskId: string): Promise<{ job: OwnerReasoningJobView }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'GET',
        path: `/v1/owner/reasoning/jobs/${encodeURIComponent(taskId)}`,
      }),
    );
    return expectOk<{ job: OwnerReasoningJobView }>(res, 'reasoningGet');
  }

  async reasoningCancel(taskId: string, reason?: string): Promise<{ ok: boolean }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/owner/reasoning/${encodeURIComponent(taskId)}/cancel`,
        body: reason === undefined ? {} : { reason },
      }),
    );
    return expectOk<{ ok: boolean }>(res, 'reasoningCancel');
  }
  async runStart(req: RunStartRequest): Promise<RunStartResult> {
    // `start` already carries the run's `idempotency_key` — it IS the command key.
    const res = await this.router.handle(
      this.stampReq({ method: 'POST', path: '/v1/run/start', body: req }),
    );
    return expectOk<RunStartResult>(res, 'runStart');
  }
  async runPause(runId: string): Promise<{ state: string }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/run/${runId}/pause`,
        body: { idempotency_key: this.nextKey() },
      }),
    );
    return expectOk<{ state: string }>(res, 'runPause');
  }
  async runResume(runId: string): Promise<{ state: string }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/run/${runId}/resume`,
        body: { idempotency_key: this.nextKey() },
      }),
    );
    return expectOk<{ state: string }>(res, 'runResume');
  }
  async runStop(runId: string, onStop?: string): Promise<{ state: string }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/run/${runId}/stop`,
        body: {
          idempotency_key: this.nextKey(),
          ...(onStop !== undefined ? { on_stop: onStop } : {}),
        },
      }),
    );
    return expectOk<{ state: string }>(res, 'runStop');
  }
  async runUpdate(runId: string, req: RunUpdateRequest): Promise<{ config_version: number }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/run/${runId}/update`,
        body: { idempotency_key: this.nextKey(), ...req },
      }),
    );
    return expectOk<{ config_version: number }>(res, 'runUpdate');
  }
  async runDecide(
    runId: string,
    req: RunDecideRequest,
  ): Promise<{ state: string; decision_revision: number }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/run/${runId}/decide`,
        body: { idempotency_key: this.nextKey(), ...req },
      }),
    );
    return expectOk<{ state: string; decision_revision: number }>(res, 'runDecide');
  }
  async confirmRisk(
    runId: string,
    messageId: string,
  ): Promise<{ state: string; authorized: boolean }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/run/${runId}/confirm-risk`,
        body: { message_id: messageId, idempotency_key: this.nextKey() },
      }),
    );
    return expectOk<{ state: string; authorized: boolean }>(res, 'confirmRisk');
  }
  async skipLost(
    runId: string,
    reservationId: string,
  ): Promise<{ reservation_id: string; state: string; fetch_resumed: boolean }> {
    const res = await this.router.handle(
      this.stampReq({
        method: 'POST',
        path: `/v1/run/${runId}/skip-lost`,
        body: { reservation_id: reservationId, idempotency_key: this.nextKey() },
      }),
    );
    return expectOk<{ reservation_id: string; state: string; fetch_resumed: boolean }>(
      res,
      'skipLost',
    );
  }
  async runStatus(runId: string): Promise<Record<string, unknown>> {
    const res = await this.router.handle(
      this.stampReq({ method: 'GET', path: `/v1/run/${runId}/status` }),
    );
    return expectOk<Record<string, unknown>>(res, 'runStatus');
  }

  async watchCreate(req: WatchCreateRequest): Promise<WatchCreateResult> {
    // `subscription_id` IS the idempotency key (createPollWatch dedups on it).
    const res = await this.router.handle(
      this.stampReq({ method: 'POST', path: '/v1/watch/create', body: req }),
    );
    return expectOk<WatchCreateResult>(res, 'watchCreate');
  }
  async watchList(): Promise<{ watches: WatchListItem[] }> {
    const res = await this.router.handle(this.stampReq({ method: 'GET', path: '/v1/watch/list' }));
    return expectOk<{ watches: WatchListItem[] }>(res, 'watchList');
  }
  async watchPause(watchId: string): Promise<{ ok: boolean }> {
    const res = await this.router.handle(
      this.stampReq({ method: 'POST', path: `/v1/watch/${watchId}/pause`, body: {} }),
    );
    return expectOk<{ ok: boolean }>(res, 'watchPause');
  }
  async watchResume(watchId: string): Promise<{ ok: boolean }> {
    const res = await this.router.handle(
      this.stampReq({ method: 'POST', path: `/v1/watch/${watchId}/resume`, body: {} }),
    );
    return expectOk<{ ok: boolean }>(res, 'watchResume');
  }
  async watchCancel(watchId: string): Promise<{ ok: boolean }> {
    const res = await this.router.handle(
      this.stampReq({ method: 'POST', path: `/v1/watch/${watchId}/cancel`, body: {} }),
    );
    return expectOk<{ ok: boolean }>(res, 'watchCancel');
  }
}

// NOTE: there is deliberately NO owner-client singleton in `@dina/core` (R2-08).
// A module-global getter here would be importable by Brain on the shared mobile
// JS VM, handing it an owner-stamping dispatcher and defeating the owner boundary.
// The instance is held at the trusted app edge instead
// (`apps/mobile/src/services/owner_run_client.ts`); constructing this class needs
// the raw CoreRouter, which Brain never receives.
