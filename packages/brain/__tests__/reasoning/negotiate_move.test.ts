/**
 * COMMITMENT_KERNEL §11 — the built-in Brain fills the strategy slot.
 *
 *   B-01  a negotiate.move claim is answered with one well-formed move parsed
 *         from the model's JSON; values stay strings for Core to parse;
 *   B-02  an answer with no move fails the job (the fixed style plays);
 *   B-03  the output guard keeps the move and screens only the owner's note.
 *   B-04  §15 step 11: a yes-or-no question for the owner is a move; an empty
 *         one fails the job; the guard screens the question as it does the note.
 */

import { createInternalBrainExecutor } from '../../src/reasoning/internal_brain_executor';
import { createReasoningOutputGuard } from '../../src/reasoning/reasoning_output_guard';

import type { AuthorityOrigin, ReasoningClaim } from '@dina/core';

const ORIGIN: AuthorityOrigin = {
  kind: 'background_job',
  ownerDid: 'did:plc:owner',
  ingress: 'workflow',
  correlationId: 'treq-1:1',
  authenticatedAtMs: 1_000,
};

const BRIEF = {
  kind: 'shelf_space.vendor',
  ref: { negotiationId: 'treq-1', turn: 1 },
  side: 'buyer',
  parts: [{ name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' }],
  table: { terms: [{ name: 'fee', value: '250000' }] },
  history: [],
  model: { never: [] },
  roundsLeft: 3,
};

function claim(): ReasoningClaim {
  return {
    taskId: 'reason-1',
    claimId: 'claim-1',
    contextTicketId: 'ticket-1',
    leaseExpiresAtMs: Date.now() + 60_000,
    taskKind: 'negotiate.move',
    purpose: 'negotiate:shelf_space.vendor',
    authorityOrigin: ORIGIN,
    input: BRIEF,
    allowedEvidenceIds: [],
    resultSchema: {},
    resultSchemaId: 'dina.reasoning.negotiate.move.result.v1',
    contextProjectionHash: 'a'.repeat(64),
    policySnapshotHash: 'b'.repeat(64),
    executionId: 'exec-1',
  } as unknown as ReasoningClaim;
}

describe('negotiate.move in the built-in Brain', () => {
  it('B-01: one well-formed move from the model’s JSON', async () => {
    const prompts: string[] = [];
    const execute = createInternalBrainExecutor({
      provider: 'test',
      llm: async (query) => {
        prompts.push(query);
        return 'Here: {"move":{"kind":"propose","versions":[{"terms":[{"name":"fee","value":"210000"}]}],"note":"halfway"}}';
      },
    });
    const out = await execute(claim(), undefined as never);
    expect(out.result).toEqual({
      move: {
        kind: 'propose',
        versions: [{ terms: [{ name: 'fee', value: '210000' }] }],
        note: 'halfway',
      },
    });
    expect(prompts[0]).toContain('"roundsLeft":3');
  });

  it('B-02: an answer with no move fails the job', async () => {
    const execute = createInternalBrainExecutor({
      provider: 'test',
      llm: async () => 'I would lower the rent.',
    });
    await expect(execute(claim(), undefined as never)).rejects.toThrow();
  });

  it('B-03: the guard keeps the move and screens only the note', async () => {
    const guard = createReasoningOutputGuard();
    const result = {
      move: {
        kind: 'propose',
        versions: [{ terms: [{ name: 'fee', value: '210000' }] }],
        note: 'halfway',
      },
    };
    const out = await guard({
      taskKind: 'negotiate.move',
      input: BRIEF,
      result,
      evidenceIds: [],
    } as never);
    expect(out.ok).toBe(true);
    expect(
      await guard({
        taskKind: 'negotiate.move',
        input: BRIEF,
        result: { nope: 1 },
        evidenceIds: [],
      } as never),
    ).toMatchObject({ ok: false });
  });

  it('B-04: a question for the owner is a move, screened like the note', async () => {
    const execute = createInternalBrainExecutor({
      provider: 'test',
      llm: async () => '{"move":{"kind":"ask_owner","question":"  May I go to ₹2,100?  "}}',
    });
    expect((await execute(claim(), undefined as never)).result).toEqual({
      move: { kind: 'ask_owner', question: 'May I go to ₹2,100?' },
    });
    const empty = createInternalBrainExecutor({
      provider: 'test',
      llm: async () => '{"move":{"kind":"ask_owner","question":"  "}}',
    });
    await expect(empty(claim(), undefined as never)).rejects.toThrow();
    const guard = createReasoningOutputGuard();
    const out = await guard({
      taskKind: 'negotiate.move',
      input: BRIEF,
      result: { move: { kind: 'ask_owner', question: 'May I go to ₹2,100?' } },
      evidenceIds: [],
    } as never);
    expect(out).toMatchObject({ ok: true, result: { move: { kind: 'ask_owner' } } });
  });
});
