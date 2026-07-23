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
    callerDID: 'did:key:z6MkAgent',
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
    const hit = await r.handle(req('/v1/agent/memory', { session_id: 's' }));
    expect(hit.status).toBe(200);
    const miss = await r.handle(req('/v1/agent/talk', { to: 'did:x' }));
    expect(miss.status).toBe(404); // no talk backing ⇒ unregistered
  });

  it('wires all six façades', async () => {
    const r = routerWith({
      memory: echo('m'),
      findService: echo('f'),
      talk: echo('t'),
      delegate: echo('d'),
      peerlens: echo('p'),
      ask: echo('a'),
    });
    for (const p of ['/v1/agent/memory', '/v1/agent/find-service', '/v1/agent/talk', '/v1/agent/delegate', '/v1/agent/peerlens', '/v1/agent/ask']) {
      expect((await r.handle(req(p, {}))).status).toBe(200);
    }
  });
});

describe('façade auth + scope gate', () => {
  const r = () => routerWith({ talk: echo('talk') });

  it('delegates to the backing with the authenticated DID + session', async () => {
    const res = await r().handle(req('/v1/agent/talk', { session_id: 'sess-9', to: 'did:peer', message: 'hi' }));
    expect(res.body).toMatchObject({ tag: 'talk', agent: 'did:key:z6MkAgent', session: 'sess-9' });
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
});
