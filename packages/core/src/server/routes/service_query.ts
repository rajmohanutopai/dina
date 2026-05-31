/**
 * POST /v1/service/query — service-query handler.
 *
 * Flow:
 *   1. Validate (to_did / capability / query_id / ttl / params).
 *   2. Canonicalise params + compute idempotency key.
 *   3. Dedupe on idem key — return existing task if active.
 *   4. Create `service_query` workflow task.
 *   5. Invoke injected D2D sender.
 *   6. On send success: transition created → running; return.
 *   7. On send failure: fail the task; return 502.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseServiceListingUri } from '@dina/protocol';
import type { CoreRouter } from '../router';
import { MAX_SERVICE_TTL } from '../../d2d/families';
import type { ServiceQueryBody } from '../../d2d/service_bodies';
import { WorkflowConflictError, type WorkflowRepository } from '../../workflow/repository';
import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../../workflow/domain';
import { getWorkflowService } from '../../workflow/service';

/** Inject-time sender contract. Wiring provides this; handler stays pure. */
export type ServiceQuerySender = (
  recipientDID: string,
  messageType: 'service.query',
  body: ServiceQueryBody,
) => Promise<void>;

let senderInstance: ServiceQuerySender | null = null;

export function setServiceQuerySender(s: ServiceQuerySender | null): void {
  senderInstance = s;
}

export function getServiceQuerySender(): ServiceQuerySender | null {
  return senderInstance;
}

// ---------------------------------------------------------------------------
// Canonical JSON — exported for tests + cross-runtime parity checks
// ---------------------------------------------------------------------------

