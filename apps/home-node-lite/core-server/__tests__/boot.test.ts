/**
 * Task 4.3 — ordered boot sequence tests.
 */

import {
  deriveDIDKey,
  getPublicKey,
  signRequest,
} from '@dina/core';
import {
  registerPublicKeyResolver,
  registerService,
  resetCallerTypeState,
  resetMiddlewareState,
  type WSFactory,
} from '@dina/core/runtime';

import { BOOT_STEPS, bootServer, type BootStep } from '../src/boot';

const TEST_SEED = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
const TEST_PUB = getPublicKey(TEST_SEED);
const TEST_DID = deriveDIDKey(TEST_PUB);

function registerBrainCaller(): void {
  resetMiddlewareState();
  resetCallerTypeState();
  registerPublicKeyResolver((did) => (did === TEST_DID ? TEST_PUB : null));
  registerService(TEST_DID, 'brain');
}

class FakeMsgBoxWS implements ReturnType<WSFactory> {
  public readyState = 0;
  public sent: Array<string | Uint8Array | ArrayBuffer> = [];
  public closed = false;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;

  constructor(public readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({ type: 'auth_challenge', nonce: 'test-nonce', ts: 1700000000 }),
      });
    });
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
    const text = coerceSentFrame(data);
    if (text === null) return;
    const parsed = JSON.parse(text) as { type?: string };
    if (parsed.type === 'auth_response') {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'auth_success' }) });
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'test close' });
  }
}

function coerceSentFrame(data: string | Uint8Array | ArrayBuffer): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return null;
}

function makeFakeMsgBoxFactory(instances: FakeMsgBoxWS[] = []): WSFactory {
  return (url) => {
    const ws = new FakeMsgBoxWS(url);
    instances.push(ws);
    return ws;
  };
}

function bootTestServer(instances?: FakeMsgBoxWS[]) {
  return bootServer({
    msgboxWsFactory: makeFakeMsgBoxFactory(instances),
    msgboxReadyTimeoutMs: 1_000,
  });
}

