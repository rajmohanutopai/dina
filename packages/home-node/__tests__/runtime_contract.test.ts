import {
  HomeNodeFeatureUnavailableError,
  createHomeNodeRuntime,
  pdsHostForEndpoints,
  resolveHostedDinaEndpoints,
  resolveMobileHostedDinaEndpoints,
  resolveServerHostedDinaEndpoints,
} from '../src';

describe('@dina/home-node runtime contract', () => {
  it('resolves hosted endpoints as one mode switch', () => {
    expect(resolveHostedDinaEndpoints('test')).toEqual({
      mode: 'test',
      msgboxWsUrl: 'wss://test-mailbox.dinakernel.com/ws',
      pdsBaseUrl: 'https://test-pds.dinakernel.com',
      appViewBaseUrl: 'https://test-appview.dinakernel.com',
      plcDirectoryUrl: 'https://plc.directory',
    });
    expect(resolveHostedDinaEndpoints('release')).toEqual({
      mode: 'release',
      msgboxWsUrl: 'wss://mailbox.dinakernel.com/ws',
      pdsBaseUrl: 'https://pds.dinakernel.com',
      appViewBaseUrl: 'https://appview.dinakernel.com',
      plcDirectoryUrl: 'https://plc.directory',
    });
  });

  it('resolves mobile and server env overrides with the same mode rules', () => {
    expect(resolveMobileHostedDinaEndpoints({}).mode).toBe('test');
    expect(
      resolveMobileHostedDinaEndpoints({ EXPO_PUBLIC_DINA_ENDPOINT_MODE: 'release' }),
    ).toMatchObject({
      mode: 'release',
      msgboxWsUrl: 'wss://mailbox.dinakernel.com/ws',
      pdsBaseUrl: 'https://pds.dinakernel.com',
      appViewBaseUrl: 'https://appview.dinakernel.com',
    });
    expect(
      resolveServerHostedDinaEndpoints({
        DINA_ENDPOINT_MODE: 'test',
        DINA_MSGBOX_URL: 'wss://mailbox.local/ws',
        DINA_PDS_URL: 'https://pds.local/',
        DINA_APPVIEW_URL: 'https://appview.local/',
        DINA_PLC_URL: 'https://plc.local/',
      }),
    ).toEqual({
      mode: 'test',
      msgboxWsUrl: 'wss://mailbox.local/ws',
      pdsBaseUrl: 'https://pds.local',
      appViewBaseUrl: 'https://appview.local',
      plcDirectoryUrl: 'https://plc.local',
    });
  });

  it('derives the handle host from the selected PDS endpoint', () => {
    expect(pdsHostForEndpoints(resolveHostedDinaEndpoints('test'))).toBe(
      'test-pds.dinakernel.com',
    );
    expect(pdsHostForEndpoints(resolveHostedDinaEndpoints('release'))).toBe(
      'pds.dinakernel.com',
    );
  });

  it('fails loud on invalid endpoint env', () => {
    expect(() =>
      resolveServerHostedDinaEndpoints({ DINA_ENDPOINT_MODE: 'prod' }),
    ).toThrow(/DINA_ENDPOINT_MODE/);
    expect(() => resolveMobileHostedDinaEndpoints({ EXPO_PUBLIC_DINA_PDS_URL: 'pds' }))
      .toThrow(/EXPO_PUBLIC_DINA_PDS_URL/);
    expect(() => resolveServerHostedDinaEndpoints({ DINA_MSGBOX_URL: 'https://msgbox.test' }))
      .toThrow(/DINA_MSGBOX_URL protocol/);
  });

  it('delegates lifecycle and feature handlers through one runtime context', async () => {
    const events: string[] = [];
    const endpoints = resolveHostedDinaEndpoints('test');
    const runtime = createHomeNodeRuntime({
      nodeId: 'did:plc:node',
      formFactor: 'mobile',
      endpoints,
      lifecycle: {
        start: (ctx) => {
          events.push(`start:${ctx.formFactor}:${ctx.endpoints.mode}`);
        },
        stop: (ctx) => {
          events.push(`stop:${ctx.nodeId}`);
        },
        dependencies: () => ({ msgbox: { state: 'ready' } }),
      },
      handlers: {
        remember: (input, ctx) => ({
          status: 'accepted',
          stagingId: `${ctx.formFactor}:${input.text}`,
        }),
        ask: (input) => ({
          status: 'complete',
          requestId: input.requestId ?? 'ask-1',
          answer: { text: `answer:${input.question}` },
        }),
      },
    });

    await runtime.start();
    await runtime.start();
    await expect(runtime.remember({ text: 'Emma likes dinosaurs' })).resolves.toEqual({
      status: 'accepted',
      stagingId: 'mobile:Emma likes dinosaurs',
    });
    await expect(
      runtime.ask({ question: 'What does Emma like?', requesterDid: 'did:key:user' }),
    ).resolves.toMatchObject({
      status: 'complete',
      answer: { text: 'answer:What does Emma like?' },
    });
    await expect(runtime.status()).resolves.toMatchObject({
      nodeId: 'did:plc:node',
      formFactor: 'mobile',
      state: 'running',
      endpoints,
      dependencies: { msgbox: { state: 'ready' } },
      features: {
        remember: { state: 'ready' },
        ask: { state: 'ready' },
        trust_publish: { state: 'missing' },
        service_query: { state: 'missing' },
      },
    });
    await runtime.stop();
    await runtime.stop();

    expect(events).toEqual(['start:mobile:test', 'stop:did:plc:node']);
  });

  it('fails explicitly when a feature has not been wired', async () => {
    const runtime = createHomeNodeRuntime({
      nodeId: 'did:plc:server',
      formFactor: 'server',
      endpoints: resolveHostedDinaEndpoints('release'),
    });

    await expect(runtime.remember({ text: 'hello' })).rejects.toThrow(
      HomeNodeFeatureUnavailableError,
    );
    await expect(runtime.queryService({ toDid: 'did:plc:p', capability: 'eta', params: {} }))
      .rejects.toMatchObject({ feature: 'service_query' });
  });

  it('rejects an empty node id', () => {
    expect(() =>
      createHomeNodeRuntime({
        nodeId: '   ',
        formFactor: 'mobile',
        endpoints: resolveHostedDinaEndpoints('test'),
      }),
    ).toThrow(/nodeId is required/);
  });
});