export function canonicalJSON(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJSON: non-finite number (${value})`);
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map(canonicalJSON).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) continue;
        parts.push(JSON.stringify(k) + ':' + canonicalJSON(v));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new Error(`canonicalJSON: unsupported type "${typeof value}"`);
  }
}

export function computeIdempotencyKey(
  toDID: string,
  capability: string,
  params: unknown,
  schemaHash?: string,
  serviceUri?: string,
): string {
  // Namespace the dedupe key by `schema_hash` when present (review #8).
  // Two requests targeting the same (to_did, capability, params) but
  // pinned to different schema versions are NOT equivalent — they
  // expect different response shapes. Without this segregation, a
  // long-running live task pinned to the old schema absorbs a fresh
  // request pinned to the new one, silently producing the wrong
  // response shape. Unpinned requests (schema_hash omitted) keep the
  // prior dedupe identity so existing callers don't regress.
  //
  // Also namespace by `service_uri` (the chosen listing) when present: a
  // provider DID may publish many listings, so two requests with the same
  // (to_did, capability, params) but DIFFERENT listings are NOT equivalent
  // and must not dedupe into one task. Requests without a service_uri keep
  // the prior dedupe identity.
  const canonical = canonicalJSON(params);
  const schemaFragment = schemaHash !== undefined && schemaHash !== '' ? `|${schemaHash}` : '';
  const uriFragment = serviceUri !== undefined && serviceUri !== '' ? `|uri=${serviceUri}` : '';
  const input = `${toDID}|${capability}|${canonical}${schemaFragment}${uriFragment}`;
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}

// ---------------------------------------------------------------------------

export interface ServiceQueryRouteOptions {
  sender?: ServiceQuerySender;
  nowSecFn?: () => number;
}

interface ServiceQueryRequest {
  to_did: string;
  capability: string;
  params: unknown;
  ttl_seconds: number;
  service_name?: string;
  query_id: string;
  origin_channel?: string;
  schema_hash?: string;
  /**
   * AT-URI of the specific listing the requester chose. A provider DID may
   * publish many listings (marketplace multi-listing per DID); `to_did` +
   * `capability` alone can't disambiguate. Carried opaquely onto the D2D
   * `service.query` body so the provider knows which listing was selected.
   */
  service_uri?: string;
}

function validateRequest(
  body: unknown,
): { ok: true; req: ServiceQueryRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const toDID = typeof b.to_did === 'string' ? b.to_did : '';
  const capability = typeof b.capability === 'string' ? b.capability : '';
  const queryId = typeof b.query_id === 'string' ? b.query_id : '';
  if (toDID === '' || capability === '' || queryId === '') {
    return { ok: false, error: 'to_did, capability, and query_id are required' };
  }
  if (!toDID.startsWith('did:')) {
    return { ok: false, error: 'to_did must be a valid DID (did:...)' };
  }
  const ttl = typeof b.ttl_seconds === 'number' ? b.ttl_seconds : NaN;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > MAX_SERVICE_TTL) {
    return { ok: false, error: `ttl_seconds must be 1-${MAX_SERVICE_TTL}` };
  }
  if (
    b.params === undefined ||
    b.params === null ||
    typeof b.params !== 'object' ||
    Array.isArray(b.params)
  ) {
    return { ok: false, error: 'params must be a non-null JSON object' };
  }
  // service_uri (optional): when present it selects WHICH listing the provider
  // answers for and flows into the provider's execution context — so bind it to
  // a well-formed com.dina.service.profile listing AT-URI whose authority is the
  // SAME DID as `to_did`. Reject a malformed or cross-DID listing so a requester
  // can't push a mismatched listing reference at the provider. '' ⇒ absent.
  let serviceUri: string | undefined;
  if (b.service_uri !== undefined) {
    // Reject present-but-non-string rather than silently treating it as absent
    // — a number/object service_uri is a malformed request, not "no listing".
    if (typeof b.service_uri !== 'string') {
      return { ok: false, error: 'service_uri must be a string when present' };
    }
    if (b.service_uri !== '') {
      const parsed = parseServiceListingUri(b.service_uri);
      if (parsed === null) {
        return {
          ok: false,
          error: 'service_uri must be an at://<did>/com.dina.service.profile/<rkey> URI',
        };
      }
      if (parsed.did !== toDID) {
        return { ok: false, error: 'service_uri must reference the same DID as to_did' };
      }
      serviceUri = b.service_uri;
    }
  }
  return {
    ok: true,
    req: {
      to_did: toDID,
      capability,
      query_id: queryId,
      ttl_seconds: ttl,
      params: b.params,
      service_name: typeof b.service_name === 'string' ? b.service_name : undefined,
      origin_channel: typeof b.origin_channel === 'string' ? b.origin_channel : undefined,
      schema_hash: typeof b.schema_hash === 'string' ? b.schema_hash : undefined,
      service_uri: serviceUri,
    },
  };
}

export function registerServiceQueryRoutes(
  router: CoreRouter,
  options: ServiceQueryRouteOptions = {},
): void {
  const nowSecFn = options.nowSecFn ?? (() => Math.floor(Date.now() / 1000));

  router.post('/v1/service/query', async (req) => {
    const service = getWorkflowService();
    if (service === null) {
      return { status: 503, body: { error: 'workflow service not wired' } };
    }
    const sender = options.sender ?? senderInstance;
    if (sender === null) {
      return { status: 503, body: { error: 'service-query sender not wired' } };
    }

    if (req.body === undefined) {
      return { status: 400, body: { error: 'empty body' } };
    }
    const v = validateRequest(req.body);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    const q = v.req;

    const idemKey = computeIdempotencyKey(
      q.to_did,
      q.capability,
      q.params,
      q.schema_hash,
      q.service_uri,
    );
    const repo: WorkflowRepository = service.store();
    const existing = repo.getActiveByIdempotencyKey(idemKey);
    if (existing !== null) {
      return {
        status: 200,
        body: {
          task_id: existing.id,
          query_id: existing.correlation_id ?? q.query_id,
          deduped: true,
        },
      };
    }

    const nowSec = nowSecFn();
    // Namespace the task id by (to_did, capability, query_id). A naked
    // `sq-${query_id}` collides when a client reuses the same query_id
    // against different recipients or capabilities (issue #20). The
    // hash suffix stays short (8 hex chars ≈ 32 bits) — collision
    // probability across one requester's task space is negligible.
    const taskId = `sq-${q.query_id}-${bytesToHex(
      sha256(new TextEncoder().encode(`${q.to_did}|${q.capability}|${q.query_id}`)),
    ).slice(0, 8)}`;
    const payload = {
      to_did: q.to_did,
      capability: q.capability,
      params: q.params,
      service_name: q.service_name ?? '',
      query_id: q.query_id,
      ttl_seconds: q.ttl_seconds,
      origin_channel: q.origin_channel ?? '',
      schema_hash: q.schema_hash ?? '',
      service_uri: q.service_uri ?? '',
    };

    try {
      service.create({
        id: taskId,
        kind: WorkflowTaskKind.ServiceQuery,
        description: `Service query: ${q.capability} to ${q.service_name ?? q.to_did}`,
        payload: canonicalJSON(payload),
        priority: WorkflowTaskPriority.Normal,
        correlationId: q.query_id,
        idempotencyKey: idemKey,
        expiresAtSec: nowSec + q.ttl_seconds,
        origin: 'api',
      });
    } catch (err) {
      if (err instanceof WorkflowConflictError) {
        const raced = repo.getActiveByIdempotencyKey(idemKey);
        if (raced !== null) {
          return {
            status: 200,
            body: {
              task_id: raced.id,
              query_id: raced.correlation_id ?? q.query_id,
              deduped: true,
            },
          };
        }
        return { status: 409, body: { error: 'duplicate query_id', code: err.code } };
      }
      return { status: 500, body: { error: (err as Error).message } };
    }

    const d2dBody: ServiceQueryBody = {
      query_id: q.query_id,
      capability: q.capability,
      params: q.params,
      ttl_seconds: q.ttl_seconds,
    };
    if (q.schema_hash !== undefined) d2dBody.schema_hash = q.schema_hash;
    if (q.service_uri !== undefined) d2dBody.service_uri = q.service_uri;

    try {
      await sender(q.to_did, 'service.query', d2dBody);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      try {
        service.fail(taskId, `send_failed: ${msg}`);
      } catch {
        /* fail-fail is non-fatal — sweeper handles stuck tasks */
      }
      return { status: 502, body: { error: `send failed: ${msg}` } };
    }

    // created → running; fast-response race is acceptable.
    void repo.transition(taskId, WorkflowTaskState.Created, WorkflowTaskState.Running, Date.now());

    return {
      status: 200,
      body: { task_id: taskId, query_id: q.query_id },
    };
  });
}
