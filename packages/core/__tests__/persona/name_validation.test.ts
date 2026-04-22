/**
 * Persona name validation tests.
 *
 * Go validates persona names via domain.NewPersonaName() with regex [a-z0-9_].
 * Mobile now matches this behavior.
 */

import { validatePersonaName, createPersona, resetPersonaState } from '../../src/persona/service';

describe('Persona Name Validation', () => {
  describe('validatePersonaName', () => {
    it('accepts valid names: lowercase letters', () => {
      expect(validatePersonaName('general')).toBeNull();
      expect(validatePersonaName('health')).toBeNull();
      expect(validatePersonaName('finance')).toBeNull();
    });

    it('accepts names with digits', () => {
      expect(validatePersonaName('vault2')).toBeNull();
      expect(validatePersonaName('test123')).toBeNull();
    });

    it('accepts names with underscores', () => {
      expect(validatePersonaName('my_vault')).toBeNull();
      expect(validatePersonaName('work_notes')).toBeNull();
    });

    it('accepts mixed alphanumeric + underscore', () => {
      expect(validatePersonaName('vault_2_backup')).toBeNull();
    });

    it('normalizes uppercase to lowercase before validation', () => {
      expect(validatePersonaName('General')).toBeNull();
      expect(validatePersonaName('HEALTH')).toBeNull();
    });

    it('rejects empty names', () => {
      expect(validatePersonaName('')).toContain('required');
      expect(validatePersonaName('   ')).toContain('required');
    });

    it('rejects names with spaces', () => {
      expect(validatePersonaName('my vault')).toContain('invalid characters');
    });

    it('rejects names with special characters', () => {
      expect(validatePersonaName('health!')).toContain('invalid characters');
      expect(validatePersonaName('vault@home')).toContain('invalid characters');
      expect(validatePersonaName('test-vault')).toContain('invalid characters');
      expect(validatePersonaName('my.vault')).toContain('invalid characters');
    });

    it('rejects names with unicode', () => {
      expect(validatePersonaName('gesundheit\u00FC')).toContain('invalid characters');
    });
  });

  describe('createPersona integration', () => {
    beforeEach(() => resetPersonaState());

    it('creates personas with valid names', () => {
      expect(() => createPersona('general', 'default')).not.toThrow();
      expect(() => createPersona('health_2', 'sensitive')).not.toThrow();
    });

    it('rejects personas with spaces in name', () => {
      expect(() => createPersona('my vault', 'default')).toThrow('invalid characters');
    });

    it('rejects personas with hyphens', () => {
      expect(() => createPersona('work-notes', 'standard')).toThrow('invalid characters');
    });

    it('rejects personas with dots', () => {
      expect(() => createPersona('v1.0', 'default')).toThrow('invalid characters');
    });
  });
});
