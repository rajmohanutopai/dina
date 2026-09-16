/**
 * The `group_plan` lifecycle card (GROUP_COORDINATION §9): a view keyed by
 * the plan id, read back strictly.
 */

import { addLifecycleMessage, getThread, readLifecycle, resetThreads } from '../../src/chat/thread';

describe('group_plan lifecycle', () => {
  beforeEach(() => resetThreads());

  it('is posted as a dina message keyed by the plan id and read back typed', () => {
    const msg = addLifecycleMessage('t', '', { kind: 'group_plan', status: 'open', planId: 'gp_1', intent: "Emma's birthday" });
    expect(msg.sources).toEqual(['gp_1']);
    expect(getThread('t')).toHaveLength(1);
    expect(readLifecycle(msg)).toEqual({ kind: 'group_plan', status: 'open', planId: 'gp_1', intent: "Emma's birthday" });
  });

  it('a row without a plan id, or with a status the card does not know, is no card', () => {
    const base = { id: 'm', threadId: 't', type: 'dina' as const, content: '', timestamp: 1 };
    expect(readLifecycle({ ...base, metadata: { lifecycle: { kind: 'group_plan', status: 'open', planId: '', intent: '' } } })).toBeNull();
    expect(readLifecycle({ ...base, metadata: { lifecycle: { kind: 'group_plan', status: 'done', planId: 'gp', intent: '' } } })).toBeNull();
    expect(readLifecycle({ ...base, metadata: { lifecycle: { kind: 'group_plan', status: 'open', planId: 'gp' } } })).toBeNull();
  });
});
