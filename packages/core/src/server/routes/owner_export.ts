/**
 * The owner's readable export (REAL_LIFE_FIXES_2 §5).
 *
 *   POST /v1/owner-export/prepare  — Brain (or the owner): builds it, keeps
 *        it in memory, answers { id, manifest }. No data.
 *   GET  /v1/owner-export/:id      — the owner's own device only (owner
 *        capability, or the owner's signed device): the document, once.
 *        Brain is refused, including phone Brain's in-process call.
 */

import { prepareReadableExport, takeReadableExport } from '../../export/readable';

import { ownerDidForRequest } from './owner_guard';

import type { CoreRouter } from '../router';

export function registerOwnerExportRoutes(router: CoreRouter, ownerCapability?: string): void {
  router.post('/v1/owner-export/prepare', async (req) => {
    const brain = req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined);
    if (!brain && typeof ownerDidForRequest(req, ownerCapability) !== 'string') {
      return { status: 403, body: { error: 'owner or brain only' } };
    }
    return { status: 200, body: await prepareReadableExport() };
  });

  router.get('/v1/owner-export/:id', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const doc = takeReadableExport(req.params.id ?? '');
    if (doc === null) return { status: 404, body: { error: 'export not found, expired, or already taken' } };
    return { status: 200, body: JSON.parse(doc) as unknown };
  });
}
