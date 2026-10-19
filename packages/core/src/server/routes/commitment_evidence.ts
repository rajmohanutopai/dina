/**
 * The owner's view of evidence (COMMITMENT_KERNEL §13, §15 step 8): what was
 * recorded about a relationship, the summary, and each side's consent to
 * share it; correcting their own answer; turning sharing on or off.
 *
 *   GET  /v1/commitment/evidence?counterparty_did=…  — records, summary, consent
 *   POST /v1/commitment/evidence/amend               — correct or dispute one's own answer
 *   PUT  /v1/commitment/evidence/consent             — share a summary with this relationship, or stop
 *
 * Owner only. Turning sharing on needs a person present: it is the one
 * switch that lets anything about a relationship leave (the counts alone,
 * once both have said yes). A summary is never published from here: that is
 * a later step (owner decision, 2026-10-16).
 */

import { ownerPresenceRefusal } from '../../commerce/owner_presence';
import { cancelWithdrawnOffers } from '../../commitment/earned_room';
import { promiseSummary } from '../../commitment/evidence';
import {
  getEvidenceStore,
  narrowForBroken,
  setOwnerConsent,
} from '../../commitment/evidence_handler';

import { makeOwnerGuard } from './owner_guard';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,256}$/;
const NO_STORE: CoreResponse = { status: 503, body: { error: 'evidence_store_unavailable' } };

export function registerEvidenceRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may read or change evidence',
  );

  router.get('/v1/commitment/evidence', async (req: CoreRequest): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const did = String(req.query.counterparty_did ?? '');
    if (!DID.test(did)) return { status: 400, body: { error: 'counterparty_did: a DID' } };
    const store = getEvidenceStore();
    if (store === null) return NO_STORE;
    const records = store.forCounterparty(did);
    const consent = store.consent(did);
    const summary = promiseSummary(records, consent);
    return {
      status: 200,
      body: {
        counterparty_did: did,
        records: records.map((e) => ({
          evidence_id: e.evidenceId,
          deal_ref: e.dealRef,
          subject: e.subject,
          item: e.item,
          occurrence: e.occurrence,
          outcome: e.outcome,
          fault: e.fault,
          source: e.source,
          note: e.note,
          facts: e.facts,
          recorded_at: e.recordedAt,
          ...(e.amendedAt === null ? {} : { amended_at: e.amendedAt }),
        })),
        summary: { kept: summary.kept, of: summary.of, no_fault: summary.noFault },
        consent: { yours: consent.self, theirs: consent.peer, shareable: summary.shareable },
      },
    };
  });

  router.post('/v1/commitment/evidence/amend', async (req: CoreRequest): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.evidence_id !== 'string' || body.evidence_id.length > 600)
      return { status: 400, body: { error: 'evidence_id: a record id' } };
    if (body.outcome !== 'kept' && body.outcome !== 'broken')
      return { status: 400, body: { error: "outcome: 'kept' | 'broken'" } };
    const note = typeof body.note === 'string' ? body.note : '';
    if (note.length > 500) return { status: 400, body: { error: 'note: up to 500 characters' } };
    const store = getEvidenceStore();
    if (store === null) return NO_STORE;
    const outcome = body.outcome;
    // A box: a closure's assignment is invisible to the compiler's narrowing.
    const box: { amended: ReturnType<typeof store.amend> } = { amended: null };
    // COMMITMENT_KERNEL §15 step 13: a record turned broken takes earned
    // room back, in the same write; a note edit on one already broken does not.
    store.atomically(() => {
      const before = store.get(body.evidence_id as string);
      box.amended = store.amend(body.evidence_id as string, { outcome, note }, Date.now());
      if (box.amended?.outcome === 'broken' && before?.outcome !== 'broken')
        narrowForBroken(box.amended.subject, box.amended.dealRef, Date.now());
    });
    const amended = box.amended;
    if (amended === null) return { status: 404, body: { error: 'no_such_owner_record' } };
    cancelWithdrawnOffers();
    return { status: 200, body: { ok: true, outcome: amended.outcome } };
  });

  router.put('/v1/commitment/evidence/consent', async (req: CoreRequest): Promise<CoreResponse> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const denied =
      ownerOnlyGuard(req) ??
      (body.on === true
        ? ownerPresenceRefusal(req, Date.now(), 'sharing a promise record needs a person present')
        : null);
    if (denied !== null) return denied;
    if (typeof body.counterparty_did !== 'string' || !DID.test(body.counterparty_did))
      return { status: 400, body: { error: 'counterparty_did: a DID' } };
    if (typeof body.on !== 'boolean') return { status: 400, body: { error: 'on: a boolean' } };
    if (!(await setOwnerConsent(body.counterparty_did, body.on, Date.now()))) return NO_STORE;
    return { status: 200, body: { ok: true, on: body.on } };
  });
}
