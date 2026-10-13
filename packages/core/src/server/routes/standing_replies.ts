/**
 * Standing replies (REAL_LIFE_FIXES_2 §14).
 *
 *   POST /v1/standing-replies/propose   Brain, with a proof of the owner's
 *        turn: { proof…, contacts: string[], reply_text, until } → a card.
 *   GET  /v1/standing-replies           Brain or the owner: the rules.
 *   POST /v1/standing-replies/:id/revoke  the owner, or Brain with a proof
 *        of an owner turn that asks to stop or cancel one.
 */

import { verifySpanProof } from '../../a2a/span_proof';
import { listStandingReplies, proposeStandingReply, revokeStandingReply } from '../../standing/standing_replies';

import { ownerDidForRequest } from './owner_guard';

import type { CoreRouter, CoreRequest } from '../router';

const CANCEL_WORDS = /\b(cancel|stop|turn off|switch off|end|remove|delete)\b/i;

function isBrain(req: CoreRequest): boolean {
  return req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined);
}

function proofOf(b: Record<string, unknown>) {
  const { release_session: rs, turn_id: turnId, turn_text: turnText, start, end } = b;
  if (typeof rs !== 'string' || typeof turnId !== 'string' || typeof turnText !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
    return null;
  }
  return { releaseSession: rs, turnId, turnText, start, end };
}

export function registerStandingReplyRoutes(router: CoreRouter, ownerCapability?: string): void {
  router.post('/v1/standing-replies/propose', async (req) => {
    if (!isBrain(req)) return { status: 403, body: { error: 'brain only' } };
    const b = (req.body as Record<string, unknown> | undefined) ?? {};
    const proof = proofOf(b);
    const contacts = Array.isArray(b.contacts) ? b.contacts.filter((x): x is string => typeof x === 'string') : null;
    if (proof === null || contacts === null || typeof b.reply_text !== 'string' || typeof b.until !== 'string') {
      return { status: 400, body: { error: 'a span proof, contacts, reply_text and until are required' } };
    }
    return { status: 200, body: await proposeStandingReply({ proof, contacts, replyText: b.reply_text, until: b.until }) };
  });

  router.get('/v1/standing-replies', async (req) => {
    if (!isBrain(req) && typeof ownerDidForRequest(req, ownerCapability) !== 'string') {
      return { status: 403, body: { error: 'owner or brain only' } };
    }
    const rules = (await listStandingReplies()).map((r) => ({
      id: r.id,
      state: r.state,
      reply_text: r.replyText,
      contacts: r.contacts.map((c) => c.name),
      expires_at: new Date(r.expiresAt).toISOString(),
    }));
    return { status: 200, body: { rules } };
  });

  router.post('/v1/standing-replies/:id/revoke', async (req) => {
    const owner = typeof ownerDidForRequest(req, ownerCapability) === 'string';
    if (!owner) {
      if (!isBrain(req)) return { status: 403, body: { error: 'owner or brain only' } };
      const proof = proofOf((req.body as Record<string, unknown> | undefined) ?? {});
      if (proof === null) return { status: 400, body: { error: "a proof of the owner's turn is required" } };
      const checked = verifySpanProof(proof, 'standing_reply');
      if (!checked.ok || !CANCEL_WORDS.test(checked.turnText)) {
        return { status: 403, body: { error: 'the owner did not ask to stop a standing reply' } };
      }
    }
    return { status: 200, body: { revoked: await revokeStandingReply(req.params.id ?? '') } };
  });
}
