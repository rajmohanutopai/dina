/**
 * The guard workers at boot (UCP plan §3.11, S19): where a model is
 * configured, Brain starts the A2A and (with DINA_UCP_ENABLED) UCP guard
 * workers on ONE slot pool, so the node never runs more than 4 guard calls at
 * once; close stops both. With UCP off, only the A2A worker runs.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { A2AGuardWorker, GuardSlots, UcpGuardWorker } from '@dina/brain';

import { bootServer } from '../src/main';

import type { LLMProvider } from '@dina/brain';

const provider: LLMProvider = {
  name: 'scripted',
  supportsStreaming: false,
  supportsToolCalling: true,
  supportsEmbedding: false,
  chat: async () => ({
    content: '',
    toolCalls: [],
    model: 'scripted',
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: 'end' as const,
  }),
  stream: () => {
    throw new Error('not used');
  },
  embed: async () => {
    throw new Error('not used');
  },
};

it('both guard workers start on one GuardSlots, and close stops both', async () => {
  const keyDir = await mkdtemp(join(tmpdir(), 'dina-brain-key-'));
  await writeFile(
    join(keyDir, 'brain.ed25519'),
    Uint8Array.from({ length: 32 }, (_v, i) => i + 1),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })) as typeof fetch;
  const slotsOf = new Map<string, unknown>();
  const stopped: string[] = [];
  jest.spyOn(A2AGuardWorker.prototype, 'start').mockImplementation(function (this: A2AGuardWorker) {
    slotsOf.set('a2a', (this as unknown as { opts: { slots?: unknown } }).opts.slots);
  });
  jest.spyOn(UcpGuardWorker.prototype, 'start').mockImplementation(function (this: UcpGuardWorker) {
    slotsOf.set('ucp', (this as unknown as { opts: { slots: unknown } }).opts.slots);
  });
  // Each stop records when it began, then waits: both must begin before either ends.
  let endA2A: () => void = () => undefined;
  jest.spyOn(A2AGuardWorker.prototype, 'stop').mockImplementation(async () => {
    stopped.push('a2a began');
    await new Promise<void>((r) => {
      endA2A = r;
      setTimeout(r, 50);
    });
    stopped.push('a2a ended');
  });
  jest.spyOn(UcpGuardWorker.prototype, 'stop').mockImplementation(async () => {
    stopped.push('ucp began');
    endA2A();
    stopped.push('ucp ended');
  });
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
        DINA_BRAIN_CALLER_AUTH: 'off',
        DINA_UCP_ENABLED: '1',
      },
      {
        askRuntime: { llm: provider, providerName: 'gemini' },
        setInterval: () => ({ unref: () => undefined }),
        clearInterval: () => undefined,
      },
    );
    const a2a = slotsOf.get('a2a');
    expect(a2a).toBeInstanceOf(GuardSlots);
    expect(slotsOf.get('ucp')).toBe(a2a);
    expect((a2a as GuardSlots).limit).toBe(4);
  } finally {
    await booted?.app.close();
    globalThis.fetch = originalFetch;
    await rm(keyDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  }
  // The UCP worker's stop began while the A2A worker's was still waiting.
  expect(stopped.indexOf('ucp began')).toBeLessThan(stopped.indexOf('a2a ended'));
  expect(stopped).toHaveLength(4);
});

it('with UCP off, only the A2A guard worker starts', async () => {
  const keyDir = await mkdtemp(join(tmpdir(), 'dina-brain-key-'));
  await writeFile(
    join(keyDir, 'brain.ed25519'),
    Uint8Array.from({ length: 32 }, (_v, i) => i + 1),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })) as typeof fetch;
  const started: string[] = [];
  jest.spyOn(A2AGuardWorker.prototype, 'start').mockImplementation(() => {
    started.push('a2a');
  });
  jest.spyOn(UcpGuardWorker.prototype, 'start').mockImplementation(() => {
    started.push('ucp');
  });
  jest.spyOn(A2AGuardWorker.prototype, 'stop').mockResolvedValue(undefined);
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
        DINA_BRAIN_CALLER_AUTH: 'off',
      },
      {
        askRuntime: { llm: provider, providerName: 'gemini' },
        setInterval: () => ({ unref: () => undefined }),
        clearInterval: () => undefined,
      },
    );
    expect(started).toEqual(['a2a']);
  } finally {
    await booted?.app.close();
    globalThis.fetch = originalFetch;
    await rm(keyDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  }
});
