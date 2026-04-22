/**
 * T4.17 — Settings personas: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.17
 */

import {
  getPersonaUIStates,
  addPersona,
  updateDescription,
  getPersonaUI,
  getPersonaCounts,
  getTierOptions,
  resetPersonas,
} from '../../src/hooks/usePersonas';

describe('Persona Settings Hook (4.17)', () => {
  beforeEach(() => resetPersonas());

  describe('getPersonaUIStates', () => {
    it('returns empty list when no personas', () => {
      expect(getPersonaUIStates()).toHaveLength(0);
    });

    it('returns personas with UI-friendly fields', () => {
      addPersona('general', 'default');
      addPersona('health', 'sensitive');

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
    it('creates a standard persona', () => {
      const err = addPersona('work', 'standard');
      expect(err).toBeNull();

      const states = getPersonaUIStates();
      expect(states).toHaveLength(1);
      expect(states[0].name).toBe('work');
      expect(states[0].tier).toBe('standard');
    });

    it('creates with description', () => {
      addPersona('health', 'sensitive', 'Medical records');

      const state = getPersonaUI('health');
      expect(state!.description).toBe('Medical records');
    });

    it('rejects empty name', () => {
      expect(addPersona('', 'standard')).toContain('required');
    });

    it('rejects too-short name', () => {
      expect(addPersona('a', 'standard')).toContain('at least 2');
    });

    it('rejects too-long name', () => {
      expect(addPersona('a'.repeat(31), 'standard')).toContain('at most 30');
    });

    it('rejects invalid characters', () => {
      expect(addPersona('work stuff!', 'standard')).toContain('letters');
    });

    it('rejects duplicate name', () => {
      addPersona('work', 'standard');
      expect(addPersona('work', 'standard')).toContain('already exists');
    });

    it('normalizes name to lowercase', () => {
      addPersona('Work', 'standard');
      const state = getPersonaUI('work');
      expect(state).not.toBeNull();
    });
  });

  describe('updateDescription', () => {
    it('updates persona description', () => {
      addPersona('work', 'standard', 'Old description');
      updateDescription('work', 'New description');

      expect(getPersonaUI('work')!.description).toBe('New description');
    });

    it('returns error for nonexistent persona', () => {
      expect(updateDescription('ghost', 'test')).not.toBeNull();
    });
  });

  describe('getPersonaCounts', () => {
    it('returns correct counts', () => {
      expect(getPersonaCounts()).toEqual({ total: 0, open: 0, closed: 0 });

      addPersona('general', 'default');
      addPersona('work', 'standard');

      expect(getPersonaCounts()).toEqual({ total: 2, open: 0, closed: 2 });
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
    it('locked persona shows correct UI flags', () => {
      addPersona('secret', 'locked');

      const state = getPersonaUI('secret');
      expect(state!.needsPassphrase).toBe(true);
      expect(state!.needsApproval).toBe(false);
      expect(state!.canAutoOpen).toBe(false);
      expect(state!.tierLabel).toContain('passphrase');
    });
  });
});
