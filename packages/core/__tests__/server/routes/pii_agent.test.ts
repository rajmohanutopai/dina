import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerPIIRoutes } from '../../../src/server/routes/pii';

const AGENT_DID = 'did:key:z6MkCodingAgent';

function request(
  body: unknown,
  over: Partial<CoreRequest> = {},
): CoreRequest {
  return {
    method: 'POST',
    path: '/v1/agent/scrub',
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
  } as CoreRequest;
}

describe('POST /v1/agent/scrub', () => {
  const router = new CoreRouter();
  registerPIIRoutes(router);

  it('returns a local rehydration map to a coding agent', async () => {
    const response = await router.handle(request({ text: 'Email raj@example.com' }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      scrubbed: 'Email [EMAIL_1]',
      entityCount: 1,
      entities: [
        {
          token: '[EMAIL_1]',
          type: 'EMAIL',
          value: 'raj@example.com',
        },
      ],
    });
  });

  it('rejects runner scope', async () => {
    const response = await router.handle(
      request({ text: 'Email raj@example.com' }, { agentScope: 'runner' }),
    );

    expect(response).toMatchObject({ status: 403 });
  });

  it('rejects a missing authenticated DID', async () => {
    const response = await router.handle(
      request({ text: 'Email raj@example.com' }, { callerDID: undefined }),
    );

    expect(response).toMatchObject({ status: 401 });
  });

  it('rejects missing and oversized text', async () => {
    expect((await router.handle(request({}))).status).toBe(400);
    expect(
      (
        await router.handle(
          request(
            { text: 'x'.repeat(100_001) },
            { rawBody: new TextEncoder().encode('{}') },
          ),
        )
      ).status,
    ).toBe(413);
  });
});
