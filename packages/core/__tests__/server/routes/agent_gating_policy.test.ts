import {
  setAgentGatingPolicyRepository,
  type AgentGatingPolicy,
  type AgentGatingPolicyRepository,
  type SetAgentGatingPolicyInput,
} from '../../../src/agent/gating_policy';
import { registerDevice, resetDeviceRegistry } from '../../../src/devices/registry';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerAgentGatingPolicyRoutes } from '../../../src/server/routes/agent_gating_policy';

class MemoryPolicyRepository implements AgentGatingPolicyRepository {
  policy: AgentGatingPolicy | null = null;

  get(): AgentGatingPolicy | null {
    return this.policy;
  }
  list(): AgentGatingPolicy[] {
    return this.policy === null ? [] : [this.policy];
  }
  set(input: SetAgentGatingPolicyInput): AgentGatingPolicy {
    const now = input.nowMs ?? 100;
    const version = (this.policy?.policyVersion ?? 0) + 1;
    this.policy = {
      agentDid: input.agentDid,
      profile: input.profile,
      policyVersion: version,
      selectedByOwnerDid: input.selectedByOwnerDid,
      createdAtMs: this.policy?.createdAtMs ?? now,
      updatedAtMs: now,
      revokedAtMs: null,
    };
    return this.policy;
  }
  revoke(): boolean {
    return false;
  }
}

function req(
  method: CoreRequest['method'],
  path: string,
  body: unknown,
  capability = 'owner-cap',
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body ?? {})),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:plc:owner',
    ownerCapability: capability,
  };
}

describe('owner connected-agent policy routes', () => {
  beforeEach(() => {
    resetDeviceRegistry();
    setNodeDID('did:plc:owner');
  });
  afterEach(() => {
    resetDeviceRegistry();
    setAgentGatingPolicyRepository(null);
  });

  it('sets a versioned policy for an exact paired coding agent and invalidates permits', async () => {
    const agent = registerDevice('Claude Code', 'z6MkPolicyAgent', 'agent', 'coding');
    const repo = new MemoryPolicyRepository();
    setAgentGatingPolicyRepository(repo);
    const invalidated: string[] = [];
    const router = new CoreRouter();
    registerAgentGatingPolicyRoutes(router, 'owner-cap', (did) => invalidated.push(did));

    const result = await router.handle(
      req('PUT', `/v1/owner/agent-policies/${agent.did}`, {
        profile: 'network_protection',
        expected_version: null,
      }),
    );
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      agent_did: agent.did,
      profile: 'network_protection',
      policy_version: 1,
    });
    expect(invalidated).toEqual([agent.did]);
  });

  it('rejects a missing owner capability and a non-coding device', async () => {
    const phone = registerDevice('Phone', 'z6MkPolicyPhone', 'rich');
    setAgentGatingPolicyRepository(new MemoryPolicyRepository());
    const router = new CoreRouter();
    registerAgentGatingPolicyRoutes(router, 'owner-cap');

    const noOwner = await router.handle(
      req(
        'PUT',
        `/v1/owner/agent-policies/${phone.did}`,
        { profile: 'full_supervision', expected_version: null },
        'wrong',
      ),
    );
    expect(noOwner.status).toBe(403);

    const wrongDevice = await router.handle(
      req('PUT', `/v1/owner/agent-policies/${phone.did}`, {
        profile: 'full_supervision',
        expected_version: null,
      }),
    );
    expect(wrongDevice.status).toBe(404);
  });
});
