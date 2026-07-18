/**
 * Owner-only interactive-run control client (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §12.5). This is the net-new OWNER dispatch — a REAL boundary, not
 * `trustedInProcess`. It is deliberately a SEPARATE client from the
 * Brain-shared `CoreClient`/`InProcessTransport`: the owner UI holds an
 * `InProcessOwnerRunClient`, Brain does not, so Brain literally has no reference
 * to a dispatch that stamps `callerType: 'owner'`. Every request it emits is
 * marked owner; the `/v1/run/*` handlers reject any other caller.
 */

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

export interface RunUpdateRequest {
  config_version: number;
  interval_ms?: number;
  queue_cap?: number;
  muted?: boolean;
  priority_ceiling?: string;
  provider_grant_id?: string | null;
}

export interface RunDecideRequest {
  message_id: string;
  decision: 'approve' | 'deny' | 'acknowledge';
}

/** The owner-only run-control surface. */
export interface OwnerRunClient {
  runStart(req: RunStartRequest): Promise<RunStartResult>;
  runPause(runId: string): Promise<{ state: string }>;
  runResume(runId: string): Promise<{ state: string }>;
  runStop(runId: string, onStop?: string): Promise<{ state: string }>;
  runUpdate(runId: string, req: RunUpdateRequest): Promise<{ config_version: number }>;
  runDecide(runId: string, req: RunDecideRequest): Promise<{ state: string; decision_revision: number }>;
  runStatus(runId: string): Promise<Record<string, unknown>>;
  // Poll-mode watch management (PSVC-4) — same owner boundary.
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

function ownerRequest(overrides: Partial<CoreRequest>): CoreRequest {
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
    // /v1/run/* handlers admit it and reject every other caller (§12.5).
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
export class InProcessOwnerRunClient implements OwnerRunClient {
  constructor(private readonly router: CoreRouter) {}

  async runStart(req: RunStartRequest): Promise<RunStartResult> {
    const res = await this.router.handle(ownerRequest({ method: 'POST', path: '/v1/run/start', body: req }));
    return expectOk<RunStartResult>(res, 'runStart');
  }
  async runPause(runId: string): Promise<{ state: string }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/run/${runId}/pause`, body: {} }),
    );
    return expectOk<{ state: string }>(res, 'runPause');
  }
  async runResume(runId: string): Promise<{ state: string }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/run/${runId}/resume`, body: {} }),
    );
    return expectOk<{ state: string }>(res, 'runResume');
  }
  async runStop(runId: string, onStop?: string): Promise<{ state: string }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/run/${runId}/stop`, body: onStop !== undefined ? { on_stop: onStop } : {} }),
    );
    return expectOk<{ state: string }>(res, 'runStop');
  }
  async runUpdate(runId: string, req: RunUpdateRequest): Promise<{ config_version: number }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/run/${runId}/update`, body: req }),
    );
    return expectOk<{ config_version: number }>(res, 'runUpdate');
  }
  async runDecide(
    runId: string,
    req: RunDecideRequest,
  ): Promise<{ state: string; decision_revision: number }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/run/${runId}/decide`, body: req }),
    );
    return expectOk<{ state: string; decision_revision: number }>(res, 'runDecide');
  }
  async runStatus(runId: string): Promise<Record<string, unknown>> {
    const res = await this.router.handle(
      ownerRequest({ method: 'GET', path: `/v1/run/${runId}/status` }),
    );
    return expectOk<Record<string, unknown>>(res, 'runStatus');
  }

  async watchList(): Promise<{ watches: WatchListItem[] }> {
    const res = await this.router.handle(ownerRequest({ method: 'GET', path: '/v1/watch/list' }));
    return expectOk<{ watches: WatchListItem[] }>(res, 'watchList');
  }
  async watchPause(watchId: string): Promise<{ ok: boolean }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/watch/${watchId}/pause`, body: {} }),
    );
    return expectOk<{ ok: boolean }>(res, 'watchPause');
  }
  async watchResume(watchId: string): Promise<{ ok: boolean }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/watch/${watchId}/resume`, body: {} }),
    );
    return expectOk<{ ok: boolean }>(res, 'watchResume');
  }
  async watchCancel(watchId: string): Promise<{ ok: boolean }> {
    const res = await this.router.handle(
      ownerRequest({ method: 'POST', path: `/v1/watch/${watchId}/cancel`, body: {} }),
    );
    return expectOk<{ ok: boolean }>(res, 'watchCancel');
  }
}
