/**
 * T2.33 — Persona service: create, list, tier, open/close lifecycle.
 *
 * Source: ARCHITECTURE.md Section 4, Task 2.33-2.35
 */

import {
  setPersonaRepository,
  type PersonaRepository,
  type StoredPersona,
} from '../../src/persona/repository';
import {
  createPersona,
  deletePersona,
  hydratePersonas,
  listPersonas,
  getPersona,
  getPersonaTier,
  isPersonaOpen,
  openPersona,
  closePersona,
  openBootPersonas,
  setPersonaDescription,
  personaExists,
  resetPersonaState,
} from '../../src/persona/service';

/** In-memory PersonaRepository for asserting write-through + hydrate. */
function makeMockRepo(seed: StoredPersona[] = []): {
  repo: PersonaRepository;
  rows: Map<string, StoredPersona>;
} {
  const rows = new Map<string, StoredPersona>(seed.map((p) => [p.name, p]));
  const repo: PersonaRepository = {
    upsert: (p) => {
      rows.set(p.name, p);
    },
    remove: (name) => {
      rows.delete(name);
    },
    list: () => [...rows.values()],
  };
  return { repo, rows };
}

describe('Persona Service', () => {
  beforeEach(() => resetPersonaState());

  describe('createPersona', () => {
    it('creates persona with tier', () => {
      const p = createPersona('general', 'default');
      expect(p.name).toBe('general');
      expect(p.tier).toBe('default');
      expect(p.isOpen).toBe(false);
    });

    it('normalizes name to lowercase', () => {
      createPersona('Health', 'sensitive');
      expect(personaExists('health')).toBe(true);
      expect(personaExists('Health')).toBe(true);
    });

    it('rejects duplicate names', () => {
      createPersona('general', 'default');
      expect(() => createPersona('general', 'standard')).toThrow('already exists');
    });

    it('rejects empty name', () => {
      expect(() => createPersona('', 'default')).toThrow('name is required');
    });

    it('accepts description', () => {
      const p = createPersona('work', 'standard', 'Work-related items');
      expect(p.description).toBe('Work-related items');
    });

    it('has createdAt timestamp', () => {
      const before = Date.now();
      const p = createPersona('general', 'default');
      expect(p.createdAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('listPersonas', () => {
    it('returns empty when none created', () => {
      expect(listPersonas()).toEqual([]);
    });

    it('returns all created personas', () => {
      createPersona('general', 'default');
      createPersona('health', 'sensitive');
      createPersona('work', 'standard');
      expect(listPersonas()).toHaveLength(3);
    });
  });

  describe('getPersona / getPersonaTier', () => {
    it('returns persona by name', () => {
      createPersona('health', 'sensitive');
      const p = getPersona('health');
      expect(p).not.toBeNull();
      expect(p!.tier).toBe('sensitive');
    });

    it('returns null for unknown persona', () => {
      expect(getPersona('nonexistent')).toBeNull();
    });

    it('getPersonaTier returns tier', () => {
      createPersona('general', 'default');
      expect(getPersonaTier('general')).toBe('default');
    });

    it('getPersonaTier throws for unknown', () => {
      expect(() => getPersonaTier('missing')).toThrow('not found');
    });
  });

  describe('open / close lifecycle', () => {
    it('persona starts closed', () => {
      createPersona('general', 'default');
      expect(isPersonaOpen('general')).toBe(false);
    });

    it('default/standard persona opens without approval', () => {
      createPersona('general', 'default');
      expect(openPersona('general')).toBe(true);
      expect(isPersonaOpen('general')).toBe(true);
    });

    it('sensitive persona requires approval', () => {
      createPersona('health', 'sensitive');
      expect(openPersona('health')).toBe(false); // no approval
      expect(isPersonaOpen('health')).toBe(false);
    });

    it('sensitive persona opens with approval', () => {
      createPersona('health', 'sensitive');
      expect(openPersona('health', true)).toBe(true);
      expect(isPersonaOpen('health')).toBe(true);
    });

    it('locked persona requires approval', () => {
      createPersona('secret', 'locked');
      expect(openPersona('secret')).toBe(false);
      expect(openPersona('secret', true)).toBe(true);
    });

    it('close sets persona to not open', () => {
      createPersona('general', 'default');
      openPersona('general');
      closePersona('general');
      expect(isPersonaOpen('general')).toBe(false);
    });

    it('opening already-open persona returns true', () => {
      createPersona('general', 'default');
      openPersona('general');
      expect(openPersona('general')).toBe(true);
    });

    it('throws for unknown persona', () => {
      expect(() => openPersona('missing')).toThrow('not found');
      expect(() => closePersona('missing')).toThrow('not found');
    });
  });

  describe('openBootPersonas', () => {
    it('opens default and standard personas', () => {
      createPersona('general', 'default');
      createPersona('work', 'standard');
      createPersona('health', 'sensitive');
      createPersona('secret', 'locked');
      const opened = openBootPersonas();
      expect(opened).toContain('general');
      expect(opened).toContain('work');
      expect(opened).not.toContain('health');
      expect(opened).not.toContain('secret');
    });

    it('does not re-open already open personas', () => {
      createPersona('general', 'default');
      openPersona('general');
      const opened = openBootPersonas();
      expect(opened).not.toContain('general'); // was already open
    });
  });

  describe('setPersonaDescription', () => {
    it('updates description', () => {
      createPersona('work', 'standard');
      setPersonaDescription('work', 'Professional contacts and docs');
      expect(getPersona('work')!.description).toBe('Professional contacts and docs');
    });

    it('throws for unknown persona', () => {
      expect(() => setPersonaDescription('missing', 'desc')).toThrow('not found');
    });
  });

  describe('durable persistence', () => {
    afterEach(() => setPersonaRepository(null));

    it('createPersona({persist:true}) writes through to the repository', () => {
      const { repo, rows } = makeMockRepo();
      setPersonaRepository(repo);
      createPersona('salon', 'standard', 'Salon hours', { persist: true });
      const row = rows.get('salon');
      expect(row).toBeDefined();
      expect(row!.tier).toBe('standard');
      expect(row!.description).toBe('Salon hours');
      expect(row!.isBuiltin).toBe(false);
    });

    it('createPersona WITHOUT persist does not write (the builtin seed path)', () => {
      const { repo, rows } = makeMockRepo();
      setPersonaRepository(repo);
      createPersona('general', 'default', 'Personal');
      expect(rows.size).toBe(0);
    });

    it('createPersona({persist:true}) FAILS CLOSED when no repository is installed', () => {
      // No setPersonaRepository — durability was requested but is impossible.
      // Must throw rather than land a memory-only persona that vanishes on
      // restart (the original "custom vault disappears" bug).
      expect(() => createPersona('salon', 'standard', undefined, { persist: true })).toThrow(
        /no persona repository|vanish on restart|durabl/i,
      );
      // And it must NOT have been registered in memory either.
      expect(getPersona('salon')).toBeNull();
    });

    it('createPersona WITHOUT persist still succeeds with no repository (builtin seed path)', () => {
      // The fail-closed gate is ONLY for persist:true — code-seeded builtins
      // must still register in memory without a repo.
      const state = createPersona('general', 'default');
      expect(state.name).toBe('general');
      expect(getPersona('general')).not.toBeNull();
    });

    it('hydratePersonas restores user rows, skipping builtins and already-registered', () => {
      const { repo } = makeMockRepo([
        { name: 'salon', tier: 'standard', description: 'S', createdAt: 1, updatedAt: 1, isBuiltin: false },
        { name: 'general', tier: 'default', description: 'G', createdAt: 0, updatedAt: 0, isBuiltin: true },
        { name: 'work', tier: 'standard', description: 'W', createdAt: 2, updatedAt: 2, isBuiltin: false },
      ]);
      setPersonaRepository(repo);
      // 'work' is already registered this boot (e.g. code-seeded) — hydrate must
      // not clobber it; 'general' is a builtin row — skipped; 'salon' is restored.
      createPersona('work', 'standard');
      const restored = hydratePersonas();
      expect(restored).toEqual(['salon']);
      expect(getPersona('salon')!.tier).toBe('standard');
      // Restored closed; the boot open-loop (openAllPersonasForInAppUser) opens it.
      expect(getPersona('salon')!.isOpen).toBe(false);
    });

    it('deletePersona removes from the registry AND the repository', () => {
      const { repo, rows } = makeMockRepo();
      setPersonaRepository(repo);
      createPersona('salon', 'standard', '', { persist: true });
      expect(rows.has('salon')).toBe(true);
      deletePersona('salon');
      expect(personaExists('salon')).toBe(false);
      expect(rows.has('salon')).toBe(false);
    });

    it('hydratePersonas is a no-op when no repository is wired', () => {
      setPersonaRepository(null);
      expect(hydratePersonas()).toEqual([]);
    });
  });
});
