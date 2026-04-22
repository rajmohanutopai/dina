/**
 * Staging inbox routes — claim / resolve / fail / extend-lease.
 * The `/ingest` route was speculative (no consumer) and has been removed.
 */

import type { CoreRouter } from '../router';
import { claim, resolve, resolveMulti, fail, extendLease, getItem } from '../../staging/service';

export function registerStagingRoutes(router: CoreRouter): void {
  router.post('/v1/staging/claim', async (req) => {
    const limit = clampInt(req.query.limit, 10, 1, 50);
    const items = claim(limit);
    return { status: 200, body: { items, count: items.length } };
  });

  router.post('/v1/staging/resolve', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const id = typeof body.id === 'string' ? body.id : '';
    const personaOpen = body.persona_open !== false;
    const data = body.data as Record<string, unknown> | undefined;
    // GAP-MULTI-01: prefer the `personas` array when supplied (port of
    // main-dina's `staging_resolve_multi`); fall back to the legacy
    // single-persona form so existing callers keep working.
    const personas = Array.isArray(body.personas)
      ? (body.personas as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '')
      : null;
    try {
      if (personas !== null && personas.length > 0) {
        const targets = personas.map((p) => ({ persona: p, personaOpen }));
        resolveMulti(id, targets, data);
        const item = getItem(id);
        return { status: 200, body: { id, status: item?.status ?? 'unknown', personas } };
      }
      const persona = typeof body.persona === 'string' ? body.persona : 'general';
      resolve(id, persona, personaOpen);
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
