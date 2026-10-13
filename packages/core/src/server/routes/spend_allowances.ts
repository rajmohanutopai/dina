/**
 * Agent spend allowances (REAL_LIFE_FIXES_2 §15).
 *
 *   POST /v1/spend-allowances/propose      Brain, with a proof of the owner's
 *        turn: { proof…, agent, amount_minor, currency, period, category,
 *        per_item_cap_minor?, until? } → a presence-gated card.
 *   GET  /v1/spend-allowances              Brain or the owner: allowances, what
 *        each used this period, and each purchase one by one ("what did my
 *        agents buy?").
 *   POST /v1/spend-allowances/:id/revoke   the owner, or Brain with a proof
 *        of an owner turn that asks to stop one.
 */

import { verifySpanProof } from '../../a2a/span_proof';
import { listActiveDevices } from '../../devices/registry';
import { allowanceStatus, listSpendUses, proposeAllowance, revokeAllowance } from '../../spend/allowance';

import { ownerDidForRequest } from './owner_guard';

import type { CoreRouter, CoreRequest } from '../router';

const STOP_WORDS = /\b(cancel|stop|end|revoke|remove|no more)\b/i;

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

export function registerSpendAllowanceRoutes(router: CoreRouter, ownerCapability?: string): void {
  router.post('/v1/spend-allowances/propose', async (req) => {
    if (!isBrain(req)) return { status: 403, body: { error: 'brain only' } };
    const b = (req.body as Record<string, unknown> | undefined) ?? {};
    const proof = proofOf(b);
    if (proof === null || typeof b.agent !== 'string' || typeof b.currency !== 'string' || typeof b.period !== 'string' || typeof b.category !== 'string') {
      return { status: 400, body: { error: 'a span proof, agent, amount_minor, currency, period and category are required' } };
    }
    const out = await proposeAllowance({
      proof,
      agent: b.agent,
      amountMinor: b.amount_minor as number,
      currency: b.currency,
      period: b.period,
      category: b.category,
      ...(b.per_item_cap_minor !== undefined ? { perItemCapMinor: b.per_item_cap_minor as number } : {}),
      ...(typeof b.until === 'string' ? { until: b.until } : {}),
    });
    return { status: 200, body: out };
  });

  router.get('/v1/spend-allowances', async (req) => {
    if (!isBrain(req) && typeof ownerDidForRequest(req, ownerCapability) !== 'string') {
      return { status: 403, body: { error: 'owner or brain only' } };
    }
    const rows = (await allowanceStatus()).map(({ allowance: a, spentMinor, period }) => ({
      id: a.id,
      state: a.state,
      agent: a.agentName,
      currency: a.currency,
      amount_minor: a.amountMinor,
      spent_minor: spentMinor,
      period: a.period,
      period_key: period,
      category: a.category,
      expires_at: new Date(a.expiresAt).toISOString(),
    }));
    const uses = (await listSpendUses()).map((u) => ({
      allowance_id: u.allowanceId,
      decision: u.decision,
      amount_minor: u.amountMinor,
      currency: u.currency,
      merchant: u.merchant,
      category: u.category,
      at: new Date(u.at).toISOString(),
      proposal_id: u.proposalId,
    }));
    // The paired agents a budget can name (device names only).
    const agents = listActiveDevices()
      .filter((d) => d.role === 'agent')
      .map((d) => d.deviceName);
    return { status: 200, body: { allowances: rows, uses, agents } };
  });

  router.post('/v1/spend-allowances/:id/revoke', async (req) => {
    const owner = typeof ownerDidForRequest(req, ownerCapability) === 'string';
    if (!owner) {
      if (!isBrain(req)) return { status: 403, body: { error: 'owner or brain only' } };
      const proof = proofOf((req.body as Record<string, unknown> | undefined) ?? {});
      if (proof === null) return { status: 400, body: { error: "a proof of the owner's turn is required" } };
      const checked = verifySpanProof(proof, 'spend_allowance');
      if (!checked.ok || !STOP_WORDS.test(checked.turnText)) {
        return { status: 403, body: { error: 'the owner did not ask to stop an allowance' } };
      }
    }
    return { status: 200, body: { revoked: await revokeAllowance(req.params.id ?? '') } };
  });
}
