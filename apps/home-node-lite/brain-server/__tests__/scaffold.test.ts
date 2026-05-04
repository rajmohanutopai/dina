/**
 * Task 5.1 scaffold — proves config loads, boot returns, /healthz
 * responds 200, and close resolves.
 *
 * Uses `port: 0` throughout to let the OS pick a free port — avoids
 * flakiness on CI when 18200 is bound by another test.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AskCoordinator, LLMProvider } from '@dina/brain';

import { bootServer, ConfigError, loadConfig } from '../src/main';

describe('brain-server — config (task 5.1/5.4 scaffold)', () => {
  it('loads defaults from empty env', () => {
    const c = loadConfig({});
    expect(c.core).toEqual({
      baseUrl: 'http://127.0.0.1:8100',
      serviceKeyDir: './service_keys',
      serviceKeyFile: 'brain.ed25519',
      httpTimeoutMs: 10000,
    });
    expect(c.endpoints).toEqual({
      mode: 'test',
      msgboxWsUrl: 'wss://test-mailbox.dinakernel.com/ws',
      pdsBaseUrl: 'https://test-pds.dinakernel.com',
      appViewBaseUrl: 'https://test-appview.dinakernel.com',
      plcDirectoryUrl: 'https://plc.directory',
    });
    expect(c.llm).toEqual({ provider: 'none' });
    expect(c.network.host).toBe('127.0.0.1');
    expect(c.network.port).toBe(8200);
    expect(c.runtime.logLevel).toBe('info');
    expect(c.runtime.prettyLogs).toBe(false);
  });

  it('honours DINA_BRAIN_HOST + PORT overrides', () => {
    const c = loadConfig({ DINA_BRAIN_HOST: '0.0.0.0', DINA_BRAIN_PORT: '8200' });
    expect(c.network.host).toBe('0.0.0.0');
    expect(c.network.port).toBe(8200);
  });

  it('throws ConfigError on invalid log level', () => {
    expect(() => loadConfig({ DINA_BRAIN_LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });

  it('throws ConfigError on out-of-range port', () => {
    expect(() => loadConfig({ DINA_BRAIN_PORT: '99999' })).toThrow(ConfigError);
  });

  it('prettyLogs=true when env flag is the string "true"', () => {
    const c = loadConfig({ DINA_BRAIN_PRETTY_LOGS: 'true' });
    expect(c.runtime.prettyLogs).toBe(true);
  });

  it('uses release endpoint defaults when DINA_ENDPOINT_MODE=release', () => {
    const c = loadConfig({ DINA_ENDPOINT_MODE: 'release' });
    expect(c.endpoints).toMatchObject({
      mode: 'release',
      msgboxWsUrl: 'wss://mailbox.dinakernel.com/ws',
      pdsBaseUrl: 'https://pds.dinakernel.com',
      appViewBaseUrl: 'https://appview.dinakernel.com',
    });
  });

  it('throws ConfigError on invalid shared endpoint config', () => {
    expect(() => loadConfig({ DINA_APPVIEW_URL: 'appview' })).toThrow(ConfigError);
  });

  it('honours Core URL and service-key config', () => {
    const c = loadConfig({
      DINA_CORE_URL: 'http://core.example:8100/',
      DINA_SERVICE_KEY_DIR: '/keys',
      DINA_BRAIN_SERVICE_KEY_FILE: 'brain-test.ed25519',
      DINA_BRAIN_DID: 'did:key:z6MkBrain',
      DINA_CORE_HTTP_TIMEOUT_MS: '2500',
    });
    expect(c.core).toEqual({
      baseUrl: 'http://core.example:8100',
      serviceKeyDir: '/keys',
      serviceKeyFile: 'brain-test.ed25519',
      serviceDid: 'did:key:z6MkBrain',
      httpTimeoutMs: 2500,
    });
  });

  it('throws ConfigError on invalid Core URL', () => {
    expect(() => loadConfig({ DINA_CORE_URL: 'core' })).toThrow(ConfigError);
    expect(() => loadConfig({ DINA_CORE_URL: 'ftp://core.example' })).toThrow(ConfigError);
  });

  it('throws ConfigError on invalid Core service-key config', () => {
    expect(() => loadConfig({ DINA_BRAIN_DID: 'brain' })).toThrow(ConfigError);
    expect(() => loadConfig({ DINA_BRAIN_SERVICE_KEY_FILE: '../brain.ed25519' })).toThrow(
      ConfigError,
    );
  });

  it('honours Gemini LLM provider config', () => {
    const c = loadConfig({
      DINA_BRAIN_LLM_PROVIDER: 'gemini',
      DINA_GEMINI_API_KEY: 'test-key',
      DINA_GEMINI_MODEL: 'gemini-test-model',
    });
    expect(c.llm).toEqual({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-test-model',
    });
  });

  it('throws ConfigError when an explicit LLM provider is incomplete or unknown', () => {
    expect(() => loadConfig({ DINA_BRAIN_LLM_PROVIDER: 'gemini' })).toThrow(ConfigError);
    expect(() => loadConfig({ DINA_BRAIN_LLM_PROVIDER: 'openai' })).toThrow(ConfigError);
  });
});

describe('brain-server — boot (task 5.1)', () => {
  it('boots, serves health/readiness, closes cleanly', async () => {
    const booted = await bootServer({
      DINA_BRAIN_HOST: '127.0.0.1',
      DINA_BRAIN_PORT: '0', // OS-assigned
      DINA_BRAIN_LOG_LEVEL: 'silent',
      DINA_BRAIN_PRETTY_LOGS: 'false',
    });
    try {
      expect(booted.boundAddress).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const res = await booted.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', role: 'brain' });

      const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({
        status: 'not_ready',
        role: 'brain',
        checks: {
          appView: 'ok',
          core: 'fail',
          askRoutes: 'disabled',
          serviceRuntime: 'disabled',
          stagingDrain: 'disabled',
          runtime: 'fail',
        },
      });
    } finally {
      await booted.app.close();
    }
  });

  it('config object is returned unchanged on the booted instance', async () => {
    const booted = await bootServer({
      DINA_BRAIN_HOST: '127.0.0.1',
      DINA_BRAIN_PORT: '0',
      DINA_BRAIN_LOG_LEVEL: 'silent',
      DINA_BRAIN_PRETTY_LOGS: 'false',
    });
    try {
      expect(booted.config.network.host).toBe('127.0.0.1');
      expect(booted.config.network.port).toBe(0);
    } finally {
      await booted.app.close();
    }
  });

  it('constructs AppView from the shared endpoint config without network on boot', async () => {
    const originalFetch = globalThis.fetch;
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ services: [] })));
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;
    let booted: Awaited<ReturnType<typeof bootServer>> | undefined;
    try {
      booted = await bootServer({
        DINA_BRAIN_HOST: '127.0.0.1',
        DINA_BRAIN_PORT: '0',
        DINA_BRAIN_LOG_LEVEL: 'silent',
        DINA_BRAIN_PRETTY_LOGS: 'false',
        DINA_APPVIEW_URL: 'https://brain-appview.example',
      });
      expect(fetchFn).not.toHaveBeenCalled();

      await booted.clients.appView.searchServices({ capability: 'eta_query' });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url] = fetchFn.mock.calls[0] as unknown as [string];
      expect(url).toBe(
        'https://brain-appview.example/xrpc/com.dina.service.search?capability=eta_query',
      );
    } finally {
      await booted?.app.close();
      globalThis.fetch = originalFetch;
    }
  });

  it('registers ask routes when an ask coordinator is supplied', async () => {
    const handleAsk = jest.fn(async () => ({
      kind: 'fast_path' as const,
      status: 200 as const,
      body: {
        request_id: 'ask-boot-test',
        status: 'complete' as const,
        answer: { text: 'boot route is wired' },
      },
    }));
    const coordinator = {
      handleAsk,
      handleStatus: jest.fn(async () => ({
        kind: 'found' as const,
        status: 200 as const,
        body: {
          request_id: 'ask-boot-test',
          status: 'complete' as const,
          created_at_ms: 1,
          updated_at_ms: 2,
          deadline_ms: 3,
          answer: { text: 'boot route is wired' },
        },
      })),
      gateway: {} as never,
      registry: {} as never,
      resumer: {} as never,
      subscribe: jest.fn(() => jest.fn()),
    } satisfies AskCoordinator;

    const booted = await bootServer(
      {
        DINA_BRAIN_HOST: '127.0.0.1',
        DINA_BRAIN_PORT: '0',
        DINA_BRAIN_LOG_LEVEL: 'silent',
        DINA_BRAIN_PRETTY_LOGS: 'false',
      },
      { askCoordinator: coordinator },
    );
    try {
      expect(booted.dependencyStatus.askRoutes).toBe('configured');

      const ask = await booted.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        headers: { 'x-request-id': 'ASK-BOOT-TEST' },
        payload: {
          question: 'is the route wired?',
          requesterDid: 'did:key:zBootRouteTester',
        },
      });
      expect(ask.statusCode).toBe(200);
      expect(ask.json()).toEqual({
        request_id: 'ask-boot-test',
        status: 'complete',
        answer: { text: 'boot route is wired' },
      });
      expect(handleAsk).toHaveBeenCalledWith({
        question: 'is the route wired?',
        requesterDid: 'did:key:zBootRouteTester',
        requestIdHeader: 'ASK-BOOT-TEST',
      });

      const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        checks: {
          appView: 'ok',
          core: 'fail',
          askRoutes: 'ok',
          stagingDrain: 'disabled',
          runtime: 'fail',
        },
      });
    } finally {
      await booted.app.close();
    }
  });

  it('builds and registers the ask coordinator from server runtime dependencies', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'dina-brain-key-'));
    const seed = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
    await writeFile(join(keyDir, 'brain.ed25519'), seed);

    const provider: LLMProvider = {
      name: 'scripted',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      chat: jest.fn(async () => ({
        content: 'server coordinator answered',
        toolCalls: [],
        model: 'scripted',
        usage: { inputTokens: 3, outputTokens: 4 },
        finishReason: 'end' as const,
      })),
      stream: () => {
        throw new Error('not used');
      },
      embed: async () => {
        throw new Error('not used');
      },
    };

    const originalFetch = globalThis.fetch;
    const fetchFn = jest.fn(async (url: string) => {
      return new Response(JSON.stringify({ error: `unexpected url ${url}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;
    const oldGoogleApiKey = process.env.GOOGLE_API_KEY;
    const oldGeminiApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const timerHandle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => timerHandle);
    const clearIntervalFn = jest.fn();
    let booted: Awaited<ReturnType<typeof bootServer>> | undefined;
    try {
      booted = await bootServer(
        {
          DINA_BRAIN_HOST: '127.0.0.1',
          DINA_BRAIN_PORT: '0',
          DINA_BRAIN_LOG_LEVEL: 'silent',
          DINA_BRAIN_PRETTY_LOGS: 'false',
          DINA_CORE_URL: 'http://core.example:8100/',
          DINA_SERVICE_KEY_DIR: keyDir,
        },
        {
          askRuntime: { llm: provider, providerName: 'gemini' },
          setInterval: setIntervalFn,
          clearInterval: clearIntervalFn,
        },
      );

      expect(booted.compositions.ask).toBeDefined();
      expect(booted.dependencyStatus.askRoutes).toBe('configured');

      const ask = await booted.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: {
          question: 'does boot compose ask?',
          requesterDid: 'did:key:zBootRuntimeTester',
        },
      });
      expect(ask.statusCode).toBe(200);
      expect(ask.json()).toMatchObject({
        status: 'complete',
        answer: { text: 'server coordinator answered' },
      });
      expect(provider.chat).toHaveBeenCalledTimes(1);

      const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        checks: {
          appView: 'ok',
          core: 'ok',
          askRoutes: 'ok',
          stagingDrain: 'ok',
          runtime: 'fail',
        },
      });
    } finally {
      await booted?.app.close();
      if (booted !== undefined) {
        expect(clearIntervalFn).toHaveBeenCalledWith(timerHandle);
      }
      globalThis.fetch = originalFetch;
      restoreEnvValue('GOOGLE_API_KEY', oldGoogleApiKey);
      restoreEnvValue('GEMINI_API_KEY', oldGeminiApiKey);
      await rm(keyDir, { recursive: true, force: true });
    }
  });

  it('builds ask runtime from config when Gemini is explicitly configured', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'dina-brain-key-'));
    const seed = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
    await writeFile(join(keyDir, 'brain.ed25519'), seed);

    const originalFetch = globalThis.fetch;
    const fetchFn = jest.fn(async (url: string) => {
      return new Response(JSON.stringify({ error: `unexpected url ${url}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;
    const oldGoogleApiKey = process.env.GOOGLE_API_KEY;
    const oldGeminiApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const timerHandle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => timerHandle);
    const clearIntervalFn = jest.fn();
    let booted: Awaited<ReturnType<typeof bootServer>> | undefined;
    try {
      booted = await bootServer(
        {
          DINA_BRAIN_HOST: '127.0.0.1',
          DINA_BRAIN_PORT: '0',
          DINA_BRAIN_LOG_LEVEL: 'silent',
          DINA_BRAIN_PRETTY_LOGS: 'false',
          DINA_CORE_URL: 'http://core.example:8100/',
          DINA_SERVICE_KEY_DIR: keyDir,
          DINA_BRAIN_LLM_PROVIDER: 'gemini',
          DINA_GEMINI_API_KEY: 'test-key',
          DINA_GEMINI_MODEL: 'gemini-test-model',
        },
        { setInterval: setIntervalFn, clearInterval: clearIntervalFn },
      );

      expect(booted.config.llm).toEqual({
        provider: 'gemini',
        apiKey: 'test-key',
        model: 'gemini-test-model',
      });
      expect(booted.compositions.ask).toBeDefined();
      expect(booted.dependencyStatus.askRoutes).toBe('configured');
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await booted?.app.close();
      if (booted !== undefined) {
        expect(clearIntervalFn).toHaveBeenCalledWith(timerHandle);
      }
      globalThis.fetch = originalFetch;
      restoreEnvValue('GOOGLE_API_KEY', oldGoogleApiKey);
      restoreEnvValue('GEMINI_API_KEY', oldGeminiApiKey);
      await rm(keyDir, { recursive: true, force: true });
    }
  });

  it('composes the shared service runtime when dependencies are supplied', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'dina-brain-key-'));
    const seed = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
    await writeFile(join(keyDir, 'brain.ed25519'), seed);

    const originalFetch = globalThis.fetch;
    const fetchFn = jest.fn(async (url: string) => {
      if (url === 'http://core.example:8100/v1/staging/claim?limit=10') {
        return new Response(JSON.stringify({ items: [], count: 0 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('http://core.example:8100/v1/workflow/events')) {
        return new Response(JSON.stringify({ events: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('http://core.example:8100/v1/workflow/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: `unexpected url ${url}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;
    const timerHandles = [{ id: 'staging' }, { id: 'events' }, { id: 'approvals' }];
    const setIntervalFn = jest.fn(() => timerHandles.shift()!);
    const clearIntervalFn = jest.fn();
    let booted: Awaited<ReturnType<typeof bootServer>> | undefined;
    try {
      booted = await bootServer(
        {
          DINA_BRAIN_HOST: '127.0.0.1',
          DINA_BRAIN_PORT: '0',
          DINA_BRAIN_LOG_LEVEL: 'silent',
          DINA_BRAIN_PRETTY_LOGS: 'false',
          DINA_CORE_URL: 'http://core.example:8100/',
          DINA_SERVICE_KEY_DIR: keyDir,
        },
        {
          serviceRuntime: {
            readConfig: () => null,
            rejectResponder: jest.fn(),
            deliver: jest.fn(),
            workflowEventIntervalMs: 25,
            approvalReconcileIntervalMs: 50,
          },
          setInterval: setIntervalFn,
          clearInterval: clearIntervalFn,
        },
      );

      expect(booted.dependencyStatus.serviceRuntime).toBe('configured');
      expect(booted.compositions.service).toBeDefined();
      expect(booted.compositions.service?.dispatcher.registeredTypes()).toEqual([
        'service.query',
      ]);
      expect(setIntervalFn).toHaveBeenNthCalledWith(2, expect.any(Function), 25);
      expect(setIntervalFn).toHaveBeenNthCalledWith(3, expect.any(Function), 50);
      await Promise.all([
        booted.schedulers.stagingDrain!.flush(),
        booted.compositions.service!.flush(),
      ]);

      const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        checks: {
          appView: 'ok',
          core: 'ok',
          serviceRuntime: 'ok',
          stagingDrain: 'ok',
          runtime: 'fail',
        },
      });
    } finally {
      await booted?.app.close();
      if (booted !== undefined) {
        expect(clearIntervalFn).toHaveBeenCalledTimes(3);
      }
      globalThis.fetch = originalFetch;
      await rm(keyDir, { recursive: true, force: true });
    }
  });

  it('constructs a signed CoreClient when the Brain service key is provisioned', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'dina-brain-key-'));
    const seed = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
    await writeFile(join(keyDir, 'brain.ed25519'), seed);

    const originalFetch = globalThis.fetch;
    const fetchFn = jest.fn(async (url: string) => {
      if (url === 'http://core.example:8100/v1/staging/claim?limit=10') {
        return new Response(JSON.stringify({ items: [], count: 0 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'http://core.example:8100/healthz') {
        return new Response(JSON.stringify({ status: 'ok', did: 'did:plc:core', version: 'test' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: `unexpected url ${url}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;
    const timerHandle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => timerHandle);
    const clearIntervalFn = jest.fn();
    let booted: Awaited<ReturnType<typeof bootServer>> | undefined;
    try {
      booted = await bootServer(
        {
          DINA_BRAIN_HOST: '127.0.0.1',
          DINA_BRAIN_PORT: '0',
          DINA_BRAIN_LOG_LEVEL: 'silent',
          DINA_BRAIN_PRETTY_LOGS: 'false',
          DINA_CORE_URL: 'http://core.example:8100/',
          DINA_SERVICE_KEY_DIR: keyDir,
        },
        { setInterval: setIntervalFn, clearInterval: clearIntervalFn },
      );

      expect(booted.clients.core).toBeDefined();
      expect(booted.dependencyStatus.core).toBe('configured');
      expect(booted.dependencyStatus.stagingDrain).toBe('running');
      expect(booted.schedulers.stagingDrain).toBeDefined();
      expect(setIntervalFn).toHaveBeenCalledTimes(1);
      expect(timerHandle.unref).toHaveBeenCalledTimes(1);
      await booted.schedulers.stagingDrain!.flush();

      const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        checks: {
          appView: 'ok',
          core: 'ok',
          stagingDrain: 'ok',
          runtime: 'fail',
        },
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[0]?.[0]).toBe('http://core.example:8100/v1/staging/claim?limit=10');
      fetchFn.mockClear();

      await booted.clients.core!.healthz();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://core.example:8100/healthz');
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-did']).toMatch(/^did:key:z/);
      expect(headers['x-signature']).toMatch(/^[0-9a-f]{128}$/);
      expect(headers['x-nonce']).toMatch(/^[0-9a-f]{32}$/);
      expect(headers['x-timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await booted?.app.close();
      if (booted !== undefined) {
        expect(clearIntervalFn).toHaveBeenCalledWith(timerHandle);
      }
      globalThis.fetch = originalFetch;
      await rm(keyDir, { recursive: true, force: true });
    }
  });

  it('does not construct CoreClient when configured did:key does not match the service key', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'dina-brain-key-'));
    const seed = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
    await writeFile(join(keyDir, 'brain.ed25519'), seed);

    const booted = await bootServer({
      DINA_BRAIN_HOST: '127.0.0.1',
      DINA_BRAIN_PORT: '0',
      DINA_BRAIN_LOG_LEVEL: 'silent',
      DINA_BRAIN_PRETTY_LOGS: 'false',
      DINA_SERVICE_KEY_DIR: keyDir,
      DINA_BRAIN_DID: 'did:key:z6MkWrong',
    });
    try {
      expect(booted.clients.core).toBeUndefined();
      expect(booted.dependencyStatus.core).toBe('service_did_mismatch');
    } finally {
      await booted.app.close();
      await rm(keyDir, { recursive: true, force: true });
    }
  });
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
