import {
  makeUnknownAuthorityOrigin,
  parseAuthorityOrigin,
  resolveEffectiveGatingProfile,
  stricterGatingProfile,
  type AuthorityOrigin,
} from '../../src/agent/gating_policy';

const owner: AuthorityOrigin = {
  kind: 'owner_interactive',
  ownerDid: 'did:plc:owner',
  requesterDid: 'did:plc:owner',
  ingress: 'coding_host',
  correlationId: 'session-1',
  authenticatedAtMs: 100,
};

describe('connected-agent gating policy', () => {
  it.each([
    'contact_request',
    'service_request',
    'delegated_task',
    'background_job',
    'system_maintenance',
    'unknown',
  ] as const)('forces %s work to Full Supervision', (kind) => {
    expect(resolveEffectiveGatingProfile('network_protection', { ...owner, kind })).toBe(
      'full_supervision',
    );
    expect(resolveEffectiveGatingProfile('sensitive_boundaries', { ...owner, kind })).toBe(
      'full_supervision',
    );
  });

  it('honors an owner-selected foreground profile only for owner-interactive origin', () => {
    expect(resolveEffectiveGatingProfile('network_protection', owner)).toBe('network_protection');
    expect(resolveEffectiveGatingProfile('sensitive_boundaries', owner)).toBe(
      'sensitive_boundaries',
    );
  });

  it('selects only a stricter profile', () => {
    expect(stricterGatingProfile('network_protection', 'sensitive_boundaries')).toBe(
      'sensitive_boundaries',
    );
    expect(stricterGatingProfile('full_supervision', 'sensitive_boundaries')).toBe(
      'full_supervision',
    );
  });

  it('strictly parses authority evidence and rejects malformed hashes', () => {
    expect(parseAuthorityOrigin(owner)).toEqual(owner);
    expect(parseAuthorityOrigin({ ...owner, evidenceHash: 'not-a-hash' })).toBeNull();
    expect(parseAuthorityOrigin({ ...owner, ownerDid: 'owner' })).toBeNull();
  });

  it('constructs unknown provenance as a non-owner origin', () => {
    const unknown = makeUnknownAuthorityOrigin({
      ownerDid: 'did:plc:owner',
      correlationId: 'session-2',
      authenticatedAtMs: 200,
    });
    expect(unknown.kind).toBe('unknown');
    expect(resolveEffectiveGatingProfile('network_protection', unknown)).toBe('full_supervision');
  });
});
