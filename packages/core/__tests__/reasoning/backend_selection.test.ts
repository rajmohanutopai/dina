import { selectReasoningBackend } from '../../src/reasoning/backend_selection';

import type { ReasoningBackendBinding } from '../../src/reasoning/domain';

const NOW = 1_700_000_000_000;

function backend(overrides: Partial<ReasoningBackendBinding> = {}): ReasoningBackendBinding {
  return {
    backendId: 'internal',
    kind: 'internal_brain',
    principalDid: 'did:key:zInternal',
    allowedTaskKinds: ['answer.compose'],
    maxSensitivity: 'sensitive',
    availability: 'always_on',
    modelClass: 'brain',
    policyVersion: 1,
    selectedByOwnerDid: 'did:plc:owner',
    enabled: true,
    createdAtMs: NOW - 1_000,
    updatedAtMs: NOW - 1_000,
    expiresAtMs: null,
    revokedAtMs: null,
    ...overrides,
  };
}

describe('selectReasoningBackend', () => {
  it('prefers an authorized connected host, then local, internal, and remote', () => {
    const selected = selectReasoningBackend(
      [
        backend({ backendId: 'remote', kind: 'remote_provider' }),
        backend({ backendId: 'internal', kind: 'internal_brain' }),
        backend({ backendId: 'local', kind: 'local_model' }),
        backend({
          backendId: 'connected',
          kind: 'connected_host',
          availability: 'foreground',
        }),
      ],
      {
        ownerDid: 'did:plc:owner',
        taskKind: 'answer.compose',
        sensitivity: 'personal',
        nowMs: NOW,
      },
    );
    expect(selected?.backendId).toBe('connected');
  });

  it('filters revoked, expired, wrong-owner, wrong-task, and insufficient ceilings', () => {
    const selected = selectReasoningBackend(
      [
        backend({ backendId: 'revoked', revokedAtMs: NOW - 1 }),
        backend({ backendId: 'expired', expiresAtMs: NOW }),
        backend({ backendId: 'other-owner', selectedByOwnerDid: 'did:plc:other' }),
        backend({ backendId: 'wrong-task', allowedTaskKinds: ['intent.route'] }),
        backend({ backendId: 'personal-only', maxSensitivity: 'personal' }),
      ],
      {
        ownerDid: 'did:plc:owner',
        taskKind: 'answer.compose',
        sensitivity: 'sensitive',
        nowMs: NOW,
      },
    );
    expect(selected).toBeNull();
  });

  it('uses freshness and then a stable id tie-break within one class', () => {
    const selected = selectReasoningBackend(
      [
        backend({ backendId: 'a', updatedAtMs: NOW }),
        backend({ backendId: 'b', updatedAtMs: NOW + 1 }),
      ],
      {
        ownerDid: 'did:plc:owner',
        taskKind: 'answer.compose',
        sensitivity: 'personal',
        nowMs: NOW,
      },
    );
    expect(selected?.backendId).toBe('b');
  });

  it('falls through to a lower-priority backend when the preferred runtime is absent', () => {
    const selected = selectReasoningBackend(
      [
        backend({
          backendId: 'connected',
          kind: 'connected_host',
          availability: 'foreground',
        }),
        backend({ backendId: 'internal', kind: 'internal_brain' }),
      ],
      {
        ownerDid: 'did:plc:owner',
        taskKind: 'answer.compose',
        sensitivity: 'personal',
        nowMs: NOW,
        isRuntimeAvailable: (binding) => binding.backendId === 'internal',
      },
    );
    expect(selected?.backendId).toBe('internal');
  });
});
