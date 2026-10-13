/**
 * POST /v1/forget/propose — the owner's chat asks to forget something
 * (REAL_LIFE_FIXES_2 §4). Brain only, with a proof of the owner's turn. Core
 * plans from its own data and always raises a card; nothing is deleted here.
 *
 * Body: { release_session, turn_id, turn_text, start, end, request }
 *   request: { person } | { persona, keep_item_ids? } | { item_ids }
 *
 * GET /v1/forget/epoch — Brain reads it before each turn and reloads its
 * thread copies when it changed.
 */

import { forgetEpoch, proposeForget, resumeForgetJobs, type ForgetRequest } from '../../forget/forget';

import type { CoreRouter } from '../router';

function isBrain(req: { callerType?: string; trustedInProcess?: boolean }): boolean {
  return req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined);
}

function parseRequest(raw: unknown): ForgetRequest | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const keys = ['person', 'persona', 'item_ids'].filter((k) => r[k] !== undefined);
  if (keys.length !== 1) return null;
  if (typeof r.person === 'string') return { person: r.person };
  if (typeof r.persona === 'string') {
    const keep = Array.isArray(r.keep_item_ids) ? r.keep_item_ids.filter((x): x is string => typeof x === 'string') : undefined;
    return { persona: r.persona, ...(keep !== undefined ? { keep_item_ids: keep } : {}) };
  }
  if (Array.isArray(r.item_ids) && r.item_ids.every((x) => typeof x === 'string')) return { item_ids: r.item_ids as string[] };
  return null;
}

export function registerForgetRoutes(router: CoreRouter): void {
  router.post('/v1/forget/propose', async (req) => {
    if (!isBrain(req)) return { status: 403, body: { error: 'brain only' } };
    const b = (req.body as Record<string, unknown> | undefined) ?? {};
    const { release_session: rs, turn_id: turnId, turn_text: turnText, start, end } = b;
    const request = parseRequest(b.request);
    if (
      typeof rs !== 'string' ||
      typeof turnId !== 'string' ||
      typeof turnText !== 'string' ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      request === null
    ) {
      return { status: 400, body: { error: 'a span proof and exactly one of person, persona or item_ids are required' } };
    }
    const out = await proposeForget({ proof: { releaseSession: rs, turnId, turnText, start, end }, request });
    return { status: 200, body: out };
  });

  router.get('/v1/forget/epoch', async (req) => {
    if (!isBrain(req)) return { status: 403, body: { error: 'brain only' } };
    // A job a restart interrupted finishes as soon as Core can run it.
    void resumeForgetJobs();
    return { status: 200, body: { epoch: await forgetEpoch() } };
  });
}
