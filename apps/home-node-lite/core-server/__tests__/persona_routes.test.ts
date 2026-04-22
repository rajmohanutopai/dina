/**
 * Task 4.92 — persona HTTP routes integration tests.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { AutoLockRegistry } from '../src/persona/auto_lock';
import { PassphraseRegistry } from '../src/persona/passphrase_unlock';
import { SessionGrantRegistry } from '../src/persona/session_grants';
import { ApprovalRegistry } from '../src/persona/approval_registry';
import {
  loadPersonaConfig,
  type LoadedPersonaConfig,
} from '../src/persona/persona_config';
import {
  registerPersonaRoutes,
  type PersonaListEntry,
} from '../src/persona/routes';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

const fastParams = { memory: 1024, iterations: 1, parallelism: 1 };

/** Helper: load a persona config from a literal. */
function makeConfig(personas: Record<string, { tier: string; description?: string }>): LoadedPersonaConfig {
  return loadPersonaConfig({
    path: '/test.json',
    readFile: () => JSON.stringify({ version: 1, personas }),
  });
}

async function buildApp(opts: {
  config: LoadedPersonaConfig;
  passphrases?: PassphraseRegistry;
  autoLock?: AutoLockRegistry;
  sessionGrants?: SessionGrantRegistry;
  approvals?: ApprovalRegistry;
}) {
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  const registerOpts: Parameters<typeof registerPersonaRoutes>[1] = {
    personaConfig: opts.config,
  };
  if (opts.passphrases) registerOpts.passphrases = opts.passphrases;
  if (opts.autoLock) registerOpts.autoLock = opts.autoLock;
  if (opts.sessionGrants) registerOpts.sessionGrants = opts.sessionGrants;
  if (opts.approvals) registerOpts.approvals = opts.approvals;
  registerPersonaRoutes(app, registerOpts);
  return app;
}

