/**
 * Items 5c/9/11/12 — coding-agent façade contract tests.
 *
 * Every façade: binds to the authenticated DID, is scope-gated to `coding`
 * (fail-closed on missing/`runner` scope), validates size/auth, and delegates
 * to its injected backing. A façade with no backing registers no route (404).
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import {
  registerAgentFacadeRoutes,
  type AgentFacadeContext,
  type AgentFacadeHandlers,
} from '../../../src/server/routes/agent_facades';
import { SessionRegistry, setSessionRegistry } from '../../../src/session/registry';

const AGENT_DID = 'did:key:z6MkAgent';
const OTHER_DID = 'did:key:z6MkOther';
let sessionId = '';

beforeEach(() => {
  const registry = new SessionRegistry();
  setSessionRegistry(registry);
  sessionId = registry.start({ agentDid: AGENT_DID, hostSessionId: 'host-1' }).sessionId;
});

afterEach(() => setSessionRegistry(null));

function active(body: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: sessionId, ...body };
}

function req(path: string, body: unknown, over: Partial<CoreRequest> = {}): CoreRequest {
  return {
    method: 'POST',
    path,
    headers: {},
    query: {},
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body ?? {})),
    params: {},
    trustedInProcess: true,
    callerType: 'agent',
    callerDID: AGENT_DID,
    agentScope: 'coding',
    ...over,
  } as unknown as CoreRequest;
}

function routerWith(handlers: AgentFacadeHandlers): CoreRouter {
  const r = new CoreRouter();
  registerAgentFacadeRoutes(r, handlers);
  return r;
}

const echo = (tag: string) => (ctx: AgentFacadeContext) => ({
  status: 200,
  body: { tag, agent: ctx.agentDid, session: ctx.sessionId, got: ctx.body },
});

describe('façade registration', () => {
  it('registers only the routes whose backing is provided', async () => {
    const r = routerWith({ memory: echo('memory') }); // only memory
    const hit = await r.handle(req('/v1/agent/memory', active()));
    expect(hit.status).toBe(200);
    const miss = await r.handle(req('/v1/agent/talk', active({ to: 'did:x' })));
    expect(miss.status).toBe(404); // no talk backing ⇒ unregistered
  });

  it('wires every narrow façade', async () => {
    const r = routerWith({
      memory: echo('m'),
      findService: echo('f'),
      serviceStatus: echo('s'),
      servicePublicationStatus: echo('ps'),
      servicePublish: echo('sp'),
      serviceInvoke: echo('si'),
      talk: echo('t'),
      delegate: echo('d'),
      actionStatus: echo('as'),
      peerlensSearch: echo('prs'),
      peerlensAttest: echo('pra'),
      peerlensStatus: echo('prx'),
      vaults: echo('v'),
      reminders: echo('r'),
      ask: echo('a'),
    });
    for (const p of [
      '/v1/agent/memory',
      '/v1/agent/service/search',
      '/v1/agent/service/status',
      '/v1/agent/service/publication-status',
      '/v1/agent/service/publish',
      '/v1/agent/service/invoke',
      '/v1/agent/talk',
      '/v1/agent/delegate',
      '/v1/agent/action/status',
      '/v1/agent/peerlens/search',
      '/v1/agent/peerlens/attest',
      '/v1/agent/peerlens/status',
      '/v1/agent/vaults',
      '/v1/agent/reminders',
      '/v1/agent/ask',
    ]) {
      expect((await r.handle(req(p, active()))).status).toBe(200);
    }
  });
});

describe('façade auth + scope gate', () => {
  const r = () => routerWith({ talk: echo('talk') });

  it('delegates to the backing with the authenticated DID + session', async () => {
    const res = await r().handle(req('/v1/agent/talk', active({ to: 'did:peer', message: 'hi' })));
    expect(res.body).toMatchObject({ tag: 'talk', agent: AGENT_DID, session: sessionId });
  });

  it('401 without a caller DID', async () => {
    const res = await r().handle(req('/v1/agent/talk', {}, { callerDID: undefined, headers: {} }));
    expect(res.status).toBe(401);
  });

  it('403 when the scope is missing (fail-closed)', async () => {
    const res = await r().handle(req('/v1/agent/talk', {}, { agentScope: undefined }));
    expect(res.status).toBe(403);
  });

  it('403 when a runner agent reaches a coding façade', async () => {
    const res = await r().handle(req('/v1/agent/talk', {}, { agentScope: 'runner' }));
    expect(res.status).toBe(403);
  });

  it('413 when the body is too large', async () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    const res = await r().handle(req('/v1/agent/talk', {}, { rawBody: new TextEncoder().encode(big) }));
    expect(res.status).toBe(413);
  });

  it('401 when the session is missing', async () => {
    const res = await r().handle(req('/v1/agent/talk', { to: 'did:peer' }));
    expect(res).toMatchObject({ status: 401, body: { error: 'invalid_session' } });
  });

  it('collapses unknown, foreign, and ended sessions to the same response', async () => {
    const registry = new SessionRegistry();
    setSessionRegistry(registry);
    const own = registry.start({ agentDid: AGENT_DID, hostSessionId: 'own' });
    const foreign = registry.start({ agentDid: OTHER_DID, hostSessionId: 'foreign' });
    registry.end(own.sessionId, AGENT_DID);

    const responses = await Promise.all([
      r().handle(req('/v1/agent/talk', { session_id: 'sess-unknown' })),
      r().handle(req('/v1/agent/talk', { session_id: foreign.sessionId })),
      r().handle(req('/v1/agent/talk', { session_id: own.sessionId })),
    ]);

    for (const response of responses) {
      expect(response).toMatchObject({ status: 401, body: { error: 'invalid_session' } });
    }
  });
});
