/**
 * In-process `CoreClient` transport — dispatches directly through the
 * `CoreRouter` without any HTTP hop.
 *
 * Used by the mobile build target (`apps/mobile/`) where Core + Brain
 * share one RN JS VM. The server build target uses `HttpCoreTransport`
 * instead (lives in `apps/home-node-lite/brain-server/`).
 *
 * Both transports implement the same `CoreClient` interface so Brain
 * code is identical across targets; only the DI wiring differs.
 *
 * **Auth note.** Direct router dispatch bypasses the Ed25519 signing
 * step. That's correct for the mobile case where Brain is in the same
 * process as Core — signing yourself with keys you already own adds
 * no security. The router's `authenticateRequest` pipeline is skipped
 * via handler registration under `auth: 'public'` or (for sensitive
 * routes) by passing pre-authorised headers that mark the request as
 * trusted-local. Sensitive-persona protection still runs via the
 * gatekeeper check inside the handler, regardless of transport.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.30.
 */

import type { CoreRouter, CoreRequest, CoreResponse } from '../server/router';
import type {
  CoreClient,
  CoreHealth,
  VaultQuery,
  VaultQueryResult,
  VaultItemInput,
  VaultStoreResult,
  VaultListOptions,
  VaultListResult,
  VaultDeleteResult,
  SignResult,
  CanonicalSignRequest,
  SignedHeaders,
  PIIScrubResult,
  PIIRehydrateResult,
  NotifyRequest,
  NotifyResult,
  PersonaStatusResult,
  PersonaUnlockResult,
  ServiceConfig,
  ServiceQueryClientRequest,
  ServiceQueryResult,
  MemoryToCOptions,
  MemoryToCResult,
} from './core-client';

/**
 * Default CoreRequest skeleton — most InProcessTransport calls reuse
 * the same empty headers/params and an empty rawBody (router only uses
 * rawBody for signature verification, which we're skipping).
 */
function blankRequest(overrides: Partial<CoreRequest>): CoreRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: { 'x-in-process': '1' },
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    ...overrides,
  };
}

/**
 * Narrowing helper — throws with a useful message on non-2xx.
 * Narrows `body` to `T` by assertion; callers should still validate
 * critical fields at the callsite.
 */
function expectOk<T>(res: CoreResponse, context: string): T {
  if (res.status < 200 || res.status >= 300) {
    const err = (res.body as { error?: string } | undefined)?.error ?? 'no error field';
    throw new Error(`InProcessTransport: ${context} failed ${res.status} — ${err}`);
  }
  return res.body as T;
}

/**
 * Implements `CoreClient` by dispatching CoreRequest objects through
 * the provided CoreRouter. No network hop; the router's handler runs
 * in the same event loop.
 */
export class InProcessTransport implements CoreClient {
  constructor(private readonly router: CoreRouter) {}

  async healthz(): Promise<CoreHealth> {
    const res = await this.router.handle(blankRequest({ method: 'GET', path: '/healthz' }));
    return expectOk<CoreHealth>(res, 'healthz');
  }

