import {
  CONNECTED_BRAIN_TASK_KINDS,
  activeConnectedBrainForPrincipal,
  connectedBrainBackendId,
  disableConnectedBrain,
  enableConnectedBrain,
  type ConnectedBrainOwnerClient,
} from '../../src/reasoning/connected_brain_control';

import type { OwnerReasoningBackendView } from '@dina/core';

function backend(overrides: Partial<OwnerReasoningBackendView> = {}): OwnerReasoningBackendView {
  return {
    backend_id: 'connected.device-1',
    kind: 'connected_host',
    principal_did: 'did:key:agent-1',
    allowed_task_kinds: ['answer.compose'],
    max_sensitivity: 'sensitive',
    availability: 'foreground',
    model_class: 'connected-host',
    policy_version: 1,
    selected_by_owner_did: 'did:plc:owner',
    enabled: true,
    created_at: 1,
    updated_at: 1,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function client(rows: OwnerReasoningBackendView[] = []) {
  const register = jest.fn(async (request) =>
    backend({
      backend_id: request.backend_id,
      principal_did: request.principal_did,
      allowed_task_kinds: request.allowed_task_kinds,
      policy_version: (request.expected_version ?? 0) + 1,
    }),
  );
  const revoke = jest.fn(async () => ({ ok: true as const }));
  const value: ConnectedBrainOwnerClient = {
    reasoningBackends: jest.fn(async () => ({ backends: rows })),
    reasoningRegisterBackend: register,
    reasoningRevokeBackend: revoke,
  };
  return { value, register, revoke };
}

describe('connected Brain owner control', () => {
  it('registers a paired coding agent for every bounded task kind', async () => {
    const mock = client();
    const result = await enableConnectedBrain(mock.value, {
      deviceId: 'device / 1',
      did: 'did:key:agent-1',
    });

    expect(result.backend_id).toMatch(/^connected\.[a-f0-9]{64}$/);
    expect(mock.register).toHaveBeenCalledWith(
      expect.objectContaining({
        backend_id: result.backend_id,
        principal_did: 'did:key:agent-1',
        kind: 'connected_host',
        allowed_task_kinds: [...CONNECTED_BRAIN_TASK_KINDS],
        availability: 'foreground',
        expected_version: null,
      }),
    );
  });

  it('revives the stable row with optimistic concurrency instead of duplicating it', async () => {
    const old = backend({ enabled: false, revoked_at: 12, policy_version: 4 });
    const mock = client([old]);
    await enableConnectedBrain(mock.value, {
      deviceId: 'device-1',
      did: 'did:key:agent-1',
    });
    expect(mock.register).toHaveBeenCalledWith(expect.objectContaining({ expected_version: 4 }));
  });

  it('does not rewrite an already-active authorization', async () => {
    const live = backend();
    const mock = client([live]);
    await expect(
      enableConnectedBrain(mock.value, { deviceId: 'device-1', did: 'did:key:agent-1' }),
    ).resolves.toBe(live);
    expect(mock.register).not.toHaveBeenCalled();
  });

  it('uses one revoke to trigger the principal-wide cascade', async () => {
    const rows = [
      backend(),
      backend({ backend_id: 'legacy', policy_version: 3 }),
      backend({ backend_id: 'other', principal_did: 'did:key:other' }),
      backend({ backend_id: 'already-off', enabled: false, revoked_at: 5 }),
    ];
    const mock = client(rows);
    await expect(disableConnectedBrain(mock.value, 'did:key:agent-1')).resolves.toBe(2);
    expect(mock.revoke.mock.calls).toEqual([['connected.device-1', 1]]);
  });

  it('ignores revoked and expired rows when deriving the active state', () => {
    expect(
      activeConnectedBrainForPrincipal(
        [
          backend({ revoked_at: 5 }),
          backend({ backend_id: 'expired', expires_at: 99 }),
          backend({ backend_id: 'live', expires_at: 101 }),
        ],
        'did:key:agent-1',
        100,
      )?.backend_id,
    ).toBe('live');
    expect(() => connectedBrainBackendId('   ')).toThrow(/identifier/i);
    expect(connectedBrainBackendId('a/b')).not.toBe(connectedBrainBackendId('ab'));
  });
});
