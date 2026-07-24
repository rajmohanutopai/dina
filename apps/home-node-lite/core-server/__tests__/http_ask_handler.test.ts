import { makeHttpAskHandler } from '../src/agent/http_ask_handler';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('makeHttpAskHandler', () => {
  it('forwards authenticated requester, session, TTL, and idempotency id', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(jsonResponse(202, { status: 'in_flight', request_id: 'req-1' }));
    const handler = makeHttpAskHandler({
      brainUrl: 'http://127.0.0.1:8200/',
      fetchImpl,
    });

    const response = await handler.handleAsk({
      question: 'What do I know?',
      requesterDid: 'did:key:zAgent',
      sessionId: 'sess-1',
      ttlMs: 30_000,
      requestIdHeader: 'req-1',
    });

    expect(response.status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8200/api/v1/ask');
    expect(init?.headers).toMatchObject({ 'x-request-id': 'req-1' });
    expect(JSON.parse(String(init?.body))).toEqual({
      question: 'What do I know?',
      requesterDid: 'did:key:zAgent',
      sessionId: 'sess-1',
      ttlMs: 30_000,
    });
  });

  it('binds status polling to requester and session', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(jsonResponse(200, { status: 'complete' }));
    const handler = makeHttpAskHandler({
      brainUrl: 'http://127.0.0.1:8200',
      fetchImpl,
    });

    await handler.handleStatus('req/with slash', 'did:key:zAgent', 'sess-1');

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'http://127.0.0.1:8200/api/v1/ask/req%2Fwith%20slash/status?' +
        'requesterDid=did%3Akey%3AzAgent&sessionId=sess-1',
    );
  });

  it('returns a bounded 503 instead of throwing when Brain is unavailable', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('connection refused'));
    const handler = makeHttpAskHandler({
      brainUrl: 'http://127.0.0.1:8200',
      fetchImpl,
    });

    await expect(
      handler.handleAsk({ question: 'hello', requesterDid: 'did:key:zAgent' }),
    ).resolves.toEqual({ status: 503, body: { error: 'ask brain unavailable' } });
  });

  it('does not pass a malformed Brain response through as a successful answer', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('not-json', { status: 200 }));
    const handler = makeHttpAskHandler({
      brainUrl: 'http://127.0.0.1:8200',
      fetchImpl,
    });

    await expect(
      handler.handleAsk({ question: 'hello', requesterDid: 'did:key:zAgent' }),
    ).resolves.toEqual({
      status: 502,
      body: { error: 'brain returned a malformed response' },
    });
  });
});