describe('GET /v1/personas (task 4.92)', () => {
  it('lists every persona sorted by name', async () => {
    const config = makeConfig({
      work: { tier: 'standard', description: 'Work' },
      general: { tier: 'default' },
      financial: { tier: 'locked' },
      health: { tier: 'sensitive' },
    });
    const app = await buildApp({ config });
    const res = await app.inject({ method: 'GET', url: '/v1/personas' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { personas: PersonaListEntry[] };
    expect(body.personas.map((p) => p.name)).toEqual([
      'financial',
      'general',
      'health',
      'work',
    ]);
    await app.close();
  });

  it('reports is_open correctly for each tier on boot', async () => {
    const config = makeConfig({
      general: { tier: 'default' },
      work: { tier: 'standard' },
      health: { tier: 'sensitive' },
      financial: { tier: 'locked' },
    });
    const app = await buildApp({
      config,
      autoLock: new AutoLockRegistry({ lockFn: () => undefined }),
    });
    const res = await app.inject({ method: 'GET', url: '/v1/personas' });
    const byName = new Map(
      (res.json() as { personas: PersonaListEntry[] }).personas.map((p) => [p.name, p]),
    );
    expect(byName.get('general')!.is_open).toBe(true);
    expect(byName.get('work')!.is_open).toBe(true);
    expect(byName.get('health')!.is_open).toBe(false);
    expect(byName.get('financial')!.is_open).toBe(false);
    await app.close();
  });

  it('description is preserved when present + omitted when absent', async () => {
    const config = makeConfig({
      a: { tier: 'default', description: 'hello' },
      b: { tier: 'default' },
    });
    const app = await buildApp({ config });
    const body = (
      await app.inject({ method: 'GET', url: '/v1/personas' })
    ).json() as { personas: PersonaListEntry[] };
    const a = body.personas.find((p) => p.name === 'a')!;
    const b = body.personas.find((p) => p.name === 'b')!;
    expect(a.description).toBe('hello');
    expect('description' in b).toBe(false);
    await app.close();
  });

  it('auto_locks_at_ms is populated when an unlocked sensitive persona has a deadline', async () => {
    const config = makeConfig({ health: { tier: 'sensitive' } });
    const autoLock = new AutoLockRegistry({ lockFn: () => undefined });
    autoLock.unlock('health', { ttlMs: 60_000 });
    const app = await buildApp({ config, autoLock });
    const body = (
      await app.inject({ method: 'GET', url: '/v1/personas' })
    ).json() as { personas: PersonaListEntry[] };
    const h = body.personas.find((p) => p.name === 'health')!;
    expect(h.is_open).toBe(true);
    expect(typeof h.auto_locks_at_ms).toBe('number');
    await app.close();
  });
});

describe('POST /v1/personas/:name/unlock (task 4.92)', () => {
  describe('default / standard tiers — always open', () => {
    it('returns is_open=true without requiring proof', async () => {
      const config = makeConfig({
        general: { tier: 'default' },
        work: { tier: 'standard' },
      });
      const app = await buildApp({ config });
      for (const name of ['general', 'work']) {
        const res = await app.inject({
          method: 'POST',
          url: `/v1/personas/${name}/unlock`,
          headers: { 'content-type': 'application/json' },
          payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as { is_open: boolean }).is_open).toBe(true);
      }
      await app.close();
    });
  });

  describe('locked tier — passphrase required', () => {
    it('accepts the correct passphrase and opens the persona', async () => {
      const config = makeConfig({ financial: { tier: 'locked' } });
      const passphrases = new PassphraseRegistry({ params: fastParams });
      await passphrases.set('financial', 'correct-horse-battery-staple');
      const autoLock = new AutoLockRegistry({ lockFn: () => undefined });
      const app = await buildApp({ config, passphrases, autoLock });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/financial/unlock',
        headers: { 'content-type': 'application/json' },
        payload: { passphrase: 'correct-horse-battery-staple' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as PersonaListEntry;
      expect(body.name).toBe('financial');
      expect(body.is_open).toBe(true);
      expect(autoLock.isUnlocked('financial')).toBe(true);
      await app.close();
    });

    it('rejects a wrong passphrase with 401', async () => {
      const config = makeConfig({ financial: { tier: 'locked' } });
      const passphrases = new PassphraseRegistry({ params: fastParams });
      await passphrases.set('financial', 'right-passphrase');
      const app = await buildApp({ config, passphrases });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/financial/unlock',
        headers: { 'content-type': 'application/json' },
        payload: { passphrase: 'wrong-passphrase' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid passphrase' });
      await app.close();
    });

    it('rejects missing passphrase with 401', async () => {
      const config = makeConfig({ financial: { tier: 'locked' } });
      const passphrases = new PassphraseRegistry({ params: fastParams });
      await passphrases.set('financial', 'x-passphrase');
      const app = await buildApp({ config, passphrases });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/financial/unlock',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'passphrase is required' });
      await app.close();
    });

    it('returns 501 when passphrase registry is not configured', async () => {
      const config = makeConfig({ financial: { tier: 'locked' } });
      const app = await buildApp({ config });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/financial/unlock',
        headers: { 'content-type': 'application/json' },
        payload: { passphrase: 'x' },
      });
      expect(res.statusCode).toBe(501);
      await app.close();
    });
  });

  describe('sensitive tier — approval OR session grant', () => {
    it('accepts a valid approval_id', async () => {
      const config = makeConfig({ health: { tier: 'sensitive' } });
      const approvals = new ApprovalRegistry({ idFn: () => 'appr-1' });
      const req = approvals.request({
        action: 'vault_query',
        requesterDid: 'did:key:brain',
        persona: 'health',
        reason: 'lab results',
        preview: 'latest',
      });
      approvals.approve(req.id);
      const autoLock = new AutoLockRegistry({ lockFn: () => undefined });
      const app = await buildApp({ config, approvals, autoLock });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/health/unlock',
        headers: { 'content-type': 'application/json' },
        payload: { approval_id: req.id },
      });
      expect(res.statusCode).toBe(200);
      expect(autoLock.isUnlocked('health')).toBe(true);
      await app.close();
    });

    it('rejects an approval_id for a different persona', async () => {
      const config = makeConfig({
        health: { tier: 'sensitive' },
        financial: { tier: 'sensitive' },
      });
      const approvals = new ApprovalRegistry();
      const req = approvals.request({
        action: 'vault_query',
        requesterDid: 'did:key:brain',
        persona: 'financial',
        reason: 'x',
        preview: '',
      });
      approvals.approve(req.id);
      const app = await buildApp({ config, approvals });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/health/unlock',
        headers: { 'content-type': 'application/json' },
        payload: { approval_id: req.id },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('accepts a valid session grant', async () => {
      const config = makeConfig({ health: { tier: 'sensitive' } });
      const sessionGrants = new SessionGrantRegistry();
      sessionGrants.start('s1', 'refactor');
      sessionGrants.addGrant('s1', {
        agentDid: 'did:key:agent',
        persona: 'health',
        mode: 'read',
      });
      const autoLock = new AutoLockRegistry({ lockFn: () => undefined });
      const app = await buildApp({ config, sessionGrants, autoLock });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/health/unlock',
        headers: { 'content-type': 'application/json' },
        payload: { session_id: 's1', agent_did: 'did:key:agent' },
      });
      expect(res.statusCode).toBe(200);
      expect(autoLock.isUnlocked('health')).toBe(true);
      await app.close();
    });

    it('rejects when neither approval nor grant is supplied', async () => {
      const config = makeConfig({ health: { tier: 'sensitive' } });
      const app = await buildApp({ config });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/health/unlock',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('rejects a session grant for a DIFFERENT agent', async () => {
      const config = makeConfig({ health: { tier: 'sensitive' } });
      const sessionGrants = new SessionGrantRegistry();
      sessionGrants.start('s1', 'x');
      sessionGrants.addGrant('s1', {
        agentDid: 'did:key:alice',
        persona: 'health',
        mode: 'read',
      });
      const app = await buildApp({ config, sessionGrants });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/health/unlock',
        headers: { 'content-type': 'application/json' },
        payload: { session_id: 's1', agent_did: 'did:key:eve' },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('error cases', () => {
    it('returns 404 for unknown persona', async () => {
      const config = makeConfig({ general: { tier: 'default' } });
      const app = await buildApp({ config });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/personas/ghost/unlock',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});

describe('POST /v1/personas/:name/lock (task 4.92)', () => {
  it('locks a sensitive persona (204 No Content)', async () => {
    const config = makeConfig({ health: { tier: 'sensitive' } });
    const autoLock = new AutoLockRegistry({ lockFn: () => undefined });
    autoLock.unlock('health');
    expect(autoLock.isUnlocked('health')).toBe(true);
    const app = await buildApp({ config, autoLock });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/personas/health/lock',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(autoLock.isUnlocked('health')).toBe(false);
    await app.close();
  });

  it('rejects locking a default-tier persona with 409', async () => {
    const config = makeConfig({ general: { tier: 'default' } });
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/personas/general/lock',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'cannot lock default-tier persona',
    });
    await app.close();
  });

  it('returns 404 for unknown persona', async () => {
    const config = makeConfig({ general: { tier: 'default' } });
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/personas/ghost/lock',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('construction validation', () => {
  it('throws when personaConfig is missing', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    expect(() =>
      registerPersonaRoutes(app, {
        personaConfig: undefined as unknown as LoadedPersonaConfig,
      }),
    ).toThrow(/personaConfig is required/);
    await app.close();
  });
});
