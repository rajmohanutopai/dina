/**
 * brain_boot composer tests.
 */

import { NullCoreClient } from '../src/brain/core_client';
import { bootstrapBrain, type BootstrapBrainOptions } from '../src/brain/brain_boot';
import { ED25519_SEED_BYTES } from '../src/brain/ed25519_signer';

function seed(byte = 0x7): Uint8Array {
  const out = new Uint8Array(ED25519_SEED_BYTES);
  for (let i = 0; i < ED25519_SEED_BYTES; i++) out[i] = (byte + i) & 0xff;
  return out;
}

function validEnv(): Record<string, string | undefined> {
  return {
    DINA_CORE_URL: 'http://localhost:8100',
    HOME: '/tmp/home',
  };
}

function baseOpts(overrides: Partial<BootstrapBrainOptions> = {}): BootstrapBrainOptions {
  return {
    env: validEnv(),
    serviceDid: 'did:plc:brain',
    readFileFn: async () => seed(),
    logEmitFn: () => {},
    ...overrides,
  };
}

describe('bootstrapBrain — input validation', () => {
  it.each([
    ['null opts', null as unknown as BootstrapBrainOptions],
    ['non-DID serviceDid', { ...baseOpts(), serviceDid: 'brain' }],
    ['missing serviceDid', { env: validEnv(), readFileFn: async () => seed() } as unknown as BootstrapBrainOptions],
  ] as const)('%s → signer-stage failure', async (_l, bad) => {
    const r = await bootstrapBrain(bad as BootstrapBrainOptions);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe('signer');
  });
});

describe('bootstrapBrain — config failure', () => {
  it('missing DINA_CORE_URL → config-stage failure with code', async () => {
    const r = await bootstrapBrain(baseOpts({ env: { HOME: '/tmp' } }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.stage === 'config') {
      expect(r.error.code).toBe('missing_required');
      expect(r.error.detail.key).toBe('DINA_CORE_URL');
    } else {
      throw new Error('expected config-stage rejection');
    }
  });
});

describe('bootstrapBrain — service-key failure', () => {
  it('readFileFn rejects ENOENT → service_key-stage not_found', async () => {
    const r = await bootstrapBrain(
      baseOpts({
        readFileFn: async () => {
          const e: NodeJS.ErrnoException = new Error('ENOENT');
          e.code = 'ENOENT';
          throw e;
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.stage === 'service_key') {
      expect(r.error.code).toBe('not_found');
    } else throw new Error('expected service_key rejection');
  });

  it('wrong-length key → service_key wrong_length', async () => {
    const r = await bootstrapBrain(
      baseOpts({ readFileFn: async () => new Uint8Array(16) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.stage === 'service_key') {
      expect(r.error.code).toBe('wrong_length');
    } else throw new Error('expected wrong_length');
  });
});

describe('bootstrapBrain — happy path', () => {
  it('returns a full BrainBootstrap with every component', async () => {
    const r = await bootstrapBrain(baseOpts({ core: new NullCoreClient() }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const b = r.bootstrap;
    expect(b.config.coreUrl).toBe('http://localhost:8100');
    expect(b.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof b.ed25519Signer.sign).toBe('function');
    expect(b.canonicalSigner.did).toBe('did:plc:brain');
    expect(b.logger).toBeDefined();
    expect(b.dispatcher.size()).toBe(6); // 6 user commands registered
  });

  it('the registered commands include /help, /status, /personas, /search, /whoami, /unlock', async () => {
    const r = await bootstrapBrain(baseOpts());
    if (!r.ok) throw new Error('expected ok');
    const names = r.bootstrap.dispatcher
      .list('user')
      .map((c) => c.name)
      .sort();
    expect(names).toEqual([
      '/help',
      '/personas',
      '/search',
      '/status',
      '/unlock',
      '/whoami',
    ]);
  });

  it('/status uses the bootstrap fingerprint + uptime anchor', async () => {
    const r = await bootstrapBrain(baseOpts({
      core: new NullCoreClient(),
      bootStartedMs: Date.now() - 2_000,
    }));
    if (!r.ok) throw new Error('expected ok');
    const status = await r.bootstrap.dispatcher.dispatch({
      name: '/status',
      argv: [],
      caller: { role: 'user' },
    });
    if (!status.ok) throw new Error('/status should succeed');
    const data = status.data as { uptimeMs: number; keyFingerprint: string };
    expect(data.uptimeMs).toBeGreaterThanOrEqual(2_000);
    expect(data.keyFingerprint).toBe(r.bootstrap.keyFingerprint);
  });

  it('canonical signer produces verifiable signatures', async () => {
    const r = await bootstrapBrain(baseOpts());
    if (!r.ok) throw new Error('expected ok');
    const signed = r.bootstrap.canonicalSigner.sign({
      method: 'POST',
      path: '/v1/vault/store',
      body: { k: 'v' },
    });
    expect(signed.headers['x-did']).toBe('did:plc:brain');
    expect(signed.headers['x-signature']).toBeTruthy();
    expect(signed.headers['x-timestamp']).toMatch(/^\d+$/);
    expect(signed.headers['x-nonce']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('overrides flow into config', async () => {
    const r = await bootstrapBrain(
      baseOpts({
        overrides: { port: 12345, logLevel: 'debug' },
      }),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.bootstrap.config.port).toBe(12345);
    expect(r.bootstrap.config.logLevel).toBe('debug');
  });

  it('help command lists the registered set when invoked', async () => {
    const r = await bootstrapBrain(baseOpts());
    if (!r.ok) throw new Error('expected ok');
    const help = await r.bootstrap.dispatcher.dispatch({
      name: '/help',
      argv: [],
      caller: { role: 'user' },
    });
    if (!help.ok) throw new Error('/help should succeed');
    const commands = (help.data as { commands: Array<{ name: string }> }).commands;
    expect(commands.length).toBe(6);
  });
});

describe('bootstrapBrain — no logEmitFn → wires real pino', () => {
  it('real pino path does not throw during boot', async () => {
    const r = await bootstrapBrain({
      env: validEnv(),
      serviceDid: 'did:plc:brain',
      readFileFn: async () => seed(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) r.bootstrap.logger.info('boot ok');
  });
});