  async vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/vault/query`,
        body: { persona, ...query },
      }),
    );
    return expectOk<VaultQueryResult>(res, `vaultQuery(persona=${persona})`);
  }

  async vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/vault/store`,
        body: { persona, ...item },
      }),
    );
    return expectOk<VaultStoreResult>(res, `vaultStore(persona=${persona})`);
  }

  async vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'GET',
        path: `/v1/vault/list`,
        query: {
          persona,
          ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
          ...(opts?.offset !== undefined ? { offset: String(opts.offset) } : {}),
          ...(opts?.type !== undefined ? { type: opts.type } : {}),
        },
      }),
    );
    return expectOk<VaultListResult>(res, `vaultList(persona=${persona})`);
  }

  async vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'DELETE',
        path: `/v1/vault/items/${encodeURIComponent(itemId)}`,
        query: { persona },
      }),
    );
    return expectOk<VaultDeleteResult>(res, `vaultDelete(persona=${persona}, id=${itemId})`);
  }

  async didSign(payload: Uint8Array): Promise<SignResult> {
    // Bytes → base64 for transport since CoreRequest.body is JSON-friendly.
    // Core's handler base64-decodes before signing; the round-trip is
    // lossless because Uint8Array → base64 is bijective.
    const base64Payload = Buffer.from(payload).toString('base64');
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/did/sign',
        body: { payload: base64Payload },
      }),
    );
    return expectOk<SignResult>(res, 'didSign');
  }

  async didSignCanonical(req: CanonicalSignRequest): Promise<SignedHeaders> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/did/sign-canonical',
        body: {
          method: req.method,
          path: req.path,
          query: req.query,
          body: Buffer.from(req.body).toString('base64'),
        },
      }),
    );
    return expectOk<SignedHeaders>(res, 'didSignCanonical');
  }

  async piiScrub(text: string): Promise<PIIScrubResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/pii/scrub',
        body: { text },
      }),
    );
    return expectOk<PIIScrubResult>(res, 'piiScrub');
  }

  async piiRehydrate(sessionId: string, text: string): Promise<PIIRehydrateResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/pii/rehydrate',
        body: { sessionId, text },
      }),
    );
    return expectOk<PIIRehydrateResult>(res, `piiRehydrate(session=${sessionId})`);
  }

  async notify(notification: NotifyRequest): Promise<NotifyResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: '/v1/notify',
        body: notification,
      }),
    );
    return expectOk<NotifyResult>(res, `notify(priority=${notification.priority})`);
  }

  async personaStatus(persona: string): Promise<PersonaStatusResult> {
    const res = await this.router.handle(
      blankRequest({
        method: 'GET',
        path: `/v1/persona/status`,
        query: { persona },
      }),
    );
    return expectOk<PersonaStatusResult>(res, `personaStatus(persona=${persona})`);
  }

  async personaUnlock(persona: string, passphrase: string): Promise<PersonaUnlockResult> {
    // Passphrase lives on the body, never the query — never end up in
    // access logs or the browser's history. Core hashes it into the
    // Argon2id KDF and never writes it to disk.
    const res = await this.router.handle(
      blankRequest({
        method: 'POST',
        path: `/v1/persona/unlock`,
        body: { persona, passphrase },
      }),
    );
    return expectOk<PersonaUnlockResult>(res, `personaUnlock(persona=${persona})`);
  }

  async serviceConfig(): Promise<ServiceConfig | null> {
    // Core returns 404 when no config is published — map to `null`
    // so Brain can branch without try/catch on a non-exceptional
    // state. Other non-2xx (500, 503) still throw via expectOk.
    const res = await this.router.handle(
      blankRequest({ method: 'GET', path: '/v1/service/config' }),
    );
    if (res.status === 404) return null;
    return expectOk<ServiceConfig>(res, 'serviceConfig');
  }

  async serviceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult> {
    // Route's validator speaks snake_case; translate at the boundary
    // so Brain code stays in camelCase. Optional fields are omitted
    // when undefined so the server's `typeof b.x === 'string'` checks
    // behave as intended (not seeing a literal `undefined`).
    const body: Record<string, unknown> = {
      to_did: req.toDID,
      capability: req.capability,
      query_id: req.queryId,
      params: req.params,
      ttl_seconds: req.ttlSeconds,
    };
    if (req.serviceName !== undefined) body.service_name = req.serviceName;
    if (req.originChannel !== undefined) body.origin_channel = req.originChannel;
    if (req.schemaHash !== undefined) body.schema_hash = req.schemaHash;

    const res = await this.router.handle(
      blankRequest({ method: 'POST', path: '/v1/service/query', body }),
    );
    const raw = expectOk<{ task_id: string; query_id: string; deduped?: boolean }>(
      res,
      `serviceQuery(capability=${req.capability})`,
    );
    const out: ServiceQueryResult = { taskId: raw.task_id, queryId: raw.query_id };
    if (raw.deduped !== undefined) out.deduped = raw.deduped;
    return out;
  }

  async memoryToC(opts?: MemoryToCOptions): Promise<MemoryToCResult> {
    // Personas flatten to a comma-separated list per the route's
    // contract (`parsePersonaFilter`). Limit encodes as string — the
    // router reads query params as strings regardless of JS type.
    const query: Record<string, string> = {};
    if (opts?.personas !== undefined && opts.personas.length > 0) {
      query.persona = opts.personas.join(',');
    }
    if (opts?.limit !== undefined) {
      query.limit = String(opts.limit);
    }
    const res = await this.router.handle(
      blankRequest({ method: 'GET', path: '/v1/memory/toc', query }),
    );
    return expectOk<MemoryToCResult>(res, 'memoryToC');
  }
}
