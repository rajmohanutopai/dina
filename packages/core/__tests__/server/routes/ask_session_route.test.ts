import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import {
  registerAskRoutes,
  type AskRouteHandler,
  type AskSubmitInput,
} from '../../../src/server/routes/ask';
import { SessionRegistry, setSessionRegistry } from '../../../src/session/registry';

const AGENT_DID = 'did:key:z6MkAgent';
const OTHER_DID = 'did:key:z6MkOther';

function req(
  method: CoreRequest['method'],
  path: string,
  body: unknown,
  query: Record<string, string> = {},
  callerDID = AGENT_DID,
): CoreRequest {
  return {
    method,
    path,
    headers: {},
    query,
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body ?? {})),
    params: {},
    trustedInProcess: true,
    callerType: 'agent',
    callerDID,
    agentScope: 'coding',
  } as CoreRequest;
}

let router: CoreRouter;
let registry: SessionRegistry;
let sessionId: string;
let handler: jest.Mocked<AskRouteHandler>;

beforeEach(() => {
  registry = new SessionRegistry();
  setSessionRegistry(registry);
  sessionId = registry.start({ agentDid: AGENT_DID, hostSessionId: 'host' }).sessionId;
  handler = {
    handleAsk: jest.fn(async (_input: AskSubmitInput) => ({
      status: 202,
      body: { status: 'in_flight', request_id: 'ask-1' },
    })),
    handleStatus: jest.fn(
      async (_id: string, _requesterDid?: string, _sessionId?: string) => ({
        status: 200,
        body: { status: 'complete', content: 'answer' },
      }),
    ),
  };
  router = new CoreRouter();
  registerAskRoutes(router, { handler });
});

afterEach(() => setSessionRegistry(null));

it('accepts an agent ask only under its live signed-body session', async () => {
  const res = await router.handle(
    req('POST', '/api/v1/ask', { prompt: 'question', session_id: sessionId }),
  );

  expect(res.status).toBe(202);
  expect(handler.handleAsk).toHaveBeenCalledWith(
    expect.objectContaining<Partial<AskSubmitInput>>({
      question: 'question',
      requesterDid: AGENT_DID,
      sessionId,
    }),
  );
});

it('rejects missing, foreign, and ended sessions uniformly', async () => {
  const foreign = registry.start({ agentDid: OTHER_DID, hostSessionId: 'foreign' });
  const ended = registry.start({ agentDid: AGENT_DID, hostSessionId: 'ended' });
  registry.end(ended.sessionId, AGENT_DID);

  for (const candidate of ['', foreign.sessionId, ended.sessionId]) {
    const res = await router.handle(
      req('POST', '/api/v1/ask', { prompt: 'question', session_id: candidate }),
    );
    expect(res).toMatchObject({ status: 401, body: { error: 'invalid_session' } });
  }
  expect(handler.handleAsk).not.toHaveBeenCalled();
});

it('binds status polling to the authenticated DID and live query session', async () => {
  const res = await router.handle(
    req(
      'GET',
      '/api/v1/ask/ask-1/status',
      undefined,
      { session_id: sessionId },
    ),
  );

  expect(res.status).toBe(200);
  expect(handler.handleStatus).toHaveBeenCalledWith('ask-1', AGENT_DID, sessionId);
});

it('does not call the status handler for an invalid session', async () => {
  const res = await router.handle(
    req(
      'GET',
      '/api/v1/ask/ask-1/status',
      undefined,
      { session_id: 'sess-unknown' },
    ),
  );

  expect(res).toMatchObject({ status: 401, body: { error: 'invalid_session' } });
  expect(handler.handleStatus).not.toHaveBeenCalled();
});
