/**
 * Tests for the service-config store — in-memory state + optional repository.
 *
 * Source parity: core/internal/service/service_config.go +
 *                core/internal/adapter/sqlite/service_config.go
 */

import {
  ServiceConfig,
  clearServiceConfig,
  getServiceConfig,
  hydrateServiceConfig,
  isCapabilityConfigured,
  onServiceConfigChanged,
  resetServiceConfigState,
  setServiceConfig,
  validateServiceConfig,
} from '../../src/service/service_config';
import {
  InMemoryServiceConfigRepository,
  SQLiteServiceConfigRepository,
  setServiceConfigRepository,
} from '../../src/service/service_config_repository';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeSQLiteAdapter } from '@dina/storage-node';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const validConfig: ServiceConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  description: 'Route 42 operator',
  capabilities: {
    eta_query: {
      mcpServer: 'transit',
      mcpTool: 'get_eta',
      responsePolicy: 'auto',
      schemaHash: 'abc123',
    },
  },
  capabilitySchemas: {
    eta_query: {
      params: { type: 'object' },
      result: { type: 'object' },
      schemaHash: 'abc123',
    },
  },
};

beforeEach(() => {
  resetServiceConfigState();
  setServiceConfigRepository(null);
});

afterAll(() => {
  resetServiceConfigState();
  setServiceConfigRepository(null);
});

describe('validateServiceConfig', () => {
  it('accepts a well-formed config', () => {
    expect(() => validateServiceConfig(validConfig)).not.toThrow();
  });

  it('accepts a config without capabilitySchemas', () => {
    const { capabilitySchemas: _c, ...rest } = validConfig;
    expect(() => validateServiceConfig(rest)).not.toThrow();
  });

  it('rejects non-object', () => {
    expect(() => validateServiceConfig(null)).toThrow(/JSON object/);
    expect(() => validateServiceConfig('x')).toThrow(/JSON object/);
  });

  it('rejects missing isDiscoverable', () => {
    const bad = { ...validConfig } as Partial<ServiceConfig>;
    delete bad.isDiscoverable;
    expect(() => validateServiceConfig(bad)).toThrow(/isDiscoverable/);
  });

  it('rejects empty name', () => {
    expect(() => validateServiceConfig({ ...validConfig, name: '' })).toThrow(/name/);
  });

  it('rejects invalid responsePolicy', () => {
    const bad = {
      ...validConfig,
      capabilities: {
        eta_query: { ...validConfig.capabilities.eta_query, responsePolicy: 'maybe' },
      },
    };
    expect(() => validateServiceConfig(bad)).toThrow(/responsePolicy/);
  });

  it('rejects empty mcpServer / mcpTool', () => {
    const makeBad = (patch: Record<string, string>) => ({
      ...validConfig,
      capabilities: {
        eta_query: { ...validConfig.capabilities.eta_query, ...patch },
      },
    });
    expect(() => validateServiceConfig(makeBad({ mcpServer: '' }))).toThrow(/mcpServer/);
    expect(() => validateServiceConfig(makeBad({ mcpTool: '' }))).toThrow(/mcpTool/);
  });

  it('rejects schemaHash with wrong type', () => {
    const bad = {
      ...validConfig,
      capabilities: {
        eta_query: { ...validConfig.capabilities.eta_query, schemaHash: 42 as unknown as string },
      },
    };
    expect(() => validateServiceConfig(bad)).toThrow(/schemaHash/);
  });

  it('rejects capabilitySchemas with missing params/result', () => {
    const makeBad = (patch: Record<string, unknown>) => ({
      ...validConfig,
      capabilitySchemas: {
        eta_query: { ...validConfig.capabilitySchemas!.eta_query, ...patch },
      },
    });
    expect(() => validateServiceConfig(makeBad({ params: undefined }))).toThrow(/params/);
    expect(() => validateServiceConfig(makeBad({ result: null }))).toThrow(/result/);
    expect(() => validateServiceConfig(makeBad({ schemaHash: '' }))).toThrow(/schemaHash/);
  });
});

describe('setServiceConfig / getServiceConfig', () => {
  it('round-trips a valid config through memory', () => {
    setServiceConfig(validConfig);
    expect(getServiceConfig()).toEqual(validConfig);
  });

  it('returns null before any write', () => {
    expect(getServiceConfig()).toBeNull();
  });

  it('throws and preserves previous value on invalid input', () => {
    setServiceConfig(validConfig);
    expect(() => setServiceConfig({ ...validConfig, name: '' })).toThrow(/name/);
    expect(getServiceConfig()).toEqual(validConfig);
  });
});

describe('clearServiceConfig', () => {
  it('removes stored config', () => {
    setServiceConfig(validConfig);
    clearServiceConfig();
    expect(getServiceConfig()).toBeNull();
  });

  it('notifies listeners with null', () => {
    const seen: Array<ServiceConfig | null> = [];
    onServiceConfigChanged((cfg) => {
      seen.push(cfg);
    });
    setServiceConfig(validConfig);
    clearServiceConfig();
    expect(seen).toEqual([validConfig, null]);
  });
});

