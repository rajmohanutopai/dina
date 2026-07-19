/**
 * T4.17 — Settings personas: data hook tests.
 *
 * `addPersona` is async (it persists + opens + wires the vault DB for the
 * owner on create), so the return-checking tests await it. Created vaults
 * are OPEN immediately for the in-app owner (mirrors
 * openAllPersonasForInAppUser) — the counts test reflects that.
 *
 * Source: ARCHITECTURE.md Task 4.17
 */

// `addPersona` now fails closed unless storage is ready (persona repo + vault
// DB). Mock the vault-DB side as ready and wire an in-memory persona repo so a
// durable create succeeds — mirroring a booted node instead of the old
// memory-only path that let custom vaults vanish on restart.
jest.mock('../../src/storage/init', () => ({
  isPersistenceReady: () => true,
  openPersonaDB: jest.fn(async () => {}),
}));

import { setPersonaRepository, type PersonaRepository, type StoredPersona } from '@dina/core';

import {
  getPersonaUIStates,
  addPersona,
  updateDescription,
  getPersonaUI,
  getPersonaCounts,
  getTierOptions,
  resetPersonas,
} from '../../src/hooks/usePersonas';

function inMemoryPersonaRepo(): PersonaRepository {
  const rows = new Map<string, StoredPersona>();
  return {
    upsert: (p) => void rows.set(p.name, p),
    remove: (name) => void rows.delete(name),
    list: () => [...rows.values()],
  };
}

describe('Persona Settings Hook (4.17)', () => {
  beforeEach(() => {
    resetPersonas();
    setPersonaRepository(inMemoryPersonaRepo());
  });
  afterEach(() => setPersonaRepository(null));

  describe('getPersonaUIStates', () => {
    it('returns empty list when no personas', () => {
      expect(getPersonaUIStates()).toHaveLength(0);
    });

    it('returns personas with UI-friendly fields', async () => {
      await addPersona('general', 'default');
      await addPersona('health', 'sensitive');

      const states = getPersonaUIStates();
      expect(states).toHaveLength(2);

      const general = states.find((s) => s.name === 'general');
      expect(general!.tier).toBe('default');
      expect(general!.tierLabel).toContain('always open');
      expect(general!.canAutoOpen).toBe(true);
      expect(general!.needsApproval).toBe(false);
      expect(general!.needsPassphrase).toBe(false);

      const health = states.find((s) => s.name === 'health');
      expect(health!.tier).toBe('sensitive');
      expect(health!.tierLabel).toContain('approval');
      expect(health!.canAutoOpen).toBe(false);
      expect(health!.needsApproval).toBe(true);
    });
  });

  describe('addPersona', () => {
    it('creates a standard persona', async () => {
      const err = await addPersona('work', 'standard');
      expect(err).toBeNull();

      const states = getPersonaUIStates();
      expect(states).toHaveLength(1);
      expect(states[0].name).toBe('work');
      expect(states[0].tier).toBe('standard');
    });

    it('opens the new vault immediately for the owner', async () => {
      await addPersona('work', 'standard');
      // The owner has full access by definition — a freshly created vault is
      // OPEN right away (not locked until next boot), so a remember can
      // route into it instead of falling back to a default vault.
      expect(getPersonaUI('work')!.isOpen).toBe(true);
    });

    it('creates with description', async () => {
      await addPersona('health', 'sensitive', 'Medical records');

      const state = getPersonaUI('health');
      expect(state!.description).toBe('Medical records');
    });

    it('rejects empty name', async () => {
      expect(await addPersona('', 'standard')).toContain('required');
    });

    it('rejects too-short name', async () => {
      expect(await addPersona('a', 'standard')).toContain('at least 2');
    });

    it('rejects too-long name', async () => {
      expect(await addPersona('a'.repeat(31), 'standard')).toContain('at most 30');
    });

    it('rejects invalid characters', async () => {
      expect(await addPersona('work stuff!', 'standard')).toContain('letters');
    });

    it('rejects hyphens (mirrors Core, which only allows a-z 0-9 _)', async () => {
      expect(await addPersona('my-salon', 'standard')).toContain('letters');
    });

    it('rejects duplicate name', async () => {
      await addPersona('work', 'standard');
      expect(await addPersona('work', 'standard')).toContain('already exists');
    });

    it('normalizes name to lowercase', async () => {
      await addPersona('Work', 'standard');
      const state = getPersonaUI('work');
      expect(state).not.toBeNull();
    });
  });

  describe('updateDescription', () => {
    it('updates persona description', async () => {
      await addPersona('work', 'standard', 'Old description');
      updateDescription('work', 'New description');

      expect(getPersonaUI('work')!.description).toBe('New description');
    });

    it('returns error for nonexistent persona', () => {
      expect(updateDescription('ghost', 'test')).not.toBeNull();
    });
  });

  describe('getPersonaCounts', () => {
    it('returns correct counts', async () => {
      expect(getPersonaCounts()).toEqual({ total: 0, open: 0, closed: 0 });

      await addPersona('general', 'default');
      await addPersona('work', 'standard');

      // Both open on create for the in-app owner.
      expect(getPersonaCounts()).toEqual({ total: 2, open: 2, closed: 0 });
    });
  });

  describe('getTierOptions', () => {
    it('returns 3 options (standard, sensitive, locked)', () => {
      const options = getTierOptions();
      expect(options).toHaveLength(3);

      expect(options.map((o) => o.value)).toEqual(['standard', 'sensitive', 'locked']);
      expect(options[0].label).toBe('Standard');
      expect(options[1].label).toBe('Sensitive');
      expect(options[2].label).toBe('Locked');

      // Each has a description
      for (const opt of options) {
        expect(opt.description.length).toBeGreaterThan(0);
      }
    });

    it('does not include default tier (only for general persona)', () => {
      const values = getTierOptions().map((o) => o.value);
      expect(values).not.toContain('default');
    });
  });

  describe('locked tier', () => {
    it('locked persona shows correct UI flags', async () => {
      await addPersona('secret', 'locked');

      const state = getPersonaUI('secret');
      expect(state!.needsPassphrase).toBe(true);
      expect(state!.needsApproval).toBe(false);
      expect(state!.canAutoOpen).toBe(false);
      expect(state!.tierLabel).toContain('passphrase');
    });
  });
});
