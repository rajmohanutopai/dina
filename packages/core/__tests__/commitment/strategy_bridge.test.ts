/**
 * COMMITMENT_KERNEL §11 — a strategy's move reaches its engine only through
 * the reasoning commit bridge, which fails closed when nothing is wired.
 */

import { createNegotiationSubmitter } from '../../src/commitment/strategy_submit';
import { createReasoningCommitBridge } from '../../src/reasoning/commit_bridge';


import type { ReasoningBackendRepository } from '../../src/reasoning/backend_repository';
import type { CoreReasoningBroker, ReasoningValidatedProposal } from '../../src/reasoning/broker';
import type { ReasoningBackendBinding } from '../../src/reasoning/domain';

const proposal = {
  task: { id: 'reason-9' },
  envelope: {
    taskKind: 'negotiate.move',
    ownerDid: 'did:plc:owner',
    authorityOrigin: {
      kind: 'background_job',
      ownerDid: 'did:plc:owner',
      ingress: 'workflow',
      correlationId: 'treq:1',
      authenticatedAtMs: 1,
    },
  },
  input: { kind: 'shelf_space.vendor', ref: { negotiationId: 'treq', turn: 1 } },
  result: { move: { kind: 'stop' } },
  evidenceIds: [],
} as unknown as ReasoningValidatedProposal;

describe('the negotiation move commit', () => {
  it('fails closed with no engine wired', async () => {
    await expect(createReasoningCommitBridge({})(proposal)).rejects.toThrow(/unavailable/);
  });
  it('hands Core’s own input and the move to the engine', async () => {
    const seen: unknown[] = [];
    const bridge = createReasoningCommitBridge({
      commitNegotiationMove: (input) => {
        seen.push(input);
        return { state: 'committed', receipt: { outcome: 'stopped' } };
      },
    });
    expect(await bridge(proposal)).toEqual({ state: 'committed', receipt: { outcome: 'stopped' } });
    expect(seen).toEqual([
      expect.objectContaining({
        taskId: 'reason-9',
        input: proposal.input,
        result: proposal.result,
      }),
    ]);
  });
});

describe('handing a turn to the strategy', () => {
  const brief = {
    kind: 'shelf_space.vendor',
    ref: { negotiationId: 'treq', turn: 1 },
    side: 'buyer' as const,
    parts: [],
    table: {},
    history: [],
    model: { constrained: [] },
    roundsLeft: 2,
  };
  const binding = (over: Partial<ReasoningBackendBinding>): ReasoningBackendBinding => ({
    backendId: 'internal',
    kind: 'internal_brain',
    principalDid: 'did:key:zInternal',
    allowedTaskKinds: ['negotiate.move'],
    maxSensitivity: 'sensitive',
    availability: 'always_on',
    policyVersion: 1,
    selectedByOwnerDid: 'did:plc:owner',
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    expiresAtMs: null,
    revokedAtMs: null,
    ...over,
  });
  const submitter = (bindings: ReasoningBackendBinding[], submit: () => { taskId: string }) =>
    createNegotiationSubmitter({
      ownerDid: () => 'did:plc:owner',
      nowMs: () => 1_000,
      getBroker: () => ({ submit }) as unknown as CoreReasoningBroker,
      getBackendRepository: () =>
        ({ list: () => bindings }) as unknown as ReasoningBackendRepository,
    });

  it('goes to the built-in Brain, never to a connected outside host', () => {
    const seen: string[] = [];
    const submit = () => {
      seen.push('submitted');
      return { taskId: 't1' };
    };
    expect(
      submitter(
        [binding({ backendId: 'host', kind: 'connected_host', availability: 'always_on' })],
        submit,
      )(brief),
    ).toBeNull();
    expect(seen).toEqual([]);
    expect(submitter([binding({})], submit)(brief)).toEqual({ taskId: 't1' });
  });

  it('any failure to hand over means no hand-over: the fixed style plays', () => {
    const throwing = () => {
      throw new Error('schema refused');
    };
    expect(submitter([binding({})], throwing)(brief)).toBeNull();
  });
});
