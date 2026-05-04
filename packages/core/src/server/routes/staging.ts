/**
 * Staging inbox routes — ingest / claim / resolve / fail / extend-lease.
 */

import {
  ingest,
  claim,
  resolve,
  resolveMulti,
  fail,
  extendLease,
  getItem,
} from '../../staging/service';

import type { CoreRouter } from '../router';

export function registerStagingRoutes(router: CoreRouter): void {
  router.post('/v1/staging/ingest', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const source = requiredString(body.source, 'source');
    const sourceId = requiredString(body.source_id, 'source_id');
    if (source.kind === 'error') return { status: 400, body: { error: source.error } };
    if (sourceId.kind === 'error') return { status: 400, body: { error: sourceId.error } };

    const dataRaw = body.data;
    if (dataRaw !== undefined && !isPlainRecord(dataRaw)) {
      return { status: 400, body: { error: 'data must be an object when supplied' } };
    }
    const producerRaw = body.producer_id;
    if (producerRaw !== undefined && typeof producerRaw !== 'string') {
      return { status: 400, body: { error: 'producer_id must be a string when supplied' } };
    }
    const expiresRaw = body.expires_at;
    if (expiresRaw !== undefined && !isFiniteNumber(expiresRaw)) {
      return { status: 400, body: { error: 'expires_at must be a finite number when supplied' } };
    }

    const result = ingest({
      source: source.value,
      source_id: sourceId.value,
      ...(producerRaw !== undefined ? { producer_id: producerRaw } : {}),
      ...(dataRaw !== undefined ? { data: dataRaw } : {}),
      ...(expiresRaw !== undefined ? { expires_at: Math.floor(expiresRaw) } : {}),
    });
    const item = getItem(result.id);
    return {
      status: result.duplicate ? 200 : 201,
      body: {
        id: result.id,
        duplicate: result.duplicate,
        status: item?.status ?? 'received',
      },
    };
  });

  router.post('/v1/staging/claim', async (req) => {
    const limit = clampInt(req.query.limit, 10, 1, 50);
    const items = claim(limit);
    return { status: 200, body: { items, count: items.length } };
  });

  router.post('/v1/staging/resolve', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const id = typeof body.id === 'string' ? body.id : '';
    const data = body.data as Record<string, unknown> | undefined;
    // GAP-MULTI-01: prefer the `personas` array when supplied (port of
    // main-dina's `staging_resolve_multi`); otherwise use the
    // single-persona form.
    const personas = Array.isArray(body.personas)
      ? (body.personas as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '')
      : null;
    try {
      if (personas !== null && personas.length > 0) {
        const accessRaw = body.persona_access;
        if (!isPlainRecord(accessRaw)) {
          return {
            status: 400,
            body: { error: 'persona_access must be an object for multi-persona resolve' },
          };
        }
        const targets: { persona: string; personaOpen: boolean }[] = [];
        for (const persona of personas) {
          const open = accessRaw[persona];
          if (typeof open !== 'boolean') {
            return {
              status: 400,
              body: { error: `persona_access.${persona} must be a boolean` },
            };
          }
          targets.push({ persona, personaOpen: open });
        }
        resolveMulti(id, targets, data);
        const item = getItem(id);
        return { status: 200, body: { id, status: item?.status ?? 'unknown', personas } };
      }
      if (typeof body.persona !== 'string' || body.persona.trim().length === 0) {
        return { status: 400, body: { error: 'persona must be a non-empty string' } };
      }
      if (typeof body.persona_open !== 'boolean') {
        return { status: 400, body: { error: 'persona_open must be a boolean' } };
      }
      const persona = body.persona.trim();
      const personaOpen = body.persona_open;
      resolve(id, persona, personaOpen, data);
      const item = getItem(id);
      return { status: 200, body: { id, status: item?.status ?? 'unknown' } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  router.post('/v1/staging/fail', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const id = typeof body.id === 'string' ? body.id : '';
    try {
      fail(id);
      const item = getItem(id);
      return { status: 200, body: { id, retry_count: item?.retry_count ?? 0 } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  router.post('/v1/staging/extend-lease', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const id = typeof body.id === 'string' ? body.id : '';
    const seconds = typeof body.seconds === 'number' ? body.seconds : 300;
    try {
      extendLease(id, seconds);
      return { status: 200, body: { id, extended_by: seconds } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requiredString(
  value: unknown,
  field: string,
): { kind: 'ok'; value: string } | { kind: 'error'; error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { kind: 'error', error: `${field} must be a non-empty string` };
  }
  return { kind: 'ok', value: value.trim() };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
