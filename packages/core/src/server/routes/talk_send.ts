/**
 * POST /v1/talk/send — the owner's chat asks to message a contact
 * (REAL_LIFE_FIXES §7). Brain only. See `talk/owner_send.ts`.
 *
 * Body: { release_session, turn_id, turn_text, start, end, contact, proposed_text }.
 */

import { ownerSendToContact } from '../../talk/owner_send';

import type { CoreRouter } from '../router';

export const TALK_SEND = '/v1/talk/send';

export function registerTalkSendRoute(router: CoreRouter): void {
  router.post(TALK_SEND, async (req) => {
    if (!(req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined))) {
      return { status: 403, body: { error: 'brain only' } };
    }
    const b = (req.body as Record<string, unknown> | undefined) ?? {};
    const { release_session: rs, turn_id: turnId, turn_text: turnText, start, end, contact } = b;
    if (
      typeof rs !== 'string' ||
      typeof turnId !== 'string' ||
      typeof turnText !== 'string' ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      typeof contact !== 'string' ||
      typeof b.proposed_text !== 'string'
    ) {
      return { status: 400, body: { error: 'a span proof, contact and proposed_text are required' } };
    }
    const out = await ownerSendToContact({
      proof: { releaseSession: rs, turnId, turnText, start, end },
      contact,
      proposedText: b.proposed_text,
    });
    return { status: 200, body: out };
  });
}
