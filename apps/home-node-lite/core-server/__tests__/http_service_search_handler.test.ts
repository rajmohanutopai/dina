import type { AgentFacadeContext } from '@dina/core';

import { makeHttpServiceSearchHandler } from '../src/agent/http_service_search_handler';

const ctx: AgentFacadeContext = {
  agentDid: 'did:key:zAgent',
  sessionId: 'sess-secret',
  body: {
    session_id: 'sess-secret',
    intent: 'book a haircut',
    q: 'Alonso',
    ignored: 'must-not-cross-process',
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Core-to-Brain service-search adapter', () => {
  it('forwards only the bounded discovery DTO and strips session/provenance', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        matches: [
          {
            capability: 'appointment_book',
            service: {
              did: 'did:plc:salon',
              name: 'Alonso Salon',
              capabilities: ['appointment_book'],
            },
          },
        ],
        capability_candidates: [],
      }),
    ) as unknown as typeof fetch;
    const handler = makeHttpServiceSearchHandler({
      brainUrl: 'http://127.0.0.1:8485/',
      fetchImpl,
    });

    const result = await handler(ctx);

    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8485/api/v1/internal/service/search');
    expect(JSON.parse(String(init.body))).toEqual({
      intent: 'book a haircut',
      q: 'Alonso',
    });
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 }), 502],
    [
      'invalid result shape',
      response({ matches: [{ capability: '', service: {} }], capability_candidates: [] }),
      502,
    ],
    ['upstream unavailable', response({ error: 'down' }, 503), 503],
  ])('fails safely on %s', async (_label, upstream, expected) => {
    const handler = makeHttpServiceSearchHandler({
      brainUrl: 'http://brain',
      fetchImpl: jest.fn().mockResolvedValue(upstream) as unknown as typeof fetch,
    });
    expect((await handler(ctx)).status).toBe(expected);
  });

  it('maps transport failures and timeouts to unavailable', async () => {
    const handler = makeHttpServiceSearchHandler({
      brainUrl: 'http://brain',
      timeoutMs: 1,
      fetchImpl: jest.fn().mockRejectedValue(new Error('socket details')) as unknown as typeof fetch,
    });
    expect(await handler(ctx)).toEqual({
      status: 503,
      body: { error: 'service directory unavailable' },
    });
  });
});
