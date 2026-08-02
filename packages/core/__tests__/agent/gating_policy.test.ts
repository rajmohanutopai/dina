import {
  DEFAULT_OWNER_AGENT_GATING_PROFILE,
  makeUnknownAuthorityOrigin,
  parseAuthorityOrigin,
  reconcileDefaultAgentGatingPolicies,
  resolveEffectiveGatingProfile,
  setAgentGatingPolicyRepository,
  stricterGatingProfile,
  type AgentGatingPolicy,
  type AgentGatingPolicyRepository,
  type SetAgentGatingPolicyInput,
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
  afterEach(() => setAgentGatingPolicyRepository(null));

  it('uses Standard as the explicit owner-interactive default', () => {
    expect(DEFAULT_OWNER_AGENT_GATING_PROFILE).toBe('network_protection');
  });

  it('reconciles only missing active coding-agent profiles to Standard', () => {
    const policies = new Map<string, AgentGatingPolicy>();
    const repo: AgentGatingPolicyRepository = {
      get: (did) => policies.get(did) ?? null,
      list: () => [...policies.values()],
      set: (input: SetAgentGatingPolicyInput) => {
        if (policies.has(input.agentDid) || input.expectedVersion !== null) {
          throw new Error('policy conflict');
        }
        const policy: AgentGatingPolicy = {
          agentDid: input.agentDid,
          profile: input.profile,
          policyVersion: 1,
          selectedByOwnerDid: input.selectedByOwnerDid,
          createdAtMs: 10,
          updatedAtMs: 10,
          revokedAtMs: null,
        };
        policies.set(input.agentDid, policy);
        return policy;
      },
      revoke: () => false,
    };
    policies.set('did:key:existing', {
      agentDid: 'did:key:existing',
      profile: 'full_supervision',
      policyVersion: 4,
      selectedByOwnerDid: 'did:plc:owner',
      createdAtMs: 1,
      updatedAtMs: 2,
      revokedAtMs: null,
    });
    setAgentGatingPolicyRepository(repo);

    expect(
      reconcileDefaultAgentGatingPolicies('did:plc:owner', [
        { did: 'did:key:new', role: 'agent', scope: 'coding' },
        { did: 'did:key:existing', role: 'agent', scope: 'coding' },
        { did: 'did:key:runner', role: 'agent', scope: 'runner' },
        { did: 'did:key:revoked', role: 'agent', scope: 'coding', revoked: true },
      ]),
    ).toEqual({ created: 1, existing: 1, failed: 0 });
    expect(policies.get('did:key:new')).toMatchObject({
      profile: 'network_protection',
      selectedByOwnerDid: 'did:plc:owner',
    });
    expect(policies.get('did:key:existing')?.profile).toBe('full_supervision');
    expect(policies.has('did:key:runner')).toBe(false);
    expect(policies.has('did:key:revoked')).toBe(false);
  });

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
