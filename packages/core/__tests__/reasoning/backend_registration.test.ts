import { ensureReasoningBackendForBoot, InMemoryReasoningBackendRepository } from '../../src';

const base = {
  backendId: 'dina.internal-brain',
  kind: 'internal_brain' as const,
  principalDid: 'did:key:z6MkInternalBrain',
  allowedTaskKinds: ['answer.compose' as const],
  maxSensitivity: 'sensitive' as const,
  availability: 'always_on' as const,
  modelClass: 'dina-internal-brain',
  selectedByOwnerDid: 'did:plc:owner',
};

describe('ensureReasoningBackendForBoot', () => {
  it('creates once and leaves an identical live policy unchanged on later boots', () => {
    const repository = new InMemoryReasoningBackendRepository();

    const first = ensureReasoningBackendForBoot(repository, { ...base, nowMs: 100 });
    const second = ensureReasoningBackendForBoot(repository, { ...base, nowMs: 200 });

    expect(first.status).toBe('created');
    expect(second.status).toBe('ready');
    expect(second.binding.policyVersion).toBe(1);
    expect(second.binding.updatedAtMs).toBe(100);
  });

  it('never revives a backend the owner revoked', () => {
    const repository = new InMemoryReasoningBackendRepository();
    const created = ensureReasoningBackendForBoot(repository, { ...base, nowMs: 100 });
    repository.revoke(base.backendId, created.binding.policyVersion, base.selectedByOwnerDid, 150);

    const result = ensureReasoningBackendForBoot(repository, { ...base, nowMs: 200 });

    expect(result.status).toBe('disabled');
    expect(result.binding.enabled).toBe(false);
    expect(result.binding.policyVersion).toBe(2);
  });

  it('does not overwrite a live but incompatible principal or policy', () => {
    const repository = new InMemoryReasoningBackendRepository();
    repository.register({
      ...base,
      principalDid: 'did:key:z6MkDifferentBrain',
      expectedVersion: null,
      nowMs: 100,
    });

    const result = ensureReasoningBackendForBoot(repository, { ...base, nowMs: 200 });

    expect(result.status).toBe('conflict');
    expect(result.binding.principalDid).toBe('did:key:z6MkDifferentBrain');
    expect(result.binding.policyVersion).toBe(1);
  });
});
