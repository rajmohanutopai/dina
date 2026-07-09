/**
 * D2D quarantine review — GET /v1/d2d/quarantine + accept/block.
 *
 * Messages from UNKNOWN senders (no contact policy) are held in Core's
 * quarantine store for owner review. The mobile app reads this in-process; the
 * web thin-client can't, so it fetches here (F4 / MRS-05 — without this the
 * SPA's InlineQuarantineCard reads the empty in-browser store and never shows
 * a pending unknown-sender message).
 *
 *   GET  /v1/d2d/quarantine              → { messages }
 *   POST /v1/d2d/quarantine/accept {…}   → un-quarantine + trust the sender
 *   POST /v1/d2d/quarantine/block  {…}   → drop the sender's messages + block
 *
 * `accept`/`block` are COMPOUND: each does the quarantine half AND the contact
 * half (mirroring mobile useD2DMessages) in one server-side call, so the web
 * makes a single request per decision. `accept` is NOT a single atomic
 * transaction (the store + staging pipeline are separate), so it is made
 * RESILIENT instead: if re-staging a released message throws, that message is
 * re-quarantined so it's never trusted-but-lost (see the handler). Owner-
 * private: the whole surface is Brain + Admin only (see auth/authz).
 */

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';
import {
  listQuarantined,
  unquarantineSender,
  blockSender,
  quarantineMessage,
} from '../../d2d/quarantine';
import { receiveAndStage } from '../../d2d/receive';
import { getContact, updateContact, addContact } from '../../contacts/directory';

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}

/**
 * Upsert a quarantined sender's trust — mirrors mobile
 * `useD2DMessages.setSenderTrust`. `addContact` THROWS when a policy already
 * exists, so a sender who is ALREADY an unknown-trust contact (the very state
 * that quarantines their messages) must be UPDATED in place, not re-added.
 */
function setSenderTrust(did: string, label: string, trustLevel: 'verified' | 'blocked'): void {
  if (getContact(did) !== null) {
    updateContact(did, { trustLevel });
  } else {
    addContact(did, label !== '' ? label : did.slice(0, 12), trustLevel);
  }
}

function readSenderDid(req: CoreRequest): { did: string; label: string } {
  const body = (req.body ?? {}) as { sender_did?: unknown; sender_label?: unknown };
  return {
    did: typeof body.sender_did === 'string' ? body.sender_did.trim() : '',
    label: typeof body.sender_label === 'string' ? body.sender_label : '',
  };
}

export function registerD2DQuarantineRoutes(router: CoreRouter): void {
  router.get('/v1/d2d/quarantine', async (): Promise<CoreResponse> => {
    return j(200, { messages: listQuarantined() });
  });

  router.post('/v1/d2d/quarantine/accept', async (req: CoreRequest): Promise<CoreResponse> => {
    const { did, label } = readSenderDid(req);
    if (did === '') return j(400, { error: 'sender_did is required' });
    // 1. Trust the sender FIRST so future messages stop re-quarantining and the
    //    re-staged ones below pass the gate (mirrors mobile acceptFromQuarantine).
    setSenderTrust(did, label, 'verified');
    // 2. Release the held messages and re-stage each so the drain runs the same
    //    enrichment/reminder pipeline it would have run had the sender been a
    //    contact when the message first arrived — that also fires onD2DMessage,
    //    so the message finally surfaces as a chat bubble. `isContact: true`.
    //
    //    RESILIENCE (not falsely atomic): `unquarantineSender` removes the
    //    messages up-front, so a throw in `receiveAndStage` would otherwise
    //    leave the sender TRUSTED but the message DROPPED (removed from
    //    quarantine, never staged → no chat bubble). Guard each re-stage: on
    //    failure, RE-QUARANTINE that message so it is preserved for a retry
    //    rather than silently lost. The trust upgrade stays (the owner's
    //    decision); only the un-processable message rolls back.
    const released = unquarantineSender(did);
    const staged: typeof released = [];
    let requarantined = 0;
    for (const msg of released) {
      const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body);
      try {
        receiveAndStage(msg.messageType, did, 'verified', body, msg.id, true);
        staged.push(msg);
      } catch {
        quarantineMessage(msg.senderDID, msg.messageType, body);
        requarantined += 1;
      }
    }
    return j(200, { released: staged, count: staged.length, requarantined });
  });

  router.post('/v1/d2d/quarantine/block', async (req: CoreRequest): Promise<CoreResponse> => {
    const { did, label } = readSenderDid(req);
    if (did === '') return j(400, { error: 'sender_did is required' });
    const blockedCount = blockSender(did);
    setSenderTrust(did, label, 'blocked');
    return j(200, { blocked_count: blockedCount });
  });
}