describe('onServiceConfigChanged', () => {
  it('fires after setServiceConfig', () => {
    const seen: Array<ServiceConfig | null> = [];
    onServiceConfigChanged((cfg) => {
      seen.push(cfg);
    });
    setServiceConfig(validConfig);
    expect(seen).toEqual([validConfig]);
  });

  it('supports multiple listeners', () => {
    const a: Array<ServiceConfig | null> = [];
    const b: Array<ServiceConfig | null> = [];
    onServiceConfigChanged((c) => {
      a.push(c);
    });
    onServiceConfigChanged((c) => {
      b.push(c);
    });
    setServiceConfig(validConfig);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('disposer unsubscribes', () => {
    const seen: Array<ServiceConfig | null> = [];
    const dispose = onServiceConfigChanged((cfg) => {
      seen.push(cfg);
    });
    dispose();
    setServiceConfig(validConfig);
    expect(seen).toEqual([]);
  });

  it('isolates failing listeners — other listeners still run', () => {
    const seen: Array<ServiceConfig | null> = [];
    onServiceConfigChanged(() => {
      throw new Error('subscriber blew up');
    });
    onServiceConfigChanged((cfg) => {
      seen.push(cfg);
    });
    setServiceConfig(validConfig);
    expect(seen).toEqual([validConfig]);
  });
});

describe('isCapabilityConfigured', () => {
  it('returns false when no config', () => {
    expect(isCapabilityConfigured('eta_query')).toBe(false);
  });

  it('returns true when capability is configured and public', () => {
    setServiceConfig(validConfig);
    expect(isCapabilityConfigured('eta_query')).toBe(true);
  });

  it('returns false for an unconfigured capability', () => {
    setServiceConfig(validConfig);
    expect(isCapabilityConfigured('route_info')).toBe(false);
  });

  it('returns false when isDiscoverable is false', () => {
    setServiceConfig({ ...validConfig, isDiscoverable: false });
    expect(isCapabilityConfigured('eta_query')).toBe(false);
  });
});

describe('repository integration', () => {
  it('persists writes through the repository', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    setServiceConfig(validConfig);
    // setServiceConfig fire-and-forget writes — drain the microtask
    // queue so the repo row is observable.
    await Promise.resolve();

    // Simulate process restart: clear in-memory state, keep the repository.
    resetServiceConfigState();
    setServiceConfigRepository(repo);

    // Phase 2.3 (task 2.3): explicit hydrate replaces the prior
    // lazy-hydrate-in-getter. Callers invoke this at boot.
    await hydrateServiceConfig();
    expect(getServiceConfig()).toEqual(validConfig);
  });

  it('hydrates from the repository on explicit boot call', async () => {
    const repo = new InMemoryServiceConfigRepository();
    await repo.put('self', JSON.stringify(validConfig), Date.now());
    setServiceConfigRepository(repo);

    // No prior setServiceConfig. Sync read returns null until hydrated.
    expect(getServiceConfig()).toBeNull();
    await hydrateServiceConfig();
    expect(getServiceConfig()).toEqual(validConfig);
  });

  it('tolerates corrupt repository rows', async () => {
    const repo = new InMemoryServiceConfigRepository();
    await repo.put('self', 'not-valid-json', Date.now());
    setServiceConfigRepository(repo);

    // Cold read returns null. Hydrate with a corrupt row also leaves
    // `current` null — error swallowed; a subsequent setServiceConfig
    // recovers (the bad row is overwritten on the next write).
    expect(getServiceConfig()).toBeNull();
    await hydrateServiceConfig();
    expect(getServiceConfig()).toBeNull();

    setServiceConfig(validConfig);
    expect(getServiceConfig()).toEqual(validConfig);
    // Fire-and-forget write — drain the microtask queue before checking.
    await Promise.resolve();
    expect(await repo.get('self')).toContain('"Bus 42"');
  });

  it('remove clears the repository row', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    setServiceConfig(validConfig);
    await Promise.resolve();
    clearServiceConfig();
    await Promise.resolve();
    expect(await repo.get('self')).toBeNull();
  });
});

// issues.txt §4 — the durability + precedence the mobile boot now honours.
describe('mobile boot precedence — real SQLite restart', () => {
  function openId(p: string, pass: string): NodeSQLiteAdapter {
    const a = new NodeSQLiteAdapter({ path: p, passphraseHex: pass, journalMode: 'WAL', synchronous: 'NORMAL' });
    applyMigrations(a, IDENTITY_MIGRATIONS);
    return a;
  }

  it('provider config survives a real close+reopen restart and isCapabilityConfigured works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-svccfg-'));
    const dbPath = path.join(dir, 'identity.sqlite');
    const pass = randomBytes(32).toString('hex');
    try {
      // Session 1: write provider config via the SQL repo.
      const a1 = openId(dbPath, pass);
      setServiceConfigRepository(new SQLiteServiceConfigRepository(a1));
      setServiceConfig(validConfig);
      await Promise.resolve(); // drain fire-and-forget write
      a1.close();

      // Session 2 (mobile boot precedence): install repo → hydrate → no env override.
      resetServiceConfigState();
      const a2 = openId(dbPath, pass);
      setServiceConfigRepository(new SQLiteServiceConfigRepository(a2));
      expect(getServiceConfig()).toBeNull(); // before hydrate
      await hydrateServiceConfig();
      expect(getServiceConfig()?.name).toBe('Bus 42'); // persisted config restored
      expect(isCapabilityConfigured('eta_query')).toBe(true); // inbound service.query would be accepted
      a2.close();
    } finally {
      setServiceConfigRepository(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an explicit initialServiceConfig overrides the hydrated config (env/demo precedence)', async () => {
    const repo = new InMemoryServiceConfigRepository();
    await repo.put('self', JSON.stringify(validConfig), Date.now());
    setServiceConfigRepository(repo);
    // Mobile order: hydrate first…
    await hydrateServiceConfig();
    expect(getServiceConfig()?.name).toBe('Bus 42');
    // …then an explicit env/demo config overrides on top.
    const override: ServiceConfig = { ...validConfig, name: 'Demo Override' };
    setServiceConfig(override);
    expect(getServiceConfig()?.name).toBe('Demo Override');
  });
});
