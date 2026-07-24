/**
 * Item 6 — `/v1/session/start|end` route, now backed by the durable registry.
 *
 * Verifies DID-bound lifecycle over the wire: authenticated start (idempotent
 * per host session), own-session-only end, and wire-compat with the daemon
 * (`{session_id,status:'open'}` / `{ok:true}`).
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerSessionRoutes } from '../../../src/server/routes/session';
import { SessionRegistry, setSessionRegistry } from '../../../src/session/registry';

const A = 'did:key:z6MkAgentA';
const B = 'did:key:z6MkAgentB';

function req(
  path: string,
  body: unknown,
  callerDID?: string,
  method: CoreRequest['method'] = 'POST',
): CoreRequest {
  return {
    method,
    path,
    headers: {},
    query: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'agent',
    callerDID,
  } as unknown as CoreRequest;
}

let router: CoreRouter;
beforeEach(() => {
  setSessionRegistry(new SessionRegistry()); // fresh registry per test
  router = new CoreRouter();
  registerSessionRoutes(router);
});
afterEach(() => setSessionRegistry(null));

describe('POST /v1/session/start', () => {
  it('mints a session bound to the caller DID (wire-compat shape)', async () => {
    const res = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, A));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe('open');
    expect(typeof body.session_id).toBe('string');
    expect(typeof body.lease_expires_at).toBe('number');
  });

  it('401 without a caller DID', async () => {
    const res = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, undefined));
    expect(res.status).toBe(401);
  });

  it('is idempotent for the same (DID, host_session_id)', async () => {
    const a = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, A));
    const b = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, A));
    expect((a.body as Record<string, unknown>).session_id).toBe(
      (b.body as Record<string, unknown>).session_id,
    );
  });
});

describe('POST /v1/session/end', () => {
  it('ends the caller\'s own session (wire-compat {ok:true})', async () => {
    const start = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, A));
    const sid = (start.body as Record<string, unknown>).session_id as string;
    const end = await router.handle(req('/v1/session/end', { session_id: sid }, A));
    expect(end.status).toBe(200);
    expect(end.body).toEqual({ ok: true });
  });

  it('400 without session_id', async () => {
    const res = await router.handle(req('/v1/session/end', {}, A));
    expect(res.status).toBe(400);
  });

  it('404 when ending another agent\'s session', async () => {
    const start = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, A));
    const sid = (start.body as Record<string, unknown>).session_id as string;
    const res = await router.handle(req('/v1/session/end', { session_id: sid }, B));
    expect(res.status).toBe(404);
  });

  it('404 on an unknown session', async () => {
    const res = await router.handle(req('/v1/session/end', { session_id: 'sess-nope' }, A));
    expect(res.status).toBe(404);
  });

  it('AUDIT: foreign vs unknown end both return an IDENTICAL 404 (no existence oracle)', async () => {
    const start = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, A));
    const sid = (start.body as Record<string, unknown>).session_id as string;
    const foreign = await router.handle(req('/v1/session/end', { session_id: sid }, B)); // A's session, B asks
    const unknown = await router.handle(req('/v1/session/end', { session_id: 'sess-nope' }, B));
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    // bodies must be byte-identical — a differing `reason` would leak that sid exists
    expect(foreign.body).toEqual(unknown.body);
    expect(foreign.body).toEqual({ ok: false });
  });

  it('a second end of the same session is 404 (already ended)', async () => {
    const start = await router.handle(req('/v1/session/start', { host_session_id: 'h1' }, A));
    const sid = (start.body as Record<string, unknown>).session_id as string;
    await router.handle(req('/v1/session/end', { session_id: sid }, A));
    const res = await router.handle(req('/v1/session/end', { session_id: sid }, A));
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/sessions', () => {
  it('lists only the authenticated caller\'s active sessions', async () => {
    await router.handle(req('/v1/session/start', { host_session_id: 'a-session' }, A));
    await router.handle(req('/v1/session/start', { host_session_id: 'b-session' }, B));

    const res = await router.handle(req('/v1/sessions', undefined, A, 'GET'));
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: Array<Record<string, unknown>> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      name: 'a-session',
      status: 'active',
      grants: [],
    });
    expect(typeof sessions[0]?.session_id).toBe('string');
  });

  it('401 without a caller DID', async () => {
    const res = await router.handle(req('/v1/sessions', undefined, undefined, 'GET'));
    expect(res.status).toBe(401);
  });
});
