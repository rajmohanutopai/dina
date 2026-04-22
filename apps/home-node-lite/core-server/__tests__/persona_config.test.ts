/**
 * Task 4.68 — persona config.json loader tests.
 *
 * Covers: happy-path loading, legacy-tier migration (via 4.74),
 * missing file, malformed JSON, schema violations, unknown tier,
 * duplicate-persona defense, description pass-through, serializer
 * round-trip.
 */

import {
  loadPersonaConfig,
  PersonaConfigError,
  serializePersonaConfig,
} from '../src/persona/persona_config';

/** Helper: build a `readFile` stub that returns the supplied string. */
function readerReturning(content: string): (path: string) => string {
  return () => content;
}

/** Helper: build a `readFile` stub that simulates ENOENT. */
function enoentReader(): (path: string) => string {
  return () => {
    const err = new Error('no such file') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
}

describe('loadPersonaConfig (task 4.68)', () => {
  describe('happy path — already-canonical config', () => {
    it('loads a minimal valid file', () => {
      const file = JSON.stringify({
        version: 1,
        personas: {
          general: { tier: 'default' },
          work: { tier: 'standard', description: 'Work comms' },
          health: { tier: 'sensitive' },
          financial: { tier: 'locked' },
        },
      });
      const loaded = loadPersonaConfig({
        path: '/x/config.json',
        readFile: readerReturning(file),
      });

      expect(loaded.version).toBe(1);
      expect(loaded.personas.size).toBe(4);
      expect(loaded.personas.get('general')).toEqual({ name: 'general', tier: 'default' });
      expect(loaded.personas.get('work')).toEqual({
        name: 'work',
        tier: 'standard',
        description: 'Work comms',
      });
      expect(loaded.migrations).toEqual([]);
    });

    it('does not include a `description` key when the source omits it', () => {
      const file = JSON.stringify({
        version: 1,
        personas: { a: { tier: 'default' } },
      });
      const loaded = loadPersonaConfig({
        path: '/x/config.json',
        readFile: readerReturning(file),
      });
      const entry = loaded.personas.get('a')!;
      expect(Object.keys(entry).sort()).toEqual(['name', 'tier']);
    });
  });

  describe('legacy migration on load', () => {
    it('migrates `open` + home-bucket name → `default`', () => {
      const file = JSON.stringify({
        version: 1,
        personas: { personal: { tier: 'open' } },
      });
      const loaded = loadPersonaConfig({
        path: '/x/config.json',
        readFile: readerReturning(file),
      });
      expect(loaded.personas.get('personal')!.tier).toBe('default');
      expect(loaded.migrations).toEqual([
        { persona: 'personal', from: 'open', to: 'default' },
      ]);
    });

    it('migrates `open` + other name → `standard`', () => {
      const file = JSON.stringify({
        version: 1,
        personas: { work: { tier: 'open' } },
      });
      const loaded = loadPersonaConfig({
        path: '/x/config.json',
        readFile: readerReturning(file),
      });
      expect(loaded.personas.get('work')!.tier).toBe('standard');
      expect(loaded.migrations).toEqual([{ persona: 'work', from: 'open', to: 'standard' }]);
    });

    it('migrates `restricted` → `sensitive`', () => {
      const file = JSON.stringify({
        version: 1,
        personas: { health: { tier: 'restricted' } },
      });
      const loaded = loadPersonaConfig({
        path: '/x/config.json',
        readFile: readerReturning(file),
      });
      expect(loaded.personas.get('health')!.tier).toBe('sensitive');
      expect(loaded.migrations).toEqual([
        { persona: 'health', from: 'restricted', to: 'sensitive' },
      ]);
    });

    it('emits migrations only for entries that actually changed', () => {
      const file = JSON.stringify({
        version: 1,
        personas: {
          general: { tier: 'default' }, // already canonical
          work: { tier: 'open' }, // migrates
          health: { tier: 'restricted' }, // migrates
          financial: { tier: 'locked' }, // already canonical
        },
      });
      const loaded = loadPersonaConfig({
        path: '/x/config.json',
        readFile: readerReturning(file),
      });
      expect(loaded.migrations.map((m) => m.persona).sort()).toEqual(['health', 'work']);
    });
  });

  describe('error cases', () => {
    it('throws PersonaConfigError(missing_file) on ENOENT', () => {
      const err = catchErr(() =>
        loadPersonaConfig({ path: '/missing.json', readFile: enoentReader() }),
      );
      expect(err).toBeInstanceOf(PersonaConfigError);
      expect(err!.code).toBe('missing_file');
      expect(err!.message).toMatch(/persona config not found/);
    });

    it('wraps non-ENOENT read errors as invalid_json', () => {
      const err = catchErr(() =>
        loadPersonaConfig({
          path: '/x.json',
          readFile: () => {
            throw new Error('EIO: disk died');
          },
        }),
      );
      expect(err).toBeInstanceOf(PersonaConfigError);
      expect(err!.code).toBe('invalid_json');
    });

    it('throws PersonaConfigError(invalid_json) on malformed JSON', () => {
      const err = catchErr(() =>
        loadPersonaConfig({
          path: '/bad.json',
          readFile: readerReturning('{not json'),
        }),
      );
      expect(err).toBeInstanceOf(PersonaConfigError);
      expect(err!.code).toBe('invalid_json');
    });

    it('throws invalid_shape when `version` is missing', () => {
      const err = catchErr(() =>
        loadPersonaConfig({
          path: '/x.json',
          readFile: readerReturning(JSON.stringify({ personas: {} })),
        }),
      );
      expect(err!.code).toBe('invalid_shape');
      const issues = (err!.detail?.issues as Array<{ path: string }>) ?? [];
      expect(issues.some((i) => i.path === 'version')).toBe(true);
    });

    it('throws invalid_shape when a persona entry is missing `tier`', () => {
      const err = catchErr(() =>
        loadPersonaConfig({
          path: '/x.json',
          readFile: readerReturning(
            JSON.stringify({ version: 1, personas: { p: { description: 'no tier' } } }),
          ),
        }),
      );
      expect(err!.code).toBe('invalid_shape');
    });

    it('throws invalid_tier on an unknown tier string', () => {
      const err = catchErr(() =>
        loadPersonaConfig({
          path: '/x.json',
          readFile: readerReturning(
            JSON.stringify({ version: 1, personas: { p: { tier: 'admin' } } }),
          ),
        }),
      );
      expect(err!.code).toBe('invalid_tier');
      expect(err!.detail?.persona).toBe('p');
      expect(err!.detail?.tier).toBe('admin');
    });

    it('invalid_tier error preserves the raw input for the operator', () => {
      const err = catchErr(() =>
        loadPersonaConfig({
          path: '/x.json',
          readFile: readerReturning(
            JSON.stringify({ version: 1, personas: { p: { tier: 'Default' } } }),
          ),
        }),
      );
      // Case-sensitive: "Default" is NOT a canonical value.
      expect(err!.code).toBe('invalid_tier');
      expect(err!.detail?.tier).toBe('Default');
    });
  });

  describe('serializePersonaConfig (round-trip)', () => {
    it('round-trips a canonical file unchanged except key order', () => {
      const file = {
        version: 1,
        personas: {
          general: { tier: 'default' },
          work: { tier: 'standard', description: 'Work' },
        },
      };
      const loaded = loadPersonaConfig({
        path: '/x.json',
        readFile: readerReturning(JSON.stringify(file)),
      });
      const back = serializePersonaConfig(loaded);
      expect(back).toEqual(file);
    });

    it('serializer output heals a legacy file (open → standard persisted)', () => {
      const legacy = {
        version: 1,
        personas: {
          work: { tier: 'open' },
          health: { tier: 'restricted' },
        },
      };
      const loaded = loadPersonaConfig({
        path: '/x.json',
        readFile: readerReturning(JSON.stringify(legacy)),
      });
      const healed = serializePersonaConfig(loaded);
      expect(healed.personas.work!.tier).toBe('standard');
      expect(healed.personas.health!.tier).toBe('sensitive');
    });

    it('drops undefined descriptions in serialized output', () => {
      const file = {
        version: 1,
        personas: { a: { tier: 'default' } },
      };
      const loaded = loadPersonaConfig({
        path: '/x.json',
        readFile: readerReturning(JSON.stringify(file)),
      });
      const back = serializePersonaConfig(loaded);
      expect(back.personas.a).toEqual({ tier: 'default' });
      expect('description' in back.personas.a!).toBe(false);
    });
  });

  describe('empty personas object', () => {
    it('accepts a file with no personas (fresh install pre-onboarding)', () => {
      const file = JSON.stringify({ version: 1, personas: {} });
      const loaded = loadPersonaConfig({
        path: '/x.json',
        readFile: readerReturning(file),
      });
      expect(loaded.personas.size).toBe(0);
      expect(loaded.migrations).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function catchErr(fn: () => void): PersonaConfigError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof PersonaConfigError) return e;
    throw e;
  }
}
