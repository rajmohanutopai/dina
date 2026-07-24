import { appendAudit, resetAuditState } from '../../../src/audit/service';
import { setAuditRepository } from '../../../src/audit/repository';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerAgentAuditRoutes } from '../../../src/server/routes/agent_audit';

const AGENT = 'did:key:z6MkCodingAgent';
const OTHER = 'did:key:z6MkOtherAgent';

function request(overrides: Partial<CoreRequest> = {}): CoreRequest {
  return {
    method: 'GET',
    path: '/v1/agent/audit',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'agent',
    callerDID: AGENT,
    agentScope: 'coding',
    ...overrides,
  };
}

describe('GET /v1/agent/audit', () => {
  let router: CoreRouter;

  beforeEach(() => {
    resetAuditState();
    setAuditRepository(null);
    router = new CoreRouter();
    registerAgentAuditRoutes(router);
  });

  afterEach(() => {
    resetAuditState();
    setAuditRepository(null);
  });

  it("returns only this coding agent's projected gate decisions", async () => {
    appendAudit(
      AGENT,
      'coding_gate:vcs_push',
      'Bash',
      JSON.stringify({
        risk: 'MODERATE',
        outcome: 'approval_required',
        reason: 'pushes to a remote',
        mode: 'enforce',
        secret: 'must-not-project',
      }),
      1_700_000_000,
    );
    appendAudit(OTHER, 'coding_gate:secret_read', 'Read', JSON.stringify({ risk: 'BLOCKED' }));
    appendAudit(AGENT, 'vault_query', 'health', 'private audit detail');

    const response = await router.handle(request());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      entries: [
        {
          id: 1,
          timestamp: '2023-11-14T22:13:20.000Z',
          action: 'vcs_push',
          tool: 'Bash',
          risk: 'MODERATE',
          outcome: 'approval_required',
          reason: 'pushes to a remote',
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('must-not-project');
    expect(JSON.stringify(response.body)).not.toContain(OTHER);
    expect(JSON.stringify(response.body)).not.toContain('private audit detail');
  });

  it('requires the coding scope and an authenticated DID', async () => {
    expect((await router.handle(request({ callerDID: '' }))).status).toBe(401);
    expect((await router.handle(request({ agentScope: 'runner' }))).status).toBe(403);
  });

  it('filters by action and caps the requested limit', async () => {
    for (let i = 0; i < 60; i++) {
      appendAudit(
        AGENT,
        i % 2 === 0 ? 'coding_gate:code_read' : 'coding_gate:vcs_push',
        'Tool',
        JSON.stringify({ risk: 'SAFE', outcome: 'allow' }),
      );
    }
    const response = await router.handle(
      request({ query: { action: 'code_read', limit: '5000' } }),
    );
    const entries = (response.body as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(30);
  });
});
