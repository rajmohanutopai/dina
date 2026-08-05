import {
  createPersona,
  getPersona,
  hydratePersonas,
  resetPersonaState,
  setPersonaRepository,
  type PersonaRepository,
  type StoredPersona,
} from '@dina/core';

import { registerRestoredPersona } from '../../src/storage/init';

function memoryRepository(): {
  repo: PersonaRepository;
  rows: Map<string, StoredPersona>;
} {
  const rows = new Map<string, StoredPersona>();
  return {
    rows,
    repo: {
      upsert: (persona) => rows.set(persona.name, persona),
      remove: (name) => {
        rows.delete(name);
      },
      list: () => [...rows.values()],
    },
  };
}

describe('archive custom-persona registration', () => {
  beforeEach(() => resetPersonaState());
  afterEach(() => {
    resetPersonaState();
    setPersonaRepository(null);
  });

  it('persists a custom persona so boot hydration restores it after import', () => {
    const { repo, rows } = memoryRepository();
    setPersonaRepository(repo);

    registerRestoredPersona('salon', 'standard');
    expect(rows.get('salon')?.tier).toBe('standard');

    // Simulate the JS restart requested after archive import.
    resetPersonaState();
    expect(hydratePersonas()).toEqual(['salon']);
    expect(getPersona('salon')?.tier).toBe('standard');
  });

  it('does not persist code-seeded builtins and fails unknown tiers closed', () => {
    const { repo, rows } = memoryRepository();
    setPersonaRepository(repo);

    createPersona('general', 'default');
    registerRestoredPersona('general', 'locked');
    expect(rows.has('general')).toBe(false);

    registerRestoredPersona('private_archive', 'unexpected-tier');
    expect(rows.get('private_archive')?.tier).toBe('locked');
  });
});
