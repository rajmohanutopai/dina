/**
 * T2.33 — Persona service: create, list, tier, open/close lifecycle.
 *
 * Source: ARCHITECTURE.md Section 4, Task 2.33-2.35
 */

import {
  createPersona,
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
});
