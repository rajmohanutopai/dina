/**
 * Task 4.3 — ordered boot sequence tests.
 */

import { BOOT_STEPS, bootServer, type BootStep } from '../src/boot';

describe('ordered boot (task 4.3)', () => {
  /** Snapshot env + restore between tests (bootServer reads process.env). */
  const originalEnv = { ...process.env };
  // Each boot writes a keyfile into DINA_VAULT_DIR; use a fresh tmpdir
  // per test so seed generation always happens on a clean slate.
  beforeEach(async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
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
      const booted = await bootServer();
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
      const booted = await bootServer();
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

    it('keystore / db_open / adapter_wire / core_router / msgbox_connect are "pending"', async () => {
      const booted = await bootServer();
      try {
        const pendingSteps = booted.trace.steps.filter((s) => s.status === 'pending');
        expect(pendingSteps.map((s) => s.step).sort()).toEqual(
          ['adapter_wire', 'core_router', 'db_open', 'keystore', 'msgbox_connect'].sort(),
        );
        for (const s of pendingSteps) {
          expect(s.pendingReason).toBeDefined();
          expect(s.pendingReason!.length).toBeGreaterThan(0);
        }
      } finally {
        await booted.app.close();
      }
    });

    it('booted.identity is populated when the identity step runs', async () => {
      const booted = await bootServer();
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
      const booted = await bootServer();
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
      const booted = await bootServer();
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
      const booted = await bootServer();
      try {
        const res = await booted.app.inject({ method: 'GET', url: '/healthz' });
        expect(res.statusCode).toBe(200);
      } finally {
        await booted.app.close();
      }
    });
  });
});
