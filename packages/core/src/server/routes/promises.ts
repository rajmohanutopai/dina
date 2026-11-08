/**
 * Promises and waits (docs/PROMISES_AND_WAITS.md), read-only.
 *
 *   GET /v1/promises?now=… — `{ items: PromiseItem[], missing: string[] }`.
 *
 * Auth: admin, Brain and the owner's devices (`authz.ts` `/v1/promises`). No
 * agent reads it: the list names the owner's contacts and deals.
 */

import { listPromisesAndWaits, type PromisesAndWaits } from '../../promises/view';

import type { CoreResponse, CoreRouter } from '../router';

export const PROMISES_PATH = '/v1/promises';

export function registerPromiseRoutes(
  router: CoreRouter,
  list: (now: number) => PromisesAndWaits = (now) => listPromisesAndWaits(now),
): void {
  router.get(PROMISES_PATH, async (req): Promise<CoreResponse> => {
    const raw = req.query.now;
    const parsed = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
    const now = Number.isFinite(parsed) ? parsed : Date.now();
    return { status: 200, body: list(now) };
  });
}