describe('ordered boot (task 4.3)', () => {
  /** Snapshot env + restore between tests (bootServer reads process.env). */
  const originalEnv = { ...process.env };
  // Each boot writes a keyfile into DINA_VAULT_DIR; use a fresh tmpdir
  // per test so seed generation always happens on a clean slate.
  beforeEach(async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-test-'));
    process.env['DINA_VAULT_DIR'] = dir;
    process.env['DINA_CORE_HOST'] = '127.0.0.1';
    process.env['DINA_CORE_PORT'] = '0'; // ephemeral
    process.env['DINA_LOG_LEVEL'] = 'silent';
  });
  afterEach(async () => {
    const fs = await import('node:fs/promises');
    const tmpDir = process.env['DINA_VAULT_DIR'];
    if (tmpDir && tmpDir.startsWith('/tmp') || tmpDir && tmpDir.includes('boot-test-')) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const k of Object.keys(process.env)) delete process.env[k];
    for (const [k, v] of Object.entries(originalEnv)) {
      if (typeof v === 'string') process.env[k] = v;
    }
    resetMiddlewareState();
    resetCallerTypeState();
    jest.restoreAllMocks();
  });

  describe('BOOT_STEPS constant', () => {
    it('enumerates the 8 canonical steps in order', () => {
      expect([...BOOT_STEPS]).toEqual([
        'config',
        'identity',
        'keystore',
        'db_open',
        'adapter_wire',
        'core_router',
        'fastify_start',
        'msgbox_connect',
      ]);
    });
  });

  describe('bootServer trace', () => {
    it('emits a trace entry for every step, in order', async () => {
      const booted = await bootTestServer();
      try {
        const seenSteps = booted.trace.steps.map((s) => s.step);
        expect(seenSteps).toEqual([...BOOT_STEPS]);
        expect(booted.trace.ok).toBe(true);
        expect(booted.trace.totalMs).toBeGreaterThanOrEqual(0);
      } finally {
        await booted.app.close();
      }
    });

    it('config + identity + fastify_start are "ok" today', async () => {
      const booted = await bootTestServer();
      try {
        const byStep: Record<BootStep, (typeof booted.trace.steps)[number]> =
          booted.trace.steps.reduce(
            (acc, s) => {
              acc[s.step] = s;
              return acc;
            },
            {} as Record<BootStep, (typeof booted.trace.steps)[number]>,
          );
        expect(byStep['config'].status).toBe('ok');
        expect(byStep['identity'].status).toBe('ok');
        expect(byStep['fastify_start'].status).toBe('ok');
        expect(byStep['fastify_start'].elapsedMs).toBeGreaterThanOrEqual(0);
      } finally {
        await booted.app.close();
      }
    });

    it('keystore / db_open / adapter_wire are "pending"', async () => {
      const booted = await bootTestServer();
      try {
        const pendingSteps = booted.trace.steps.filter((s) => s.status === 'pending');
        expect(pendingSteps.map((s) => s.step).sort()).toEqual(
          ['adapter_wire', 'db_open', 'keystore'].sort(),
        );
        for (const s of pendingSteps) {
          expect(s.pendingReason).toBeDefined();
          expect(s.pendingReason!.length).toBeGreaterThan(0);
        }
      } finally {
        await booted.app.close();
      }
    });

    it('connects to MsgBox and records the boot state', async () => {
      const instances: FakeMsgBoxWS[] = [];
      const booted = await bootTestServer(instances);
      try {
        const msgboxStep = booted.trace.steps.find((s) => s.step === 'msgbox_connect');
        expect(msgboxStep?.status).toBe('ok');
        expect(booted.msgbox.status).toBe('connected');
        expect(booted.msgbox.url).toBe('wss://test-mailbox.dinakernel.com/ws');
        expect(booted.msgbox.did).toMatch(/^did:key:z6Mk/);
        expect(instances).toHaveLength(1);
        expect(instances[0]?.url).toBe('wss://test-mailbox.dinakernel.com/ws');
        expect(instances[0]?.sent.length).toBeGreaterThan(0);
      } finally {
        await booted.app.close();
      }
    });

    it('exposes MsgBox connection state through /readyz', async () => {
      const booted = await bootTestServer();
      try {
        const res = await booted.app.inject({ method: 'GET', url: '/readyz' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          status: 'ok',
          checks: { core_router: 'ok', msgbox: 'ok' },
        });
      } finally {
        await booted.app.close();
      }
    });

    it('keeps MsgBox pending and readiness failing when explicitly disabled', async () => {
      process.env['DINA_MSGBOX_ENABLED'] = 'false';
      const booted = await bootServer();
      try {
        const msgboxStep = booted.trace.steps.find((s) => s.step === 'msgbox_connect');
        expect(msgboxStep?.status).toBe('pending');
        expect(msgboxStep?.pendingReason).toContain('DINA_MSGBOX_ENABLED=false');
        expect(booted.msgbox.status).toBe('pending');
        const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
        expect(ready.statusCode).toBe(503);
        expect(ready.json()).toEqual({
          status: 'not_ready',
          checks: { core_router: 'ok', msgbox: 'fail' },
        });
      } finally {
        await booted.app.close();
      }
    });

    it('keeps the server running but not ready when MsgBox connect fails', async () => {
      const booted = await bootServer({
        msgboxWsFactory: () => {
          throw new Error('relay unavailable');
        },
        msgboxReadyTimeoutMs: 1,
      });
      try {
        const msgboxStep = booted.trace.steps.find((s) => s.step === 'msgbox_connect');
        expect(msgboxStep?.status).toBe('pending');
        expect(msgboxStep?.pendingReason).toContain('handshake did not complete');
        expect(booted.trace.ok).toBe(true);
        expect(booted.msgbox.status).toBe('pending');

        const health = await booted.app.inject({ method: 'GET', url: '/healthz' });
        expect(health.statusCode).toBe(200);
        const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
        expect(ready.statusCode).toBe(503);
        expect(ready.json()).toEqual({
          status: 'not_ready',
          checks: { core_router: 'ok', msgbox: 'fail' },
        });
      } finally {
        await booted.app.close();
      }
    });

    it('assembles and binds the shared CoreRouter during boot', async () => {
      const booted = await bootTestServer();
      try {
        const coreRouterStep = booted.trace.steps.find((s) => s.step === 'core_router');
        expect(coreRouterStep?.status).toBe('ok');
        expect(booted.coreRouter.size()).toBeGreaterThan(0);
        expect(booted.routesBound).toBe(booted.coreRouter.size() - 1); // /healthz stays shell-owned
      } finally {
        await booted.app.close();
      }
    });

    it('booted.identity is populated when the identity step runs', async () => {
      const booted = await bootTestServer();
      try {
        expect(booted.identity).toBeDefined();
        // First boot → generated (fresh tmpdir); re-boot would be loaded.
        if (booted.identity) {
          expect(['generated', 'loaded_convenience']).toContain(booted.identity.kind);
        }
      } finally {
        await booted.app.close();
      }
    });

    it('ok flag is true when no step failed', async () => {
      const booted = await bootTestServer();
      try {
        expect(booted.trace.ok).toBe(true);
      } finally {
        await booted.app.close();
      }
    });

    it('bad config throws (config step records failed, then rethrows)', async () => {
      delete process.env['DINA_VAULT_DIR']; // break the required field
      await expect(bootServer()).rejects.toThrow(/DINA_VAULT_DIR/);
    });
  });

  describe('composition output', () => {
    it('returns {config, logger, app, trace}', async () => {
      const booted = await bootTestServer();
      try {
        expect(booted.config).toBeDefined();
        expect(booted.logger).toBeDefined();
        expect(booted.app).toBeDefined();
        expect(booted.trace).toBeDefined();
        expect(typeof booted.app.close).toBe('function');
      } finally {
        await booted.app.close();
      }
    });

    it('server is actually listening (accepts /healthz)', async () => {
      const booted = await bootTestServer();
      try {
        const res = await booted.app.inject({ method: 'GET', url: '/healthz' });
        expect(res.statusCode).toBe(200);
      } finally {
        await booted.app.close();
      }
    });

    it('serves signed CoreRouter routes through the booted Fastify process', async () => {
      registerBrainCaller();
      const booted = await bootTestServer();
      try {
        const query = 'kind=demo&state=queued';
        const headers = signRequest(
          'GET',
          '/v1/workflow/tasks',
          query,
          new Uint8Array(0),
          TEST_SEED,
          TEST_DID,
        );
        const res = await booted.app.inject({
          method: 'GET',
          url: `/v1/workflow/tasks?${query}`,
          headers,
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'workflow service not wired' });
      } finally {
        await booted.app.close();
      }
    });
  });
});
